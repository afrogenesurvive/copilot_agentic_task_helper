/**
 * Queue Poller — reads unactioned items from the priority queue
 *
 * Polls logs/pending-tool-calls/priority.jsonl for items that haven't
 * been cleared yet. Returns them one at a time to avoid race conditions.
 *
 * The in-memory lock prevents the same item from being picked up twice
 * if a poll cycle overlaps with processing.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { sanitizeObject } from "../../scripts/sanitize.stub.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_FILE = path.resolve(__dirname, "..", "..", "logs", "pending-tool-calls", "priority.jsonl");
// Events that failed every attempt are appended here instead of being silently dropped.
const DEAD_LETTER_FILE = path.resolve(__dirname, "..", "..", "logs", "pending-tool-calls", "dead-letter.jsonl");
const TASKS_DIR = path.resolve(__dirname, "..", "..", "tasks");

// The webhook server holds the queue in memory and rewrites the file from that
// copy, so clearing through its API is what keeps the two in step (a bare file
// edit gets reverted on the next enqueue — see event-queue.js saveQueue).
const QUEUE_NAME = "priority";
const WEBHOOK_BASE = `http://localhost:${process.env.WEBHOOK_PORT || "3199"}`;

// In-memory set of event IDs currently being processed (lock)
const processing = new Set();

// In-memory set of task line indices currently being processed
const taskProcessing = new Set();

/**
 * Read all unactioned (not cleared) items from the priority queue.
 * Filters out items currently being processed by another instance.
 * @returns {Array} Pending events (oldest first)
 */
export function readPending() {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return [];

    const lines = fs.readFileSync(QUEUE_FILE, "utf8").split("\n").filter(Boolean);
    const pending = [];

    for (const line of lines) {
      try {
        const evt = sanitizeObject(JSON.parse(line));
        // Skip cleared events and items already being processed
        if (evt.cleared) continue;
        if (processing.has(evt.id)) continue;
        pending.push(evt);
      } catch {
        /* skip malformed lines */
      }
    }

    return pending;
  } catch (err) {
    console.error("   ❌ [POLLER] Error reading queue:", err.message);
    return [];
  }
}

/**
 * Clear an event so it is never processed again.
 *
 * The webhook server owns the queue in memory, so the API is tried first: it
 * updates that copy *and* rewrites the file (PATCH /events/:id?queue=priority).
 * Anything else — server down, token unset, event not in its memory — falls back
 * to the in-place file edit this used to do on its own.
 *
 * The processing lock is released in `finally`, so a line that cannot be
 * rewritten (already cleared, or absent because the server just rewrote the
 * file) no longer locks the id for the life of the process.
 *
 * @param {string} eventId — The event ID to mark
 * @param {object} [extra] — Extra fields for the queue line (e.g. failure detail)
 * @returns {Promise<boolean>} Success
 */
export async function markCleared(eventId, extra) {
  try {
    let ok = false;
    try {
      ok = await clearViaApi(eventId);
    } catch (err) {
      console.warn(`   ⚠️  [POLLER] API clear failed (${err.message}) — editing the queue file instead`);
    }
    // `extra` only ever lands in the file: the server has no way to store arbitrary
    // fields, so its next saveQueue drops them and the dead-letter file remains the
    // durable record of the failure.
    if (!ok || extra) ok = clearInFile(eventId, extra) || ok;
    return ok;
  } finally {
    processing.delete(eventId);
  }
}

/**
 * PATCH the event cleared on the webhook server. False means "use the file
 * fallback" — unreachable, refused (503 with no WEBHOOK_API_TOKEN, 401 on
 * mismatch), or an event that server does not hold.
 */
async function clearViaApi(eventId) {
  const token = process.env.WEBHOOK_API_TOKEN || "";
  if (!token) return false; // /events fails closed without it — skip the round trip
  const res = await fetch(`${WEBHOOK_BASE}/events/${encodeURIComponent(eventId)}?queue=${QUEUE_NAME}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.ok) return true;
  if (res.status !== 404) console.warn(`   ⚠️  [POLLER] API clear returned HTTP ${res.status}`);
  return false;
}

/** In-place JSONL edit — the offline path, and the only one that can store `extra`. */
function clearInFile(eventId, extra) {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return false;

    const content = fs.readFileSync(QUEUE_FILE, "utf8");
    const lines = content.split("\n");
    let found = false;

    const updated = lines.map((line) => {
      if (!line.trim()) return line;
      try {
        const evt = JSON.parse(line);
        if (evt.id === eventId && (!evt.cleared || extra)) {
          if (!evt.cleared) {
            evt.cleared = true;
            evt.clearedAt = new Date().toISOString();
            evt.clearedBy = "agent-runner";
          }
          if (extra && typeof extra === "object") Object.assign(evt, extra);
          found = true;
          return JSON.stringify(evt);
        }
        return line;
      } catch {
        return line;
      }
    });

    if (found) fs.writeFileSync(QUEUE_FILE, updated.join("\n"), "utf8");
    return found;
  } catch (err) {
    console.error("   ❌ [POLLER] Error marking cleared:", err.message);
    return false;
  }
}

/**
 * Append a permanently-failed event to the dead-letter file.
 *
 * A failed reply used to be marked cleared and forgotten: the user saw silence and
 * nothing recorded why. This keeps the event and its error so the operator can
 * replay or fix it, and it lives outside the queue so it can never block the head
 * of the line (every trigger retries `pending[0]`).
 *
 * @param {object} entry — anything JSON-serializable (event summary + error)
 * @returns {boolean} Success
 */
export function appendDeadLetter(entry) {
  try {
    fs.mkdirSync(path.dirname(DEAD_LETTER_FILE), { recursive: true });
    fs.appendFileSync(DEAD_LETTER_FILE, JSON.stringify({ deadLetteredAt: new Date().toISOString(), ...entry }) + "\n", "utf8");
    return true;
  } catch (err) {
    console.error("   ❌ [POLLER] Error writing dead letter:", err.message);
    return false;
  }
}

/**
 * Acquire a processing lock for an event (prevents duplicate handling).
 * @param {string} eventId
 */
export function acquireLock(eventId) {
  processing.add(eventId);
}

/**
 * Release a processing lock for an event.
 * @param {string} eventId
 */
export function releaseLock(eventId) {
  processing.delete(eventId);
}

/**
 * Read all uncompleted tasks from today's task file (tasks/YYYY-MM-DD.md).
 * Returns an array of { lineIndex, checked, text, raw } for unchecked items only.
 * @returns {Array}
 */
export function readTasks() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const taskFile = path.join(TASKS_DIR, `${today}.md`);
    if (!fs.existsSync(taskFile)) return [];

    const content = fs.readFileSync(taskFile, "utf8");
    const lines = content.split("\n");
    const tasks = [];

    lines.forEach((line, lineIndex) => {
      const match = line.match(/^-\s*\[([ x])\]\s*(.+)/);
      if (match) {
        tasks.push({
          lineIndex,
          checked: match[1] === "x",
          text: match[2].trim(),
          raw: line,
        });
      }
    });

    return tasks;
  } catch (err) {
    console.error("   ❌ [POLLER] Error reading tasks:", err.message);
    return [];
  }
}

/**
 * Mark a task as completed ([ ] → [x]) by its line index in the task file.
 * @param {number} lineIndex
 * @returns {boolean} Success
 */
export function markTaskDone(lineIndex) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const taskFile = path.join(TASKS_DIR, `${today}.md`);
    if (!fs.existsSync(taskFile)) return false;

    const content = fs.readFileSync(taskFile, "utf8");
    const lines = content.split("\n");

    const line = lines[lineIndex];
    if (!line) return false;
    if (!line.includes("- [ ]")) return false; // already done or not a task

    lines[lineIndex] = line.replace("- [ ]", "- [x]");
    fs.writeFileSync(taskFile, lines.join("\n"), "utf8");

    taskProcessing.delete(lineIndex);
    return true;
  } catch (err) {
    console.error("   ❌ [POLLER] Error marking task done:", err.message);
    return false;
  }
}

/**
 * Acquire a processing lock for a task (prevents duplicate handling).
 * @param {number} lineIndex
 */
export function acquireTaskLock(lineIndex) {
  taskProcessing.add(lineIndex);
}

/**
 * Release a processing lock for a task.
 * @param {number} lineIndex
 */
export function releaseTaskLock(lineIndex) {
  taskProcessing.delete(lineIndex);
}

/**
 * Check if a task is currently locked (being processed).
 * @param {number} lineIndex
 * @returns {boolean}
 */
export function isTaskLocked(lineIndex) {
  return taskProcessing.has(lineIndex);
}
