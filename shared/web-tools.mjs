/**
 * shared/web-tools.mjs — ONE implementation of DuckDuckGo search + page fetch.
 *
 * Consumed by BOTH paths so they can never silently diverge:
 *   - mcp/agent-runner/tool-executor.js — the Electron operator chat + agent runner
 *   - mcp/web-search/index.js           — the web-search MCP server
 *
 * Before this module each side had its own copy and they behaved differently:
 *   - the executor's snippets kept raw HTML entities ("&#x27;" instead of "'"),
 *     because its regex strip never decoded them;
 *   - its single selector assumed `class` preceded `href` in the anchor and had no
 *     fallback, so a DuckDuckGo markup change would have returned ZERO results
 *     with ok:true — indistinguishable from "no matches";
 *   - the MCP server preferred <article>/<main> while the executor stripped every
 *     tag, so identical URLs produced different text;
 *   - only the MCP server sanitized its output.
 *
 * Deliberately dependency-free: cheerio is installed only under
 * mcp/web-search/node_modules, so a module shared with the repo root cannot
 * resolve it. Everything here is plain string handling.
 *
 * Both entry points throw on failure and never return partial-but-ok data.
 */

import { sanitizeObject } from "../scripts/sanitize.stub.mjs";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const DDG_URL = "https://html.duckduckgo.com/html/";
const FETCH_TIMEOUT_MS = 15000;
const MAX_TEXT = 15000; // extracted readable text (HTML pages)
const MAX_NON_HTML = 5000; // raw body for non-HTML responses (JSON, plain text, …)
const DEFAULT_MAX_RESULTS = 10;
const HARD_MAX_RESULTS = 25; // the manifest advertises "max 20"; cap above that, not unbounded

/* ── HTML text helpers ─────────────────────────────────────────────────────── */

/** The handful of entities that actually show up in search snippets. */
const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  middot: "·",
  copy: "©",
  reg: "®",
  deg: "°",
  pound: "£",
  euro: "€",
  times: "×",
  laquo: "«",
  raquo: "»",
};

/**
 * Decode named + numeric (decimal and hex) HTML entities.
 *
 * `&#x27;` → `'`, `&#39;` → `'`, `&amp;` → `&`. Unknown entities are left as-is.
 * C0 control characters are dropped so a crafted `&#0;` can't smuggle a control
 * byte into text that is later displayed or fed to a model.
 */
export function decodeEntities(str) {
  return String(str).replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === "#") {
      const isHex = body[1] === "x" || body[1] === "X";
      const code = parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return " ";
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

/**
 * Strip markup to readable text.
 *
 * Entities are decoded AFTER tags are removed, so `&lt;script&gt;` in a page
 * cannot turn into a live-looking tag boundary in the extracted text.
 */
export function stripTags(html) {
  return decodeEntities(
    String(html)
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|svg|iframe|template|form|button)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

/** Read an attribute out of a raw tag-attribute string (single or double quoted). */
function attrValue(attrs, name) {
  const m = String(attrs).match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  return m ? (m[1] ?? m[2] ?? "") : "";
}

/** Unwrap DuckDuckGo's `//duckduckgo.com/l/?uddg=<enc>&rut=…` redirect wrapper. */
function unwrapDdgUrl(href) {
  const raw = decodeEntities(href || "");
  if (!raw) return "";
  const uddg = raw.match(/[?&]uddg=([^&]+)/);
  if (uddg) {
    try {
      return decodeURIComponent(uddg[1]);
    } catch {
      return raw;
    }
  }
  if (raw.startsWith("//")) return `https:${raw}`;
  return raw;
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/* ── Search ────────────────────────────────────────────────────────────────── */

/**
 * Pull result rows out of DuckDuckGo's HTML page.
 *
 * Collects anchors by tag (so attribute ORDER doesn't matter), prefers ones
 * carrying the `result__a` class, and falls back to any anchor pointing at a
 * `uddg=` redirect — which is what saved results look like when the class name
 * changes. Snippets are paired to titles by index, matching DuckDuckGo's own
 * ordering.
 */
function parseSearchResults(html, maxResults) {
  const anchors = [];
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(html))) {
    anchors.push({ attrs: m[1], html: m[2], href: attrValue(m[1], "href"), cls: attrValue(m[1], "class") });
  }

  let titles = anchors.filter((a) => /\bresult__a\b/.test(a.cls));
  if (!titles.length) titles = anchors.filter((a) => a.href && /[?&]uddg=/.test(a.href));

  // The snippet element is an <a> in current markup and a <div> in older variants.
  const snippetRe = /class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/gi;
  const snippets = [...html.matchAll(snippetRe)].map((s) => stripTags(s[1]));

  const results = [];
  for (const anchor of titles) {
    if (results.length >= maxResults) break;
    const url = unwrapDdgUrl(anchor.href);
    const title = stripTags(anchor.html);
    if (!url && !title) continue;
    results.push({ title, url, snippet: snippets[results.length] || "" });
  }
  return results;
}

/**
 * Search the web via DuckDuckGo's HTML endpoint (no API key).
 * @param {string} query
 * @param {number} [maxResults]
 * @returns {Promise<Array<{title:string,url:string,snippet:string}>>}
 */
export async function searchDuckDuckGo(query, maxResults = DEFAULT_MAX_RESULTS) {
  const q = String(query ?? "").trim();
  if (!q) throw new Error("web_search requires a non-empty query");
  const limit = clampInt(maxResults, 1, HARD_MAX_RESULTS, DEFAULT_MAX_RESULTS);

  const resp = await fetch(DDG_URL, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "text/html",
    },
    body: new URLSearchParams({ q }).toString(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`DuckDuckGo returned HTTP ${resp.status}`);

  const html = await resp.text();
  const results = parseSearchResults(html, limit);

  // An empty array on a page that contains no result markup at all is a parse
  // failure, not "no matches" — say so instead of silently reporting success.
  // DuckDuckGo answers automated bursts with HTTP 202 + an anti-bot page that has
  // no result markup, so both causes are worth naming in the error.
  if (!results.length && !/result__a|result__snippet|uddg=/.test(html)) {
    throw new Error("DuckDuckGo returned no parseable results (its markup may have changed, or the request was rate-limited/blocked).");
  }

  return results.map((r) => sanitizeObject(r, { auditSource: "web/search" }));
}

/* ── Fetch ─────────────────────────────────────────────────────────────────── */

/**
 * True for hosts a model-chosen URL must never be able to reach: the local
 * backend, other services on the LAN, and link-local metadata endpoints.
 */
export function isPrivateHost(hostname) {
  const h = String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".home.arpa")) return true;

  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if ([a, b, Number(v4[3]), Number(v4[4])].some((n) => n > 255)) return true; // bogus → refuse
    if (a === 0 || a === 10 || a === 127 || a === 169) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast + reserved
    return false;
  }

  if (h.includes(":")) {
    if (h === "::1" || h === "::") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // fc00::/7 unique-local
    if (/^fe[89ab][0-9a-f]:/.test(h)) return true; // fe80::/10 link-local
    if (/^::ffff:/.test(h)) return true; // v4-mapped
    return false;
  }

  // Any other literal (a bare IPv6-ish string) is refused; real hostnames pass.
  return false;
}

/**
 * Validate a URL before fetching: http(s) only, never a private/loopback host.
 *
 * The URL is chosen by the model, so without this it can read the local webhook
 * server (`http://localhost:3199/…`) or probe the LAN from inside the machine.
 */
export function assertFetchableUrl(input) {
  let u;
  try {
    u = new URL(String(input ?? "").trim());
  } catch {
    throw new Error(`Not a valid URL: ${input}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`Only http/https URLs can be fetched (got ${u.protocol.replace(":", "")})`);
  }
  if (isPrivateHost(u.hostname)) {
    throw new Error(`Refusing to fetch a private or loopback host (${u.hostname})`);
  }
  return u.toString();
}

/** Pick the most readable chunk of a page: article → main → body. */
function extractMainText(html) {
  const cleaned = String(html).replace(/<!--[\s\S]*?-->/g, " ");
  const candidates = [];

  for (const re of [
    /<article\b[^>]*>([\s\S]*?)<\/article>/i,
    /<main\b[^>]*>([\s\S]*?)<\/main>/i,
    /<[^>]*\brole\s*=\s*"main"[^>]*>([\s\S]*?)<\/div>/i,
  ]) {
    const m = cleaned.match(re);
    if (m) candidates.push(stripTags(m[1]));
  }

  const bodyMatch = cleaned.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) candidates.push(stripTags(bodyMatch[1]));

  // Prefer the first container with real content; otherwise the longest; and if
  // the page has no <body> at all, fall back to stripping the whole document.
  return candidates.find((c) => c.length > 200) || candidates.sort((a, b) => b.length - a.length)[0] || stripTags(cleaned);
}

function extractTitle(html) {
  return (
    stripTags(String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "") ||
    stripTags(String(html).match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "") ||
    decodeEntities(String(html).match(/<meta[^>]+property\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']*)["']/i)?.[1] || "")
  );
}

/**
 * Fetch a URL and extract its readable content.
 * @param {string} url
 * @returns {Promise<{url:string,contentType:string,title:string,text:string,truncated:boolean}>}
 */
export async function fetchPage(url) {
  const target = assertFetchableUrl(url);

  const resp = await fetch(target, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText || ""}`.trim());

  // A redirect chain can land on a private host even when the original URL was
  // public. `fetch` does not expose intermediate hops, so re-validate the final
  // URL and discard the body rather than returning it.
  try {
    assertFetchableUrl(resp.url);
  } catch {
    throw new Error(`Refusing to use a page that redirected to a private host (${resp.url})`);
  }

  const body = await resp.text();
  const contentType = resp.headers.get("content-type") || "";

  if (!/text\/html|application\/xhtml/i.test(contentType)) {
    return sanitizeObject(
      {
        url: resp.url,
        contentType,
        title: "",
        text: body.slice(0, MAX_NON_HTML),
        truncated: body.length > MAX_NON_HTML,
      },
      { auditSource: "web/fetch" },
    );
  }

  const text = extractMainText(body);
  return sanitizeObject(
    {
      url: resp.url,
      contentType,
      title: extractTitle(body),
      text: text.slice(0, MAX_TEXT),
      truncated: text.length > MAX_TEXT,
    },
    { auditSource: "web/fetch" },
  );
}
