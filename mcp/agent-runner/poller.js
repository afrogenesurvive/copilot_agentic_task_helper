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
const TASKS_DIR = path.resolve(__dirname, "..", "..", "tasks");

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
