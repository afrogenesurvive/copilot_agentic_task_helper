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

/* ── MCP Server ── */

const server = new Server({ name: "trello-mcp-server", version: "1.0.0" }, { capabilities: { tools: {} } });

/* ── Tool: create card ── */

server.setRequestHandler({ method: "tools/call", params: { name: "trello_create_card" } }, async (request) => {
  const args = request.params?.arguments || {};
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
});

/* ── Tool: get card ── */

server.setRequestHandler({ method: "tools/call", params: { name: "trello_get_card" } }, async (request) => {
  const args = request.params?.arguments || {};
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
});

/* ── Tool: list cards ── */

server.setRequestHandler({ method: "tools/call", params: { name: "trello_list_cards" } }, async (request) => {
  const args = request.params?.arguments || {};
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
});

/* ── Tool: add comment ── */

server.setRequestHandler({ method: "tools/call", params: { name: "trello_add_comment" } }, async (request) => {
  const args = request.params?.arguments || {};
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
});

/* ── Tool: update card ── */

server.setRequestHandler({ method: "tools/call", params: { name: "trello_update_card" } }, async (request) => {
  const args = request.params?.arguments || {};
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
});

/* ── Tool: get lists on board ── */

server.setRequestHandler({ method: "tools/call", params: { name: "trello_get_lists" } }, async (request) => {
  const args = request.params?.arguments || {};
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
});

/* ── Tool definitions ── */

server.setRequestHandler({ method: "tools/list" }, async () => ({
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
