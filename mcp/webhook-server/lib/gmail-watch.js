/**
 * Gmail Watch — Manage Gmail API push notification watch
 *
 * Starts, stops, and auto-renews Gmail watch requests so the
 * webhook server receives push notifications for new emails.
 *
 * Functions:
 *   startWatch()     — Set up Gmail watch for the configured user
 *   stopWatch()      — Stop the current Gmail watch
 *   ensureWatch()    — Start or renew watch (auto-renew on cron)
 *   getWatchStatus() — Check current watch state
 */

import { google } from "googleapis";
import { google as googleAuth } from "google-auth-library";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.resolve(__dirname, "..", "..", "..", "logs", "notifications");
const STATE_FILE = path.join(STATE_DIR, ".gmail-watch-state.json");

function getAuthClient() {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    throw new Error("Missing Gmail OAuth2 credentials");
  }
  const oauth2 = new googleAuth.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  return oauth2;
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    }
  } catch {
    /* ignore */
  }
  return null;
}

function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

/**
 * Start a Gmail watch for push notifications.
 * @param {object} [overrides] - Optional overrides for topic/labels
 * @returns {object} Watch response
 */
export async function startWatch(overrides = {}) {
  const auth = getAuthClient();
  const gmail = google.gmail({ version: "v1", auth });

  const topicName = overrides.topicName || process.env.GMAIL_TOPIC_NAME;
  const userId = overrides.userId || process.env.GMAIL_USER || "me";
  const labelIds = overrides.labelIds || ["INBOX"];

  if (!topicName) {
    throw new Error("GMAIL_TOPIC_NAME is required");
  }

  console.log(`[gmail-watch] Starting watch for ${userId} → ${topicName}`);

  const res = await gmail.users.watch({
    userId,
    requestBody: {
      topicName,
      labelIds,
      labelFilterAction: "include",
    },
  });

  const state = {
    email: userId,
    historyId: res.data.historyId,
    expiration: res.data.expiration,
    topicName,
    startedAt: new Date().toISOString(),
  };

  saveState(state);
  console.log(`[gmail-watch] Watch started — historyId: ${res.data.historyId}`);
  return res.data;
}

/**
 * Stop the current Gmail watch.
 */
export async function stopWatch() {
  const auth = getAuthClient();
  const gmail = google.gmail({ version: "v1", auth });
  const userId = process.env.GMAIL_USER || "me";

  console.log(`[gmail-watch] Stopping watch for ${userId}`);
  await gmail.users.stop({ userId });

  try {
    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  } catch {
    /* ignore */
  }

  console.log("[gmail-watch] Watch stopped");
}

/**
 * Ensure a Gmail watch is active — starts one if missing or expiring soon.
 * Call this periodically (e.g., via cron or setInterval) to auto-renew.
 * @param {object} [options] - Options
 * @param {number} [options.renewBeforeMs] - Renew if expiring within this many ms (default: 1 hour)
 * @returns {object} Current watch state
 */
export async function ensureWatch(options = {}) {
  const renewBeforeMs = options.renewBeforeMs || 60 * 60 * 1000; // 1 hour
  const state = loadState();

  if (state) {
    const expiresAt = parseInt(state.expiration, 10);
    const now = Date.now();
    const remaining = expiresAt - now;

    if (remaining > renewBeforeMs) {
      console.log(`[gmail-watch] Watch still valid — ${Math.round(remaining / 1000 / 60)}m remaining`);
      return state;
    }

    console.log(`[gmail-watch] Watch expiring soon (${Math.round(remaining / 1000 / 60)}m) — renewing`);
  } else {
    console.log("[gmail-watch] No watch state found — starting");
  }

  return await startWatch();
}

/**
 * Get the current watch state without modifying anything.
 * @returns {object|null}
 */
export function getWatchStatus() {
  return loadState();
}
