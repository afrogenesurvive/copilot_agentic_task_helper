#!/usr/bin/env node

/**
 * log-event.js — CLI tool for manual event logging
 *
 * Usage:
 *   node scripts/log-event.js <source> <type> <json-data>
 *
 * Example:
 *   node scripts/log-event.js webhook trello_createCard '{"cardId":"abc123"}'
 */

import { logEvent } from "./logger.js";

const [, , source, type, jsonData] = process.argv;

if (!source || !type || !jsonData) {
  console.error("Usage: node scripts/log-event.js <source> <type> <json-data>");
  process.exit(1);
}

let data;
try {
  data = JSON.parse(jsonData);
} catch (err) {
  console.error("Invalid JSON data:", err.message);
  process.exit(1);
}

logEvent(source, type, data);
