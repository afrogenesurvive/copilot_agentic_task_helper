#!/usr/bin/env node

/**
 * update-push-endpoint.js — Update the push endpoint URL for Trello webhooks
 *
 * When the tunnel URL changes (e.g., after Cloudflare Tunnel restart),
 * this script updates all registered Trello webhooks to point to the new URL.
 *
 * Usage:
 *   WEBHOOK_BASE_URL=https://new-url.trycloudflare.com \
 *     node mcp/webhook-server/scripts/update-push-endpoint.js
 *
 * Environment:
 *   TRELLO_KEY, TRELLO_TOKEN
 *   WEBHOOK_BASE_URL — new public URL
 */

import fetch from "node-fetch";
import "dotenv/config";

const TRELLO_KEY = process.env.TRELLO_KEY || "";
const TRELLO_TOKEN = process.env.TRELLO_TOKEN || "";
const NEW_URL = `${process.env.WEBHOOK_BASE_URL || "http://localhost:3199"}/webhooks/trello`;

async function listWebhooks() {
  const url = `https://api.trello.com/1/tokens/${TRELLO_TOKEN}/webhooks/?key=${TRELLO_KEY}`;
  const resp = await fetch(url);
  const data = await resp.json();
  return Array.isArray(data) ? data : [];
}

async function updateWebhook(webhookId, newUrl) {
  const url = `https://api.trello.com/1/webhooks/${webhookId}?key=${TRELLO_KEY}`;
  const body = new URLSearchParams({ callbackURL: newUrl });

  const resp = await fetch(url, { method: "PUT", body });
  const data = await resp.json();

  if (resp.ok) {
    console.log(`✅ Updated webhook ${webhookId} → ${newUrl}`);
  } else {
    console.error(`❌ Failed to update ${webhookId}: ${data.message || JSON.stringify(data)}`);
  }
}

async function main() {
  if (!TRELLO_KEY || !TRELLO_TOKEN) {
    console.error("❌ TRELLO_KEY and TRELLO_TOKEN must be set");
    process.exit(1);
  }

  console.log(`Updating Trello webhook endpoints to:\n   ${NEW_URL}\n`);

  const webhooks = await listWebhooks();
  console.log(`Found ${webhooks.length} webhook(s)\n`);

  for (const wh of webhooks) {
    console.log(`   ${wh.id} → currently: ${wh.callbackURL}`);
    if (wh.callbackURL !== NEW_URL) {
      await updateWebhook(wh.id, NEW_URL);
    } else {
      console.log(`   ⏭️  Already up to date`);
    }
  }

  console.log("\n✅ Done");
}

main().catch(console.error);
