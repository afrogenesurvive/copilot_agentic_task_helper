#!/usr/bin/env node

/**
 * Trello MCP Server
 *
 * Provides tools for Trello board, list, and card management.
 * Uses the Model Context Protocol (stdio transport) for Copilot integration.
 *
 * Environment variables (from .env or envFile):
 *   TRELLO_KEY, TRELLO_TOKEN, TRELLO_BASE_URL
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fetch from "node-fetch";
import "dotenv/config";

const TRELLO_KEY = process.env.TRELLO_KEY || "";
const TRELLO_TOKEN = process.env.TRELLO_TOKEN || "";
const BASE_URL = process.env.TRELLO_BASE_URL || "https://api.trello.com/1";

function trelloUrl(path, params = {}) {
  const qs = new URLSearchParams({ key: TRELLO_KEY, token: TRELLO_TOKEN, ...params });
  return `${BASE_URL}${path}?${qs}`;
}

async function trelloFetch(url, options = {}) {
  const resp = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Trello API error ${resp.status}: ${text}`);
  }
  return resp.json();
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
    ["tool_call", `trello/${name} input=${argsStr}`],
    ["tool_response", `trello/${name} output=${respStr}`],
  ]) {
    const line = `[${ts}] EVENT name=${eventName} details=${details}`;
    const entry = { timestamp: ts, name: eventName, details };
    fs.appendFileSync(path.join(LOG_DIR, `${today}_verbose.log`), JSON.stringify(entry) + "\n");
    fs.appendFileSync(path.join(LOG_DIR, `${today}.log`), line + "\n");
    console.error(`[mcp] ${line}`);
  }
}

/* ── MCP Server ── */

const server = new Server({ name: "trello-mcp-server", version: "1.0.0" }, { capabilities: { tools: {} } });

/* ── Tool call handler (single dispatch) ── */

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  let result;
  let summary;
  switch (name) {
    case "trello_create_card":
      result = await handleCreateCard(args);
      summary = `created "${args.name}"`;
      break;
    case "trello_get_card":
      result = await handleGetCard(args);
      summary = "fetched";
      break;
    case "trello_list_cards": {
      result = await handleListCards(args);
      const n = result.content?.[0]?.text ? JSON.parse(result.content[0].text).length : 0;
      summary = `${n} cards`;
      break;
    }
    case "trello_add_comment":
      result = await handleAddComment(args);
      summary = "commented";
      break;
    case "trello_update_card":
      result = await handleUpdateCard(args);
      summary = "updated";
      break;
    case "trello_get_lists": {
      result = await handleGetLists(args);
      const n = result.content?.[0]?.text ? JSON.parse(result.content[0].text).length : 0;
      summary = `${n} lists`;
      break;
    }
    default:
      result = { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      summary = "unknown tool";
  }
  logToolCall(name, args, summary);
  return result;
});

async function handleCreateCard(args) {
  const { listId, name, desc } = args;
  if (!listId || !name) {
    return { content: [{ type: "text", text: "Missing required parameters: listId, name" }], isError: true };
  }
  try {
    const data = await trelloFetch(trelloUrl(`/lists/${listId}/cards`, { name, desc: desc || "" }), { method: "POST" });
    return { content: [{ type: "text", text: JSON.stringify({ id: data.id, url: data.url, name: data.name }, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error creating card: ${err.message}` }], isError: true };
  }
}

async function handleGetCard(args) {
  const { cardId } = args;
  if (!cardId) {
    return { content: [{ type: "text", text: "Missing required parameter: cardId" }], isError: true };
  }
  try {
    const data = await trelloFetch(trelloUrl(`/cards/${cardId}`, { fields: "all" }));
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error getting card: ${err.message}` }], isError: true };
  }
}

async function handleListCards(args) {
  const { listId } = args;
  if (!listId) {
    return { content: [{ type: "text", text: "Missing required parameter: listId" }], isError: true };
  }
  try {
    const data = await trelloFetch(trelloUrl(`/lists/${listId}/cards`, { fields: "name,id,url,dateLastActivity" }));
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error listing cards: ${err.message}` }], isError: true };
  }
}

async function handleAddComment(args) {
  const { cardId, text } = args;
  if (!cardId || !text) {
    return { content: [{ type: "text", text: "Missing required parameters: cardId, text" }], isError: true };
  }
  try {
    const data = await trelloFetch(trelloUrl(`/cards/${cardId}/actions/comments`, { text }), { method: "POST" });
    return { content: [{ type: "text", text: JSON.stringify({ id: data.id }, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error adding comment: ${err.message}` }], isError: true };
  }
}

async function handleUpdateCard(args) {
  const { cardId, ...fields } = args;
  if (!cardId) {
    return { content: [{ type: "text", text: "Missing required parameter: cardId" }], isError: true };
  }
  try {
    const data = await trelloFetch(trelloUrl(`/cards/${cardId}`, fields), { method: "PUT" });
    return { content: [{ type: "text", text: JSON.stringify({ id: data.id, name: data.name }, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error updating card: ${err.message}` }], isError: true };
  }
}

async function handleGetLists(args) {
  const { boardId } = args;
  if (!boardId) {
    return { content: [{ type: "text", text: "Missing required parameter: boardId" }], isError: true };
  }
  try {
    const data = await trelloFetch(trelloUrl(`/boards/${boardId}/lists`, { fields: "name,id" }));
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error getting lists: ${err.message}` }], isError: true };
  }
}

/* ── Tool definitions ── */

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "trello_create_card",
      description: "Create a new Trello card in a list",
      inputSchema: {
        type: "object",
        properties: {
          listId: { type: "string", description: "ID of the list to create the card in" },
          name: { type: "string", description: "Card title" },
          desc: { type: "string", description: "Card description (optional)" },
        },
        required: ["listId", "name"],
      },
    },
    {
      name: "trello_get_card",
      description: "Get detailed info about a Trello card",
      inputSchema: {
        type: "object",
        properties: {
          cardId: { type: "string", description: "Card ID" },
        },
        required: ["cardId"],
      },
    },
    {
      name: "trello_list_cards",
      description: "List all cards in a Trello list",
      inputSchema: {
        type: "object",
        properties: {
          listId: { type: "string", description: "List ID" },
        },
        required: ["listId"],
      },
    },
    {
      name: "trello_add_comment",
      description: "Add a comment to a Trello card",
      inputSchema: {
        type: "object",
        properties: {
          cardId: { type: "string", description: "Card ID" },
          text: { type: "string", description: "Comment text" },
        },
        required: ["cardId", "text"],
      },
    },
    {
      name: "trello_update_card",
      description: "Update a Trello card's fields (name, desc, pos, etc.)",
      inputSchema: {
        type: "object",
        properties: {
          cardId: { type: "string", description: "Card ID" },
          name: { type: "string", description: "New card title (optional)" },
          desc: { type: "string", description: "New description (optional)" },
          pos: { type: "string", description: "Position: 'top', 'bottom', or a number (optional)" },
          closed: { type: "boolean", description: "Archive/unarchive card (optional)" },
        },
        required: ["cardId"],
      },
    },
    {
      name: "trello_get_lists",
      description: "Get all lists on a Trello board",
      inputSchema: {
        type: "object",
        properties: {
          boardId: { type: "string", description: "Board ID" },
        },
        required: ["boardId"],
      },
    },
  ],
}));

/* ── Start ── */

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("✅ Trello MCP Server running on stdio");
