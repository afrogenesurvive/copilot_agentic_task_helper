#!/usr/bin/env node

/**
 * WhatsApp MCP Server
 *
 * Meta WhatsApp Cloud API access for the Copilot agent: send texts/templates,
 * list the WhatsApp Business Account's phone numbers (test + real/burner),
 * read inbound messages persisted from the /webhooks/whatsapp/push webhook,
 * and check a number's connection status.
 *
 * Official Cloud API only (no Baileys/unofficial clients). One WABA holds the
 * free test number AND a real (burner) number — both share the same system-user
 * token. The active "from" number defaults to WHATSAPP_PHONE_NUMBER_ID; each
 * tool accepts an optional `phoneNumberId` argument to pick test vs live.
 *
 * Environment variables (from config.json/.env via shared/config-loader.cjs):
 *   WHATSAPP_ACCESS_TOKEN        (required) — system-user token with
 *                                whatsapp_business_messaging (+ management)
 *   WHATSAPP_WABA_ID             (required for whatsapp_list_numbers)
 *   WHATSAPP_PHONE_NUMBER_ID     (default "from" number for sends)
 *   WHATSAPP_TEST_PHONE_NUMBER_ID(optional) — the free sandbox number id
 *   WHATSAPP_API_VERSION         (optional, default v25.0)
 *   WHATSAPP_APP_SECRET          (webhook signature verify — used by the
 *                                webhook handler, not this server)
 *   WHATSAPP_WEBHOOK_VERIFY_TOKEN(webhook hub.challenge verify)
 *
 * API base: https://graph.facebook.com/<API_VERSION>
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
 *
 * Tool schemas live in shared/tool-manifest.js (whatsappTools) so the Electron
 * chat agent and agent runner share the same definitions.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import config from "../../shared/config-loader.cjs";
config.loadEnvInto(process.env);
import { sanitizeObject } from "../../scripts/sanitize.stub.mjs";
import { toolCall } from "../../shared/logger.mjs";
import { whatsappTools } from "../../shared/tool-manifest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");
const INBOX_DIR = path.join(REPO, "safe", "whatsapp", "inbox");

const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || "";
const WABA_ID = process.env.WHATSAPP_WABA_ID || "";
const ACTIVE_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";
const TEST_PHONE_ID = process.env.WHATSAPP_TEST_PHONE_NUMBER_ID || "";
const API_VERSION = process.env.WHATSAPP_API_VERSION || "v25.0";

/* ── Response helpers (sanitized) ── */

function safeText(text) {
  return { type: "text", text };
}

function safeJson(data) {
  const sanitized = sanitizeObject(data, { auditSource: "mcp/whatsapp" });
  return { type: "text", text: JSON.stringify(sanitized, null, 2) };
}

function logToolCall(name, args, summary) {
  toolCall("mcp", "whatsapp", { name, args, response: summary });
  console.error(`[mcp] whatsapp/${name} → ${String(summary).slice(0, 80)}`);
}

/* ── WhatsApp Graph client ── */

function phoneRequired(args) {
  const id = resolvePhoneId(args);
  return id
    ? null
    : {
        content: [
          safeText(
            "No phone number target — pass phoneNumberId or set WHATSAPP_PHONE_NUMBER_ID in .env. Run whatsapp_list_numbers to find your test/live number IDs."
          ),
        ],
        isError: true,
      };
}

/** Resolve which "from" phone number a call targets: arg override > env default. */
function resolvePhoneId(args) {
  return (args && args.phoneNumberId) || ACTIVE_PHONE_ID;
}

async function graphFetch(pathname, { method = "GET", body } = {}) {
  if (!TOKEN) {
    throw new Error(
      "WHATSAPP_ACCESS_TOKEN is not set. Add it to the repo-root config.json/.env (Meta app → WhatsApp → API Setup → system user token), then reload the MCP server."
    );
  }
  const url = `https://graph.facebook.com/${API_VERSION}${pathname}`;
  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }
  if (!resp.ok) {
    const err = (json && json.error) || {};
    const detail = err.message || (json && (json.message || json.error)) || resp.statusText;
    throw new Error(`WhatsApp API ${resp.status}${err.code ? ` (${err.code})` : ""}: ${detail}`);
  }
  return json;
}

/* ── Tool implementations ── */

async function handleStatus(args) {
  const info = {
    configured: {
      accessToken: Boolean(TOKEN),
      wabaId: WABA_ID || null,
      activePhoneId: ACTIVE_PHONE_ID || null,
      testPhoneId: TEST_PHONE_ID || null,
      apiVersion: API_VERSION,
    },
    connected: false,
  };
  const phoneId = resolvePhoneId(args);
  if (TOKEN && phoneId) {
    try {
      const data = await graphFetch(`/${phoneId}?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status,status`);
      info.connected = Boolean(data && data.status === "CONNECTED");
      info.activeNumber = {
        phoneNumberId: phoneId,
        displayPhoneNumber: data && data.display_phone_number,
        verifiedName: data && data.verified_name,
        qualityRating: data && data.quality_rating,
        codeVerificationStatus: data && data.code_verification_status,
        status: data && data.status,
      };
    } catch (err) {
      info.activeNumber = { phoneNumberId: phoneId, error: err.message };
    }
  } else {
    info.hint =
      "Set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID in config.json/.env, then reload the MCP server. Run whatsapp_list_numbers to find your number IDs.";
  }
  return { content: [safeJson(info)] };
}

async function handleListNumbers(args) {
  const wabaId = (args && args.wabaId) || WABA_ID;
  if (!wabaId) {
    return {
      content: [safeText("No WhatsApp Business Account — pass wabaId or set WHATSAPP_WABA_ID in .env")],
      isError: true,
    };
  }
  const data = await graphFetch(`/${wabaId}/phone_numbers`);
  const trimmed = ((data && data.data) || []).map((n) => ({
    phoneNumberId: n.id,
    displayPhoneNumber: n.display_phone_number,
    verifiedName: n.verified_name,
    qualityRating: n.quality_rating,
    codeVerificationStatus: n.code_verification_status,
  }));
  return { content: [safeJson(trimmed)] };
}

/** Inbound history is persisted (sanitized) by the webhook handler to
 *  safe/whatsapp/inbox/*.jsonl — Cloud API GET /messages only returns outbound,
 *  so the local inbox is the source of truth for received messages. */
function readInboxRecords(limit) {
  let files = [];
  try {
    files = fs.existsSync(INBOX_DIR) ? fs.readdirSync(INBOX_DIR).filter((f) => f.endsWith(".jsonl")).sort().reverse() : [];
  } catch {
    return [];
  }
  const records = [];
  const want = Math.max(Number(limit) || 20, 1);
  for (const file of files) {
    if (records.length >= want * 10) break;
    let lines = [];
    try {
      lines = fs.readFileSync(path.join(INBOX_DIR, file), "utf8").split("\n").filter(Boolean);
    } catch {
      continue;
    }
    for (const line of lines.reverse()) {
      try {
        records.push(JSON.parse(line));
      } catch {
        /* skip malformed line */
      }
      if (records.length >= want * 10) break;
    }
  }
  return records;
}

async function handleListMessages(args) {
  const contact = (args && args.contact) || null;
  const limit = Math.min(Math.max(Number((args && args.limit) || 20), 1), 100);
  const records = readInboxRecords(limit * 10);
  const filtered = contact ? records.filter((r) => r.waId === contact || r.from === contact || r.to === contact) : records;
  const messages = filtered.slice(0, limit).map((r) => ({
    direction: r.direction || "in",
    waId: r.waId || null,
    from: r.from || null,
    to: r.to || null,
    ts: r.ts || null,
    type: r.type || "text",
    text: r.text || r.body || null,
    messageId: r.messageId || null,
  }));
  return { content: [safeJson({ total: filtered.length, count: messages.length, messages })] };
}

async function handleSendText(args) {
  const to = (args && args.to) || "";
  const body = (args && args.body) || "";
  if (!to) return { content: [safeText("Missing required parameter: to (E.164, e.g. +15551234567)")], isError: true };
  if (!body) return { content: [safeText("Missing required parameter: body")], isError: true };
  const bad = phoneRequired(args);
  if (bad) return bad;
  const phoneId = resolvePhoneId(args);
  const data = await graphFetch(`/${phoneId}/messages`, {
    method: "POST",
    body: {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: Boolean(args.previewUrl), body },
    },
  });
  return {
    content: [
      safeJson({
        ok: true,
        to,
        messageId: data && data.messages && data.messages[0] && data.messages[0].id,
        phoneNumberId: phoneId,
      }),
    ],
  };
}

async function handleSendTemplate(args) {
  const to = (args && args.to) || "";
  const templateName = (args && args.templateName) || "";
  const language = (args && args.language) || "en_US";
  if (!to) return { content: [safeText("Missing required parameter: to (E.164, e.g. +15551234567)")], isError: true };
  if (!templateName) return { content: [safeText("Missing required parameter: templateName")], isError: true };
  const bad = phoneRequired(args);
  if (bad) return bad;
  const params = (args && args.params) || [];
  const phoneId = resolvePhoneId(args);
  const template = { name: templateName, language: { code: language } };
  if (Array.isArray(params) && params.length > 0) {
    template.components = [{ type: "body", parameters: params.map((p) => ({ type: "text", text: String(p) })) }];
  }
  const data = await graphFetch(`/${phoneId}/messages`, {
    method: "POST",
    body: { messaging_product: "whatsapp", recipient_type: "individual", to, type: "template", template },
  });
  return {
    content: [
      safeJson({
        ok: true,
        to,
        templateName,
        messageId: data && data.messages && data.messages[0] && data.messages[0].id,
        phoneNumberId: phoneId,
      }),
    ],
  };
}

async function handleMarkRead(args) {
  const messageId = (args && args.messageId) || "";
  if (!messageId) return { content: [safeText("Missing required parameter: messageId (wamid)")], isError: true };
  const bad = phoneRequired(args);
  if (bad) return bad;
  const phoneId = resolvePhoneId(args);
  await graphFetch(`/${phoneId}/messages`, {
    method: "POST",
    body: { messaging_product: "whatsapp", status: "read", message_id: messageId },
  });
  return { content: [safeJson({ ok: true, messageId, phoneNumberId: phoneId })] };
}

/* ── MCP Server ── */

const server = new Server({ name: "whatsapp-mcp-server", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: whatsappTools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  let result;
  let summary;
  try {
    switch (name) {
      case "whatsapp_status":
        result = await handleStatus(args);
        summary = "status checked";
        break;
      case "whatsapp_list_numbers":
        result = await handleListNumbers(args);
        summary = "numbers listed";
        break;
      case "whatsapp_list_messages":
        result = await handleListMessages(args);
        summary = "messages listed";
        break;
      case "whatsapp_send_text":
        result = await handleSendText(args);
        summary = "text sent";
        break;
      case "whatsapp_send_template":
        result = await handleSendTemplate(args);
        summary = "template sent";
        break;
      case "whatsapp_mark_read":
        result = await handleMarkRead(args);
        summary = "marked read";
        break;
      default:
        result = { content: [safeText(`Unknown tool: ${name}`)], isError: true };
        summary = "unknown tool";
    }
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    const friendly = msg.startsWith("WHATSAPP_ACCESS_TOKEN")
      ? msg
      : `Error: ${msg}`;
    result = { content: [safeText(friendly)], isError: true };
    summary = "error";
  }
  logToolCall(name, args, summary);
  return result;
});

/* ── Start ── */

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("✅ WhatsApp MCP Server running on stdio");
