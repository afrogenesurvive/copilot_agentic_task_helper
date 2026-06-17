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
const RAW_DIR = path.resolve(LOG_DIR, "raw");
const NOTIFY_DIR = path.resolve(__dirname, "..", "..", "..", "logs", "notifications", "gmail");

/**
 * Log the full raw webhook body before any sanitization or processing.
 * Provides a forensic audit trail in logs/webhook/raw/YYYY-MM-DD.jsonl.
 */
function logRawBody(source, body) {
  const ts = new Date().toISOString();
  const day = ts.slice(0, 10);
  const entry = {
    ts,
    source,
    body: typeof body === "object" ? body : { raw: String(body) },
  };
  try {
    fs.mkdirSync(RAW_DIR, { recursive: true });
    fs.appendFileSync(path.join(RAW_DIR, `${day}.jsonl`), JSON.stringify(entry) + "\n");
  } catch (err) {
    console.error(`   ❌ [RAW] Failed to log raw body: ${err.message}`);
  }
}

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
      console.error("   ⚠️  [GMAIL] No Gmail auth available");
      return {};
    }
    const gmail = google.gmail({ version: "v1", auth });
    const userId = process.env.GMAIL_USER || "me";

    // The push notification historyId is the Gmail history state AFTER the change.
    // To find the exact message that triggered it, we query history at several
    // offsets before this ID (0, -1, -5, -10) because the push notification
    // doesn't include the message ID directly — just the history state.
    // Try each offset until we find a newly added message.
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
      console.error("   ⚠️  [GMAIL] No message found in history");
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

    // Determine direction: did WE send this, or did someone else?
    // If the "From" header contains our configured email username, it was sent by us.
    // This helps separate outbound replies from incoming customer messages.
    const configuredUser = process.env.GMAIL_USER || "me";
    const direction = from && from.includes(configuredUser.replace(/@.*/, "")) ? "sent" : "received";

    console.error(`   📧 [GMAIL] Fetched: "${subject || "(no subject)"}" from ${from || "?"} (${direction})`);
    return { from, to, subject, date, snippet: msg.data.snippet, messageId: msgId, direction };
  } catch (err) {
    console.error(`   ❌ [GMAIL] fetchMessageDetails: ${err.message}`);
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
    console.log(`📧 [GMAIL] Push verification (GET)`);
    return res.status(200).send("OK");
  }

  const body = req.body;

  if (!body || !body.message) {
    console.log(`⚠️  [GMAIL] Unexpected body format`);
    logVerbose({ type: "invalid_body", source: "gmail", body: JSON.stringify(body).slice(0, 500) });
    // Still dump raw body for forensic audit even if unexpected format
    if (body) logRawBody("gmail", body);
    return res.status(400).json({ error: "Expected Pub/Sub message format" });
  }

  // Dump raw webhook body for forensic audit (before any sanitization)
  logRawBody("gmail", body);

  // Gmail Cloud Pub/Sub sends push notifications with base64-encoded JSON.
  // The decoded payload contains { emailAddress, historyId }.
  // The historyId lets us query Gmail API for the actual message details.
  let decoded;
  try {
    const json = Buffer.from(body.message.data, "base64").toString("utf8");
    decoded = JSON.parse(json);
  } catch (err) {
    console.log(`⚠️  [GMAIL] Failed to decode push: ${err.message}`);
    logVerbose({ type: "decode_error", source: "gmail", error: err.message });
    return res.status(200).json({ status: "decode_failed" });
  }

  const { emailAddress, historyId } = decoded;

  console.log(`📧 [GMAIL] Push from ${emailAddress || "?"}`);

  logVerbose({
    type: "push_received",
    source: "gmail",
    historyId,
    emailAddress,
    messageId: body.message.messageId,
  });

  // Fetch message details from Gmail API for richer logging
  console.log(`   📧 [GMAIL] Fetching message details...`);
  const details = await fetchMessageDetails(historyId);

  // Log notification (trimmed to specified fields, sanitized)
  const direction = details.direction || "received";
  const entry = {
    ts,
    source: "gmail",
    type: "new_message",
    data: sanitizeObject(
      {
        direction,
        from: details.from,
        to: details.to,
        subject: details.subject,
        date: details.date,
        snippet: details.snippet,
      },
      { auditSource: "webhook/gmail" },
    ),
  };
  // Strip undefined fields
  Object.keys(entry.data).forEach((k) => entry.data[k] === undefined && delete entry.data[k]);
  logNotification(entry);
  const action = direction === "sent" ? "to" : "from";
  console.log(
    `   📧 [GMAIL] ${entry.data.direction === "sent" ? "→ Sent: " : "← Received: "}"${entry.data.subject || "(no subject)"}" ${entry.data.direction === "sent" ? "to" : "from"} ${entry.data[action] || "?"}`,
  );

  // --- Build and route the event ---
  // Gmail events always go to misc_notifications (raw webhook data).
  // However, dispatch() checks tool dispatch rules: if a rule matches
  // (e.g., "email from VIP customer"), an additional pending_tool_call
  // is enqueued to the priority queue for agent action.
  const event = {
    source: "gmail",
    type: "new_message",
    data: sanitizeObject(
      {
        direction,
        emailAddress,
        historyId,
        messageId: body.message.messageId,
        publishTime: body.message.publishTime,
        ...(details.from && { from: details.from }),
        ...(details.to && { to: details.to }),
        ...(details.subject && { subject: details.subject }),
        ...(details.messageId && { gmailMessageId: details.messageId }),
      },
      { auditSource: "webhook/gmail" },
    ),
  };

  enqueueEvent(event, "misc_notifications");

  // Check if any tool dispatch rules match (matched rules → priority queue)
  dispatch(event);

  console.log(`   📧 [GMAIL] Event → misc_notifications (tool dispatch → priority)`);

  res.status(200).json({ status: "received" });
}
