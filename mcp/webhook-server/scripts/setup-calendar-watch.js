#!/usr/bin/env node

/**
 * setup-calendar-watch.js — Set up Google Calendar push notification channel
 *
 * Creates a Calendar event watch that sends notifications to the
 * webhook server (same Pub/Sub push endpoint pattern as Gmail).
 *
 * Calendar's watch API uses direct webhook delivery (not Pub/Sub topics),
 * but the notification lands on the same webhook server as Gmail's
 * Pub/Sub push, so processing is unified.
 *
 * Usage:
 *   node mcp/webhook-server/scripts/setup-calendar-watch.js
 *
 * Environment:
 *   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
 *   WEBHOOK_BASE_URL — public tunnel URL
 */

import "dotenv/config";
import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.resolve(__dirname, "..", "..", "..", "logs", "notifications");
const STATE_FILE = path.join(STATE_DIR, ".calendar-watch-state.json");

function getAuthClient() {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    throw new Error("Missing Google OAuth2 credentials");
  }
  const oauth2 = new OAuth2Client(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  return oauth2;
}

function loadState() {
  try {
    return fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : null;
  } catch {
    return null;
  }
}

function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

export async function startCalendarWatch(overrides = {}) {
  const auth = getAuthClient();
  const calendar = google.calendar({ version: "v3", auth });
  const baseUrl = overrides.webhookBaseUrl || process.env.WEBHOOK_BASE_URL;

  if (!baseUrl) throw new Error("WEBHOOK_BASE_URL is required");

  const address = `${baseUrl.replace(/\/$/, "")}/webhooks/calendar/push`;
  console.log(`   🔄 [CALENDAR WATCH] Setting up with address: ${address}`);

  const res = await calendar.events.watch({
    calendarId: "primary",
    requestBody: {
      id: `calendar-watch-${Date.now()}`,
      type: "web_hook",
      address,
    },
  });

  const state = {
    channelId: res.data.id,
    resourceId: res.data.resourceId,
    expiration: res.data.expiration,
    address,
    startedAt: new Date().toISOString(),
  };

  saveState(state);
  console.log(`   ✅ [CALENDAR WATCH] Started (expires: ${new Date(parseInt(state.expiration)).toISOString()})`);
  return res.data;
}

export function getCalendarWatchStatus() {
  return loadState();
}

// CLI entry point
async function main() {
  const existing = loadState();
  if (existing) {
    const expiresAt = new Date(parseInt(existing.expiration, 10));
    console.log(`Existing calendar watch found:`);
    console.log(`   Channel:   ${existing.channelId}`);
    console.log(`   Resource:  ${existing.resourceId}`);
    console.log(`   Expires:   ${expiresAt.toISOString()}`);
    console.log(`   Address:   ${existing.address}`);
    console.log("");
  }
  await startCalendarWatch();
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
