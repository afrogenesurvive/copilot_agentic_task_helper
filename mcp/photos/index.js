#!/usr/bin/env node

/**
 * Google Photos Picker MCP Server
 *
 * Interactive, user-selected access to a user's REAL Google Photos library.
 *
 * WHY PICKER-ONLY: on 2025-03-31 Google removed the Library API's
 * photoslibrary / photoslibrary.readonly scopes — the Library API can now only
 * manage content THIS APP creates (uploads), and this project deliberately does
 * NOT use uploads. The only way to touch pre-existing library photos is the
 * Google Photos Picker API: a human opens a Google-hosted picker page and
 * selects a batch (up to 2000 items), then this server lists/downloads exactly
 * what they chose. Whole-library enumeration is NOT possible via any Google API.
 *
 * FLOW (mandatory human pause):
 *   1. photos_picker_start    → creates a session, returns a pickerUri + id
 *   2. USER opens pickerUri in a browser signed in as the owning Google account
 *      (cannot be iframed; optionally append /autoclose so the tab closes itself)
 *   3. photos_picker_poll     → until mediaItemsSet is true
 *   4. photos_picker_list     → list the picked items (baseUrl + metadata)
 *   5. photos_picker_download → save the picked bytes locally (=d = original)
 *   6. photos_picker_delete   → clean up the session
 *
 * Session + baseUrls are SHORT-LIVED (~1h); pull bytes promptly. Metadata is
 * thin: id, mimeType, dimensions, creation time — no album membership.
 *
 * Reuses the shared Gmail OAuth client. Requires the refresh token in .env to
 * be granted: https://www.googleapis.com/auth/photospicker.mediaitems.readonly
 * (see scripts/gmail-auth.mjs — Library scopes are harmless extras if present,
 * but only the Picker scope is needed here).
 *
 * Environment variables (from .env):
 *   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
 */

import fs from "fs";
import path from "path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { OAuth2Client } from "google-auth-library";
import config from "../../shared/config-loader.cjs";
config.loadEnvInto(process.env);
import { sanitizeObject } from "../../scripts/sanitize.stub.mjs";
import { toolCall } from "../../shared/logger.mjs";
import { photosTools } from "../../shared/tool-manifest.js";

/* ── Auth (reuses Gmail OAuth2 credentials with combined scopes) ── */

function createAuthClient() {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    throw new Error("Missing Google OAuth2 credentials in environment");
  }
  const oauth2 = new OAuth2Client(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  return oauth2;
}

const auth = createAuthClient();

/* ── Picker REST client (direct fetch — same pattern as trello/netlify servers) ── */

const PICKER_BASE = "https://photospicker.googleapis.com/v1";

async function apiCall(pathname, { method = "GET", params, body } = {}) {
  const { token } = await auth.getAccessToken();
  if (!token) throw new Error("Could not obtain an access token");
  const url = new URL(PICKER_BASE + pathname);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const headers = { Authorization: `Bearer ${token}` };
  let payload;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers, body: payload });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const e = await res.json();
      msg = e.error?.message || msg;
    } catch {
      /* non-JSON error body — keep the status message */
    }
    throw new Error(msg);
  }
  if (res.status === 204) return { data: {} };
  return { data: await res.json() };
}

/* ── Response formatters ── */

function formatSession(session) {
  const formatted = {
    id: session.id || null,
    pickerUri: session.pickerUri || null,
    expireTime: session.expireTime || null,
    mediaItemsSet: !!session.mediaItemsSet,
    pickingConfig: session.pickingConfig ? { maxItemCount: session.pickingConfig.maxItemCount || null } : null,
    pollingConfig: session.pollingConfig
      ? { pollInterval: session.pollingConfig.pollInterval || null, timeoutIn: session.pollingConfig.timeoutIn || null }
      : null,
  };
  return formatted;
}

/**
 * Picker media items carry no filename — only id, mimeType, and metadata.
 * baseUrl is time-limited; append "=d" to download the original bytes.
 */
function formatPickedItem(item) {
  const meta = item.mediaMetadata || {};
  const formatted = {
    id: item.id,
    baseUrl: item.baseUrl || null,
    mimeType: item.mimeType || null,
    mediaMetadata: {
      creationTime: meta.creationTime || null,
      width: meta.width ?? null,
      height: meta.height ?? null,
      video: meta.video ? { fps: meta.video.fps ?? null, status: meta.video.status || null } : null,
    },
  };
  return formatted;
}

/* ── Download helpers ── */

const EXT_BY_MIME = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/heic": "heic",
  "image/heif": "heif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/x-msvideo": "avi",
  "video/x-matroska": "mkv",
};

/* ── Sanitization helpers ── */

function safeText(text) {
  return { type: "text", text };
}

function safeJson(data) {
  const sanitized = sanitizeObject(data);
  return { type: "text", text: JSON.stringify(sanitized, null, 2) };
}

/* ── Tool call logger ── */

function logToolCall(name, args, summary) {
  toolCall("mcp", "photos", { name, args, response: summary });
  console.error(`[mcp] photos/${name} → ${typeof summary === "string" ? summary.slice(0, 80) : "done"}`);
}

/* ── MCP Server ── */

const server = new Server({ name: "photos-picker-mcp-server", version: "1.0.0" }, { capabilities: { tools: {} } });

/* ── Tool call handler ── */

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  let result;
  let summary;
  switch (name) {
    case "photos_picker_start":
      result = await handlePickerStart(args);
      try {
        const d = JSON.parse(result.content?.[0]?.text || "{}");
        summary = `session ${d.id} — open pickerUri in a browser (expires ${d.expireTime || "?"})`;
      } catch {
        summary = "done";
      }
      break;
    case "photos_picker_poll":
      result = await handlePickerPoll(args);
      try {
        const d = JSON.parse(result.content?.[0]?.text || "{}");
        summary = d.mediaItemsSet ? "user finished picking" : "still waiting for user to pick";
      } catch {
        summary = "done";
      }
      break;
    case "photos_picker_list":
      result = await handlePickerList(args);
      try {
        const d = JSON.parse(result.content?.[0]?.text || "{}");
        summary = `${Array.isArray(d) ? d.length : d.mediaItems?.length || 0} picked item(s)`;
      } catch {
        summary = "done";
      }
      break;
    case "photos_picker_download":
      result = await handlePickerDownload(args);
      try {
        const d = JSON.parse(result.content?.[0]?.text || "{}");
        summary = Array.isArray(d) ? `saved ${d.length} file(s)` : "download error";
      } catch {
        summary = "done";
      }
      break;
    case "photos_picker_delete":
      result = await handlePickerDelete(args);
      summary = "done";
      break;
    default:
      result = { content: [safeText(`Unknown tool: ${name}`)], isError: true };
      summary = "unknown tool";
  }
  logToolCall(name, args, summary);
  return result;
});

/* ── Handlers ── */

async function handlePickerStart(args) {
  const maxItemCount = parseInt(args?.maxItemCount, 10);
  try {
    const body = Number.isFinite(maxItemCount) && maxItemCount > 0 ? { pickingConfig: { maxItemCount: Math.min(maxItemCount, 2000) } } : undefined;
    const res = await apiCall("/sessions", { method: "POST", body });
    return { content: [safeJson(formatSession(res.data))] };
  } catch (err) {
    return { content: [safeText(`Error creating picker session: ${err.message}`)], isError: true };
  }
}

async function handlePickerPoll(args) {
  const sessionId = args?.sessionId;
  if (!sessionId) {
    return { content: [safeText("Missing required parameter: sessionId")], isError: true };
  }
  try {
    const res = await apiCall(`/sessions/${encodeURIComponent(sessionId)}`);
    return { content: [safeJson(formatSession(res.data))] };
  } catch (err) {
    return { content: [safeText(`Error polling picker session: ${err.message}`)], isError: true };
  }
}

async function handlePickerList(args) {
  const sessionId = args?.sessionId;
  if (!sessionId) {
    return { content: [safeText("Missing required parameter: sessionId")], isError: true };
  }
  const pageSize = Math.min(Math.max(parseInt(args?.pageSize, 10) || 100, 1), 100);
  try {
    const res = await apiCall(`/mediaItems/${encodeURIComponent(sessionId)}`, {
      params: { pageSize, pageToken: args?.pageToken || undefined },
    });
    return {
      content: [
        safeJson({
          mediaItems: (res.data.mediaItems || []).map(formatPickedItem),
          nextPageToken: res.data.nextPageToken || null,
        }),
      ],
    };
  } catch (err) {
    return { content: [safeText(`Error listing picked media: ${err.message}`)], isError: true };
  }
}

async function handlePickerDownload(args) {
  const sessionId = args?.sessionId;
  const outDir = args?.outDir;
  if (!sessionId) {
    return { content: [safeText("Missing required parameter: sessionId")], isError: true };
  }
  if (!outDir) {
    return { content: [safeText("Missing required parameter: outDir")], isError: true };
  }
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const wantIds = Array.isArray(args?.mediaItemIds) && args.mediaItemIds.length ? new Set(args.mediaItemIds) : null;

    // List every picked item (paginate).
    const items = [];
    let pageToken;
    do {
      const res = await apiCall(`/mediaItems/${encodeURIComponent(sessionId)}`, {
        params: { pageSize: 100, pageToken: pageToken || undefined },
      });
      for (const it of res.data.mediaItems || []) {
        if (!wantIds || wantIds.has(it.id)) items.push(it);
      }
      pageToken = res.data.nextPageToken || null;
    } while (pageToken);

    if (items.length === 0) {
      return { content: [safeText("No picked media items to download (has the user finished picking?)")], isError: true };
    }

    const { token } = await auth.getAccessToken();
    if (!token) throw new Error("Could not obtain an access token");

    const saved = [];
    const failed = [];
    for (const it of items) {
      const mime = it.mimeType || "";
      const ext = EXT_BY_MIME[mime] || "bin";
      const stamp = (it.mediaMetadata?.creationTime || "unknown").replace(/[:.]/g, "-");
      const safeId = String(it.id || "item").replace(/[^A-Za-z0-9_-]/g, "");
      const filePath = path.join(outDir, `${stamp}_${safeId}.${ext}`);

      let res = await fetch((it.baseUrl || "") + "=d", { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok && it.baseUrl) {
        // Fallback: some baseUrls need no transform suffix.
        res = await fetch(it.baseUrl, { headers: { Authorization: `Bearer ${token}` } });
      }
      if (!res.ok) {
        failed.push({ id: it.id, status: res.status });
        continue;
      }
      fs.writeFileSync(filePath, Buffer.from(await res.arrayBuffer()));
      saved.push(filePath);
    }
    return { content: [safeJson({ saved, failed })] };
  } catch (err) {
    return { content: [safeText(`Error downloading picked media: ${err.message}`)], isError: true };
  }
}

async function handlePickerDelete(args) {
  const sessionId = args?.sessionId;
  if (!sessionId) {
    return { content: [safeText("Missing required parameter: sessionId")], isError: true };
  }
  try {
    await apiCall(`/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    return { content: [safeJson({ ok: true, sessionId, message: `Deleted picker session ${sessionId}` })] };
  } catch (err) {
    return { content: [safeText(`Error deleting picker session: ${err.message}`)], isError: true };
  }
}

/* ── Tool definitions (from shared manifest) ── */

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: photosTools,
}));

/* ── Start ── */

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("✅ Photos Picker MCP Server running on stdio");
