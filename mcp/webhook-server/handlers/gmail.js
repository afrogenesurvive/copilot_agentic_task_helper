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
import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { enqueueEvent } from "../lib/event-queue.js";
import { dispatch } from "../lib/tool-dispatch.js";
import { sanitizeObject } from "../../../scripts/sanitize.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, "..", "..", "..", "logs", "webhook");
const NOTIFY_DIR = path.resolve(__dirname, "..", "..", "..", "logs", "notifications", "gmail");

function logVerbose(entry) {
  const ts = new Date().toISOString();
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(path.join(LOG_DIR, `${ts.slice(0, 10)}_verbose.log`), JSON.stringify({ ts, ...entry }) + "\n");
}

function logNotification(entry) {
  const ts = entry.ts || new Date().toISOString();
  const day = ts.slice(0, 10);
  fs.mkdirSync(NOTIFY_DIR, { recursive: true });
  fs.appendFileSync(path.join(NOTIFY_DIR, `${day}.jsonl`), JSON.stringify(entry) + "\n");
}

function getGmailAuth() {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) return null;
  const oauth2 = new OAuth2Client(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  return oauth2;
}

async function fetchMessageDetails(historyId) {
  try {
    const auth = getGmailAuth();
    if (!auth) {
      console.error("   ⚠️  No Gmail auth available");
      return {};
    }
    const gmail = google.gmail({ version: "v1", auth });
    const userId = process.env.GMAIL_USER || "me";

    // The push notification historyId is the state AFTER the change.
    // To find the message that triggered it, we query history BEFORE this ID.
    // Try several offsets in case the exact history boundary differs.
    let msgId = null;
    for (const offset of [0, -1, -5, -10]) {
      const startId = typeof historyId === "number" || typeof historyId === "string" ? String(Number(historyId) + offset) : String(historyId);
      if (Number(startId) <= 0) continue;

      const history = await gmail.users.history.list({
        userId,
        startHistoryId: startId,
        historyTypes: ["messageAdded"],
      });

      const added = history.data.history || [];
      msgId = added[0]?.messagesAdded?.[0]?.message?.id;
      if (msgId) break;
    }

    if (!msgId) {
      console.error("   ⚠️  No message found in history for", historyId);
      return {};
    }

    // Fetch the message
    const msg = await gmail.users.messages.get({
      userId,
      id: msgId,
      format: "metadata",
      metadataHeaders: ["From", "To", "Subject", "Date"],
    });
    const headers = msg.data.payload?.headers || [];
    const from = headers.find((h) => h.name === "From")?.value;
    const to = headers.find((h) => h.name === "To")?.value;
    const subject = headers.find((h) => h.name === "Subject")?.value;
    const date = headers.find((h) => h.name === "Date")?.value;

    // Determine direction: if the "From" matches our configured user, it was sent by us
    const configuredUser = process.env.GMAIL_USER || "me";
    const direction = from && from.includes(configuredUser.replace(/@.*/, "")) ? "sent" : "received";

    console.error(`   → Fetched: "${subject || "(no subject)"}" from ${from || "?"} (${direction})`);
    return { from, to, subject, date, snippet: msg.data.snippet, messageId: msgId, direction };
  } catch (err) {
    console.error(`   ⚠️  fetchMessageDetails error: ${err.message}`);
    return {};
  }
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
export async function gmailHandler(req, res) {
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

  // Fetch message details from Gmail API for richer logging
  console.log(`   → Fetching message details...`);
  const details = await fetchMessageDetails(historyId);

  // Log notification (trimmed to specified fields, sanitized)
  const direction = details.direction || "received";
  const entry = {
    ts,
    source: "gmail",
    type: "new_message",
    data: sanitizeObject({
      direction,
      from: details.from,
      to: details.to,
      subject: details.subject,
      date: details.date,
      snippet: details.snippet,
    }),
  };
  // Strip undefined fields
  Object.keys(entry.data).forEach((k) => entry.data[k] === undefined && delete entry.data[k]);
  logNotification(entry);
  const action = direction === "sent" ? "to" : "from";
  console.log(`   → Logged: ${entry.data.subject ? `"${entry.data.subject}"` : "(no subject)"} ${action} ${entry.data[action] || "?"}`);

  // Enqueue event (sanitized)
  const event = {
    source: "gmail",
    type: "new_message",
    data: sanitizeObject({
      direction,
      emailAddress,
      historyId,
      messageId: body.message.messageId,
      publishTime: body.message.publishTime,
      ...(details.from && { from: details.from }),
      ...(details.to && { to: details.to }),
      ...(details.subject && { subject: details.subject }),
      ...(details.messageId && { gmailMessageId: details.messageId }),
    }),
  };

  enqueueEvent(event);

  // Check if any tool dispatch rules match
  dispatch(event);

  console.log(`   → Enqueued for agent processing`);

  res.status(200).json({ status: "received" });
}
