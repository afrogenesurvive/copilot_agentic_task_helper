/**
 * Drive Webhook Handler — Google Drive push notification callbacks
 *
 * Receives Google Drive change notifications (via Pub/Sub push),
 * logs them, and enqueues them as misc_notifications.
 *
 * Unlike Gmail, Drive push notifications don't carry change details —
 * they just signal that *something* changed. To find out what changed,
 * you need to call `drive.changes.list()` with the saved startPageToken.
 */

import { enqueueEvent } from "../lib/event-queue.js";
import { sanitizeObject } from "../../../scripts/sanitize.mjs";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, "..", "..", "..", "logs", "notifications", "drive");

/**
 * Handle Drive push notification (POST).
 * Logs the notification and enqueues it for processing.
 */
export async function drivePushHandler(req, res) {
  try {
    const ts = new Date().toISOString();
    const today = ts.slice(0, 10);
    const body = req.body || {};
    const headers = req.headers || {};

    // Drive push notifications come as Pub/Sub messages
    const message = body.message || {};
    const data = message.data ? JSON.parse(Buffer.from(message.data, "base64").toString("utf8")) : {};

    const notification = sanitizeObject({
      timestamp: ts,
      source: "drive",
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

    // Enqueue as a misc notification (Drive changes always go to misc)
    await enqueueEvent("drive", "change", {
      notification,
      text: `Drive change detected: ${data.changeType || "unknown"} at ${ts}`,
    });

    // Acknowledge immediately (Google expects 200 within 30s)
    res.status(200).json({ status: "ok" });
  } catch (err) {
    console.error(`❌ [Drive webhook] Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}
