/**
 * Webhook Server — Express server on port 3199
 *
 * Receives push notifications from Trello and Gmail, logs them,
 * and enqueues pending tool calls for the Copilot agent to process.
 *
 * Dual-queue system:
 *   priority            — Tool dispatch events (matching rules) + authorized frontdesk inputs
 *   misc_notifications  — All other notifications (raw webhooks, non-matching events)
 *
 * Endpoints:
 *   POST/HEAD /webhooks/trello     — Trello webhook callbacks
 *   POST/GET  /webhooks/gmail/push — Gmail Pub/Sub push notifications
 *   GET       /events              — Read pending events (?queue=priority|misc_notifications)
 *   GET       /events/priority     — Shortcut: read priority queue unactioned items
 *   DELETE    /events/:id          — Clear a processed event (?queue=priority|misc_notifications)
 *   PATCH     /events/:id          — Soft-delete (?queue=priority|misc_notifications)
 *   GET       /health              — Health check
 *
 * Reminder: Every 5 minutes, prints a summary of unactioned priority items
 * to the terminal so you never miss something that needs attention.
 *
 * Environment:
 *   WEBHOOK_PORT        (default 3199)
 *   WEBHOOK_BASE_URL    — public URL for webhook registration
 *   PRIORITY_REMINDER_INTERVAL — reminder interval in ms (default 300000 = 5 min)
 */

import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { trelloHandler } from "./handlers/trello.js";
import { gmailHandler } from "./handlers/gmail.js";
import {
  enqueueEvent,
  readEvents,
  clearEvent,
  markCleared,
  clearEvents,
  countPriorityPending,
  getPriorityPending,
  findEventByNumber,
  markClearedByNumber,
} from "./lib/event-queue.js";

const app = express();
const PORT = parseInt(process.env.WEBHOOK_PORT || "3199", 10);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_LOG_DIR = path.resolve(__dirname, "..", "..", "logs", "tool_call");
const TASKS_DIR = path.resolve(__dirname, "..", "..", "tasks");

/* ── Middleware ──
 *
 * Standard Express middleware stack:
 *   - CORS: allows cross-origin requests from webapp/Netlify
 *   - JSON body parser: parses Trello/Gmail webhook payloads (limit 1MB)
 *   - URL-encoded: handles form data if needed
 *   - Request logger: shows every incoming request in the terminal for debugging
 */

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// Request logging — shows every request coming through the tunnel
app.use((req, res, next) => {
  const ts = new Date().toISOString();
  const ip = req.headers["x-forwarded-for"] || req.ip || "unknown";
  const ua = (req.headers["user-agent"] || "unknown").slice(0, 80);
  console.log(`🌐 [HTTP] ${req.method} ${req.path} — ${ip}`);
  next();
});

// Rate limit: 100 requests per minute per IP
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

/* ── Health check ── */

app.get("/health", (_req, res) => {
  res.json({ status: "ok", port: PORT, uptime: process.uptime() });
});

/* ── Trello webhooks ── */

app.head("/webhooks/trello", trelloHandler);
app.post("/webhooks/trello", trelloHandler);

/* ── Gmail push notifications ── */

app.post("/webhooks/gmail/push", gmailHandler);
app.get("/webhooks/gmail/push", gmailHandler);

/* ── Event queue endpoints (dual-queue aware) ──
 *
 * These HTTP endpoints let external services (and the human) inspect
 * and manage both queues without needing direct file access.
 *
 * Queue selection via ?queue=priority|misc_notifications query param.
 * Default queue: misc_notifications (for safety — you must explicitly
 * request priority to modify it).
 */

// GET /events — Read events from a named queue (default: misc_notifications)
//   ?queue=priority|misc_notifications
//   ?cleared=false  (filters out soft-deleted items)
app.get("/events", (req, res) => {
  const queueName = req.query.queue || "misc_notifications";
  const filterCleared = req.query.cleared === "false" ? { cleared: false } : undefined;
  const pending = readEvents(queueName, filterCleared);
  res.json({ queue: queueName, count: pending.length, events: pending });
});

// GET /events/priority — Shortcut to see unactioned priority items
app.get("/events/priority", (_req, res) => {
  const pending = getPriorityPending();
  res.json({ queue: "priority", count: pending.length, events: pending });
});

// DELETE /events/:id — Remove an event (supports ?queue= param)
app.delete("/events/:id", (req, res) => {
  const queueName = req.query.queue || "misc_notifications";
  const removed = clearEvent(req.params.id, queueName);
  if (removed) {
    res.json({ status: "cleared", id: req.params.id, queue: queueName });
  } else {
    res.status(404).json({ error: "Event not found in queue: " + queueName });
  }
});

// PATCH /events/:id — Soft-delete (supports ?queue= param)
app.patch("/events/:id", (req, res) => {
  const queueName = req.query.queue || "misc_notifications";
  const marked = markCleared(req.params.id, queueName);
  if (marked) {
    res.json({ status: "marked_cleared", id: req.params.id, queue: queueName });
  } else {
    res.status(404).json({ error: "Event not found in queue: " + queueName });
  }
});

/* ── Status API endpoints (for the frontdesk webapp) ──
 *
 * These endpoints serve queue status, task lists, and tool dispatch
 * rules so the webapp can display them in the Status tab.
 * All support CORS via the existing app.use(cors()) middleware.
 */

// GET /api/queue-status — Summary of both queues with counts
app.get("/api/queue-status", (_req, res) => {
  try {
    const priority = readEvents("priority", { cleared: false });
    const misc = readEvents("misc_notifications", { cleared: false });
    const priorityDone = readEvents("priority").filter((e) => e.cleared);
    const miscDone = readEvents("misc_notifications").filter((e) => e.cleared);
    res.json({
      priority: { pending: priority.length, cleared: priorityDone.length, items: priority.slice(-20).reverse() },
      misc: { pending: misc.length, cleared: miscDone.length, items: misc.slice(-20).reverse() },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tasks — Today's task list (if any)
app.get("/api/tasks", (_req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const taskFile = path.join(TASKS_DIR, `${today}.md`);
    const tasks = loadTaskList();
    res.json({ date: today, exists: fs.existsSync(taskFile), content: tasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rules — Tool dispatch rules (enabled only)
app.get("/api/rules", (_req, res) => {
  try {
    const rulesPath = path.resolve(__dirname, "..", "..", "safe", "webhook-tool-rules.json");
    if (!fs.existsSync(rulesPath)) {
      return res.json({ rules: [] });
    }
    const raw = fs.readFileSync(rulesPath, "utf8");
    const parsed = JSON.parse(raw);
    const rules = (parsed.rules || []).map((r) => ({
      name: r.name,
      enabled: r.enabled,
      source: r.match?.source,
      type: r.match?.type,
      conditions: r.match?.conditions || null,
      tool: r.tool,
    }));
    res.json({ rules });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/tool-logs", (req, res) => {
  const lines = parseInt(req.query.lines || "20", 10);
  const today = new Date().toISOString().slice(0, 10);
  const logFile = path.join(TOOL_LOG_DIR, `${today}.log`);

  try {
    if (!fs.existsSync(logFile)) {
      return res.json({ date: today, lines: 0, entries: [] });
    }
    const content = fs.readFileSync(logFile, "utf8");
    const allLines = content.trim().split("\n").filter(Boolean);
    const tail = allLines.slice(-lines);
    return res.json({ date: today, lines: tail.length, total: allLines.length, entries: tail });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/* ── Live tool call tail in terminal ──
 *
 * Uses a polling file watcher to print new tool call log entries
 * to the terminal in real-time (every 2 seconds).
 * This lets you see MCP tool activity without opening the log file.
 */

// Track the last read position in the log file (in bytes)
let toolLogLastSize = (() => {
  try {
    const f = path.join(TOOL_LOG_DIR, `${new Date().toISOString().slice(0, 10)}.log`);
    return fs.existsSync(f) ? fs.statSync(f).size : 0;
  } catch {
    return 0;
  }
})();

function tailToolLog() {
  const today = new Date().toISOString().slice(0, 10);
  const logFile = path.join(TOOL_LOG_DIR, `${today}.log`);
  try {
    if (!fs.existsSync(logFile)) return;
    const stat = fs.statSync(logFile);
    // If file hasn't grown since last check, skip
    if (stat.size <= toolLogLastSize) return;
    // Read only the new bytes (efficient incremental read)
    const fd = fs.openSync(logFile, "r");
    const buf = Buffer.alloc(stat.size - toolLogLastSize);
    fs.readSync(fd, buf, 0, buf.length, toolLogLastSize);
    fs.closeSync(fd);
    toolLogLastSize = stat.size;
    const lines = buf.toString("utf8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      console.log(`   🤖 ${line}`);
    }
  } catch {
    // ignore
  }
}

// Poll every 2 seconds for new tool call log entries
setInterval(tailToolLog, 2000);

/* ── Priority queue reminder system ──
 *
 * Periodically (default: every 5 minutes), prints a prominent terminal alert
 * showing all unactioned priority queue items — each with its # so you can
 * type "done 3" to clear it. Also shows any non-queue tasks from tasks/.
 *
 * Configure the interval with PRIORITY_REMINDER_INTERVAL env var (milliseconds).
 * Set to 0 to disable reminders.
 *
 * Configure with PRIORITY_REMINDER_INTERVAL env var (ms).
 */

const REMINDER_INTERVAL = parseInt(process.env.PRIORITY_REMINDER_INTERVAL || "300000", 10);

function loadTaskList() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const taskFile = path.join(TASKS_DIR, `${today}.md`);
    if (fs.existsSync(taskFile)) {
      const content = fs.readFileSync(taskFile, "utf8").trim();
      return content || null;
    }
    return null;
  } catch {
    return null;
  }
}

function printPriorityReminder() {
  const pending = getPriorityPending();
  const tasks = loadTaskList();
  if (pending.length === 0 && !tasks) return;

  const line = "═".repeat(60);
  const now = new Date().toISOString();
  console.log(`\n${line}`);
  console.log(`⏰ REMINDER [${now}]`);
  console.log(`${line}`);

  // Priority queue items
  if (pending.length > 0) {
    console.log(`\n   🔴 ${pending.length} unactioned item(s) in PRIORITY queue:\n`);
    for (const evt of pending) {
      const num = evt.seqNo ? `#${evt.seqNo}` : `#?`;
      const desc = evt.data?.rule ? `Rule: "${evt.data.rule}" → tool: ${evt.data.tool}` : `${evt.source}/${evt.type}`;
      const summary = evt.data?.originalEvent?.data?.card?.name
        ? ` — card: "${evt.data.originalEvent.data.card.name}"`
        : evt.data?.text
          ? ` — "${evt.data.text.slice(0, 60)}"`
          : evt.card?.name
            ? ` — card: "${evt.card.name}"`
            : "";
      console.log(`   ${num}) ${desc}${summary}`);
      console.log(`      Queued: ${evt.queuedAt}`);
    }
  }

  // Non-queue task list
  if (tasks) {
    console.log(`\n   📋 TODAY'S TASKS:\n`);
    const taskLines = tasks.split("\n").filter((l) => l.trim());
    for (const taskLine of taskLines) {
      console.log(`      ${taskLine}`);
    }
  }

  console.log(`\n${line}`);
  console.log(`   💡 Type "help" in the server terminal for queue commands`);
  console.log(`   💡 Type "ls" to list pending items with numbers`);
  console.log(`   💡 Type "done #" to mark an item cleared`);
  console.log(`${line}\n`);
}

const reminderInterval = setInterval(printPriorityReminder, REMINDER_INTERVAL);
console.log(`   ⏰ [REMINDER] Priority queue reminder active every ${REMINDER_INTERVAL / 1000}s`);

/* ── Start server ── */

app.listen(PORT, () => {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`   🌐 Webhook server — http://localhost:${PORT}`);
  console.log(`   📋 Events:  /events | Priority: /events/priority`);
  console.log(`   📊 Status:  /api/queue-status | /api/tasks | /api/rules`);
  console.log(`   🤖 Tool logs: /tool-logs`);
  console.log(`   ⏰ Reminder: every ${REMINDER_INTERVAL / 60000}m`);
  console.log(`   💬 Terminal: type "help" for commands`);
  console.log(`${"=".repeat(50)}\n`);
});

/* ── Interactive terminal prompt ──
 *
 * Uses Node.js readline to provide a live command prompt (webhook>).
 * This lets you manage queues directly from the server terminal
 * without needing curl, HTTP requests, or file editing.
 *
 * Commands:
 *   help             — Show available commands
 *   ls [queue]       — List pending items with seq numbers
 *   done <number>    — Mark an item as cleared by its #
 *   peek <number>    — Show full JSON details of an item by its #
 *   tasks            — Show today's task list from tasks/YYYY-MM-DD.md
 *   clear [queue]    — Clear all items from a queue (caution)
 *   reminder         — Force print the reminder now
 */

import readline from "readline";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "webhook> ",
  terminal: true,
});

// Command registry — maps command names to handler functions and help text
const COMMANDS = {
  help: { desc: "Show this help", fn: cmdHelp },
  ls: { desc: "List pending items: ls [priority|misc_notifications]", fn: cmdList },
  done: { desc: "Mark item cleared by #: done <seqNo>", fn: cmdDone },
  peek: { desc: "Show full details of an item by its #", fn: cmdPeek },
  tasks: { desc: "Show today's task list", fn: cmdTasks },
  clear: { desc: "Clear all items from a queue (caution): clear [priority|misc_notifications]", fn: cmdClear },
  reminder: { desc: "Force print the reminder now", fn: cmdReminder },
};

function cmdHelp() {
  console.log(`\n${"─".repeat(50)}`);
  console.log("   Available commands:");
  for (const [name, info] of Object.entries(COMMANDS)) {
    console.log(`   ${name.padEnd(10)} — ${info.desc}`);
  }
  console.log(`${"─".repeat(50)}\n`);
}

// Lists pending items in a queue with their sequential # for easy reference
function cmdList(args) {
  const queueName = args || "priority";
  const items = readEvents(queueName, { cleared: false });
  if (items.length === 0) {
    return console.log(`   📭 "${queueName}" queue is empty.`);
  }
  console.log(`\n   📋 "${queueName}" queue (${items.length} pending):`);
  for (const evt of items) {
    const num = evt.seqNo ? `#${evt.seqNo}` : `#?`;
    const desc = evt.data?.rule ? `Rule: "${evt.data.rule}" → tool: ${evt.data.tool}` : `${evt.source}/${evt.type}`;
    const summary = evt.data?.originalEvent?.data?.card?.name
      ? ` — card: "${evt.data.originalEvent.data.card.name}"`
      : evt.data?.text
        ? ` — "${evt.data.text.slice(0, 60)}"`
        : evt.card?.name
          ? ` — card: "${evt.card.name}"`
          : "";
    console.log(`   ${num}) ${desc}${summary}`);
  }
  console.log(``);
}

// Marks an item as cleared by its sequential #
// Example: "done 3" clears priority item #3
function cmdDone(args) {
  if (!args || !/^\d+$/.test(args)) {
    return console.log(`   ⚠️  Usage: done <number>. Type "ls" to see item numbers.`);
  }
  const seqNo = parseInt(args, 10);
  const found = markClearedByNumber(seqNo);
  if (found) {
    console.log(`   ✅ Item #${seqNo} marked as cleared.`);
  } else {
    console.log(`   ⚠️  No item found with #${seqNo}. Type "ls" to see items.`);
  }
}

// Prints the full JSON of a queue item for inspection
// Useful for debugging: see all event fields, timestamps, flags
function cmdPeek(args) {
  if (!args || !/^\d+$/.test(args)) {
    return console.log(`   ⚠️  Usage: peek <number>. Type "ls" to see item numbers.`);
  }
  const seqNo = parseInt(args, 10);
  const evt = findEventByNumber(seqNo);
  if (!evt) return console.log(`   ⚠️  No item found with #${seqNo}.`);
  console.log(`\n   📄 Item #${seqNo}:`);
  console.log(`      ${JSON.stringify(evt, null, 2).split("\n").join("\n      ")}`);
  console.log(``);
}

// Shows today's task list from tasks/YYYY-MM-DD.md
// Tasks are also shown in the periodic reminder
function cmdTasks() {
  const tasks = loadTaskList();
  if (!tasks) return console.log(`   📭 No task file for today. Create tasks/YYYY-MM-DD.md`);
  console.log(`\n   📋 TODAY'S TASKS:\n`);
  for (const line of tasks.split("\n").filter((l) => l.trim())) {
    console.log(`      ${line}`);
  }
  console.log(``);
}

// DANGER: removes ALL items from a queue. Use with care.
function cmdClear(args) {
  const queueName = args || "misc_notifications";
  const items = readEvents(queueName);
  if (items.length === 0) return console.log(`   "${queueName}" queue already empty.`);
  clearEvents(queueName);
  console.log(`   🗑️  Cleared all ${items.length} items from "${queueName}".`);
}

function cmdReminder() {
  printPriorityReminder();
}

rl.prompt();

// Readline input handler — parses the command + arguments from each line
rl.on("line", (input) => {
  const trimmed = input.trim();
  if (!trimmed) {
    rl.prompt();
    return;
  }

  // Split on whitespace: first word = command, rest = arguments
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1).join(" ");

  if (cmd in COMMANDS) {
    COMMANDS[cmd].fn(args);
  } else {
    console.log(`   Unknown command "${cmd}". Type "help" for available commands.`);
  }

  rl.prompt();
});

rl.on("close", () => {
  console.log("\n   Interactive terminal closed.");
  process.exit(0);
});

export default app;
