/**
 * Trello webhook handler
 *
 * Receives Trello webhook callbacks (POST) and webhook
 * configuration verification requests (HEAD).
 *
 * Logs all events and enqueues matching tool calls.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { enqueueEvent } from "../lib/event-queue.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, "..", "..", "..", "logs", "webhook");
const NOTIFY_DIR = path.resolve(__dirname, "..", "..", "..", "logs", "notifications", "trello");

function logError(msg) {
  const ts = new Date().toISOString();
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(path.join(LOG_DIR, `${ts.slice(0, 10)}.log`), `[${ts}] ERROR: ${msg}\n`);
}

function logVerbose(entry) {
  const ts = new Date().toISOString();
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(
    path.join(LOG_DIR, `${ts.slice(0, 10)}_verbose.log`),
    JSON.stringify({ ts, ...entry }) + "\n",
  );
}

function logNotification(data) {
  const ts = new Date().toISOString();
  const day = ts.slice(0, 10);
  fs.mkdirSync(NOTIFY_DIR, { recursive: true });
  fs.appendFileSync(
    path.join(NOTIFY_DIR, `${day}.jsonl`),
    JSON.stringify({ ts, source: "trello", type: data.action?.type || "unknown", data }) + "\n",
  );
}

/**
 * HEAD handler — Trello sends this to verify the webhook endpoint.
 */
export function trelloHandler(req, res) {
  const ts = new Date().toISOString();

  if (req.method === "HEAD") {
    console.log(`📡 [${ts}] Trello webhook verification (HEAD)`);
    logVerbose({ type: "head_verification", source: "trello" });
    return res.status(200).end();
  }

  // POST — actual event
  const body = req.body;

  if (!body) {
    logError("Empty body received from Trello webhook");
    return res.status(400).json({ error: "Empty body" });
  }

  const action = body.action;
  const model = body.model;

  console.log(`📡 [${ts}] Trello event: ${action?.type || "unknown"} on card "${action?.data?.card?.name || "?"}"`);

  logVerbose({ type: "webhook_received", source: "trello", action: action?.type, card: action?.data?.card?.name });

  // Log notification
  logNotification(body);

  // Check if this board is in our watch list
  const boardId = model?.id || action?.data?.board?.id;
  const watchedIds = (process.env.TRELLO_WEBHOOK_MODEL_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);

  if (watchedIds.length > 0 && boardId && !watchedIds.includes(boardId)) {
    console.log(`   → Board ${boardId} not in watch list, skipping`);
    return res.status(200).json({ status: "ignored", reason: "board_not_watched" });
  }

  // Enqueue as pending tool call
  const event = {
    source: "trello",
    type: action?.type || "unknown",
    data: action?.data || {},
    board: model?.name || action?.data?.board?.name,
    card: action?.data?.card,
    list: action?.data?.list,
    timestamp: action?.date || ts,
  };

  enqueueEvent(event);

  console.log(`   → Enqueued for agent processing`);

  res.status(200).json({ status: "received" });
}
