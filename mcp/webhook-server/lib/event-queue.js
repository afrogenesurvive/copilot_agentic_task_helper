/**
 * Event Queue — Dual in-memory queues with JSONL persistence
 *
 * Two named queues:
 *   priority          — Tool dispatch events (matching rules) + authorized frontdesk inputs
 *   misc_notifications — All other notifications (raw webhooks, non-matching events)
 *
 * Each queue is stored in its own JSONL file under logs/pending-tool-calls/
 * so data survives server restarts.
 *
 * Every event gets a human-friendly `seqNo` (sequential # across all queues)
 * for easy terminal-based queue management.
 *
 * Functions:
 *   enqueueEvent(event, queueName?)    — Add event to named queue (default: misc_notifications)
 *   readEvents(queueName?, filter?)    — Read events from a named queue
 *   clearEvent(id, queueName?)         — Remove a processed event by ID from a named queue
 *   markCleared(id, queueName?)        — Soft-delete: mark event as 'cleared' in-place
 *   clearEvents(queueName?)            — Clear all events from a named queue
 *   countPriorityPending()             — Quick count of unactioned priority events
 *   getPriorityPending()               — Get all unactioned priority events (not cleared)
 *   findEventByNumber(seqNo, queue?)   — Find an event by its seqNo
 *   markClearedByNumber(seqNo, queue?) — Soft-delete an event by its seqNo
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { sanitizeObject } from "../../../scripts/sanitize.stub.mjs";
import { log as logEvent } from "../../../shared/logger.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_DIR = path.resolve(__dirname, "..", "..", "..", "logs", "pending-tool-calls");

// Trigger file — when a priority item is enqueued, this file is touched so
// the agent runner (watch mode) can react immediately instead of polling.
const TRIGGER_FILE = path.resolve(QUEUE_DIR, ".runner-trigger");

// Named queue definitions — each gets its own JSONL file on disk for crash recovery.
// - priority:            urgent items needing attention (tool dispatch + authorized frontdesk)
// - misc_notifications:  everything else (raw webhooks, daily review fodder)
const QUEUES = {
  priority: { file: "priority.jsonl", label: "priority" },
  misc_notifications: { file: "misc_notifications.jsonl", label: "misc_notifications" },
};

// In-memory stores (keyed by queue name).
// We keep two separate arrays so operations on one queue don't affect the other.
// Each is independently persisted to its own JSONL file.
const stores = { priority: [], misc_notifications: [] };

// Auto-incrementing sequence number across all queues.
// Every event gets a human-friendly # (1, 2, 3...) so you can type
// "done 3" in the interactive terminal instead of copying UUIDs.
let nextSeqNo = 1;

// On startup, find the highest existing seqNo across both queues
// so new events don't collide with reloaded ones.
function computeMaxSeqNo() {
  let max = 0;
  for (const name of Object.keys(QUEUES)) {
    for (const evt of stores[name]) {
      if (evt.seqNo && evt.seqNo > max) max = evt.seqNo;
    }
  }
  nextSeqNo = max + 1;
}

/**
 * Get the file path for a named queue.
 */
function queueFilePath(name) {
  const def = QUEUES[name];
  if (!def) throw new Error(`Unknown queue: "${name}"`);
  return path.join(QUEUE_DIR, def.file);
}

/**
 * Load all queues from disk. Each named queue reads from its own JSONL file.
 * On first run after the upgrade, also migrates the legacy single queue.jsonl
 * by splitting events into priority.jsonl and misc_notifications.jsonl.
 */
function loadAll() {
  try {
    fs.mkdirSync(QUEUE_DIR, { recursive: true });

    for (const name of Object.keys(QUEUES)) {
      const file = queueFilePath(name);
      if (fs.existsSync(file)) {
        const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            parsed._reloaded = true;
            stores[name].push(sanitizeObject(parsed, { auditSource: "event-queue/reload" }));
          } catch {
            /* skip malformed */
          }
        }
        console.log(`   📋 [QUEUE] Loaded ${stores[name].length} event(s) into "${name}" from ${QUEUES[name].file}`);
      }
    }

    // Legacy migration: if old queue.jsonl exists, split its events
    const legacyFile = path.join(QUEUE_DIR, "queue.jsonl");
    if (fs.existsSync(legacyFile)) {
      const lines = fs.readFileSync(legacyFile, "utf8").split("\n").filter(Boolean);
      let migratedPriority = 0;
      let migratedMisc = 0;
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          parsed._reloaded = true;
          parsed._migrated = true;
          const sanitized = sanitizeObject(parsed, { auditSource: "event-queue/migration" });
          // Tool dispatch events go to priority, everything else to misc
          if (parsed.source === "tool_dispatch") {
            stores.priority.push(sanitized);
            migratedPriority++;
          } else {
            stores.misc_notifications.push(sanitized);
            migratedMisc++;
          }
        } catch {
          /* skip malformed */
        }
      }
      if (migratedPriority > 0 || migratedMisc > 0) {
        console.log(`   📋 [QUEUE] Migrated ${migratedPriority} priority + ${migratedMisc} misc events from legacy queue.jsonl`);
        // Persist the split data and remove the old file
        saveAll();
        fs.renameSync(legacyFile, legacyFile + ".bak");
        console.log(`   📋 [QUEUE] Legacy queue.jsonl renamed to queue.jsonl.bak`);
      }
    }
  } catch (err) {
    console.error("   ❌ [QUEUE] Error loading queues:", err.message);
  }
}

function saveAll() {
  try {
    fs.mkdirSync(QUEUE_DIR, { recursive: true });
    for (const name of Object.keys(QUEUES)) {
      adoptExternalClears(name);
      const sanitized = stores[name].map((e) => sanitizeObject(e, { auditSource: "event-queue/saveAll" }));
      const content = sanitized.map((e) => JSON.stringify(e)).join("\n") + "\n";
      fs.writeFileSync(queueFilePath(name), content, "utf8");
    }
  } catch (err) {
    console.error("   ❌ [QUEUE] Error saving queues:", err.message);
  }
}

// Load all queues on module init
loadAll();
// Compute next sequence number from existing events
computeMaxSeqNo();

// Assign seqNo to any events that don't have one (e.g., migrated from legacy queue.jsonl
// before the seqNo feature was added, or events from older versions of the queue format).
for (const name of Object.keys(QUEUES)) {
  for (const evt of stores[name]) {
    if (!evt.seqNo) {
      evt.seqNo = nextSeqNo++;
    }
  }
}

/**
 * Adopt `cleared` markers another process wrote straight to the queue file.
 *
 * The agent runner clears events by editing `priority.jsonl` in place (and, when
 * the server is reachable, through PATCH /events/:id — which lands here anyway).
 * This module's `stores[name]` is loaded once at startup and never re-read, so a
 * plain `saveQueue()` would re-serialise the stale copy over the runner's edit:
 * every already-answered event came back to life on the next enqueue and was
 * answered again (event #1510 was answered four times on 2026-09-24). Merging the
 * on-disk flags before writing makes the file authoritative for `cleared` while
 * the server stays authoritative for everything else.
 */
function adoptExternalClears(name) {
  const file = queueFilePath(name);
  let onDisk;
  try {
    if (!fs.existsSync(file)) return;
    onDisk = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return; // unreadable or mid-write — the next persist will try again
  }

  const clearedById = new Map();
  for (const e of onDisk) {
    if (e && e.id && e.cleared) clearedById.set(e.id, e);
  }
  if (clearedById.size === 0) return;

  for (const evt of stores[name]) {
    if (evt.cleared) continue;
    const disk = clearedById.get(evt.id);
    if (!disk) continue;
    evt.cleared = true;
    if (disk.clearedAt) evt.clearedAt = disk.clearedAt;
    if (disk.clearedBy) evt.clearedBy = disk.clearedBy;
  }
}

function saveQueue(name) {
  try {
    fs.mkdirSync(QUEUE_DIR, { recursive: true });
    adoptExternalClears(name);
    const sanitized = stores[name].map((e) => sanitizeObject(e, { auditSource: "event-queue/saveQueue" }));
    const content = sanitized.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.writeFileSync(queueFilePath(name), content, "utf8");
  } catch (err) {
    console.error(`   ❌ [QUEUE] Error saving "${name}":`, err.message);
  }
}

/**
 * Signal the agent runner that new priority items are available.
 * Touches the .runner-trigger file so an fs.watch-based runner
 * can react immediately instead of polling.
 */
function signalAgentRunner() {
  try {
    fs.writeFileSync(TRIGGER_FILE, String(Date.now()));
  } catch {
    // Runner may not be running — that's fine
  }
}

/**
 * Add an event to a named queue.
 * @param {object} event — Event object with source, type, data, etc.
 * @param {string} [queueName] — Queue name: 'priority' or 'misc_notifications' (default)
 * @returns {string} event ID
 */
export function enqueueEvent(event, queueName = "misc_notifications") {
  const name = QUEUES[queueName] ? queueName : "misc_notifications";
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const seqNo = nextSeqNo++;
  const sanitized = sanitizeObject(event, { auditSource: "event-queue/enqueue" });
  const entry = { id, seqNo, ...sanitized, queuedAt: new Date().toISOString(), _queue: name };
  stores[name].push(entry);
  saveQueue(name);
  console.log(`   📋 [QUEUE] Enqueued #${seqNo} → "${name}" (${event.source}/${event.type})`);
  logEvent({ source: "webhook", subSource: "queue", level: "info", message: `enqueued #${seqNo} → ${name} (${event.source}/${event.type})`, data: { id, seqNo, queue: name, source: event.source, type: event.type, ...(event.data?.sub ? { sub: event.data.sub } : {}), ...(event.data?.text ? { text: String(event.data.text).slice(0, 200) } : {}) } });
  // Notify the agent runner if this was a priority queue item
  if (name === "priority") {
    signalAgentRunner();
  }
  return id;
}

/**
 * Read events from a named queue (oldest first).
 * @param {string} [queueName] — Queue name (default: 'misc_notifications')
 * @param {object} [filter] — Optional filter { cleared: boolean }
 * @returns {Array} Events
 */
export function readEvents(queueName = "misc_notifications", filter) {
  const name = QUEUES[queueName] ? queueName : "misc_notifications";
  let events = [...stores[name]];
  if (filter && filter.cleared === false) {
    events = events.filter((e) => !e.cleared);
  }
  return events;
}

/**
 * Soft-delete: mark an event as 'cleared' in a named queue.
 * @param {string} id — Event ID to mark
 * @param {string} [queueName] — Queue name (default: 'misc_notifications')
 * @returns {boolean} Whether an event was found and marked
 */
export function markCleared(id, queueName = "misc_notifications") {
  const name = QUEUES[queueName] ? queueName : "misc_notifications";
  const entry = stores[name].find((e) => e.id === id);
  if (!entry) return false;
  entry.cleared = true;
  entry.clearedAt = new Date().toISOString();
  saveQueue(name);
  console.log(`   ✅ [QUEUE] Marked cleared in "${name}"`);
  return true;
}

/**
 * Remove a processed event by ID from a named queue.
 * @param {string} id — Event ID to remove
 * @param {string} [queueName] — Queue name (default: 'misc_notifications')
 * @returns {boolean} Whether an event was removed
 */
export function clearEvent(id, queueName = "misc_notifications") {
  const name = QUEUES[queueName] ? queueName : "misc_notifications";
  const idx = stores[name].findIndex((e) => e.id === id);
  if (idx === -1) return false;
  stores[name].splice(idx, 1);
  saveQueue(name);
  console.log(`   🗑️ [QUEUE] Removed from "${name}"`);
  return true;
}

/**
 * Remove all events from a named queue.
 * @param {string} [queueName] — Queue name (default: 'misc_notifications')
 */
export function clearEvents(queueName = "misc_notifications") {
  const name = QUEUES[queueName] ? queueName : "misc_notifications";
  stores[name].length = 0;
  saveQueue(name);
  console.log(`   🗑️ [QUEUE] All events cleared from "${name}"`);
}

/**
 * Count unactioned (not cleared) events in the priority queue.
 * @returns {number}
 */
export function countPriorityPending() {
  return stores.priority.filter((e) => !e.cleared).length;
}

/**
 * Get all unactioned (not cleared) events from the priority queue.
 * @returns {Array}
 */
export function getPriorityPending() {
  return stores.priority.filter((e) => !e.cleared);
}

/**
 * Find an event by its sequence number across all queues (or a specific queue).
 * @param {number} seqNo — Sequence number to find
 * @param {string} [queueName] — Optional: restrict search to one queue
 * @returns {object|null} The event, or null if not found
 */
export function findEventByNumber(seqNo, queueName) {
  // If no specific queue name given, search both queues (priority first, then misc)
  const names = queueName && QUEUES[queueName] ? [queueName] : Object.keys(QUEUES);
  for (const name of names) {
    const found = stores[name].find((e) => e.seqNo === seqNo);
    if (found) return found;
  }
  return null;
}

/**
 * Soft-delete an event by its sequence number.
 * @param {number} seqNo — Sequence number to mark cleared
 * @param {string} [queueName] — Queue to search (optional, searches all)
 * @returns {boolean} Whether an event was found and marked
 */
export function markClearedByNumber(seqNo, queueName) {
  // Search across queues (or restrict to one if specified)
  const names = queueName && QUEUES[queueName] ? [queueName] : Object.keys(QUEUES);
  for (const name of names) {
    const entry = stores[name].find((e) => e.seqNo === seqNo);
    if (entry) {
      entry.cleared = true;
      entry.clearedAt = new Date().toISOString();
      saveQueue(name);
      console.log(`   ✅ [QUEUE] Marked #${seqNo} as cleared in "${name}"`);
      return true;
    }
  }
  return false;
}
