/**
 * Webhook Server — Express server on port 3199
 *
 * Receives push notifications from Trello and Gmail, logs them,
 * and enqueues pending tool calls for the Copilot agent to process.
 *
 * Endpoints:
 *   POST/HEAD /webhooks/trello     — Trello webhook callbacks
 *   POST/GET  /webhooks/gmail/push — Gmail Pub/Sub push notifications
 *   GET       /events              — Read pending events
 *   DELETE    /events/:id          — Clear a processed event
 *   GET       /health              — Health check
 *
 * Environment:
 *   WEBHOOK_PORT  (default 3199)
 *   WEBHOOK_BASE_URL — public URL for webhook registration
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
import { enqueueEvent, readEvents, clearEvent, markCleared } from "./lib/event-queue.js";

const app = express();
const PORT = parseInt(process.env.WEBHOOK_PORT || "3199", 10);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_LOG_DIR = path.resolve(__dirname, "..", "..", "logs", "tool_call");

/* ── Middleware ── */

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

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

/* ── Event queue ── */

app.get("/events", (req, res) => {
  const filterCleared = req.query.cleared === "false" ? { cleared: false } : undefined;
  const pending = readEvents(filterCleared);
  res.json({ count: pending.length, events: pending });
});

app.delete("/events/:id", (req, res) => {
  const removed = clearEvent(req.params.id);
  if (removed) {
    res.json({ status: "cleared", id: req.params.id });
  } else {
    res.status(404).json({ error: "Event not found" });
  }
});

// PATCH /events/:id — soft-delete (mark cleared without removing)
app.patch("/events/:id", (req, res) => {
  const marked = markCleared(req.params.id);
  if (marked) {
    res.json({ status: "marked_cleared", id: req.params.id });
  } else {
    res.status(404).json({ error: "Event not found" });
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

/* ── Live tool call tail in terminal ── */

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
    if (stat.size <= toolLogLastSize) return;
    const fd = fs.openSync(logFile, "r");
    const buf = Buffer.alloc(stat.size - toolLogLastSize);
    fs.readSync(fd, buf, 0, buf.length, toolLogLastSize);
    fs.closeSync(fd);
    toolLogLastSize = stat.size;
    const lines = buf.toString("utf8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      console.log(`   🔧 ${line}`);
    }
  } catch {
    // ignore
  }
}

// Poll every 2 seconds for new tool call log entries
setInterval(tailToolLog, 2000);

/* ── Start server ── */

app.listen(PORT, () => {
  console.log(`🌐 Webhook server listening on http://localhost:${PORT}`);
  console.log(`   Health:  http://localhost:${PORT}/health`);
  console.log(`   Events:  http://localhost:${PORT}/events`);
  console.log(`   Tool logs: http://localhost:${PORT}/tool-logs`);
  console.log(`   🔧 Live tool call tail active (polls every 2s)`);
});

export default app;
