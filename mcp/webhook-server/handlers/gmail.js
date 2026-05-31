/**
 * Gmail push notification handler
 *
 * Receives Gmail Pub/Sub push notifications and enqueues
 * new message events for the agent to process.
 *
 * Endpoints:
 *   POST /webhooks/gmail/push — Gmail Pub/Sub push delivery
 *   GET  /webhooks/gmail/push — Verification endpoint
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { enqueueEvent } from "../lib/event-queue.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, "..", "..", "..", "logs", "webhook");
const NOTIFY_DIR = path.resolve(__dirname, "..", "..", "..", "logs", "notifications", "gmail");

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
    JSON.stringify({ ts, source: "gmail", type: "new_message", data }) + "\n",
  );
}

/**
 * Verify the Gmail Pub/Sub push notification payload.
 * Gmail sends a Cloud Pub/Sub message wrapper:
 * {
 *   message: {
 *     data: base64-encoded JSON string,
 *     messageId: string,
 *     publishTime: string
 *   },
 *   subscription: string
 * }
 */
export function gmailHandler(req, res) {
  const ts = new Date().toISOString();

  if (req.method === "GET") {
    // Some push systems send a GET to verify
    console.log(`📧 [${ts}] Gmail push verification (GET)`);
    return res.status(200).send("OK");
  }

  const body = req.body;

  if (!body || !body.message) {
    console.log(`⚠️  [${ts}] Gmail push — unexpected body format`);
    logVerbose({ type: "invalid_body", source: "gmail", body: JSON.stringify(body).slice(0, 500) });
    return res.status(400).json({ error: "Expected Pub/Sub message format" });
  }

  // Decode the Pub/Sub message data
  let decoded;
  try {
    const json = Buffer.from(body.message.data, "base64").toString("utf8");
    decoded = JSON.parse(json);
  } catch (err) {
    console.log(`⚠️  [${ts}] Gmail push — failed to decode: ${err.message}`);
    logVerbose({ type: "decode_error", source: "gmail", error: err.message });
    return res.status(200).json({ status: "decode_failed" });
  }

  const { emailAddress, historyId } = decoded;

  console.log(`📧 [${ts}] Gmail push: historyId=${historyId}, email=${emailAddress || "?"}`);

  logVerbose({
    type: "push_received",
    source: "gmail",
    historyId,
    emailAddress,
    messageId: body.message.messageId,
  });

  // Log notification
  logNotification({ emailAddress, historyId, messageId: body.message.messageId });

  // Enqueue event
  const event = {
    source: "gmail",
    type: "new_message",
    data: {
      emailAddress,
      historyId,
      messageId: body.message.messageId,
      publishTime: body.message.publishTime,
    },
  };

  enqueueEvent(event);

  console.log(`   → Enqueued for agent processing`);

  res.status(200).json({ status: "received" });
}
