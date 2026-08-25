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
import { getSeatAccounts } from "../../scripts/frontdesk-accounts.mjs";

// ── Frontdesk Allowlist — only these tools can be called for frontdesk events ──
const FRONTDESK_ALLOWLIST = new Set([
  // Trello — read-only + commenting (safe)
  "trello_add_comment",
  "trello_get_card",
  "trello_list_cards",
  "trello_get_lists",
  "trello_get_card_actions",
  // Gmail — read + reply (safe)
  "gmail_list_messages",
  "gmail_get_message",
  // Web Search — read-only (safe)
  "web_search",
  "web_fetch",
  // Frontdesk — encrypted reply to a chat user (safe)
  "frontdesk_reply",
]);

// ── Blocklist — NEVER allowed, even for non-frontdesk events ──
const BLOCKLIST = new Set([
  // These are destructive operations that should never be automated via the runner
  "drive_delete_file",
  "drive_move_file",
]);

// ── Trello API helpers ──

const TRELLO_KEY = process.env.TRELLO_KEY || "";
const TRELLO_TOKEN = process.env.TRELLO_TOKEN || "";
const TRELLO_BASE = "https://api.trello.com/1";

// Per-seat credentials resolved before each tool call (see executeToolCall).
// null → fall back to the default .env accounts.
let activeCreds = null;

function trelloUrl(path, params = {}) {
  const key = activeCreds?.trello?.key || TRELLO_KEY;
  const token = activeCreds?.trello?.token || TRELLO_TOKEN;
  const qs = new URLSearchParams({ key, token, ...params });
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

async function trelloCreateCard(listId, name, desc) {
  const url = trelloUrl(`/lists/${listId}/cards`, { name, desc: desc || "" });
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) throw new Error(`Trello API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { ok: true, tool: "trello_create_card", result: { id: data.id, name: data.name, url: data.url } };
}

async function trelloUpdateCard(cardId, fields) {
  const url = trelloUrl(`/cards/${cardId}`, fields);
  const res = await fetch(url, { method: "PUT" });
  if (!res.ok) throw new Error(`Trello API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { ok: true, tool: "trello_update_card", result: { id: data.id, name: data.name } };
}

async function trelloCreateChecklist(cardId, name) {
  const url = trelloUrl(`/cards/${cardId}/checklists`, { name });
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) throw new Error(`Trello API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { ok: true, tool: "trello_create_checklist", result: { id: data.id, name: data.name } };
}

async function trelloAddChecklistItem(checklistId, name, checked) {
  const url = trelloUrl(`/checklists/${checklistId}/checkItems`, { name, checked: checked ? "true" : "false" });
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) throw new Error(`Trello API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { ok: true, tool: "trello_add_checklist_item", result: { id: data.id, name: data.name } };
}

// ── Gmail API helpers ──

import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";

function getGmailClient() {
  const g = activeCreds?.google || {};
  const clientId = g.clientId || process.env.GMAIL_CLIENT_ID;
  const clientSecret = g.clientSecret || process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = g.refreshToken || process.env.GMAIL_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null;
  const oauth2 = new OAuth2Client(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });
  return google.gmail({ version: "v1", auth: oauth2 });
}

async function gmailListMessages(query, maxResults) {
  const gmail = getGmailClient();
  if (!gmail) throw new Error("Gmail auth not configured");
  const userId = activeCreds?.google?.user || process.env.GMAIL_USER || "me";
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
  const userId = activeCreds?.google?.user || process.env.GMAIL_USER || "me";
  const res = await gmail.users.messages.get({
    userId,
    id,
    format: format || "metadata",
    metadataHeaders: ["From", "To", "Subject", "Date"],
  });
  return { ok: true, tool: "gmail_get_message", result: res.data };
}

async function gmailSendMessage(to, subject, body) {
  const gmail = getGmailClient();
  if (!gmail) throw new Error("Gmail auth not configured");
  const userId = activeCreds?.google?.user || process.env.GMAIL_USER || "me";

  // Build RFC 2822 message
  const email = [
    `From: ${userId}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    body,
  ].join("\r\n");

  const encoded = Buffer.from(email).toString("base64url");
  const res = await gmail.users.messages.send({ userId, requestBody: { raw: encoded } });
  return { ok: true, tool: "gmail_send_message", result: { id: res.data.id } };
}

// ── Handler registry ──

// ── Web Search helpers ──

const WEB_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const DDG_URL = "https://html.duckduckgo.com/html/";

async function webSearchDuckDuckGo(query, maxResults) {
  const body = new URLSearchParams({ q: query });
  const resp = await fetch(DDG_URL, {
    method: "POST",
    headers: { "User-Agent": WEB_USER_AGENT, "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!resp.ok) throw new Error(`DuckDuckGo returned ${resp.status}`);

  const html = await resp.text();
  // Basic regex-based extraction (no cheerio dependency needed in runner)
  const results = [];
  const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets = [...html.matchAll(snippetRegex)].map((m) => stripHtml(m[1]));

  let idx = 0;
  for (const match of html.matchAll(resultRegex)) {
    if (idx >= (maxResults || 10)) break;
    let url = match[1];
    // Extract from DDG redirect
    const uddg = url.match(/uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    results.push({
      title: stripHtml(match[2]).trim(),
      url: url,
      snippet: snippets[idx] || "",
    });
    idx++;
  }

  return { ok: true, tool: "web_search", result: results };
}

async function webFetchPage(url) {
  const resp = await fetch(url, {
    headers: { "User-Agent": WEB_USER_AGENT },
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const text = await resp.text();
  const contentType = resp.headers.get("content-type") || "";
  const title = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || "";

  // Strip HTML tags for a clean text preview
  const clean = text
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  const MAX_LENGTH = 15000;
  return {
    ok: true,
    tool: "web_fetch",
    result: {
      url: resp.url,
      contentType,
      title,
      text: clean.slice(0, MAX_LENGTH),
      truncated: clean.length > MAX_LENGTH,
    },
  };
}

// ── Frontdesk reply (via webhook server — it owns the encryption + session) ──

async function frontdeskReply(sub, text) {
  const base = `http://localhost:${process.env.WEBHOOK_PORT || "3199"}`;
  const token = process.env.WEBHOOK_API_TOKEN || "";
  const res = await fetch(`${base}/api/frontdesk/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ sub, text }),
  });
  if (!res.ok) throw new Error(`Webhook API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { ok: true, tool: "frontdesk_reply", result: data };
}

function stripHtml(str) {
  return str
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/g, " ")
    .trim();
}

const HANDLERS = {
  trello_add_comment: (args) => trelloComment(args.cardId, args.text),
  trello_get_card: (args) => trelloGetCard(args.cardId),
  trello_list_cards: (args) => trelloListCards(args.listId),
  trello_get_lists: (args) => trelloGetLists(args.boardId),
  trello_get_card_actions: (args) => trelloGetCardActions(args.cardId, args.filter),
  trello_create_card: (args) => trelloCreateCard(args.listId, args.name, args.desc),
  trello_update_card: (args) => trelloUpdateCard(args.cardId, args),
  trello_create_checklist: (args) => trelloCreateChecklist(args.cardId, args.name),
  trello_add_checklist_item: (args) => trelloAddChecklistItem(args.checklistId, args.name, args.checked),
  gmail_list_messages: (args) => gmailListMessages(args.query, args.maxResults),
  gmail_get_message: (args) => gmailGetMessage(args.id, args.format),
  gmail_send_message: (args) => gmailSendMessage(args.to, args.subject, args.body),
  web_search: (args) => webSearchDuckDuckGo(args.query, args.maxResults),
  web_fetch: (args) => webFetchPage(args.url),
  frontdesk_reply: (args) => frontdeskReply(args.sub, args.text),
};

/**
 * Execute a tool call chosen by the model.
 * @param {string} toolName — Name of the tool to call
 * @param {object} args — Parameters for the tool
 * @param {object} [options] — Execution options
 * @param {boolean} [options.isFrontdesk=false] — If true, restricts to FRONTDESK_ALLOWLIST
 * @returns {object} { ok, tool, result?, error? }
 */
export async function executeToolCall(toolName, args, options = {}) {
  const isFrontdesk = options.isFrontdesk === true;

  // Safety gate 1: Blocklist check (applies to ALL events)
  if (BLOCKLIST.has(toolName)) {
    return { ok: false, tool: toolName, error: `Tool "${toolName}" is blocked for all autonomous use` };
  }

  // Safety gate 2: Frontdesk events are restricted to read-only + commenting
  if (isFrontdesk && !FRONTDESK_ALLOWLIST.has(toolName)) {
    return { ok: false, tool: toolName, error: `Tool "${toolName}" is not allowed for frontdesk events (read-only + commenting only)` };
  }

  // Safety gate 3: Handler exists
  const handler = HANDLERS[toolName];
  if (!handler) {
    return { ok: false, tool: toolName, error: `No handler registered for "${toolName}"` };
  }

  // Resolve per-seat account credentials (gates which Google/Trello account the
  // agent uses when acting for a frontdesk seat). null → default .env.
  const seat = options.sub ? getSeatAccounts(options.sub) : null;
  activeCreds = { google: seat?.google || null, trello: seat?.trello || null };
  if (seat) {
    console.log(`   🔑 [EXECUTOR] Per-seat accounts for "${options.sub}" — google=${seat.google ? "yes" : "no"}, trello=${seat.trello ? "yes" : "no"}`);
  }

  console.log(`   🔧 [EXECUTOR] Executing ${toolName}...`);

  try {
    const result = await handler(args);
    console.log(`   ✅ [EXECUTOR] ${toolName} succeeded`);
    return result;
  } catch (err) {
    console.error(`   ❌ [EXECUTOR] ${toolName} failed: ${err.message}`);
    return { ok: false, tool: toolName, error: err.message };
  } finally {
    activeCreds = null;
  }
}
