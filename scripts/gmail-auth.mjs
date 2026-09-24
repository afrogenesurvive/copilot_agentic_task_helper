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
import { OPERATOR_SCOPES } from "../shared/google-scopes.mjs";
import googleToken from "../shared/google-token.cjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// One canonical list, shared with the dashboard's "Connect Google" button
// (electron/src/main/oauth.js → connectGoogleOperator) so a token minted from
// either route has identical capabilities. See shared/google-scopes.mjs for why
// `calendar` (not calendar.events) and `tasks` are required.
const SCOPES = OPERATOR_SCOPES;
const CREDENTIALS_PATH = path.join(ROOT, "safe", "gmail-oauth2.json");
const TOKEN_PATH = path.join(ROOT, "tokens", "gmail-token.json");

/**
 * Write the new refresh token to whichever store actually WINS.
 *
 * `config.json` is PRIMARY and `.env` only supplies keys config.json omits
 * (shared/config-loader.cjs), and this repo's config.json DOES define
 * GMAIL_REFRESH_TOKEN — so the old write-`.env`-only behaviour was a silent
 * no-op: the freshly granted token landed in a file that could never win while
 * the stack kept using the old one. shared/google-token.cjs picks the right
 * store and backs it up first.
 */
function persistRefreshToken(refreshToken) {
  const saved = googleToken.saveOperatorRefreshToken(refreshToken);
  console.log("──────────────────────────────────────────────");
  if (!saved.ok) {
    console.warn(`⚠️  Could not save the token automatically: ${saved.error}`);
    console.warn("   Paste it into GMAIL_REFRESH_TOKEN by hand (.env or config.json).");
    return false;
  }
  console.log(`✅ GMAIL_REFRESH_TOKEN written to ${saved.store}`);
  console.log(`   File:   ${saved.path}`);
  if (saved.backup) console.log(`   Backup: ${saved.backup}`);
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
    console.error("   No config file was modified - your existing credentials are intact.");
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

  // Push the new token straight into the winning store so no secret needs copy-pasting.
  persistRefreshToken(refreshToken);
  console.log("   Restart the MCP servers / webhook server to pick up the new token.");
  console.log("──────────────────────────────────────────────");
  console.log(`   Access token (short-lived): ${accessToken?.slice(0, 20)}...`);
  console.log("   (Access tokens auto-refresh; only the refresh token matters)");
}

main().catch((err) => {
  console.error("❌ Authorization failed:", err.message);
  process.exit(1);
});
