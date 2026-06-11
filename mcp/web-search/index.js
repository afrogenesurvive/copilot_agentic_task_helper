#!/usr/bin/env node

/**
 * Web Search MCP Server
 *
 * Provides web search and light web scraping tools.
 * Uses DuckDuckGo HTML search (no API key needed) and cheerio for content extraction.
 *
 * Environment variables: none required
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as cheerio from "cheerio";
import "dotenv/config";
import { sanitizeObject } from "../../scripts/sanitize.mjs";

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
  const sanitized = sanitizeObject(data);
  return { type: "text", text: JSON.stringify(sanitized, null, 2) };
}

function logToolCall(name, args, response) {
  const ts = new Date().toISOString();
  const today = ts.slice(0, 10);
  const argsStr = JSON.stringify(args).slice(0, 200);
  let respStr = typeof response === "string" ? response : "done";
  if (respStr.length > 100) {
    try {
      const parsed = JSON.parse(respStr);
      if (Array.isArray(parsed)) respStr = `${parsed.length} items`;
      else if (parsed.title) respStr = `"${parsed.title.slice(0, 60)}"`;
      else respStr = respStr.slice(0, 100) + "...";
    } catch {
      respStr = respStr.slice(0, 100) + "...";
    }
  }
  fs.mkdirSync(LOG_DIR, { recursive: true });

  for (const [eventName, details] of [
    ["tool_call", `web-search/${name} input=${argsStr}`],
    ["tool_response", `web-search/${name} output=${respStr}`],
  ]) {
    const entry = { timestamp: ts, name: eventName, details };
    fs.appendFileSync(path.join(LOG_DIR, `${today}_verbose.log`), JSON.stringify(entry) + "\n");
    fs.appendFileSync(path.join(LOG_DIR, `${today}.log`), `[${ts}] EVENT name=${eventName} details=${details}\n`);
    console.error(`[mcp] [${ts}] EVENT name=${eventName} details=${details}`);
  }
}

/* ── DuckDuckGo Search ── */

const DDG_URL = "https://html.duckduckgo.com/html/";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function searchDuckDuckGo(query, maxResults = 10) {
  const body = new URLSearchParams({ q: query });
  const resp = await fetch(DDG_URL, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "text/html",
    },
    body: body.toString(),
  });

  if (!resp.ok) {
    throw new Error(`DuckDuckGo returned status ${resp.status}`);
  }

  const html = await resp.text();
  const $ = cheerio.load(html);
  const results = [];

  $(".result").each((i, el) => {
    if (i >= maxResults) return false;

    const titleEl = $(el).find(".result__title a");
    const snippetEl = $(el).find(".result__snippet");
    const url = titleEl.attr("href") || "";

    // DDG wraps URLs — extract the actual URL from redirect
    let actualUrl = url;
    if (url.startsWith("//") || url.startsWith("/")) {
      const match = url.match(/uddg=(https?%3A[^&]+)/i);
      if (match) {
        actualUrl = decodeURIComponent(match[1]);
      }
    }

    results.push({
      title: titleEl.text().trim() || "",
      url: actualUrl,
      snippet: snippetEl.text().trim() || "",
    });
  });

  // Fallback: if no results found via class selector, try alternative parsing
  if (results.length === 0) {
    $("a.result__a, h2 a").each((i, el) => {
      if (i >= maxResults) return false;
      const href = $(el).attr("href") || "";
      let actualUrl = href;
      if (href.startsWith("//") || href.startsWith("/")) {
        const match = href.match(/uddg=(https?%3A[^&]+)/i);
        if (match) actualUrl = decodeURIComponent(match[1]);
      }
      results.push({
        title: $(el).text().trim(),
        url: actualUrl,
        snippet: $(el).closest(".result").find(".result__snippet").text().trim() || "",
      });
    });
  }

  return results;
}

/* ── Web fetch / scrape ── */

async function fetchPage(url) {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    redirect: "follow",
    timeout: 15000,
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  }

  const html = await resp.text();
  const contentType = resp.headers.get("content-type") || "";
  const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml");

  if (!isHtml) {
    // Not HTML — return raw text preview
    const text = html.slice(0, 5000);
    return {
      url: resp.url,
      contentType,
      title: "",
      text: text,
      truncated: html.length > 5000,
    };
  }

  const $ = cheerio.load(html);

  // Remove unwanted elements
  $("script, style, nav, footer, header, iframe, noscript, svg, form, button, [role=navigation]").remove();

  // Extract title
  const title = $("title").text().trim() || $("h1").first().text().trim() || $('meta[property="og:title"]').attr("content") || "";

  // Extract main content — prefer article, main, or body
  let mainText = "";
  const selectors = ["article", "main", '[role="main"]', ".content", "#content", ".post", ".entry", "body"];

  for (const sel of selectors) {
    const el = $(sel).first();
    if (el.length) {
      mainText = el.text().trim();
      if (mainText.length > 200) break;
    }
  }

  if (!mainText || mainText.length < 50) {
    mainText = $("body").text().trim();
  }

  // Clean up whitespace
  mainText = mainText.replace(/\s+/g, " ").trim();

  // Truncate to reasonable length
  const MAX_LENGTH = 15000;
  const truncated = mainText.length > MAX_LENGTH;

  return {
    url: resp.url,
    contentType,
    title,
    text: mainText.slice(0, MAX_LENGTH),
    truncated,
  };
}

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
