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
import { google } from "googleapis";
import { google as googleAuth } from "google-auth-library";
import "dotenv/config";

/* ── Auth ── */

function getAuthClient() {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    throw new Error("Missing Gmail OAuth2 credentials in environment");
  }
  const oauth2 = new googleAuth.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
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

/* ── MCP Server ── */

const server = new Server({ name: "gmail-mcp-server", version: "1.0.0" }, { capabilities: { tools: {} } });

/* ── Tool: list messages ── */

server.setRequestHandler({ method: "tools/call", params: { name: "gmail_list_messages" } }, async (request) => {
  const args = request.params?.arguments || {};
  const query = args.query || "";
  const maxResults = Math.min(args.maxResults || 10, 100);
  const userId = process.env.GMAIL_USER || "me";

  try {
    const res = await gmail.users.messages.list({
      userId,
      q: query,
      maxResults,
    });

    const messages = res.data.messages || [];
    const detailed = await Promise.all(
      messages.map(async (m) => {
        const detail = await gmail.users.messages.get({ userId, id: m.id, format: "metadata" });
        return formatMessage(detail.data, "metadata");
      }),
    );

    return {
      content: [{ type: "text", text: JSON.stringify(detailed, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error listing messages: ${err.message}` }],
      isError: true,
    };
  }
});

/* ── Tool: get message ── */

server.setRequestHandler({ method: "tools/call", params: { name: "gmail_get_message" } }, async (request) => {
  const args = request.params?.arguments || {};
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
    const formatted = formatMessage(res.data, format);

    return {
      content: [{ type: "text", text: JSON.stringify(formatted, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error getting message: ${err.message}` }],
      isError: true,
    };
  }
});

/* ── Tool: send message ── */

server.setRequestHandler({ method: "tools/call", params: { name: "gmail_send_message" } }, async (request) => {
  const args = request.params?.arguments || {};
  const { to, subject, body } = args;
  if (!to || !subject || !body) {
    return {
      content: [{ type: "text", text: "Missing required parameters: to, subject, body" }],
      isError: true,
    };
  }

  const userId = process.env.GMAIL_USER || "me";

  try {
    // Build raw MIME message
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

    const res = await gmail.users.messages.send({
      userId,
      requestBody: { raw: encoded },
    });

    return {
      content: [{ type: "text", text: JSON.stringify({ id: res.data.id, threadId: res.data.threadId }, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error sending message: ${err.message}` }],
      isError: true,
    };
  }
});

/* ── Tool definitions ── */

server.setRequestHandler({ method: "tools/list" }, async () => ({
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
