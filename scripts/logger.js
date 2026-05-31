/**
 * logger.js — Structured logging utility
 *
 * Logs events to daily files with JSON formatting.
 * Supports multiple log sources (notifications, webhooks, tool calls).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, "..", "logs");

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Log a structured event to a daily log file.
 * @param {string} source - Log category (e.g., "webhook", "tool_call")
 * @param {string} type - Event type (e.g., "trello_createCard", "gmail_newMessage")
 * @param {object} data - Event data payload
 */
export function logEvent(source, type, data) {
  const date = today();
  const logDir = path.join(LOG_DIR, source);
  ensureDir(logDir);

  const logFile = path.join(logDir, `${date}.log`);
  const entry = {
    ts: new Date().toISOString(),
    source,
    type,
    data,
  };

  fs.appendFileSync(logFile, JSON.stringify(entry) + "\n", "utf8");
  console.log(`[${source}] ${type} — logged to ${logFile}`);
}

/**
 * Log a JSONL notification entry.
 * @param {string} source - Notification source (e.g., "gmail", "trello")
 * @param {string} type - Notification type
 * @param {object} data - Notification data
 */
export function logNotification(source, type, data) {
  const date = today();
  const logDir = path.join(LOG_DIR, "notifications", source);
  ensureDir(logDir);

  const logFile = path.join(logDir, `${date}.jsonl`);
  const entry = {
    ts: new Date().toISOString(),
    source,
    type,
    data,
  };

  fs.appendFileSync(logFile, JSON.stringify(entry) + "\n", "utf8");
  console.log(`[notification] ${source}/${type} — logged`);
}
