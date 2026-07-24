#!/usr/bin/env node

/**
 * One-time script: Convert Bills Master Check_current.xlsx → Google Sheet
 *
 * Uses Google Drive API to copy the existing xlsx file with mimeType conversion
 * to Google Sheets format. The new Sheet becomes the target for future bill
 * extraction operations.
 *
 * Usage:
 *   node scripts/convert-xlsx-to-sheet.mjs
 *
 * Environment variables (from .env):
 *   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
 */

import fs from "fs";
import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";

// Manually load .env without dotenv dependency
const envPath = new URL("../.env", import.meta.url);
const envContent = fs.readFileSync(envPath, "utf-8");
for (const line of envContent.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eqIdx = trimmed.indexOf("=");
  if (eqIdx === -1) continue;
  const key = trimmed.slice(0, eqIdx).trim();
  const val = trimmed.slice(eqIdx + 1).trim();
  if (!process.env[key]) process.env[key] = val;
}

// We search for the file by name rather than hardcoding an ID
const SEARCH_NAME = "Bills Check Master_current.xlsx";

function getAuthClient() {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    throw new Error("Missing Google OAuth2 credentials in environment");
  }
  const oauth2 = new OAuth2Client(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  return oauth2;
}

async function main() {
  const auth = getAuthClient();
  const drive = google.drive({ version: "v3", auth });

  // 1. Search for the xlsx file by name
  console.log(`🔍 Searching for "${SEARCH_NAME}" on Drive...`);
  const searchRes = await drive.files.list({
    q: `name = '${SEARCH_NAME.replace(/'/g, "\\'")}' and trashed = false`,
    fields: "files(id, name, mimeType, parents, webViewLink)",
    pageSize: 10,
  });

  if (!searchRes.data.files?.length) {
    console.error(`❌ File "${SEARCH_NAME}" not found on Drive.`);
    console.error("Available xlsx files matching 'Bills Master':");
    const fallback = await drive.files.list({
      q: "name contains 'Bills Master' and trashed = false",
      fields: "files(id, name, mimeType)",
      pageSize: 20,
    });
    for (const f of fallback.data.files || []) {
      console.error(`  - ${f.name} (${f.id}) [${f.mimeType}]`);
    }
    process.exit(1);
  }

  const orig = searchRes.data.files[0];
  console.log(`  Name: ${orig.name}`);
  console.log(`  MIME: ${orig.mimeType}`);
  console.log(`  ID:   ${orig.id}`);
  console.log(`  URL:  ${orig.webViewLink}`);

  // 2. Determine the sheet name (strip .xlsx extension)
  const sheetName = orig.name.replace(/\.xlsx$/i, "");

  // 3. Check if a Google Sheets version already exists
  const sheetSearch = await drive.files.list({
    q: `name = '${sheetName.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
    fields: "files(id, name, webViewLink, createdTime)",
    pageSize: 10,
  });

  if (sheetSearch.data.files?.length > 0) {
    const existing = sheetSearch.data.files[0];
    console.log(`\n✅ Google Sheet already exists:`);
    console.log(`  Name: ${existing.name}`);
    console.log(`  ID:   ${existing.id}`);
    console.log(`  URL:  ${existing.webViewLink}`);
    console.log(`  Created: ${existing.createdTime}`);
    console.log(`\n📝 Add to .env: SHEET_ID=${existing.id}`);
    return;
  }

  // 4. Copy + convert xlsx → Google Sheets
  console.log(`\n🔄 Converting to Google Sheet...`);
  const copied = await drive.files.copy({
    fileId: orig.id,
    requestBody: {
      name: sheetName,
      mimeType: "application/vnd.google-apps.spreadsheet",
      parents: orig.parents || undefined,
    },
  });

  console.log(`\n✅ Created Google Sheet:`);
  console.log(`  Name: ${copied.data.name}`);
  console.log(`  ID:   ${copied.data.id}`);
  console.log(`  URL:  https://docs.google.com/spreadsheets/d/${copied.data.id}/edit`);
  console.log(`\n📝 Add to .env: SHEET_ID=${copied.data.id}`);
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
