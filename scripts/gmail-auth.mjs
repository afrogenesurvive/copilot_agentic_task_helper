#!/usr/bin/env node

/**
 * google-auth.mjs — Get a unified Google OAuth2 refresh token
 *
 * Requests scopes for Gmail, Drive, Calendar, and Photos so all MCP servers
 * (Gmail, Drive, Calendar, Photos) can share one refresh token.
 *
 * Usage:
 *   node scripts/gmail-auth.mjs
 *
 * Prerequisites:
 *   - safe/gmail-oauth2.json with your OAuth2 client credentials
 *   - Gmail API, Drive API, and Calendar API enabled in Google Cloud Console
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { authenticate } from "@google-cloud/local-auth";
import { google } from "googleapis";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  // Google Photos Library API — post-2025-03-31 app-created scopes (the old
  // 'photoslibrary' / 'photoslibrary.readonly' scopes were REMOVED by Google):
  "https://www.googleapis.com/auth/photoslibrary.appendonly",
  "https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata",
  "https://www.googleapis.com/auth/photoslibrary.edit.appcreateddata",
  // Google Photos Picker API — interactive, user-selected access to the user's
  // REAL library photos (the only way to touch non-app-created content now).
  // Requires a browser step where the user picks items each session.
  "https://www.googleapis.com/auth/photospicker.mediaitems.readonly",
];
const CREDENTIALS_PATH = path.join(ROOT, "safe", "gmail-oauth2.json");
const TOKEN_PATH = path.join(ROOT, "tokens", "gmail-token.json");

async function main() {
  // Check credentials exist
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.error(`❌ No OAuth2 credentials found at ${CREDENTIALS_PATH}`);
    console.error("   Download them from Google Cloud Console → APIs & Services → Credentials");
    console.error("   Save as a desktop OAuth2 client JSON file.");
    process.exit(1);
  }

  console.log("🔑 Starting Google OAuth2 authorization (Gmail + Drive + Calendar + Photos)...");
  console.log(`   Credentials: ${CREDENTIALS_PATH}`);
  console.log(`   Scopes:      ${SCOPES.join(", ")}`);
  console.log("");

  // Run the OAuth consent flow (opens browser)
  const client = await authenticate({
    scopes: SCOPES,
    keyfilePath: CREDENTIALS_PATH,
  });

  const refreshToken = client.credentials.refresh_token;
  const accessToken = client.credentials.access_token;

  // Save full token to tokens/ for reference
  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
  const tokenPayload = JSON.stringify(
    {
      type: "authorized_user",
      refresh_token: refreshToken,
      ...client.credentials,
    },
    null,
    2,
  );
  fs.writeFileSync(TOKEN_PATH, tokenPayload, "utf8");

  console.log("✅ Authentication successful!");
  console.log(`   Token saved to: ${TOKEN_PATH}`);
  console.log("");
  console.log("──────────────────────────────────────────────");
  console.log("📋 Copy this into your .env file:");
  console.log("");
  console.log(`GMAIL_REFRESH_TOKEN=${refreshToken}`);
  console.log("");
  console.log("──────────────────────────────────────────────");
  console.log(`   Access token (short-lived): ${accessToken?.slice(0, 20)}...`);
  console.log("   (Access tokens auto-refresh; only the refresh token matters)");
}

main().catch((err) => {
  console.error("❌ Authorization failed:", err.message);
  process.exit(1);
});
