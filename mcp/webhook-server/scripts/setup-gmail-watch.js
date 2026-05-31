#!/usr/bin/env node

/**
 * setup-gmail-watch.js — Set up Gmail push notification watch
 *
 * Calls the Gmail API to start a watch for the configured user,
 * sending push notifications to the webhook server.
 *
 * Usage:
 *   node mcp/webhook-server/scripts/setup-gmail-watch.js
 *
 * Environment:
 *   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_USER
 *   GMAIL_TOPIC_NAME — Pub/Sub topic (e.g., projects/xxx/topics/yyy)
 *   WEBHOOK_BASE_URL — public URL (used for logging only)
 */

import { startWatch, getWatchStatus } from "../lib/gmail-watch.js";

async function main() {
  console.log("📧 Gmail Watch Setup");
  console.log("");

  // Check existing state
  const existing = getWatchStatus();
  if (existing) {
    const expiresAt = new Date(parseInt(existing.expiration, 10));
    console.log(`Existing watch found:`);
    console.log(`   Email:     ${existing.email}`);
    console.log(`   History:   ${existing.historyId}`);
    console.log(`   Expires:   ${expiresAt.toISOString()}`);
    console.log(`   Topic:     ${existing.topicName}`);
    console.log("");
  }

  console.log("Starting Gmail watch...");
  try {
    const result = await startWatch();
    console.log(`\n✅ Watch started successfully!`);
    console.log(`   History ID: ${result.historyId}`);
    console.log(`   Expiration: ${new Date(parseInt(result.expiration, 10)).toISOString()}`);
  } catch (err) {
    console.error(`\n❌ Failed to start watch: ${err.message}`);
    process.exit(1);
  }
}

main().catch(console.error);
