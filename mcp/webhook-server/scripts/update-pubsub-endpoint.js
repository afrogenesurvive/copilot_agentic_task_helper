#!/usr/bin/env node

/**
 * update-pubsub-endpoint.js — Update GCloud Pub/Sub push endpoint
 *
 * Uses the service account key (GOOGLE_APPLICATION_CREDENTIALS)
 * to update the push subscription endpoint, without needing the gcloud CLI.
 *
 * Usage:
 *   node mcp/webhook-server/scripts/update-pubsub-endpoint.js
 *
 * Environment:
 *   GOOGLE_APPLICATION_CREDENTIALS — path to service account JSON key
 *   GMAIL_PUBSUB_SUBSCRIPTION     — subscription name (e.g., gmail-notifications-sub)
 *   WEBHOOK_BASE_URL              — tunnel URL to point the push to
 */

import { google } from "googleapis";
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

  console.log(`📧 Updating Pub/Sub push endpoint...`);
  console.log(`   Subscription: ${subscription}`);
  console.log(`   Push endpoint: ${pushEndpoint}`);

  // Authenticate with service account
  const auth = new google.auth.GoogleAuth({
    keyFile: resolvedPath,
    scopes: ["https://www.googleapis.com/auth/pubsub"],
  });

  const pubsub = google.pubsub({ version: "v1", auth });

  const name = `projects/agent-workflow-497323/subscriptions/${subscription}`;

  try {
    await pubsub.projects.subscriptions.patch({
      name,
      updateMask: "pushConfig",
      requestBody: {
        pushConfig: {
          pushEndpoint,
          // No auth needed — the endpoint is public via Cloudflare
          oidcToken: undefined,
        },
      },
    });
    console.log(`✅ Pub/Sub push endpoint updated successfully`);
  } catch (err) {
    console.error(`❌ Failed to update Pub/Sub subscription: ${err.message}`);
    if (err.response?.data) {
      console.error(`   Details: ${JSON.stringify(err.response.data)}`);
    }
    process.exit(1);
  }
}

main().catch(console.error);
