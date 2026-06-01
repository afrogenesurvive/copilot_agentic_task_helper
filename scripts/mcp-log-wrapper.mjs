#!/usr/bin/env node

/**
 * mcp-log-wrapper.mjs — Automatic MCP tool call logger
 *
 * Wraps an MCP server's stdio transport to automatically log
 * all tool calls and responses to logs/tool_call/YYYY-MM-DD.log
 * without modifying the server code.
 *
 * Usage:
 *   node scripts/mcp-log-wrapper.mjs <server_name> <server_script> [args...]
 *
 * Example:
 *   node scripts/mcp-log-wrapper.mjs gmail mcp/gmail/index.js
 *   node scripts/mcp-log-wrapper.mjs trello mcp/trello/index.js
 *
 * Package.json:
 *   "mcp:gmail": "node scripts/mcp-log-wrapper.mjs gmail mcp/gmail/index.js"
 *   "mcp:trello": "node scripts/mcp-log-wrapper.mjs trello mcp/trello/index.js"
 */

import { spawn } from "child_process";
import { createInterface } from "readline";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, "..", "logs", "tool_call");

const serverName = process.argv[2];
const serverScript = process.argv[3];
const serverArgs = process.argv.slice(4);

if (!serverName || !serverScript) {
  console.error("Usage: node scripts/mcp-log-wrapper.mjs <server_name> <server_script> [args...]");
  process.exit(1);
}

const serverPath = path.resolve(__dirname, "..", serverScript);

if (!fs.existsSync(serverPath)) {
  console.error(`MCP server not found: ${serverPath}`);
  process.exit(1);
}

fs.mkdirSync(LOG_DIR, { recursive: true });

function logEntry(name, details) {
  const ts = new Date().toISOString();
  const today = ts.slice(0, 10);
  const entry = { timestamp: ts, name, details };
  const line = `[${ts}] EVENT name=${name} details=${details}`;

  // JSONL verbose
  fs.appendFileSync(path.join(LOG_DIR, `${today}_verbose.log`), JSON.stringify(entry) + "\n");
  // Human-readable log file
  fs.appendFileSync(path.join(LOG_DIR, `${today}.log`), line + "\n");
  // Also print to stderr so it's visible in terminal/MCP server output
  console.error(`[mcp-log] ${line}`);
}

// ── Spawn the MCP server process ──

const child = spawn(process.execPath, [serverPath, ...serverArgs], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env },
});

// ── Log and forward child stdout → our stdout ──

const rl = createInterface({ input: child.stdout });

child.stdout.on("data", (chunk) => {
  const data = chunk.toString();
  // Try to extract tool call responses from JSON-RPC messages
  try {
    const lines = data.trim().split("\n");
    for (const line of lines) {
      // Forward to parent stdout
      process.stdout.write(line + "\n");

      // Attempt to parse JSON-RPC response
      if (line.startsWith("{")) {
        const msg = JSON.parse(line);
        // tools/call response — log the result
        if (msg.id && msg.result) {
          const toolName = msg.id; // Some MCP implementations use id as tool name
          const resultStr = JSON.stringify(msg.result).slice(0, 120);
          logEntry("tool_response", `${serverName} id=${msg.id} result=${resultStr}`);
        }
      }
    }
  } catch {
    // Not JSON-RPC, just pass through
    process.stdout.write(data);
  }
});

// ── Read and log our stdin (tool calls from Copilot), forward to child stdin ──

const stdinRl = createInterface({ input: process.stdin });

process.stdin.on("data", (chunk) => {
  const data = chunk.toString();
  // Write to child's stdin
  child.stdin.write(data);

  // Attempt to parse JSON-RPC tool call
  try {
    const lines = data.trim().split("\n");
    for (const line of lines) {
      if (line.startsWith("{")) {
        const msg = JSON.parse(line);
        if (msg.method === "tools/call") {
          const params = msg.params || {};
          const args = params.arguments || {};
          const toolCallName = `${serverName}/${params.name || "unknown"}`;
          const argsStr = JSON.stringify(args).slice(0, 200);
          logEntry("tool_call", `${toolCallName} input=${argsStr} id=${msg.id}`);
        }
      }
    }
  } catch {
    // Not JSON-RPC, just forward
  }
});

// ── Handle process exit ──

child.on("exit", (code) => {
  logEntry("server_exit", `${serverName} code=${code}`);
  process.exit(code);
});

process.on("SIGTERM", () => child.kill());
process.on("SIGINT", () => child.kill());

logEntry("server_start", `${serverName} script=${serverScript}`);
