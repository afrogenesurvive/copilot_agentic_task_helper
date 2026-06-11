#!/usr/bin/env node

/**
 * check-gmail-watch.js — Check and renew Gmail Pub/Sub watch
 *
 * Standalone script that can be run directly (not via -e flag),
 * so it works with Node.js import syntax regardless of version.
 *
 * Usage:
 *   node mcp/webhook-server/scripts/check-gmail-watch.js
 */

import { ensureWatch, getWatchStatus } from "../lib/gmail-watch.js";

async function main() {
  const status = getWatchStatus();
  if (status) {
    const expiresAt = new Date(parseInt(status.expiration, 10));
    const remaining = expiresAt - Date.now();
    console.log(`Existing Gmail watch found:`);
    console.log(`   Email:     ${status.email}`);
    console.log(`   History:   ${status.historyId}`);
    console.log(`   Expires:   ${expiresAt.toISOString()} (${Math.round(remaining / 1000 / 60)}m remaining)`);
    console.log(`   Topic:     ${status.topicName}`);
    console.log(``);

    if (remaining < 60 * 60 * 1000) {
      console.log(`   → Watch expiring soon, renewing...`);
      await ensureWatch();
      const updated = getWatchStatus();
      console.log(`   ✅ Renewed — expires ${new Date(parseInt(updated.expiration, 10)).toISOString()}`);
    } else {
      console.log(`   ✅ Watch is valid`);
    }
  } else {
    console.log(`   → No watch active, starting...`);
    await ensureWatch();
    const updated = getWatchStatus();
    if (updated) {
      console.log(`   ✅ Started — expires ${new Date(parseInt(updated.expiration, 10)).toISOString()}`);
    } else {
      console.log(`   ❌ Failed to start watch`);
    }
  }
}

main().catch((err) => {
  console.error(`   ❌ Error: ${err.message}`);
  process.exit(1);
});
