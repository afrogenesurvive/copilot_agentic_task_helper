#!/usr/bin/env node

/**
 * Gmail MCP Server
 *
 * Provides tools for reading, searching, and sending Gmail messages.
 * Uses the Model Context Protocol (stdio transport) for Copilot integration.
 *
 * Environment variables (from .env or envFile):
 *   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_USER
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import "dotenv/config";

/* ── Auth ── */

function getAuthClient() {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    throw new Error("Missing Gmail OAuth2 credentials in environment");
  }
  const oauth2 = new OAuth2Client(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  return oauth2;
}

const gmail = google.gmail({ version: "v1", auth: getAuthClient() });

/* ── Helpers ── */

/**
 * Recursively walk the MIME payload tree to extract the plain-text body.
 * Falls back to HTML body, then snippet.
 */
function extractBody(payload) {
  if (!payload) return "";

  // Direct text/plain part
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64").toString("utf8");
  }

  // text/html fallback (we'll keep the HTML if no plain text)
  if (payload.mimeType === "text/html" && payload.body?.data) {
    const html = Buffer.from(payload.body.data, "base64").toString("utf8");
    return html.replace(/<[^>]+>/g, "").trim(); // strip tags
  }

  // Multipart — recurse into parts
  if (payload.parts && payload.parts.length > 0) {
    for (const part of payload.parts) {
      const result = extractBody(part);
      if (result) return result;
    }
  }

  return "";
}

function extractHeader(headers, name) {
  const h = headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return h?.value || "";
}

function formatMessage(msg, format = "full") {
  const { id, threadId, labelIds, internalDate, snippet, payload } = msg;
  const headers = payload?.headers || [];
  const result = {
    id,
    threadId,
    labelIds,
    internalDate,
    snippet,
    headers: {
      from: extractHeader(headers, "from"),
      to: extractHeader(headers, "to"),
      cc: extractHeader(headers, "cc"),
      bcc: extractHeader(headers, "bcc"),
      subject: extractHeader(headers, "subject"),
      date: extractHeader(headers, "date"),
    },
  };

  if (format === "full") {
    result.body = extractBody(payload);
  }

  return result;
}

/* ── Tool call logger ── */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, "..", "..", "logs", "tool_call");

function logToolCall(name, args, response) {
  const ts = new Date().toISOString();
  const today = ts.slice(0, 10);
  const argsStr = JSON.stringify(args).slice(0, 200);
  let respStr = typeof response === "string" ? response : "done";
  // Truncate long JSON responses to keep logs readable
  if (respStr.length > 100) {
    try {
      const parsed = JSON.parse(respStr);
      if (Array.isArray(parsed)) respStr = `${parsed.length} items`;
      else if (parsed.id) respStr = `id=${parsed.id}`;
      else respStr = respStr.slice(0, 100) + "...";
    } catch {
      respStr = respStr.slice(0, 100) + "...";
    }
  }
  fs.mkdirSync(LOG_DIR, { recursive: true });

  for (const [eventName, details] of [
    ["tool_call", `gmail/${name} input=${argsStr}`],
    ["tool_response", `gmail/${name} output=${respStr}`],
  ]) {
    const line = `[${ts}] EVENT name=${eventName} details=${details}`;
    const entry = { timestamp: ts, name: eventName, details };
    fs.appendFileSync(path.join(LOG_DIR, `${today}_verbose.log`), JSON.stringify(entry) + "\n");
    fs.appendFileSync(path.join(LOG_DIR, `${today}.log`), line + "\n");
    console.error(`[mcp] ${line}`);
  }
}

/* ── MCP Server ── */

const server = new Server({ name: "gmail-mcp-server", version: "1.0.0" }, { capabilities: { tools: {} } });

/* ── Tool call handler (single dispatch) ── */

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  let result;
  let summary;
  switch (name) {
    case "gmail_list_messages":
      result = await handleListMessages(args);
      try {
        const d = JSON.parse(result.content?.[0]?.text || "[]");
        summary = `${d.length} messages`;
      } catch {
        summary = "done";
      }
      break;
    case "gmail_get_message":
      result = await handleGetMessage(args);
      try {
        const d = JSON.parse(result.content?.[0]?.text || "{}");
        summary = `"${d.headers?.subject || d.subject || "(no subject)"}" from ${d.headers?.from || d.from || "?"}`.slice(0, 120);
      } catch {
        summary = "done";
      }
      break;
    case "gmail_send_message":
      result = await handleSendMessage(args);
      summary = "sent";
      break;
    default:
      result = { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      summary = "unknown tool";
  }
  logToolCall(name, args, summary);
  return result;
});

async function handleListMessages(args) {
  const query = args.query || "";
  const maxResults = Math.min(args.maxResults || 10, 100);
  const userId = process.env.GMAIL_USER || "me";

  try {
    const res = await gmail.users.messages.list({ userId, q: query, maxResults });
    const messages = res.data.messages || [];
    const detailed = await Promise.all(
      messages.map(async (m) => {
        const detail = await gmail.users.messages.get({ userId, id: m.id, format: "metadata" });
        return formatMessage(detail.data, "metadata");
      }),
    );
    return { content: [{ type: "text", text: JSON.stringify(detailed, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error listing messages: ${err.message}` }], isError: true };
  }
}

async function handleGetMessage(args) {
  const id = args.id;
  if (!id) {
    return { content: [{ type: "text", text: "Missing required parameter: id" }], isError: true };
  }
  const format = args.format || "full";
  const userId = process.env.GMAIL_USER || "me";

  try {
    const res = await gmail.users.messages.get({
      userId,
      id,
      format: format === "metadata" ? "metadata" : "full",
    });
    return { content: [{ type: "text", text: JSON.stringify(formatMessage(res.data, format), null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error getting message: ${err.message}` }], isError: true };
  }
}

async function handleSendMessage(args) {
  const { to, subject, body } = args;
  if (!to || !subject || !body) {
    return { content: [{ type: "text", text: "Missing required parameters: to, subject, body" }], isError: true };
  }
  const userId = process.env.GMAIL_USER || "me";

  try {
    const from = userId;
    const mime = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 7bit",
      "",
      body,
    ].join("\r\n");
    const encoded = Buffer.from(mime).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const res = await gmail.users.messages.send({ userId, requestBody: { raw: encoded } });
    return { content: [{ type: "text", text: JSON.stringify({ id: res.data.id, threadId: res.data.threadId }, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error sending message: ${err.message}` }], isError: true };
  }
}

/* ── Tool definitions ── */

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "gmail_list_messages",
      description: "List Gmail messages matching a search query",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Gmail search query (same as search box syntax)" },
          maxResults: { type: "number", description: "Max results (default 10, max 100)", default: 10 },
        },
      },
    },
    {
      name: "gmail_get_message",
      description: "Get a Gmail message by ID with full body content",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Message ID" },
          format: {
            type: "string",
            enum: ["full", "metadata"],
            description: "'full' returns decoded body + headers; 'metadata' returns headers + snippet",
            default: "full",
          },
        },
        required: ["id"],
      },
    },
    {
      name: "gmail_send_message",
      description: "Send a plain text email",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient email address" },
          subject: { type: "string", description: "Email subject" },
          body: { type: "string", description: "Email body text" },
        },
        required: ["to", "subject", "body"],
      },
    },
  ],
}));

/* ── Start ── */

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("✅ Gmail MCP Server running on stdio");
