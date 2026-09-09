/**
 * WhatsApp Cloud API push notification handler (inbound messages)
 *
 * Receives Meta WhatsApp Cloud API webhooks and:
 *   1. Verifies X-Hub-Signature-256 (HMAC-SHA256 of the raw body with
 *      WHATSAPP_APP_SECRET) so unverified payloads are never processed.
 *   2. Dumps the raw body for forensic audit (logs/webhook/raw).
 *   3. Persists each inbound text message (sanitized) to
 *      safe/whatsapp/inbox/YYYY-MM-DD.jsonl — the local source of truth that
 *      whatsapp_list_messages reads (Cloud API GET only returns outbound).
 *   4. Logs a notification (logs/notifications/whatsapp/*.jsonl) + enqueues to
 *      the misc queue, then runs tool-dispatch rules (source "whatsapp").
 *
 * Endpoints:
 *   GET  /webhooks/whatsapp/push — hub.challenge verification
 *   POST /webhooks/whatsapp/push — Meta webhook delivery
 *
 * Env (config.json/.env): WHATSAPP_APP_SECRET (HMAC verify),
 *      WHATSAPP_WEBHOOK_VERIFY_TOKEN (GET challenge).
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { enqueueEvent } from "../lib/event-queue.js";
import { dispatch } from "../lib/tool-dispatch.js";
import { sanitizeObject } from "../../../scripts/sanitize.stub.mjs";
import { notify, webhookVerbose, webhookRaw } from "../../../shared/logger.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..", "..");
const INBOX_DIR = path.join(REPO, "safe", "whatsapp", "inbox");

const APP_SECRET = process.env.WHATSAPP_APP_SECRET || "";
const VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || "";

function logVerbose(entry) {
  webhookVerbose("whatsapp", entry);
}

function logRawBody(body) {
  webhookRaw("whatsapp", body);
}

function logNotification(entry) {
  notify(entry.source || "whatsapp", entry.type || "event", entry.data);
}

/** Constant-time comparison of the X-Hub-Signature-256 header. */
function signatureMatches(header, rawBody) {
  if (!APP_SECRET || !header) return false;
  const expected = `sha256=${crypto.createHmac("sha256", APP_SECRET).update(rawBody).digest("hex")}`;
  const a = Buffer.from(String(header));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function appendInbox(record) {
  try {
    const day = new Date(record.ts || Date.now()).toISOString().slice(0, 10);
    fs.mkdirSync(INBOX_DIR, { recursive: true });
    fs.appendFileSync(path.join(INBOX_DIR, `${day}.jsonl`), JSON.stringify(record) + "\n");
  } catch (err) {
    console.error(`   ❌ [WHATSAPP] inbox write failed: ${err.message}`);
  }
}

/** Extract readable body text from a Cloud API message object by type. */
function messageText(msg) {
  if (!msg || typeof msg !== "object") return null;
  if (msg.type === "text" && msg.text && typeof msg.text.body === "string") return msg.text.body;
  // Non-text (media/audio/location) messages keep their type label; body text stays null.
  return null;
}

export async function whatsappHandler(req, res) {
  const ts = new Date().toISOString();

  // ── GET: webhook verification (hub.challenge) ──
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token && token === VERIFY_TOKEN) {
      console.log(`🔑 [WHATSAPP] Webhook verified (hub.challenge)`);
      return res.status(200).send(String(challenge));
    }
    console.log(`⚠️  [WHATSAPP] Webhook verify token mismatch`);
    return res.status(403).send("Forbidden");
  }

  const body = req.body;
  if (!body || body.object !== "whatsapp_business_account") {
    if (body) logRawBody(body);
    return res.status(400).json({ error: "Expected WhatsApp Business Account webhook" });
  }

  // Forensic copy of the raw (unsanitized) payload BEFORE anything else.
  logRawBody(body);

  // ── Verify X-Hub-Signature-256 (HMAC of the raw body with app secret) ──
  const sig = req.headers["x-hub-signature-256"];
  const raw = req.rawBody || Buffer.from(JSON.stringify(body));
  if (APP_SECRET) {
    if (!sig || !signatureMatches(sig, raw)) {
      console.log(`⚠️  [WHATSAPP] Signature mismatch — ignoring payload`);
      logVerbose({ type: "signature_mismatch", source: "whatsapp", ts });
      return res.status(401).json({ error: "Invalid signature" });
    }
  } else {
    console.warn("   ⚠️  [WHATSAPP] WHATSAPP_APP_SECRET not set — skipping HMAC verification");
  }

  let processed = 0;
  const entries = Array.isArray(body.entry) ? body.entry : [];

  for (const entry of entries) {
    for (const change of (entry && entry.changes) || []) {
      if (change.field !== "messages") continue;
      const value = change.value || {};
      const metadata = value.metadata || {};
      const contact = (value.contacts && value.contacts[0]) || {};
      const waId = contact.wa_id || null;
      const name = (contact.profile && contact.profile.name) || null;
      const messages = Array.isArray(value.messages) ? value.messages : [];

      for (const msg of messages) {
        if (msg.type === "button" || msg.type === "interactive" || msg.type === "unknown") continue;
        const text = messageText(msg);
        const clean = sanitizeObject(
          {
            direction: "in",
            ts,
            waId,
            from: msg.from || waId,
            to: metadata.display_phone_number || null,
            phoneNumberId: metadata.phone_number_id || null,
            name,
            type: msg.type || "text",
            text,
            messageId: msg.id || null,
          },
          { auditSource: "webhook/whatsapp" },
        );
        Object.keys(clean).forEach((k) => clean[k] === undefined && delete clean[k]);

        // Local inbox — source of truth for whatsapp_list_messages
        appendInbox(clean);

        // Notification log (logs/notifications/whatsapp/YYYY-MM-DD.jsonl)
        logNotification({
          ts,
          source: "whatsapp",
          type: "new_message",
          data: {
            direction: "in",
            from: clean.from,
            to: clean.to,
            waId: clean.waId,
            name: clean.name,
            type: clean.type,
            text: clean.text,
            messageId: clean.messageId,
            phoneNumberId: clean.phoneNumberId,
          },
        });

        // Queue event → misc_notifications; dispatch() may escalate to priority
        const event = {
          source: "whatsapp",
          type: "new_message",
          data: sanitizeObject(
            {
              from: clean.from,
              to: clean.to,
              waId: clean.waId,
              name: clean.name,
              type: clean.type,
              text: clean.text,
              messageId: clean.messageId,
              phoneNumberId: clean.phoneNumberId,
            },
            { auditSource: "webhook/whatsapp" },
          ),
        };
        enqueueEvent(event, "misc_notifications");
        dispatch(event);
        processed++;
        console.log(`   💬 [WHATSAPP] ← from ${clean.from || "?"}: "${String(clean.text || clean.type || "").slice(0, 60)}"`);
      }
    }
  }

  if (processed === 0) console.log(`💬 [WHATSAPP] Push received (no inbound text messages to process)`);
  res.status(200).json({ status: "received", processed });
}
