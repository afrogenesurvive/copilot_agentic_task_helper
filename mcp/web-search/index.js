#!/usr/bin/env node

/**
 * Web Search MCP Server
 *
 * Provides web search and light web scraping tools.
 * DuckDuckGo HTML search (no API key needed) + dependency-free page extraction,
 * both implemented in `shared/web-tools.mjs` — the same module the Electron
 * operator chat uses, so the two paths behave identically.
 *
 * Environment variables: none required
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { searchDuckDuckGo, fetchPage } from "../../shared/web-tools.mjs";
import config from "../../shared/config-loader.cjs";
config.loadEnvInto(process.env);
import { sanitizeObject } from "../../scripts/sanitize.stub.mjs";

/* ── Tool call logger ── */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, "..", "..", "logs", "tool_call");

function safeText(text) {
  return { type: "text", text: text };
}

function safeJson(data) {
  const sanitized = sanitizeObject(data, { auditSource: "mcp/web-search" });
  return { type: "text", text: JSON.stringify(sanitized, null, 2) };
}

import { toolCall } from "../../shared/logger.mjs";

// Tool-call logging routes through the shared logger (shared/logger.mjs), which
// preserves logs/tool_call/*.log + *_verbose.log AND emits unified live entries.
function logToolCall(name, args, response) {
  toolCall("mcp", "web-search", { name, args, response });
  console.error(`[mcp] web-search/${name} → ${typeof response === "string" ? response.slice(0, 80) : "done"}`);
}

/* ── DuckDuckGo Search + page fetch ──
 *
 * Both live in `shared/web-tools.mjs`, which is also what the Electron operator
 * chat and the agent runner call through `mcp/agent-runner/tool-executor.js`.
 * One implementation means the MCP server and the chat cannot disagree about
 * entity decoding, selector fallbacks, main-content extraction, the private-host
 * guard, or output sanitization. (cheerio is no longer needed here.)
 */

/* ── MCP Server ── */

const server = new Server({ name: "web-search-mcp-server", version: "1.0.0" }, { capabilities: { tools: {} } });

/* ── Tool definitions (inlined here + shared manifest) ── */

const webSearchTools = [
  {
    name: "web_search",
    description:
      "Search the web using DuckDuckGo. Returns a list of results with title, URL, and snippet for each. No API key required. Good for finding current information, news, documentation, and general web content.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        maxResults: { type: "number", description: "Maximum results to return (default 10, max 20)", default: 10 },
      },
      required: ["query"],
    },
  },
  {
    name: "web_fetch",
    description:
      "Fetch a web page and extract its main readable content. Returns the page title, URL, and clean text content (HTML stripped). Good for reading articles, documentation, or any web page. Handles redirects and extracts main content areas.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full URL (including https://) of the page to fetch" },
      },
      required: ["url"],
    },
  },
];

/* ── Tool call handler ── */

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  let result;
  let summary;

  try {
    switch (name) {
      case "web_search": {
        const { query, maxResults } = args;
        if (!query) {
          return { content: [safeText("Missing required parameter: query")], isError: true };
        }
        const results = await searchDuckDuckGo(query, maxResults || 10);
        result = { content: [safeJson(results)] };
        summary = `${results.length} results`;
        break;
      }

      case "web_fetch": {
        const { url } = args;
        if (!url) {
          return { content: [safeText("Missing required parameter: url")], isError: true };
        }
        // Basic URL validation
        try {
          new URL(url);
        } catch {
          return { content: [safeText(`Invalid URL: "${url}"`)], isError: true };
        }
        const page = await fetchPage(url);
        result = { content: [safeJson(page)] };
        summary = `"${page.title.slice(0, 60)}" (${page.text.length} chars)`;
        break;
      }

      default:
        result = { content: [safeText(`Unknown tool: ${name}`)], isError: true };
        summary = "unknown tool";
    }
  } catch (err) {
    result = { content: [safeText(`Error: ${err.message}`)], isError: true };
    summary = `error: ${err.message}`;
  }

  logToolCall(name, args, summary);
  return result;
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: webSearchTools,
}));

/* ── Start ── */

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("✅ Web Search MCP Server running on stdio");
