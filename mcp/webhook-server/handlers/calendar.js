/**
 * Calendar Webhook Handler — Google Calendar push notification callbacks
 *
 * Receives Google Calendar event notifications (via Pub/Sub push),
 * logs them, and enqueues them as misc_notifications.
 *
 * Like Drive, Calendar push notifications are thin signals — they tell you
 * a channel has changed. You need to call `calendar.events.list()` with
 * the updatedSyncToken to get the actual changes.
 */

import { enqueueEvent } from "../lib/event-queue.js";
import { sanitizeObject } from "../../../scripts/sanitize.mjs";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, "..", "..", "..", "logs", "notifications", "calendar");

/**
 * Handle Calendar push notification (POST).
 * Logs the notification and enqueues it for processing.
 */
export async function calendarPushHandler(req, res) {
  try {
    const ts = new Date().toISOString();
    const today = ts.slice(0, 10);
    const body = req.body || {};
    const headers = req.headers || {};

    // Calendar push notifications come as Pub/Sub messages
    const message = body.message || {};
    const data = message.data ? JSON.parse(Buffer.from(message.data, "base64").toString("utf8")) : {};

    const notification = sanitizeObject({
      timestamp: ts,
      source: "calendar",
      type: "change",
      messageId: message.messageId || "unknown",
      publishTime: message.publishTime,
      data,
      headers: {
        contentType: headers["content-type"],
        userAgent: headers["user-agent"],
      },
    });

    // Log to file
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, `${today}.jsonl`), JSON.stringify(notification) + "\n");

    // Enqueue as a misc notification
    await enqueueEvent("calendar", "change", {
      notification,
      text: `Calendar change detected at ${ts}`,
    });

    // Acknowledge immediately
    res.status(200).json({ status: "ok" });
  } catch (err) {
    console.error(`❌ [Calendar webhook] Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}
