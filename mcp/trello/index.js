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
import { sanitizeObject } from "../../scripts/sanitize.mjs";
import { trelloTools } from "../../shared/tool-manifest.js";

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

/**
 * Wrap text into a sanitized MCP content response.
 * Strips prompt injection patterns from external data before the agent sees it.
 */
function safeText(text) {
  return { type: "text", text: text };
}

/**
 * Sanitize and stringify an API response object.
 */
function safeJson(data) {
  const sanitized = sanitizeObject(data, { auditSource: "mcp/trello" });
  return { type: "text", text: JSON.stringify(sanitized, null, 2) };
}

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
    case "trello_get_card_actions": {
      result = await handleGetCardActions(args);
      const actions = result.content?.[0]?.text ? JSON.parse(result.content[0].text) : [];
      summary = `${actions.length} actions`;
      break;
    }
    case "trello_get_checklists": {
      result = await handleGetChecklists(args);
      const items = result.content?.[0]?.text ? JSON.parse(result.content[0].text) : [];
      summary = `${items.length} checklists`;
      break;
    }
    case "trello_create_checklist":
      result = await handleCreateChecklist(args);
      summary = `created checklist "${args.name}"`;
      break;
    case "trello_add_checklist_item":
      result = await handleAddChecklistItem(args);
      summary = `added item "${args.name}"`;
      break;
    case "trello_create_list":
      result = await handleCreateList(args);
      summary = `created list "${args.name}"`;
      break;
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
    return { content: [safeText("Missing required parameters: listId, name")], isError: true };
  }
  try {
    const data = await trelloFetch(trelloUrl(`/lists/${listId}/cards`, { name, desc: desc || "" }), { method: "POST" });
    return { content: [safeJson({ id: data.id, url: data.url, name: data.name })] }; // id/url/name are internal, sanitize defensively
  } catch (err) {
    return { content: [safeText(`Error creating card: ${err.message}`)], isError: true };
  }
}

async function handleGetCard(args) {
  const { cardId } = args;
  if (!cardId) {
    return { content: [safeText("Missing required parameter: cardId")], isError: true };
  }
  try {
    const data = await trelloFetch(trelloUrl(`/cards/${cardId}`, { fields: "all" }));
    return { content: [safeJson(data)] }; // Card names, descriptions, comments may contain injection
  } catch (err) {
    return { content: [safeText(`Error getting card: ${err.message}`)], isError: true };
  }
}

async function handleListCards(args) {
  const { listId } = args;
  if (!listId) {
    return { content: [safeText("Missing required parameter: listId")], isError: true };
  }
  try {
    const data = await trelloFetch(trelloUrl(`/lists/${listId}/cards`, { fields: "name,id,url,dateLastActivity" }));
    return { content: [safeJson(data)] }; // Card names may contain injection
  } catch (err) {
    return { content: [safeText(`Error listing cards: ${err.message}`)], isError: true };
  }
}

async function handleAddComment(args) {
  const { cardId, text } = args;
  if (!cardId || !text) {
    return { content: [safeText("Missing required parameters: cardId, text")], isError: true };
  }
  try {
    const data = await trelloFetch(trelloUrl(`/cards/${cardId}/actions/comments`, { text }), { method: "POST" });
    return { content: [safeJson({ id: data.id })] }; // Internal ID, sanitize defensively
  } catch (err) {
    return { content: [safeText(`Error adding comment: ${err.message}`)], isError: true };
  }
}

async function handleUpdateCard(args) {
  const { cardId, ...fields } = args;
  if (!cardId) {
    return { content: [safeText("Missing required parameter: cardId")], isError: true };
  }
  try {
    const data = await trelloFetch(trelloUrl(`/cards/${cardId}`, fields), { method: "PUT" });
    return { content: [safeJson({ id: data.id, name: data.name })] }; // Card name may contain injection
  } catch (err) {
    return { content: [safeText(`Error updating card: ${err.message}`)], isError: true };
  }
}

async function handleGetLists(args) {
  const { boardId } = args;
  if (!boardId) {
    return { content: [safeText("Missing required parameter: boardId")], isError: true };
  }
  try {
    const data = await trelloFetch(trelloUrl(`/boards/${boardId}/lists`, { fields: "name,id" }));
    return { content: [safeJson(data)] }; // List names may contain injection
  } catch (err) {
    return { content: [safeText(`Error getting lists: ${err.message}`)], isError: true };
  }
}

/* ── Tool definitions (from shared manifest) ── */

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: trelloTools,
}));

async function handleGetCardActions(args) {
  const { cardId, filter } = args;
  if (!cardId) {
    return { content: [safeText("Missing required parameter: cardId")], isError: true };
  }
  try {
    const params = { filter: filter || "commentCard", fields: "data,date,type" };
    const data = await trelloFetch(trelloUrl(`/cards/${cardId}/actions`, params));
    return { content: [safeJson(data)] }; // Card comments are user-generated — sanitize
  } catch (err) {
    return { content: [safeText(`Error getting card actions: ${err.message}`)], isError: true };
  }
}

async function handleGetChecklists(args) {
  const { cardId } = args;
  if (!cardId) {
    return { content: [safeText("Missing required parameter: cardId")], isError: true };
  }
  try {
    const data = await trelloFetch(trelloUrl(`/cards/${cardId}/checklists`));
    return { content: [safeJson(data)] };
  } catch (err) {
    return { content: [safeText(`Error getting checklists: ${err.message}`)], isError: true };
  }
}

async function handleCreateChecklist(args) {
  const { cardId, name } = args;
  if (!cardId || !name) {
    return { content: [safeText("Missing required parameters: cardId, name")], isError: true };
  }
  try {
    const data = await trelloFetch(trelloUrl(`/cards/${cardId}/checklists`, { name }), { method: "POST" });
    return { content: [safeJson({ id: data.id, name: data.name, idCard: data.idCard })] };
  } catch (err) {
    return { content: [safeText(`Error creating checklist: ${err.message}`)], isError: true };
  }
}

async function handleAddChecklistItem(args) {
  const { checklistId, name, checked } = args;
  if (!checklistId || !name) {
    return { content: [safeText("Missing required parameters: checklistId, name")], isError: true };
  }
  try {
    const data = await trelloFetch(trelloUrl(`/checklists/${checklistId}/checkItems`, { name, checked: checked ? "true" : "false" }), {
      method: "POST",
    });
    return { content: [safeJson({ id: data.id, name: data.name, state: data.state })] };
  } catch (err) {
    return { content: [safeText(`Error adding checklist item: ${err.message}`)], isError: true };
  }
}

async function handleCreateList(args) {
  const { boardId, name } = args;
  if (!boardId || !name) {
    return { content: [safeText("Missing required parameters: boardId, name")], isError: true };
  }
  try {
    const data = await trelloFetch(trelloUrl(`/boards/${boardId}/lists`, { name }), { method: "POST" });
    return { content: [safeJson({ id: data.id, name: data.name })] };
  } catch (err) {
    return { content: [safeText(`Error creating list: ${err.message}`)], isError: true };
  }
}

/* ── Start ── */

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("✅ Trello MCP Server running on stdio");
