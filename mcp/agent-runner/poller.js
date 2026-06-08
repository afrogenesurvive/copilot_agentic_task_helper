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
import { sanitizeObject } from "../../scripts/sanitize.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_FILE = path.resolve(__dirname, "..", "..", "logs", "pending-tool-calls", "priority.jsonl");

// In-memory set of event IDs currently being processed (lock)
const processing = new Set();

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
 * Mark an event as cleared in the queue file (soft-delete).
 * Adds "cleared": true and "clearedAt" timestamp to the JSON line.
 * @param {string} eventId — The event ID to mark
 * @returns {boolean} Success
 */
export function markCleared(eventId) {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return false;

    const content = fs.readFileSync(QUEUE_FILE, "utf8");
    const lines = content.split("\n");
    let found = false;

    const updated = lines.map((line) => {
      if (!line.trim()) return line;
      try {
        const evt = JSON.parse(line);
        if (evt.id === eventId && !evt.cleared) {
          evt.cleared = true;
          evt.clearedAt = new Date().toISOString();
          evt.clearedBy = "agent-runner";
          found = true;
          return JSON.stringify(evt);
        }
        return line;
      } catch {
        return line;
      }
    });

    if (found) {
      fs.writeFileSync(QUEUE_FILE, updated.join("\n"), "utf8");
      processing.delete(eventId);
    }

    return found;
  } catch (err) {
    console.error("   ❌ [POLLER] Error marking cleared:", err.message);
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
