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
import { trelloHandler } from "./handlers/trello.js";
import { gmailHandler } from "./handlers/gmail.js";
import { enqueueEvent, readEvents, clearEvent } from "./lib/event-queue.js";

const app = express();
const PORT = parseInt(process.env.WEBHOOK_PORT || "3199", 10);

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
  const pending = readEvents();
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

/* ── Start server ── */

app.listen(PORT, () => {
  console.log(`🌐 Webhook server listening on http://localhost:${PORT}`);
  console.log(`   Health:  http://localhost:${PORT}/health`);
  console.log(`   Events:  http://localhost:${PORT}/events`);
});

export default app;
