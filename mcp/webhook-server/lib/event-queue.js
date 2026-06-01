/**
 * Event Queue — In-memory event queue with JSONL persistence
 *
 * Events are stored in memory and also persisted to a JSONL file
 * under logs/pending-tool-calls/ so they survive server restarts.
 *
 * Functions:
 *   enqueueEvent(event)  — Add event to queue
 *   readEvents()         — Read all pending events (supports cleared filter)
 *   clearEvent(id)       — Remove a processed event by ID
 *   clearEvents()        — Clear all pending events
 *   markCleared(id)      — Soft-delete: mark event as 'cleared' in-place
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_DIR = path.resolve(__dirname, "..", "..", "..", "logs", "pending-tool-calls");
const QUEUE_FILE = path.join(QUEUE_DIR, "queue.jsonl");

// In-memory queue
const queue = [];

// Load existing events from disk on startup
function load() {
  try {
    fs.mkdirSync(QUEUE_DIR, { recursive: true });
    if (fs.existsSync(QUEUE_FILE)) {
      const lines = fs.readFileSync(QUEUE_FILE, "utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          queue.push(JSON.parse(line));
        } catch {
          /* skip malformed */
        }
      }
    }
  } catch (err) {
    console.error("[event-queue] Error loading queue:", err.message);
  }
}

function save() {
  try {
    fs.mkdirSync(QUEUE_DIR, { recursive: true });
    const content = queue.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.writeFileSync(QUEUE_FILE, content, "utf8");
  } catch (err) {
    console.error("[event-queue] Error saving queue:", err.message);
  }
}

// Load on module init
load();

/**
 * Add an event to the queue.
 * @param {object} event — Event object with source, type, data, etc.
 * @returns {string} event ID
 */
export function enqueueEvent(event) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const entry = { id, ...event, queuedAt: new Date().toISOString() };
  queue.push(entry);
  save();
  console.log(`[event-queue] Enqueued event ${id} (${event.source}/${event.type})`);
  return id;
}

/**
 * Read all pending events (oldest first).
 * Pass { cleared: false } to exclude soft-deleted events.
 * @param {object} [filter] - Optional filter { cleared: boolean }
 * @returns {Array} Pending events
 */
export function readEvents(filter) {
  let events = [...queue];
  if (filter && filter.cleared === false) {
    events = events.filter((e) => !e.cleared);
  }
  return events;
}

/**
 * Soft-delete: mark an event as 'cleared' instead of removing it.
 * @param {string} id — Event ID to mark
 * @returns {boolean} Whether an event was found and marked
 */
export function markCleared(id) {
  const entry = queue.find((e) => e.id === id);
  if (!entry) return false;
  entry.cleared = true;
  entry.clearedAt = new Date().toISOString();
  save();
  console.log(`[event-queue] Marked event ${id} as cleared`);
  return true;
}

/**
 * Remove a processed event by ID.
 * @param {string} id — Event ID to remove
 * @returns {boolean} Whether an event was removed
 */
export function clearEvent(id) {
  const idx = queue.findIndex((e) => e.id === id);
  if (idx === -1) return false;
  queue.splice(idx, 1);
  save();
  console.log(`[event-queue] Cleared event ${id}`);
  return true;
}

/**
 * Remove all events from the queue.
 */
export function clearEvents() {
  queue.length = 0;
  save();
  console.log("[event-queue] All events cleared");
}
