#!/usr/bin/env node

/**
 * setup-trello-webhook.js — Register Trello webhooks
 *
 * Registers one webhook per board ID listed in TRELLO_WEBHOOK_MODEL_IDS.
 * The webhook will POST to WEBHOOK_BASE_URL/webhooks/trello.
 *
 * Usage:
 *   node mcp/webhook-server/scripts/setup-trello-webhook.js
 *
 * Environment:
 *   TRELLO_KEY, TRELLO_TOKEN, TRELLO_BASE_URL
 *   TRELLO_WEBHOOK_MODEL_IDS — comma-separated board IDs
 *   WEBHOOK_BASE_URL — public URL for the webhook endpoint
 */

import fetch from "node-fetch";
import "dotenv/config";

const TRELLO_KEY = process.env.TRELLO_KEY || "";
const TRELLO_TOKEN = process.env.TRELLO_TOKEN || "";
const BASE_URL = process.env.TRELLO_BOARD_ID || "https://api.trello.com/1";
const WEBHOOK_URL = `${process.env.WEBHOOK_BASE_URL || "http://localhost:3199"}/webhooks/trello`;
const MODEL_IDS = (process.env.TRELLO_WEBHOOK_MODEL_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
const ACTIONS = process.env.TRELLO_WEBHOOK_ACTIONS || "createCard,updateCard,commentCard,updateCheckItemStateOnCard";

async function registerWebhook(boardId, description) {
  const url = `https://api.trello.com/1/tokens/${TRELLO_TOKEN}/webhooks/?key=${TRELLO_KEY}`;

  const body = new URLSearchParams({
    callbackURL: WEBHOOK_URL,
    idModel: boardId,
    description: description || `Webhook for board ${boardId}`,
  });

  try {
    const resp = await fetch(url, { method: "POST", body });
    const data = await resp.json();

    if (resp.ok) {
      console.log(`✅ Webhook registered for board ${boardId}: ${data.id}`);
      return data;
    } else {
      console.error(`❌ Failed for board ${boardId}: ${data.message || JSON.stringify(data)}`);
      return null;
    }
  } catch (err) {
    console.error(`❌ Error for board ${boardId}: ${err.message}`);
    return null;
  }
}

async function listExistingWebhooks() {
  const url = `https://api.trello.com/1/tokens/${TRELLO_TOKEN}/webhooks/?key=${TRELLO_KEY}`;
  try {
    const resp = await fetch(url);
    const data = await resp.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function main() {
  if (!TRELLO_KEY || !TRELLO_TOKEN) {
    console.error("❌ TRELLO_KEY and TRELLO_TOKEN must be set in .env");
    process.exit(1);
  }

  if (MODEL_IDS.length === 0) {
    console.error("❌ TRELLO_WEBHOOK_MODEL_IDS is empty — set board IDs in .env");
    process.exit(1);
  }

  console.log(`📡 Trello webhook setup`);
  console.log(`   Endpoint: ${WEBHOOK_URL}`);
  console.log(`   Boards:   ${MODEL_IDS.join(", ")}`);
  console.log(`   Actions:  ${ACTIONS}`);
  console.log("");

  // List existing
  const existing = await listExistingWebhooks();
  console.log(`Existing webhooks: ${existing.length}`);
  for (const wh of existing) {
    console.log(`   ${wh.id} → ${wh.idModel} (${wh.callbackURL})`);
  }
  console.log("");

  // Register for each board
  for (const boardId of MODEL_IDS) {
    const existingWh = existing.find((wh) => wh.idModel === boardId);
    if (existingWh) {
      console.log(`⏭️  Board ${boardId} already has webhook ${existingWh.id}`);
      continue;
    }
    await registerWebhook(boardId, `Copilot agent - ${boardId}`);
  }

  console.log("\n✅ Done");
}

main().catch(console.error);
