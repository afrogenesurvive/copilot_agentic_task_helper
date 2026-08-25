#!/usr/bin/env node

/**
 * Google Sheets MCP Server
 *
 * Provides tools for reading, writing, inserting rows, and copying formatting
 * in Google Sheets. Uses cell-level API — no full file download/upload needed.
 *
 * Reuses the same OAuth2 credentials as the Gmail/Drive MCP servers.
 * Environment variables (from .env):
 *   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import "dotenv/config";
import { sanitizeObject } from "../../scripts/sanitize.stub.mjs";
import { sheetsTools } from "../../shared/tool-manifest.js";

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

const sheets = google.sheets({ version: "v4", auth: getAuthClient() });

/* ── Sanitization helpers ── */

function safeText(text) {
  return { type: "text", text: text };
}

function safeJson(data) {
  const sanitized = sanitizeObject(data, { auditSource: "mcp/sheets" });
  return { type: "text", text: JSON.stringify(sanitized, null, 2) };
}

/* ── Tool call logger ── */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, "..", "..", "logs", "tool_call");

import { toolCall } from "../../shared/logger.mjs";

// Tool-call logging routes through the shared logger (shared/logger.mjs), which
// preserves logs/tool_call/*.log + *_verbose.log AND emits unified live entries.
function logToolCall(name, args, summary) {
  toolCall("mcp", "sheets", { name, args, response: summary });
  console.error(`[mcp] sheets/${name} → ${typeof summary === "string" ? summary.slice(0, 80) : "done"}`);
}

/* ── MCP Server ── */

const server = new Server({ name: "sheets-mcp-server", version: "1.0.0" }, { capabilities: { tools: {} } });

/* ── Tool handlers ── */

/**
 * Read cell values from a Google Sheet by range.
 * Returns a 2D array of values.
 */
async function handleGetValues(args) {
  const { spreadsheetId, range } = args;
  if (!spreadsheetId || !range) {
    return { content: [safeText("Missing required parameters: spreadsheetId, range")], isError: true };
  }

  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
      valueRenderOption: "FORMATTED_VALUE",
    });
    const result = {
      spreadsheetId,
      range: res.data.range,
      majorDimension: res.data.majorDimension,
      values: res.data.values || [],
    };
    return { content: [safeJson(result)] };
  } catch (err) {
    return { content: [safeText(`Error reading sheet values: ${err.message}`)], isError: true };
  }
}

/**
 * Write values to a range in a Google Sheet.
 * Provide a 2D array; replaces existing content in the range.
 */
async function handleUpdateValues(args) {
  const { spreadsheetId, range, values } = args;
  if (!spreadsheetId || !range || !values) {
    return { content: [safeText("Missing required parameters: spreadsheetId, range, values")], isError: true };
  }

  if (!Array.isArray(values) || !values.every((r) => Array.isArray(r))) {
    return { content: [safeText("'values' must be a 2D array (array of arrays)")], isError: true };
  }

  try {
    const res = await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: "USER_ENTERED",
      requestBody: { values },
    });
    return {
      content: [
        safeJson({
          updatedRange: res.data.updatedRange,
          updatedRows: res.data.updatedRows,
          updatedColumns: res.data.updatedColumns,
          updatedCells: res.data.updatedCells,
        }),
      ],
    };
  } catch (err) {
    return { content: [safeText(`Error updating sheet values: ${err.message}`)], isError: true };
  }
}

/**
 * Insert blank rows at a specific position in a Google Sheet.
 */
async function handleInsertRows(args) {
  const { spreadsheetId, sheetId, startIndex, numRows } = args;
  if (spreadsheetId === undefined || sheetId === undefined || startIndex === undefined) {
    return { content: [safeText("Missing required parameters: spreadsheetId, sheetId, startIndex")], isError: true };
  }

  try {
    const res = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            insertDimension: {
              range: {
                sheetId,
                dimension: "ROWS",
                startIndex,
                endIndex: startIndex + (numRows || 1),
              },
            },
          },
        ],
      },
    });
    return {
      content: [
        safeJson({
          spreadsheetId,
          insertedRows: numRows || 1,
          atIndex: startIndex,
          status: "ok",
        }),
      ],
    };
  } catch (err) {
    return { content: [safeText(`Error inserting rows: ${err.message}`)], isError: true };
  }
}

/**
 * Copy formatting (pasteType: PASTE_FORMAT) from a source range to a target range.
 * Uses the Sheets API batchUpdate with copyPaste request.
 */
async function handleCopyPasteFormat(args) {
  const { spreadsheetId, sourceSheetId, sourceStartRow, sourceEndRow, sourceStartCol, sourceEndCol, targetSheetId, targetStartRow, pasteType } = args;

  if (
    !spreadsheetId ||
    sourceSheetId === undefined ||
    sourceStartRow === undefined ||
    sourceEndRow === undefined ||
    targetSheetId === undefined ||
    targetStartRow === undefined
  ) {
    return {
      content: [safeText("Missing required parameters: spreadsheetId, sourceSheetId, sourceStartRow, sourceEndRow, targetSheetId, targetStartRow")],
      isError: true,
    };
  }

  try {
    const res = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            copyPaste: {
              source: {
                sheetId: sourceSheetId,
                startRowIndex: sourceStartRow,
                endRowIndex: sourceEndRow,
                startColumnIndex: sourceStartCol ?? 0,
                endColumnIndex: sourceEndCol ?? 7,
              },
              destination: {
                sheetId: targetSheetId,
                startRowIndex: targetStartRow,
                endRowIndex: targetStartRow + (sourceEndRow - sourceStartRow),
                startColumnIndex: sourceStartCol ?? 0,
                endColumnIndex: sourceEndCol ?? 7,
              },
              pasteType: pasteType || "PASTE_FORMAT",
            },
          },
        ],
      },
    });
    return {
      content: [
        safeJson({
          spreadsheetId,
          sourceRange: `rows ${sourceStartRow}-${sourceEndRow}`,
          targetStartRow,
          pasteType: pasteType || "PASTE_FORMAT",
          status: "ok",
        }),
      ],
    };
  } catch (err) {
    return { content: [safeText(`Error copying formatting: ${err.message}`)], isError: true };
  }
}

/**
 * Get metadata about a Google Sheet: sheet names, grid IDs, row/column counts,
 * frozen row/column info.
 */
async function handleGetMetadata(args) {
  const { spreadsheetId } = args;
  if (!spreadsheetId) {
    return { content: [safeText("Missing required parameter: spreadsheetId")], isError: true };
  }

  try {
    const res = await sheets.spreadsheets.get({
      spreadsheetId,
      ranges: [],
      includeGridData: false,
    });
    const metadata = {
      spreadsheetId: res.data.spreadsheetId,
      spreadsheetUrl: res.data.spreadsheetUrl,
      title: res.data.properties?.title,
      locale: res.data.properties?.locale,
      timeZone: res.data.properties?.timeZone,
      sheets: res.data.sheets?.map((s) => ({
        sheetId: s.properties?.sheetId,
        title: s.properties?.title,
        index: s.properties?.index,
        rowCount: s.properties?.gridProperties?.rowCount,
        columnCount: s.properties?.gridProperties?.columnCount,
        frozenRowCount: s.properties?.gridProperties?.frozenRowCount || 0,
        frozenColumnCount: s.properties?.gridProperties?.frozenColumnCount || 0,
      })),
    };
    return { content: [safeJson(metadata)] };
  } catch (err) {
    return { content: [safeText(`Error getting sheet metadata: ${err.message}`)], isError: true };
  }
}

/* ── Tool call handler (single dispatch) ── */

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  let result;
  let summary;
  switch (name) {
    case "sheets_get_values":
      result = await handleGetValues(args);
      try {
        const d = JSON.parse(result.content?.[0]?.text || "{}");
        summary = `${d.values?.length || 0} rows`;
      } catch {
        summary = "done";
      }
      break;
    case "sheets_update_values":
      result = await handleUpdateValues(args);
      try {
        const d = JSON.parse(result.content?.[0]?.text || "{}");
        summary = `${d.updatedCells || 0} cells`;
      } catch {
        summary = "done";
      }
      break;
    case "sheets_insert_rows":
      result = await handleInsertRows(args);
      summary = `${args.numRows || 1} rows at ${args.startIndex}`;
      break;
    case "sheets_copy_paste_format":
      result = await handleCopyPasteFormat(args);
      summary = `format from ${args.sourceStartRow}-${args.sourceEndRow} to ${args.targetStartRow}`;
      break;
    case "sheets_get_metadata":
      result = await handleGetMetadata(args);
      try {
        const d = JSON.parse(result.content?.[0]?.text || "{}");
        summary = `${d.sheets?.length || 0} sheets`;
      } catch {
        summary = "done";
      }
      break;
    default:
      result = { content: [safeText(`Unknown tool: ${name}`)], isError: true };
      summary = "unknown tool";
  }
  logToolCall(name, args, summary);
  return result;
});

/* ── Tool definitions (from shared manifest) ── */

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: sheetsTools,
}));

/* ── Start ── */

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("✅ Sheets MCP Server running on stdio");
