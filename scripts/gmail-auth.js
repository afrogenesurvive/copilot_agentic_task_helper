#!/usr/bin/env node

/**
 * gmail-auth.js — Gmail OAuth2 Authentication Helper
 *
 * Generates OAuth2 credentials for Gmail API access.
 * Saves the token to tokens/gmail-token.json for use by MCP servers.
 *
 * Usage:
 *   node scripts/gmail-auth.js
 *
 * Prerequisites:
 *   - Google Cloud project with Gmail API enabled
 *   - OAuth2 credentials saved as credentials/gmail-oauth2.json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { authenticate } from "@google-cloud/local-auth";
import { google } from "googleapis";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];
const TOKEN_PATH = path.resolve(__dirname, "..", "tokens", "gmail-token.json");
const CREDENTIALS_PATH = path.resolve(__dirname, "..", "credentials", "gmail-oauth2.json");

async function loadSavedCredentials() {
  try {
    const content = fs.readFileSync(TOKEN_PATH, "utf8");
    const credentials = JSON.parse(content);
    return google.auth.fromJSON(credentials);
  } catch {
    return null;
  }
}

async function saveCredentials(client) {
  const content = fs.readFileSync(CREDENTIALS_PATH, "utf8");
  const keys = JSON.parse(content);
  const key = keys.installed || keys.web;
  const payload = JSON.stringify({
    type: "authorized_user",
    client_id: key.client_id,
    client_secret: key.client_secret,
    refresh_token: client.credentials.refresh_token,
  });
  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
  fs.writeFileSync(TOKEN_PATH, payload, "utf8");
  console.log(`Credentials saved to ${TOKEN_PATH}`);
}

async function authorize() {
  let client = await loadSavedCredentials();
  if (client) {
    console.log("Using saved credentials from", TOKEN_PATH);
    return client;
  }

  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.error(`No OAuth2 credentials found at ${CREDENTIALS_PATH}`);
    console.error("Download OAuth2 credentials from Google Cloud Console and save them.");
    process.exit(1);
  }

  client = await authenticate({
    scopes: SCOPES,
    keyfilePath: CREDENTIALS_PATH,
  });

  await saveCredentials(client);
  console.log("Authentication successful!");
  return client;
}

authorize().catch(console.error);
