#!/usr/bin/env node

/**
 * Google Drive MCP Server
 *
 * Provides tools for listing, searching, and reading Google Drive files.
 * Uses the Model Context Protocol (stdio transport) for Copilot integration.
 *
 * Reuses the same OAuth2 credentials as the Gmail MCP server (combined scopes).
 * Environment variables (from .env):
 *   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import "dotenv/config";
import { sanitizeObject } from "../../scripts/sanitize.mjs";
import { driveTools } from "../../shared/tool-manifest.js";

/* ── Auth (reuses Gmail OAuth2 credentials with combined scopes) ── */

function getAuthClient() {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    throw new Error("Missing Google OAuth2 credentials in environment");
  }
  const oauth2 = new OAuth2Client(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  return oauth2;
}

const drive = google.drive({ version: "v3", auth: getAuthClient() });

/* ── Helpers ── */

/**
 * Format a Drive file object into a clean response shape.
 */
function formatFile(file) {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size || null,
    createdTime: file.createdTime,
    modifiedTime: file.modifiedTime,
    parents: file.parents || [],
    webViewLink: file.webViewLink || null,
    webContentLink: file.webContentLink || null,
    description: file.description || null,
    ownedByMe: file.ownedByMe ?? null,
    lastModifyingUser: file.lastModifyingUser
      ? { displayName: file.lastModifyingUser.displayName, emailAddress: file.lastModifyingUser.emailAddress }
      : null,
  };
}

/**
 * Extract plain text content from a Google Docs file via export.
 */
async function extractDocContent(fileId) {
  const res = await drive.files.export({
    fileId,
    mimeType: "text/plain",
  });
  return res.data;
}

/**
 * Fetch file binary content as base64 (for non-Drive-native types like PDFs, images).
 */
async function extractFileContent(fileId) {
  const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
  return Buffer.from(res.data).toString("base64").slice(0, 100000); // cap at ~100KB
}

/* ── Sanitization helpers ── */

function safeText(text) {
  return { type: "text", text };
}

function safeJson(data) {
  const sanitized = sanitizeObject(data);
  return { type: "text", text: JSON.stringify(sanitized, null, 2) };
}

/* ── Tool call logger ── */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, "..", "..", "logs", "tool_call");

function logToolCall(name, args, summary) {
  const ts = new Date().toISOString();
  const today = ts.slice(0, 10);
  const argsStr = JSON.stringify(args).slice(0, 200);
  const respStr = typeof summary === "string" ? summary.slice(0, 120) : "done";
  fs.mkdirSync(LOG_DIR, { recursive: true });

  for (const [eventName, details] of [
    ["tool_call", `drive/${name} input=${argsStr}`],
    ["tool_response", `drive/${name} output=${respStr}`],
  ]) {
    const line = `[${ts}] EVENT name=${eventName} details=${details}`;
    const entry = { timestamp: ts, name: eventName, details };
    fs.appendFileSync(path.join(LOG_DIR, `${today}_verbose.log`), JSON.stringify(entry) + "\n");
    fs.appendFileSync(path.join(LOG_DIR, `${today}.log`), line + "\n");
    console.error(`[mcp] ${line}`);
  }
}

/* ── MCP Server ── */

const server = new Server({ name: "drive-mcp-server", version: "1.0.0" }, { capabilities: { tools: {} } });

/* ── Tool call handler ── */

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  let result;
  let summary;
  switch (name) {
    case "drive_list_files":
      result = await handleListFiles(args);
      try {
        const d = JSON.parse(result.content?.[0]?.text || "[]");
        summary = `${d.length} files`;
      } catch {
        summary = "done";
      }
      break;
    case "drive_get_file":
      result = await handleGetFile(args);
      try {
        const d = JSON.parse(result.content?.[0]?.text || "{}");
        summary = `"${d.name || "(unnamed)"}" (${d.mimeType || "?"})`;
      } catch {
        summary = "done";
      }
      break;
    case "drive_search_files":
      result = await handleSearchFiles(args);
      try {
        const d = JSON.parse(result.content?.[0]?.text || "[]");
        summary = `${d.length} results`;
      } catch {
        summary = "done";
      }
      break;
    case "drive_create_file":
      result = await handleCreateFile(args);
      try {
        const d = JSON.parse(result.content?.[0]?.text || "{}");
        summary = `"${d.name}" created (${d.mimeType})`;
      } catch {
        summary = "done";
      }
      break;
    case "drive_update_file":
      result = await handleUpdateFile(args);
      try {
        const d = JSON.parse(result.content?.[0]?.text || "{}");
        summary = `"${d.name}" updated`;
      } catch {
        summary = "done";
      }
      break;
    case "drive_move_file":
      result = await handleMoveFile(args);
      try {
        const d = JSON.parse(result.content?.[0]?.text || "{}");
        summary = `"${d.name}" moved`;
      } catch {
        summary = "done";
      }
      break;
    case "drive_create_folder":
      result = await handleCreateFolder(args);
      try {
        const d = JSON.parse(result.content?.[0]?.text || "{}");
        summary = `folder "${d.name}" created`;
      } catch {
        summary = "done";
      }
      break;
    case "drive_delete_file":
      result = await handleDeleteFile(args);
      summary = "trashed";
      break;
    default:
      result = { content: [safeText(`Unknown tool: ${name}`)], isError: true };
      summary = "unknown tool";
  }
  logToolCall(name, args, summary);
  return result;
});

/* ── Tool handlers ── */

/**
 * Resolve a folder name, path (e.g. "Projects/Client"), or ID to a Drive folder ID.
 *
 * Looks up known directory paths from safe/drive-directories.json.
 * Supports:
 *   - "root" → "root"
 *   - A path like "Projects/Reports" → folder ID
 *   - A folder name (if unique) → folder ID
 *   - An existing folder ID → returned as-is
 */
function resolveFolderId(folderId) {
  if (!folderId || folderId === "root") return "root";

  // Try loading the directory reference file
  try {
    const refPath = new URL("../../safe/drive-directories.json", import.meta.url);
    const ref = JSON.parse(fs.readFileSync(refPath, "utf8"));

    // Try exact path match first
    if (ref.byPath && ref.byPath[folderId]) {
      return ref.byPath[folderId];
    }

    // Try direct ID lookup (already an ID)
    if (ref.byId && ref.byId[folderId]) {
      return folderId;
    }

    // Try searching by folder name (if it's a simple name like "Projects")
    // Return the first match
    if (ref.byId) {
      for (const [id, info] of Object.entries(ref.byId)) {
        if (info.name === folderId) {
          return id;
        }
      }
    }
  } catch {
    // File doesn't exist or is invalid — just use the provided value
  }

  // Not found in reference — assume it's already an ID
  return folderId;
}

async function handleListFiles(args) {
  const pageSize = Math.min(args.pageSize || 20, 100);
  const inputFolder = args.folderId || "root";
  const folderId = resolveFolderId(inputFolder);

  // Log if the name was resolved to a different ID
  if (folderId !== inputFolder) {
    console.error(`[mcp] drive/list_files resolved "${inputFolder}" → ${folderId}`);
  }

  try {
    const query = folderId === "root" ? `'root' in parents and trashed = false` : `'${folderId}' in parents and trashed = false`;

    const res = await drive.files.list({
      q: query,
      pageSize,
      fields: "files(id,name,mimeType,size,createdTime,modifiedTime,parents,webViewLink,ownedByMe,lastModifyingUser)",
      orderBy: "modifiedTime desc",
    });
    const files = (res.data.files || []).map(formatFile);
    return { content: [safeJson(files)] }; // File names/metadata sanitized
  } catch (err) {
    return { content: [safeText(`Error listing files: ${err.message}`)], isError: true };
  }
}

async function handleGetFile(args) {
  const fileId = args.fileId;
  if (!fileId) {
    return { content: [safeText("Missing required parameter: fileId")], isError: true };
  }
  const includeContent = args.includeContent !== false;

  try {
    const res = await drive.files.get({
      fileId,
      fields: "id,name,mimeType,size,createdTime,modifiedTime,parents,webViewLink,webContentLink,description,ownedByMe,lastModifyingUser",
    });
    const file = formatFile(res.data);

    // Fetch content for text-based files
    if (includeContent && file.mimeType) {
      const textMimes = [
        "text/plain",
        "text/html",
        "text/csv",
        "text/markdown",
        "application/json",
        "application/xml",
        "text/xml",
        "application/javascript",
        "text/javascript",
        "text/css",
      ];
      const docMimes = [
        "application/vnd.google-apps.document",
        "application/vnd.google-apps.spreadsheet",
        "application/vnd.google-apps.presentation",
      ];

      if (textMimes.includes(file.mimeType)) {
        try {
          file.content = await extractFileContent(fileId);
        } catch {
          file.content = "(could not read content)";
        }
      } else if (docMimes.includes(file.mimeType)) {
        try {
          file.content = await extractDocContent(fileId);
        } catch {
          file.content = "(could not export content)";
        }
      }
    }

    return { content: [safeJson(file)] }; // File metadata sanitized
  } catch (err) {
    return { content: [safeText(`Error getting file: ${err.message}`)], isError: true };
  }
}

async function handleSearchFiles(args) {
  const query = args.query || "";
  const pageSize = Math.min(args.pageSize || 20, 100);

  try {
    const q = `name contains '${query.replace(/'/g, "\\'")}' and trashed = false`;
    const res = await drive.files.list({
      q,
      pageSize,
      fields: "files(id,name,mimeType,size,createdTime,modifiedTime,parents,webViewLink,ownedByMe,lastModifyingUser)",
      orderBy: "modifiedTime desc",
    });
    const files = (res.data.files || []).map(formatFile);
    return { content: [safeJson(files)] }; // Search results sanitized
  } catch (err) {
    return { content: [safeText(`Error searching files: ${err.message}`)], isError: true };
  }
}

/* ── Create File ── */

async function handleCreateFile(args) {
  const { name, mimeType, content, parentFolderId, description } = args;
  if (!name) {
    return { content: [safeText("Missing required parameter: name")], isError: true };
  }

  const resolvedParent = resolveFolderId(parentFolderId || "root");
  const effectiveMimeType = mimeType || "application/vnd.google-apps.document";

  try {
    // Create the file metadata
    const fileMetadata = {
      name,
      description: description || "",
      mimeType: effectiveMimeType,
      parents: resolvedParent === "root" ? [] : [resolvedParent],
    };

    // For Google-native formats, just create with metadata
    const isGoogleFormat = effectiveMimeType.startsWith("application/vnd.google-apps");

    if (isGoogleFormat || !content) {
      const res = await drive.files.create({
        requestBody: fileMetadata,
        fields: "id,name,mimeType,size,createdTime,modifiedTime,parents,webViewLink,description,ownedByMe",
      });
      return { content: [safeJson(formatFile(res.data))] };
    }

    // For non-Google formats with content, upload with media
    const res = await drive.files.create({
      requestBody: fileMetadata,
      media: { mimeType: effectiveMimeType, body: content },
      fields: "id,name,mimeType,size,createdTime,modifiedTime,parents,webViewLink,description,ownedByMe",
    });
    return { content: [safeJson(formatFile(res.data))] };
  } catch (err) {
    return { content: [safeText(`Error creating file: ${err.message}`)], isError: true };
  }
}

/* ── Update File ── */

async function handleUpdateFile(args) {
  const { fileId, name, description, content } = args;
  if (!fileId) {
    return { content: [safeText("Missing required parameter: fileId")], isError: true };
  }

  try {
    // Update metadata
    const metadata = {};
    if (name !== undefined) metadata.name = name;
    if (description !== undefined) metadata.description = description;

    if (Object.keys(metadata).length > 0) {
      await drive.files.update({
        fileId,
        requestBody: metadata,
        fields: "id,name,mimeType,description",
      });
    }

    // Update content if provided (for text-based files)
    if (content !== undefined) {
      // Get the current mimeType to pass it back
      const info = await drive.files.get({
        fileId,
        fields: "id,name,mimeType",
      });
      await drive.files.update({
        fileId,
        media: { mimeType: info.data.mimeType, body: content },
        fields: "id,name,mimeType,size",
      });
    }

    // Fetch the final state
    const res = await drive.files.get({
      fileId,
      fields: "id,name,mimeType,size,createdTime,modifiedTime,parents,webViewLink,description,ownedByMe,lastModifyingUser",
    });
    return { content: [safeJson(formatFile(res.data))] };
  } catch (err) {
    return { content: [safeText(`Error updating file: ${err.message}`)], isError: true };
  }
}

/* ── Move File ── */

async function handleMoveFile(args) {
  const { fileId, newParentFolderId, newName } = args;
  if (!fileId) {
    return { content: [safeText("Missing required parameter: fileId")], isError: true };
  }
  if (!newParentFolderId) {
    return { content: [safeText("Missing required parameter: newParentFolderId")], isError: true };
  }

  const resolvedParent = resolveFolderId(newParentFolderId);
  if (resolvedParent === "root" && newParentFolderId !== "root") {
    // Allow explicit "root"
  }

  try {
    // Get current parents
    const file = await drive.files.get({
      fileId,
      fields: "id,name,parents",
    });

    const currentParents = file.data.parents || [];
    const allParents = currentParents.join(",");

    // Update metadata (rename if requested)
    const metadata = {};
    if (newName !== undefined) metadata.name = newName;

    // Move by removing from current parents and adding to new parent
    const res = await drive.files.update({
      fileId,
      addParents: resolvedParent === "root" ? "" : resolvedParent,
      removeParents: allParents,
      requestBody: Object.keys(metadata).length > 0 ? metadata : undefined,
      fields: "id,name,mimeType,parents,webViewLink",
    });

    return { content: [safeJson(formatFile(res.data))] };
  } catch (err) {
    return { content: [safeText(`Error moving file: ${err.message}`)], isError: true };
  }
}

/* ── Create Folder ── */

async function handleCreateFolder(args) {
  const { name, parentFolderId } = args;
  if (!name) {
    return { content: [safeText("Missing required parameter: name")], isError: true };
  }

  const resolvedParent = resolveFolderId(parentFolderId || "root");

  try {
    const fileMetadata = {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: resolvedParent === "root" ? [] : [resolvedParent],
    };

    const res = await drive.files.create({
      requestBody: fileMetadata,
      fields: "id,name,mimeType,createdTime,parents,webViewLink",
    });
    return { content: [safeJson(formatFile(res.data))] };
  } catch (err) {
    return { content: [safeText(`Error creating folder: ${err.message}`)], isError: true };
  }
}

/* ── Delete File ── */

async function handleDeleteFile(args) {
  const { fileId } = args;
  if (!fileId) {
    return { content: [safeText("Missing required parameter: fileId")], isError: true };
  }

  try {
    await drive.files.update({
      fileId,
      requestBody: { trashed: true },
      fields: "id,name",
    });
    return { content: [safeText(`File "${fileId}" moved to trash`)] };
  } catch (err) {
    return { content: [safeText(`Error deleting file: ${err.message}`)], isError: true };
  }
}

/* ── Tool definitions (from shared manifest) ── */

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: driveTools,
}));

/* ── Start ── */

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("✅ Drive MCP Server running on stdio");
