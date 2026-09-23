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
import http from "http";
import path from "path";
import { exec } from "child_process";
import { fileURLToPath } from "url";
import { google } from "googleapis";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  // Required to create/manage Gmail FILTERS (auto-label mail on arrival).
  // Without it, users.settings.filters.* fails with 403 insufficientPermissions.
  "https://www.googleapis.com/auth/gmail.settings.basic",
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

/**
 * Write the new refresh token into .env (the file every MCP server reads).
 * Backs the file up first and never touches GMAIL_REFRESH_TOKEN_2.
 */
function updateEnvRefreshToken(refreshToken) {
  const ENV_PATH = path.join(ROOT, ".env");
  if (!fs.existsSync(ENV_PATH)) {
    console.warn(`⚠️  No .env at ${ENV_PATH} - update GMAIL_REFRESH_TOKEN manually.`);
    return false;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${ENV_PATH}.bak-${stamp}`;
  fs.copyFileSync(ENV_PATH, backup);

  const lines = fs.readFileSync(ENV_PATH, "utf8").split("\n");
  let replaced = 0;
  const out = lines.map((line) => {
    // Anchored on '=' so the GMAIL_REFRESH_TOKEN_2 line cannot match.
    if (/^GMAIL_REFRESH_TOKEN=/.test(line)) {
      replaced++;
      return `GMAIL_REFRESH_TOKEN=${refreshToken}`;
    }
    return line;
  });
  if (!replaced) out.push(`GMAIL_REFRESH_TOKEN=${refreshToken}`);

  fs.writeFileSync(ENV_PATH, out.join("\n"), "utf8");
  console.log("──────────────────────────────────────────────");
  console.log(`✅ .env updated (GMAIL_REFRESH_TOKEN ${replaced ? "replaced" : "appended"})`);
  console.log(`   Backup: ${path.basename(backup)}`);
  console.log("   GMAIL_REFRESH_TOKEN_2 left untouched.");
  return true;
}

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

  // Run the OAuth consent flow (opens a browser tab).
  // Implemented directly rather than via @google-cloud/local-auth so we can force
  // prompt=consent, which guarantees Google returns a refresh_token. local-auth
  // only sets access_type=offline, so a re-consent can silently omit it.
  const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
  const cfg = creds.installed || creds.web;
  if (!cfg || !cfg.client_id || !cfg.client_secret) {
    console.error("❌ OAuth2 client JSON needs an 'installed' or 'web' block with client_id + client_secret.");
    process.exit(1);
  }

  const client = new google.auth.OAuth2(cfg.client_id, cfg.client_secret, "http://localhost");

  const { code, redirectUri } = await new Promise((resolve, reject) => {
    let redirectUri;
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, "http://localhost");
      if (u.pathname !== "/") {
        res.writeHead(404).end();
        return;
      }
      const err = u.searchParams.get("error");
      const authCode = u.searchParams.get("code");
      if (err || !authCode) {
        const msg = err || "No authentication code provided.";
        res.end(`Authorization failed: ${msg}. You can close this tab.`, () => server.close());
        reject(new Error(msg));
        return;
      }
      res.end("Authentication successful! You can close this tab and return to the terminal.", () => server.close());
      resolve({ code: authCode, redirectUri });
    });

    server.listen(0, () => {
      redirectUri = `http://localhost:${server.address().port}`;
      const url = client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent", // force a refresh_token even on re-consent
        scope: SCOPES,
        redirect_uri: redirectUri,
      });
      console.log("🌐 Authorize here (a browser tab should open automatically):");
      console.log("");
      console.log(url);
      console.log("");
      if (process.platform === "darwin") exec(`open "${url}"`);
    });
  });

  console.log("🔁 Exchanging authorization code for tokens...");
  const { tokens } = await client.getToken({ code, redirect_uri: redirectUri });
  client.credentials = tokens;

  const refreshToken = tokens.refresh_token;
  const accessToken = tokens.access_token;

  // Guard: never overwrite good credentials with an empty token.
  if (!refreshToken || typeof refreshToken !== "string" || refreshToken.length < 20) {
    console.error(`❌ Google did not return a refresh_token (got: ${JSON.stringify(refreshToken)}).`);
    console.error("   .env was NOT modified - your existing credentials are intact.");
    console.error("   To force a fresh refresh token:");
    console.error("     1. Open https://myaccount.google.com/permissions");
    console.error("     2. Remove access for this app (Google OAuth2)");
    console.error("     3. Re-run: node scripts/gmail-auth.mjs");
    process.exit(1);
  }

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

  // Push the new token straight into .env so no secret needs copy-pasting.
  updateEnvRefreshToken(refreshToken);
  console.log("   Restart the MCP servers / webhook server to pick up the new token.");
  console.log("──────────────────────────────────────────────");
  console.log(`   Access token (short-lived): ${accessToken?.slice(0, 20)}...`);
  console.log("   (Access tokens auto-refresh; only the refresh token matters)");
}

main().catch((err) => {
  console.error("❌ Authorization failed:", err.message);
  process.exit(1);
});
