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
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { trelloHandler } from "./handlers/trello.js";
import { gmailHandler } from "./handlers/gmail.js";
import { drivePushHandler } from "./handlers/drive.js";
import { calendarPushHandler } from "./handlers/calendar.js";
import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
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
import { allTools } from "../../shared/tool-manifest.js";

const app = express();

// Trust proxy configuration.
// By default trusts the first hop (enough for a single tunnel like ngrok).
// For production, set TRUST_PROXY to a comma-separated list of IPs/CIDR ranges:
//   "1"                     — trust the first hop (default)
//   "loopback"              — trust 127.0.0.1/8, ::1
//   "uniquelocal"           — trust private IP ranges (RFC 1918)
//   "173.245.48.0/20,103.21.244.0/22"  — Cloudflare IP ranges
//   "false"                 — disable (not recommended behind a tunnel)
app.set("trust proxy", process.env.TRUST_PROXY || 1);

const PORT = parseInt(process.env.WEBHOOK_PORT || "3199", 10);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_LOG_DIR = path.resolve(__dirname, "..", "..", "logs", "tool_call");
const TASKS_DIR = path.resolve(__dirname, "..", "..", "tasks");

/* ── Middleware ──
 *
 * Standard Express middleware stack:
 *   - CORS: restricted to known origins (CORS_ORIGINS env var, comma-separated)
 *   - Security headers: set manually (no helmet dependency)
 *   - HTTPS redirect: when behind a proxy terminating TLS
 *   - JSON body parser: parses Trello/Gmail webhook payloads (limit 1MB)
 *   - URL-encoded: handles form data if needed
 *   - Request logger: shows every incoming request in the terminal for debugging
 *   - Rate limit: 100 requests per minute per IP
 */

const CORS_ORIGINS = (process.env.CORS_ORIGINS || "http://localhost:3199").split(",").map((s) => s.trim());
app.use(cors({ origin: CORS_ORIGINS, credentials: true }));

// ── Security headers (no helmet dependency) ──
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "0"); // modern browsers ignore this; set for legacy
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

// ── HTTPS redirect when behind a proxy that terminates TLS ──
app.use((req, res, next) => {
  const proto = req.headers["x-forwarded-proto"] || "";
  if (proto === "http") {
    return res.redirect(301, `https://${req.headers["host"]}${req.url}`);
  }
  next();
});

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// ── API token authentication middleware ──
// All endpoints except /health, /webhooks/* are protected.
// Clients must send:  Authorization: Bearer <WEBHOOK_API_TOKEN>
const API_TOKEN = process.env.WEBHOOK_API_TOKEN || "";
function requireAuth(req, res, next) {
  // Skip auth for webhook callbacks and health check
  if (req.path === "/health" || req.path.startsWith("/webhooks/")) {
    return next();
  }
  if (!API_TOKEN) {
    // No token configured — skip auth check (development mode)
    return next();
  }
  const header = req.headers["authorization"];
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid Authorization header. Use: Bearer <token>" });
  }
  const token = header.slice(7);
  // Constant-time comparison to prevent timing attacks
  if (token.length !== API_TOKEN.length) {
    return res.status(401).json({ error: "Invalid token" });
  }
  if (!crypto.timingSafeEqual(Buffer.from(token), Buffer.from(API_TOKEN))) {
    return res.status(401).json({ error: "Invalid token" });
  }
  next();
}
app.use(requireAuth);

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

/* ── Google Drive push notifications ── */

app.post("/webhooks/drive/push", drivePushHandler);

/* ── Google Calendar push notifications ── */

app.post("/webhooks/calendar/push", calendarPushHandler);

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

/**
 * Parse today's task file into structured task objects with line indices.
 * @returns {Array} [{ lineIndex, checked, text, raw }]
 */
function readTasksDetailed() {
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
  } catch {
    return [];
  }
}

/**
 * Mark a task as completed by its 1-based index among all tasks.
 * Returns the lineIndex if found, or -1 if not found.
 * @param {number} taskNum — 1-based index of the task
 * @returns {number} The line index of the marked task, or -1
 */
function markTaskDoneByNumber(taskNum) {
  try {
    const tasks = readTasksDetailed();
    const idx = taskNum - 1;
    if (idx < 0 || idx >= tasks.length) return -1;

    const task = tasks[idx];
    if (task.checked) return -2; // already done

    const today = new Date().toISOString().slice(0, 10);
    const taskFile = path.join(TASKS_DIR, `${today}.md`);
    const content = fs.readFileSync(taskFile, "utf8");
    const lines = content.split("\n");

    lines[task.lineIndex] = lines[task.lineIndex].replace("- [ ]", "- [x]");
    fs.writeFileSync(taskFile, lines.join("\n"), "utf8");

    return task.lineIndex;
  } catch {
    return -1;
  }
}

function printPriorityReminder() {
  const pending = getPriorityPending();
  const tasks = readTasksDetailed();
  const hasTasks = tasks.length > 0;
  if (pending.length === 0 && !hasTasks) return;

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

  // Non-queue task list (numbered)
  if (hasTasks) {
    const pendingTasks = tasks.filter((t) => !t.checked);
    console.log(`\n   📋 TODAY'S TASKS (${pendingTasks.length} pending / ${tasks.length} total):\n`);
    tasks.forEach((t, i) => {
      const num = i + 1;
      const status = t.checked ? "✅" : "⬜";
      console.log(`   ${num}) ${status} ${t.text}`);
    });
    if (pendingTasks.length > 0) {
      console.log(`\n   💡 Type "done-task <num>" or "done task <num>" to mark done`);
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
 *   help                 — Show available commands
 *   ls [queue]           — List pending items with seq numbers
 *   done <number>        — Mark an item as cleared by its #
 *   done task <number>   — Mark a task as completed by its number
 *   execute <number>     — Process a queue event via DeepSeek inline
 *   execute task <number>— Process a task via DeepSeek inline
 *   peek <number>        — Show full JSON details of an item by its #
 *   tasks                — Show today's task list from tasks/YYYY-MM-DD.md
 *                        (numbered, with ✅/⬜ status)
 *   clear [queue]        — Clear all items from a queue (caution)
 *   reminder             — Force print the reminder now
 */

let rl = null;

function setupReadline() {
  import("readline").then((readline) => {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "webhook> ",
      terminal: true,
    });

    // Command registry — maps command names to handler functions and help text
    const COMMANDS = {
      help: { desc: "Show this help", fn: cmdHelp },
      ls: { desc: "List pending items: ls [priority|misc_notifications]", fn: cmdList },
      done: { desc: "Mark item cleared by #: done <seqNo> | done task <taskNum>", fn: cmdDone },
      execute: { desc: "Process an event via DeepSeek inline: execute <seqNo>", fn: cmdExecute },
      "execute-task": { desc: "Process a task via DeepSeek inline: execute-task <taskNum>", fn: cmdExecuteTask },
      "done-task": { desc: "Mark a task done by number: done-task <taskNum>", fn: cmdDoneTask },
      peek: { desc: "Show full details of an item by its #", fn: cmdPeek },
      tasks: { desc: "Show today's task list", fn: cmdTasks },
      clear: { desc: "Clear all items from a queue (caution): clear [priority|misc]", fn: cmdClear },
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

    // Queue name aliases so you can type "clear misc" instead of "clear misc_notifications"
    function resolveQueueAlias(name) {
      if (!name) return null;
      const aliases = {
        misc: "misc_notifications",
        notifications: "misc_notifications",
        priority: "priority",
        pri: "priority",
      };
      return aliases[name.toLowerCase()] || name;
    }

    function cmdList(args) {
      const queueName = resolveQueueAlias(args) || "priority";
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

    function cmdTasks() {
      const tasks = readTasksDetailed();
      if (tasks.length === 0) return console.log(`   📭 No task file for today. Create tasks/YYYY-MM-DD.md`);
      console.log(`\n   📋 TODAY'S TASKS:\n`);
      tasks.forEach((t, i) => {
        const num = i + 1;
        const status = t.checked ? "✅" : "⬜";
        console.log(`   ${num}) ${status} ${t.text}`);
      });
      console.log(`\n   💡 Type "done-task <num>" to mark a task done`);
      console.log(`   💡 Type "execute-task <num>" to process a task via DeepSeek`);
      console.log(``);
    }

    function cmdClear(args) {
      const queueName = resolveQueueAlias(args) || "misc_notifications";
      const items = readEvents(queueName);
      if (items.length === 0) return console.log(`   "${queueName}" queue already empty.`);
      clearEvents(queueName);
      console.log(`   🗑️  Cleared all ${items.length} items from "${queueName}".`);
    }

    // ── Tool allowlist (same as agent runner) ──
    const EXECUTE_ALLOWLIST = new Set([
      "trello_add_comment",
      "trello_get_card",
      "trello_list_cards",
      "trello_get_lists",
      "trello_get_card_actions",
      "gmail_list_messages",
      "gmail_get_message",
    ]);

    /** Build event context for DeepSeek */
    function buildEventContext(event) {
      const lines = [`New ${event.source}/${event.type} event:`];
      if (event.data?.text) lines.push(`Message: "${event.data.text.slice(0, 500)}"`);
      if (event.data?.rule) {
        lines.push(`Matched rule: "${event.data.rule}"`);
        lines.push(`Requested tool: ${event.data.tool}`);
      }
      if (event.data?.originalEvent?.data?.card?.id) {
        lines.push(`Card ID (Trello hex ID): ${event.data.originalEvent.data.card.id}`);
        if (event.data.originalEvent.data.card.name) lines.push(`Card name: "${event.data.originalEvent.data.card.name}"`);
      }
      if (event.data?.originalEvent?.data?.list?.id) {
        lines.push(`List ID: ${event.data.originalEvent.data.list.id}`);
        if (event.data.originalEvent.data.list.name) lines.push(`List name: "${event.data.originalEvent.data.list.name}"`);
      }
      if (event.data?.originalEvent?.data?.board?.id) {
        lines.push(`Board ID: ${event.data.originalEvent.data.board.id}`);
        if (event.data.originalEvent.data.board.name) lines.push(`Board name: "${event.data.originalEvent.data.board.name}"`);
      }
      if (event.data?.subject) lines.push(`Subject: "${event.data.subject}"`);
      if (event.data?.direction) lines.push(`Direction: ${event.data.direction}`);
      return lines.join("\n");
    }

    /** Map tool manifest to OpenAI function format */
    function mapTools(tools) {
      return tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
    }

    /** Get authenticated Gmail client */
    function getGmailClient() {
      const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
      if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) return null;
      const oauth2 = new OAuth2Client(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
      oauth2.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
      return google.gmail({ version: "v1", auth: oauth2 });
    }

    /** Execute a validated tool call against Trello/Gmail API */
    async function executeTool(toolName, args) {
      const { TRELLO_KEY, TRELLO_TOKEN } = process.env;
      const trelloUrl = (path, params = {}) =>
        `https://api.trello.com/1${path}?${new URLSearchParams({ key: TRELLO_KEY, token: TRELLO_TOKEN, ...params })}`;

      switch (toolName) {
        case "trello_add_comment": {
          const res = await fetch(trelloUrl(`/cards/${args.cardId}/actions/comments`, { text: args.text }), { method: "POST" });
          if (!res.ok) throw new Error(`Trello API ${res.status}: ${await res.text()}`);
          return { ok: true, tool: toolName, result: "Comment added" };
        }
        case "trello_get_card": {
          const res = await fetch(trelloUrl(`/cards/${args.cardId}`, { fields: "name,desc,idList,idBoard,due" }));
          if (!res.ok) throw new Error(`Trello API ${res.status}: ${await res.text()}`);
          return { ok: true, tool: toolName, result: await res.json() };
        }
        case "trello_list_cards": {
          const res = await fetch(trelloUrl(`/lists/${args.listId}/cards`, { fields: "name,id,idList,due" }));
          if (!res.ok) throw new Error(`Trello API ${res.status}: ${await res.text()}`);
          return { ok: true, tool: toolName, result: await res.json() };
        }
        case "trello_get_lists": {
          const res = await fetch(trelloUrl(`/boards/${args.boardId}/lists`, { fields: "name,id" }));
          if (!res.ok) throw new Error(`Trello API ${res.status}: ${await res.text()}`);
          return { ok: true, tool: toolName, result: await res.json() };
        }
        case "trello_get_card_actions": {
          const res = await fetch(trelloUrl(`/cards/${args.cardId}/actions`, { filter: args.filter || "commentCard" }));
          if (!res.ok) throw new Error(`Trello API ${res.status}: ${await res.text()}`);
          return { ok: true, tool: toolName, result: await res.json() };
        }
        case "gmail_list_messages": {
          const gmail = getGmailClient();
          if (!gmail) throw new Error("Gmail auth not configured (check GMAIL_CLIENT_ID/TOKEN in .env)");
          const userId = process.env.GMAIL_USER || "me";
          const res = await gmail.users.messages.list({ userId, q: args.query || "", maxResults: args.maxResults || 10 });
          return { ok: true, tool: toolName, result: res.data.messages || [] };
        }
        case "gmail_get_message": {
          const gmail = getGmailClient();
          if (!gmail) throw new Error("Gmail auth not configured (check GMAIL_CLIENT_ID/TOKEN in .env)");
          const userId = process.env.GMAIL_USER || "me";
          const res = await gmail.users.messages.get({
            userId,
            id: args.id,
            format: args.format || "metadata",
            metadataHeaders: ["From", "To", "Subject", "Date"],
          });
          return { ok: true, tool: toolName, result: res.data };
        }
        default:
          throw new Error(`Tool "${toolName}" not supported in execute flow`);
      }
    }

    /** Execute a queue event via DeepSeek inline */
    async function cmdExecute(args) {
      if (!args || !/^\d+$/.test(args)) {
        return console.log(`   ⚠️  Usage: execute <number>. Type "ls" to see item numbers.`);
      }

      const seqNo = parseInt(args, 10);
      const event = findEventByNumber(seqNo);
      if (!event) return console.log(`   ⚠️  No item found with #${seqNo}. Type "ls" to see items.`);
      if (event.cleared) return console.log(`   ⚠️  Item #${seqNo} is already cleared.`);

      const apiKey = process.env.DEEPSEEK_API_KEY;
      if (!apiKey) return console.log(`   ❌ DEEPSEEK_API_KEY not set in .env`);

      console.log(`\n   🤖 [EXECUTE] Processing #${seqNo}: ${event.source}/${event.type}`);
      console.log(`   📤 [EXECUTE] Sending to DeepSeek...`);

      try {
        const eventContext = buildEventContext(event);
        const tools = mapTools(allTools);

        const response = await fetch("https://api.deepseek.com/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: "deepseek-chat",
            messages: [
              {
                role: "system",
                content:
                  "You are an autonomous business workflow agent. Your job is to process incoming events and decide what action to take. Choose ONE tool and provide ALL required parameters. Respond only with a tool call — no explanatory text.",
              },
              { role: "user", content: eventContext },
            ],
            tools,
            tool_choice: "auto",
            temperature: 0.1,
          }),
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`DeepSeek API ${response.status}: ${errText}`);
        }

        const data = await response.json();
        const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
        if (!toolCall) {
          const reply = data.choices?.[0]?.message?.content || "(empty)";
          console.log(`   ⚠️ [EXECUTE] No tool call returned — model said: "${reply.slice(0, 200)}"`);
          console.log(`   ⏭️  [EXECUTE] Marking #${seqNo} as skipped.`);
          markClearedByNumber(seqNo);
          return;
        }

        let toolArgs;
        try {
          toolArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          console.log(`   ❌ [EXECUTE] Invalid JSON in tool arguments: "${toolCall.function.arguments}"`);
          return;
        }

        const toolName = toolCall.function.name;
        console.log(`   🤖 [EXECUTE] DeepSeek chose: ${toolName}(${JSON.stringify(toolArgs)})`);

        // Validate against allowlist
        if (!EXECUTE_ALLOWLIST.has(toolName)) {
          console.log(`   🛑 [EXECUTE] Tool "${toolName}" is not on the allowlist. Skipping.`);
          markClearedByNumber(seqNo);
          return;
        }

        // Execute
        console.log(`   🛠️  [EXECUTE] Executing ${toolName}...`);
        const result = await executeTool(toolName, toolArgs);

        if (result.ok) {
          console.log(`   ✅ [EXECUTE] ${toolName} succeeded`);
          if (result.result && typeof result.result === "object") {
            const summary = JSON.stringify(result.result).slice(0, 300);
            console.log(`   📄 [EXECUTE] Result: ${summary}`);
          }
        }

        markClearedByNumber(seqNo);
        console.log(`   ✅ [EXECUTE] Item #${seqNo} processed and cleared.`);
      } catch (err) {
        console.log(`   ❌ [EXECUTE] Error: ${err.message}`);
      }
    }

    function cmdReminder() {
      printPriorityReminder();
    }

    /** Mark a task done by 1-based number */
    function cmdDoneTask(args) {
      if (!args || !/^\d+$/.test(args)) {
        return console.log(`   ⚠️  Usage: done-task <taskNum>. Type "tasks" to see task numbers.`);
      }
      const taskNum = parseInt(args, 10);
      const result = markTaskDoneByNumber(taskNum);
      if (result === -1) {
        console.log(`   ⚠️  No task found with #${taskNum}. Type "tasks" to see tasks.`);
      } else if (result === -2) {
        console.log(`   ⚠️  Task #${taskNum} is already done.`);
      } else {
        console.log(`   ✅ Task #${taskNum} marked as done.`);
      }
    }

    /** Execute a task via DeepSeek inline (like cmdExecute but for tasks) */
    async function cmdExecuteTask(args) {
      if (!args || !/^\d+$/.test(args)) {
        return console.log(`   ⚠️  Usage: execute-task <taskNum>. Type "tasks" to see task numbers.`);
      }

      const taskNum = parseInt(args, 10);
      const tasks = readTasksDetailed();
      const idx = taskNum - 1;
      if (idx < 0 || idx >= tasks.length) {
        return console.log(`   ⚠️  No task found with #${taskNum}. Type "tasks" to see tasks.`);
      }

      const task = tasks[idx];
      if (task.checked) {
        return console.log(`   ⚠️  Task #${taskNum} is already done.`);
      }

      const apiKey = process.env.DEEPSEEK_API_KEY;
      if (!apiKey) return console.log(`   ❌ DEEPSEEK_API_KEY not set in .env`);

      console.log(`\n   🤖 [EXECUTE-TASK] Processing task #${taskNum}: "${task.text}"`);
      console.log(`   📤 [EXECUTE-TASK] Sending to DeepSeek...`);

      try {
        const taskContext = [
          `Task to complete: "${task.text}"`,
          "",
          "You are a daily task automation agent. Use available tools to make progress on this task.",
          "If the task requires actions you can't take (file edits, deployments, environment changes), reply with '[skip]' to mark it as not actionable by automation.",
          "If you can make progress (read queues, send notifications, comment on cards), do so now.",
        ].join("\n");

        const tools = mapTools(allTools);

        const response = await fetch("https://api.deepseek.com/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: "deepseek-chat",
            messages: [
              {
                role: "system",
                content:
                  "You are an autonomous task automation agent. Your job is to make progress on daily tasks. If you can take action with available tools, do so. Otherwise respond with '[skip]'.",
              },
              { role: "user", content: taskContext },
            ],
            tools,
            tool_choice: "auto",
            temperature: 0.1,
          }),
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`DeepSeek API ${response.status}: ${errText}`);
        }

        const data = await response.json();
        const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
        if (!toolCall) {
          const reply = data.choices?.[0]?.message?.content || "(empty)";
          const isSkip = reply.toLowerCase().includes("[skip]");
          console.log(`   ⚠️  [EXECUTE-TASK] No tool call returned. Model said: "${reply.slice(0, 200)}"`);
          if (isSkip) {
            markTaskDoneByNumber(taskNum);
            console.log(`   ⏭️  [EXECUTE-TASK] Task #${taskNum} marked as not automatable.`);
          }
          return;
        }

        let toolArgs;
        try {
          toolArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          console.log(`   ❌ [EXECUTE-TASK] Invalid JSON in tool arguments: "${toolCall.function.arguments}"`);
          return;
        }

        const toolName = toolCall.function.name;
        console.log(`   🤖 [EXECUTE-TASK] DeepSeek chose: ${toolName}(${JSON.stringify(toolArgs)})`);

        // Validate against allowlist
        if (!EXECUTE_ALLOWLIST.has(toolName)) {
          console.log(`   🛑 [EXECUTE-TASK] Tool "${toolName}" is not on the allowlist. Skipping.`);
          markTaskDoneByNumber(taskNum);
          return;
        }

        // Execute
        console.log(`   🛠️  [EXECUTE-TASK] Executing ${toolName}...`);
        const result = await executeTool(toolName, toolArgs);

        if (result.ok) {
          console.log(`   ✅ [EXECUTE-TASK] ${toolName} succeeded`);
          if (result.result && typeof result.result === "object") {
            const summary = JSON.stringify(result.result).slice(0, 300);
            console.log(`   📄 [EXECUTE-TASK] Result: ${summary}`);
          }
        }

        markTaskDoneByNumber(taskNum);
        console.log(`   ✅ [EXECUTE-TASK] Task #${taskNum} processed and marked done.`);
      } catch (err) {
        console.log(`   ❌ [EXECUTE-TASK] Error: ${err.message}`);
      }
    }

    rl.prompt();

    rl.on("line", (input) => {
      const trimmed = input.trim();
      if (!trimmed) {
        rl.prompt();
        return;
      }

      const parts = trimmed.split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const second = parts[1]?.toLowerCase();
      const args = parts.slice(1).join(" ");

      // Support compound commands like "execute task <N>" and "done task <N>"
      if (second === "task" && COMMANDS[`${cmd}-task`]) {
        COMMANDS[`${cmd}-task`].fn(parts.slice(2).join(" "));
      } else if (cmd in COMMANDS) {
        COMMANDS[cmd].fn(args);
      } else {
        console.log(`   Unknown command "${cmd}". Type "help" for available commands.`);
      }

      rl.prompt();
    });

    rl.on("close", () => {
      console.log("\n   Interactive terminal closed.");
      // Don't call process.exit() — under nohup stdin EOF would kill the server.
      // The server keeps running; HTTP endpoints still work.
    });
  });
}

if (process.stdin.isTTY) {
  setupReadline();
} else {
  console.log("   💬 No TTY stdin — interactive terminal disabled (running under nohup/background)");
}

export default app;
