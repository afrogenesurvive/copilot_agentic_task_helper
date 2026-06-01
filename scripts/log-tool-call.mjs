#!/usr/bin/env node

/**
 * log-tool-call.mjs — Log an MCP tool call to logs/tool_call/
 *
 * Usage:
 *   node scripts/log-tool-call.mjs <tool_name> '<input_json>' '<output_summary>'
 *
 * Example:
 *   node scripts/log-tool-call.mjs gmail_list_messages '{"query":"..."}' '1 result'
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, "..", "logs", "tool_call");

const [, , toolName, inputJson, outputSummary] = process.argv;

if (!toolName) {
  console.error("Usage: node scripts/log-tool-call.mjs <tool_name> '<input_json>' '<output_summary>'");
  process.exit(1);
}

const ts = new Date().toISOString();
const today = ts.slice(0, 10);

fs.mkdirSync(LOG_DIR, { recursive: true });

const callEntry = {
  timestamp: ts,
  name: "tool_call",
  details: `${toolName} input=${inputJson || "{}"}`,
};

const respEntry = {
  timestamp: ts,
  name: "tool_response",
  details: `${toolName} output=${outputSummary || "done"}`,
};

for (const entry of [callEntry, respEntry]) {
  // Verbose JSONL
  fs.appendFileSync(path.join(LOG_DIR, `${today}_verbose.log`), JSON.stringify(entry) + "\n");
  // Human-readable log
  const human = `[${entry.timestamp}] EVENT name=${entry.name} details=${entry.details}\n`;
  fs.appendFileSync(path.join(LOG_DIR, `${today}.log`), human);
}

console.log(`✅ Logged: ${toolName} → ${outputSummary || "done"}`);
