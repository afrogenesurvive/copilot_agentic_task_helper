/**
 * Tool Executor — validates and executes tool calls against Trello/Gmail APIs
 *
 * The model chooses a tool and provides params. This module:
 *   1. Checks the tool is on the allowlist (safety gate)
 *   2. Validates required params are present
 *   3. Calls the underlying REST API directly (not via MCP stdio)
 *   4. Returns a result summary
 *
 * Environment: reuses TRELLO_KEY, TRELLO_TOKEN, GMAIL_* from .env
 */

import "dotenv/config";

// ── Allowlist — only these tools can be called autonomously ──
const ALLOWLIST = new Set([
  // Trello — read-only + commenting (safe)
  "trello_add_comment",
  "trello_get_card",
  "trello_list_cards",
  "trello_get_lists",
  "trello_get_card_actions",
  // Gmail — read + reply (safe)
  "gmail_list_messages",
  "gmail_get_message",
]);

// ── Blocklist — these are NEVER allowed ──
const BLOCKLIST = new Set(["trello_create_card", "trello_update_card", "gmail_send_message"]);

// ── Trello API helpers ──

const TRELLO_KEY = process.env.TRELLO_KEY || "";
const TRELLO_TOKEN = process.env.TRELLO_TOKEN || "";
const TRELLO_BASE = "https://api.trello.com/1";

function trelloUrl(path, params = {}) {
  const qs = new URLSearchParams({ key: TRELLO_KEY, token: TRELLO_TOKEN, ...params });
  return `${TRELLO_BASE}${path}?${qs}`;
}

async function trelloComment(cardId, text) {
  const url = trelloUrl(`/cards/${cardId}/actions/comments`, { text });
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) throw new Error(`Trello API ${res.status}: ${await res.text()}`);
  return { ok: true, tool: "trello_add_comment" };
}

async function trelloGetCard(cardId) {
  const url = trelloUrl(`/cards/${cardId}`, { fields: "name,desc,idList,idBoard,due" });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Trello API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { ok: true, tool: "trello_get_card", result: data };
}

async function trelloListCards(listId) {
  const url = trelloUrl(`/lists/${listId}/cards`, { fields: "name,id,idList,due" });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Trello API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { ok: true, tool: "trello_list_cards", result: data };
}

async function trelloGetLists(boardId) {
  const url = trelloUrl(`/boards/${boardId}/lists`, { fields: "name,id" });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Trello API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { ok: true, tool: "trello_get_lists", result: data };
}

async function trelloGetCardActions(cardId, filter) {
  const params = { filter: filter || "commentCard" };
  const url = trelloUrl(`/cards/${cardId}/actions`, params);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Trello API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { ok: true, tool: "trello_get_card_actions", result: data };
}

// ── Gmail API helpers ──

import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";

function getGmailClient() {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) return null;
  const oauth2 = new OAuth2Client(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: "v1", auth: oauth2 });
}

async function gmailListMessages(query, maxResults) {
  const gmail = getGmailClient();
  if (!gmail) throw new Error("Gmail auth not configured");
  const userId = process.env.GMAIL_USER || "me";
  const res = await gmail.users.messages.list({
    userId,
    q: query || "",
    maxResults: maxResults || 10,
  });
  return { ok: true, tool: "gmail_list_messages", result: res.data.messages || [] };
}

async function gmailGetMessage(id, format) {
  const gmail = getGmailClient();
  if (!gmail) throw new Error("Gmail auth not configured");
  const userId = process.env.GMAIL_USER || "me";
  const res = await gmail.users.messages.get({
    userId,
    id,
    format: format || "metadata",
    metadataHeaders: ["From", "To", "Subject", "Date"],
  });
  return { ok: true, tool: "gmail_get_message", result: res.data };
}

// ── Handler registry ──

const HANDLERS = {
  trello_add_comment: (args) => trelloComment(args.cardId, args.text),
  trello_get_card: (args) => trelloGetCard(args.cardId),
  trello_list_cards: (args) => trelloListCards(args.listId),
  trello_get_lists: (args) => trelloGetLists(args.boardId),
  trello_get_card_actions: (args) => trelloGetCardActions(args.cardId, args.filter),
  gmail_list_messages: (args) => gmailListMessages(args.query, args.maxResults),
  gmail_get_message: (args) => gmailGetMessage(args.id, args.format),
};

/**
 * Execute a tool call chosen by the model.
 * Validates against allowlist before executing.
 * @param {string} toolName — Name of the tool to call (e.g., "trello_add_comment")
 * @param {object} args — Parameters for the tool
 * @returns {object} { ok, tool, result?, error? }
 */
export async function executeToolCall(toolName, args) {
  // Safety gate 1: Blocklist check
  if (BLOCKLIST.has(toolName)) {
    return { ok: false, tool: toolName, error: `Tool "${toolName}" is blocked for autonomous use` };
  }

  // Safety gate 2: Allowlist check
  if (!ALLOWLIST.has(toolName)) {
    return { ok: false, tool: toolName, error: `Tool "${toolName}" not in allowlist` };
  }

  // Safety gate 3: Handler exists
  const handler = HANDLERS[toolName];
  if (!handler) {
    return { ok: false, tool: toolName, error: `No handler registered for "${toolName}"` };
  }

  console.log(`   🔧 [EXECUTOR] Executing ${toolName}...`);

  try {
    const result = await handler(args);
    console.log(`   ✅ [EXECUTOR] ${toolName} succeeded`);
    return result;
  } catch (err) {
    console.error(`   ❌ [EXECUTOR] ${toolName} failed: ${err.message}`);
    return { ok: false, tool: toolName, error: err.message };
  }
}
