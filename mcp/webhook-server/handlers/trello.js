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
import crypto from "crypto";
import { enqueueEvent } from "../lib/event-queue.js";
import { dispatch } from "../lib/tool-dispatch.js";
import { sanitizeObject } from "../../../scripts/sanitize.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, "..", "..", "..", "logs", "webhook");
const NOTIFY_DIR = path.resolve(__dirname, "..", "..", "..", "logs", "notifications", "trello");
const FRONTDESK_UNAUTHORIZED_DIR = path.resolve(__dirname, "..", "..", "..", "logs", "frontdesk", "unauthorized");
const SESSION_LOG_DIR = path.resolve(__dirname, "..", "..", "..", "logs", "frontdesk", "sessions");

function logError(msg) {
  const ts = new Date().toISOString();
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(path.join(LOG_DIR, `${ts.slice(0, 10)}.log`), `[${ts}] ERROR: ${msg}\n`);
}

function logVerbose(entry) {
  const ts = new Date().toISOString();
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(path.join(LOG_DIR, `${ts.slice(0, 10)}_verbose.log`), JSON.stringify({ ts, ...entry }) + "\n");
}

function logNotification(body) {
  const ts = new Date().toISOString();
  const day = ts.slice(0, 10);
  const action = body.action || {};
  const model = body.model || {};
  const d = action.data || {};

  const entry = {
    ts,
    source: "trello",
    type: action.type || "unknown",
    data: sanitizeObject({
      board: model.name || d.board?.name,
      list: d.list?.name,
      card: d.card?.name,
      checklist: d.checklist?.name,
      checkItem: d.checkItem?.name,
    }),
  };

  // Strip undefined fields
  Object.keys(entry.data).forEach((k) => entry.data[k] === undefined && delete entry.data[k]);

  fs.mkdirSync(NOTIFY_DIR, { recursive: true });
  fs.appendFileSync(path.join(NOTIFY_DIR, `${day}.jsonl`), JSON.stringify(entry) + "\n");
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

  const checkItemName = action?.data?.checkItem?.name;
  const checklistName = action?.data?.checklist?.name;
  const checklistSuffix = checkItemName ? ` — checklist item "${checkItemName}" in "${checklistName || "?"}"` : "";
  console.log(`📡 [${ts}] Trello event: ${action?.type || "unknown"} on card "${action?.data?.card?.name || "?"}"${checklistSuffix}`);

  logVerbose({ type: "webhook_received", source: "trello", action: action?.type, card: action?.data?.card?.name });

  // Log notification (sanitized)
  logNotification(body);

  // Check if this board is in our watch list
  const boardId = model?.id || action?.data?.board?.id;
  const watchedIds = (process.env.TRELLO_WEBHOOK_MODEL_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (watchedIds.length > 0 && boardId && !watchedIds.includes(boardId)) {
    console.log(`   → Board ${boardId} not in watch list, skipping`);
    return res.status(200).json({ status: "ignored", reason: "board_not_watched" });
  }

  // Enqueue as pending tool call (sanitized against prompt injection)
  const event = {
    source: "trello",
    type: action?.type || "unknown",
    data: sanitizeObject(action?.data || {}),
    board: model?.name || action?.data?.board?.name,
    card: sanitizeObject(action?.data?.card || {}),
    list: action?.data?.list,
    timestamp: action?.date || ts,
  };

  // Verify HMAC signature for frontdesk_input commentCard events
  // Strips [sig:...] from the text so the agent sees clean text,
  // and sets event.data._verified so the agent can trust the origin.
  if (event.type === "commentCard" && event.list?.name === "frontdesk_input") {
    const text = action?.data?.text || "";
    const sigMatch = text.match(/\[sig:([a-f0-9]{16})\]$/);
    if (sigMatch) {
      const providedSig = sigMatch[1];
      const cleanText = text.replace(/\s*\[sig:[a-f0-9]{16}\]$/, "");
      const secret = process.env.FRONTEND_HMAC_SECRET;
      if (secret) {
        const expectedSig = crypto.createHmac("sha256", secret).update(cleanText).digest("hex").slice(0, 16);
        if (providedSig === expectedSig) {
          console.log(`   ✅ HMAC signature valid for frontdesk_input comment`);
          event.data._verified = true;
        } else {
          console.log(`   ⚠️ HMAC signature INVALID for frontdesk_input comment`);
          event.data._verified = false;
        }
      }
      // Strip sig from text so agent only sees the clean message
      event.data.text = cleanText;
      // Also strip from the text field within data.text if nested differently
      if (event.data.data?.text) event.data.data.text = cleanText;
    } else if (process.env.FRONTEND_HMAC_SECRET) {
      // No signature but we expect one — flag as unverified
      console.log(`   ⚠️ frontdesk_input comment has no HMAC signature (may be direct API call)`);
      event.data._verified = false;
    }

    // Check for auto-authorization passphrase (---passphrase--- at start of text)
    // If valid, the agent may auto-answer read-only questions without human approval.
    const currentText = event.data.text || "";
    // Match ---passphrase--- anywhere in the text (not just at start)
    // since the webapp prefixes with [username]
    const passphraseMatch = currentText.match(/---(.+?)---/);
    if (passphraseMatch) {
      const providedPassphrase = passphraseMatch[1];
      const storedPassphrase = process.env.FRONTEND_AUTH_PASSPHRASE;
      if (storedPassphrase && providedPassphrase === storedPassphrase) {
        console.log(`   ✅ Frontdesk passphrase valid — auto-authorizing`);
        event.data._authorized = true;
      } else {
        console.log(`   ⚠️ Frontdesk passphrase INVALID`);
        event.data._authorized = false;
      }
      // Strip passphrase block from text so agent only sees the actual question
      event.data.text = currentText.replace(/---.+?---\s*/, "").trim();
      if (event.data.data?.text) {
        event.data.data.text = event.data.data.text.replace(/---.+?---\s*/, "").trim();
      }
    }
  }

  // Log non-authorized frontdesk input to a dedicated directory for review
  if (event.type === "commentCard" && event.list?.name === "frontdesk_input" && event.data._authorized !== true) {
    const day = ts.slice(0, 10);
    const logEntry = {
      ts,
      direction: "input",
      text: action?.data?.text || "",
      verified: event.data._verified,
      card: event.card?.name,
      cardId: action?.data?.card?.id,
    };
    fs.mkdirSync(FRONTDESK_UNAUTHORIZED_DIR, { recursive: true });
    fs.appendFileSync(path.join(FRONTDESK_UNAUTHORIZED_DIR, `${day}.jsonl`), JSON.stringify(logEntry) + "\n");
    console.log(`   ⚠️ Non-authorized frontdesk input from "${event.card?.name || "?"}" — "${event.data.text || "(empty)"}"`);
    console.log(`   → Logged to logs/frontdesk/unauthorized/`);

    // Auto-reply on frontdesk_output with generic response
    const trelloKey = process.env.TRELLO_KEY;
    const trelloToken = process.env.TRELLO_TOKEN;
    const outputListId = process.env.TRELLO_LIST_FRONTEDESK_OUTPUT;
    if (trelloKey && trelloToken && outputListId) {
      const today = new Date().toISOString().slice(0, 10);
      const originalText = (event.data.text || "(empty)").trim();
      const genericReply = originalText
        ? `You said: "${originalText}" — Thank you for your message. A team member will review and respond shortly.`
        : "Thank you for your message. A team member will review and respond shortly.";

      // Find or create today's output card
      (async () => {
        try {
          const listUrl = `https://api.trello.com/1/lists/${outputListId}/cards?key=${trelloKey}&token=${trelloToken}&fields=name,id`;
          const listResp = await fetch(listUrl);
          const cards = await listResp.json();
          let outputCard = Array.isArray(cards) ? cards.find((c) => c.name === today) : null;

          if (!outputCard) {
            const createUrl = `https://api.trello.com/1/cards?idList=${outputListId}&key=${trelloKey}&token=${trelloToken}&name=${encodeURIComponent(today)}`;
            const createResp = await fetch(createUrl, { method: "POST" });
            outputCard = await createResp.json();
          }

          // Add generic reply as comment
          const commentUrl = `https://api.trello.com/1/cards/${outputCard.id}/actions/comments?key=${trelloKey}&token=${trelloToken}&text=${encodeURIComponent(genericReply)}`;
          await fetch(commentUrl, { method: "POST" });
          console.log(`   → Auto-replied on frontdesk_output with generic response`);
        } catch (err) {
          console.error(`   ⚠️ Failed to auto-reply: ${err.message}`);
        }
      })();
    } else {
      console.warn(`   ⚠️ TRELLO_KEY, TRELLO_TOKEN, or TRELLO_LIST_FRONTEDESK_OUTPUT not set — cannot auto-reply`);
    }
  }

  // Capture session log cards from Trello and write to local logs
  // The Netlify log-session function creates Trello cards on the session_logs
  // list; the webhook picks them up and persists them to the local filesystem.
  if (event.type === "createCard" && event.list?.name === "session_logs") {
    const day = ts.slice(0, 10);
    const cardDesc = action?.data?.card?.desc || "";
    let sessionEntry;
    try {
      sessionEntry = JSON.parse(cardDesc);
    } catch {
      sessionEntry = { ts, raw: cardDesc };
    }
    fs.mkdirSync(SESSION_LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(SESSION_LOG_DIR, `${day}.jsonl`), JSON.stringify(sessionEntry) + "\n");
    console.log(`   📋 Session log card: ${action?.data?.card?.name || "?"} — written to logs/frontdesk/sessions/`);
    // Skip queue — session data doesn't need tool dispatch
    console.log(`   → Session data — skipping queue`);
    return res.status(200).json({ status: "session_logged" });
  }

  // All frontdesk input goes through the queue so the agent can find it.
  // Authorized messages are tagged and will be auto-answered when the agent
  // processes the queue. Unauthorized messages wait for human approval.
  enqueueEvent(event);
  dispatch(event);
  console.log(`   → Enqueued for agent processing`);

  res.status(200).json({ status: "received" });
}
