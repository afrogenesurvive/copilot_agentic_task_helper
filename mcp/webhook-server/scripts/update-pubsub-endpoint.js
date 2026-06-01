#!/usr/bin/env node

/**
 * update-pubsub-endpoint.js — Update GCloud Pub/Sub push endpoint
 *
 * Uses the service account key (GOOGLE_APPLICATION_CREDENTIALS)
 * to update the push subscription endpoint via direct REST API call,
 * without needing the gcloud CLI.
 *
 * Usage:
 *   node mcp/webhook-server/scripts/update-pubsub-endpoint.js
 *
 * Environment:
 *   GOOGLE_APPLICATION_CREDENTIALS — path to service account JSON key
 *   GMAIL_PUBSUB_SUBSCRIPTION     — subscription name (e.g., gmail-notifications-sub)
 *   WEBHOOK_BASE_URL              — tunnel URL to point the push to
 */

import { GoogleAuth } from "google-auth-library";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const subscription = process.env.GMAIL_PUBSUB_SUBSCRIPTION;
  const baseUrl = process.env.WEBHOOK_BASE_URL;

  if (!keyPath) {
    console.error("❌ GOOGLE_APPLICATION_CREDENTIALS not set in .env");
    process.exit(1);
  }
  if (!subscription) {
    console.error("❌ GMAIL_PUBSUB_SUBSCRIPTION not set in .env");
    process.exit(1);
  }
  if (!baseUrl) {
    console.error("❌ WEBHOOK_BASE_URL not set in .env");
    process.exit(1);
  }

  const resolvedPath = path.resolve(__dirname, "..", "..", "..", keyPath);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`❌ Service account key not found at: ${resolvedPath}`);
    process.exit(1);
  }

  const pushEndpoint = `${baseUrl}/webhooks/gmail/push`;
  const subscriptionName = `projects/agent-workflow-497323/subscriptions/${subscription}`;

  console.log(`📧 Updating Pub/Sub push endpoint...`);
  console.log(`   Subscription: ${subscription}`);
  console.log(`   Push endpoint: ${pushEndpoint}`);

  // Authenticate with service account and get an access token
  const auth = new GoogleAuth({
    keyFile: resolvedPath,
    scopes: ["https://www.googleapis.com/auth/pubsub"],
  });

  const client = await auth.getClient();
  const token = await client.getAccessToken();

  // Step 1: Get the current subscription to preserve other fields
  console.log(`   Fetching current subscription config...`);
  const getResp = await fetch(`https://pubsub.googleapis.com/v1/${subscriptionName}`, { headers: { Authorization: `Bearer ${token.token}` } });

  if (!getResp.ok) {
    const err = await getResp.text();
    throw new Error(`Failed to fetch subscription: ${getResp.status} — ${err}`);
  }

  const current = await getResp.json();

  // Step 2: Update only the pushConfig
  // The Google Pub/Sub PATCH API expects an UpdateSubscriptionRequest body:
  //   { "subscription": { "pushConfig": {...} }, "updateMask": "pushConfig" }
  const updateBody = {
    subscription: {
      pushConfig: {
        pushEndpoint,
      },
    },
    updateMask: "pushConfig",
  };

  console.log(`   Sending update...`);
  const patchResp = await fetch(`https://pubsub.googleapis.com/v1/${subscriptionName}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(updateBody),
  });

  if (!patchResp.ok) {
    const err = await patchResp.text();
    throw new Error(`Failed to update subscription: ${patchResp.status} — ${err}`);
  }

  console.log(`✅ Pub/Sub push endpoint updated successfully`);
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
