/**
 * Shared structured logger — the single logging path for the whole stack.
 *
 * Every component (webhook server, agent runner, MCP servers, frontdesk lib)
 * emits structured entries here. Each call writes:
 *   - a unified JSONL line to logs/live/YYYY-MM-DD.jsonl:
 *       {ts, source, subSource, level, message, data?}
 *   - plus (via the compatibility helpers) the legacy file layouts that
 *     existing consumers depend on (logs/tool_call/*, logs/webhook/*,
 *     logs/notifications/*) so nothing breaks.
 *
 * Sources: webhook | runner | mcp | tunnel | frontdesk | notifications | electron
 * Levels:  debug | info | warn | error   (filtered by LOG_LEVEL, default info)
 *
 * Env: LOG_DIR (default <repo>/logs), LOG_LEVEL, LOG_CONSOLE (=1 to also echo to stderr)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const LOG_DIR = path.resolve(process.env.LOG_DIR || path.join(REPO, "logs"));

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL = LEVELS[String(process.env.LOG_LEVEL || "info").toLowerCase()] ?? LEVELS.info;
const ECHO_CONSOLE = process.env.LOG_CONSOLE === "1" || process.env.LOG_CONSOLE === "true";

function day() {
  return new Date().toISOString().slice(0, 10);
}

function appendLine(dir, file, line) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, file), line + "\n");
  } catch {
    /* logging must never crash the caller */
  }
}

/** Clip a value for the unified live stream (keeps the JSONL lines bounded). */
function clip(v, n = 600) {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** Unified structured entry (the canonical live-log format). */
export function log({ source = "app", subSource, level = "info", message = "", data }) {
  const lvl = LEVELS[level] ?? LEVELS.info;
  if (lvl < MIN_LEVEL) return;
  const entry = { source, subSource, level, message };
  if (data !== undefined) entry.data = data;
  appendLine(path.join(LOG_DIR, "live"), `${day()}.jsonl`, JSON.stringify({ ts: new Date().toISOString(), ...entry }));
  if (ECHO_CONSOLE) process.stderr.write(`[${level}] ${source}${subSource ? "/" + subSource : ""}: ${message}\n`);
}

/**
 * Tool-call logging — preserves logs/tool_call/YYYY-MM-DD.log + *_verbose.log
 * (the format served by GET /tool-logs) while also emitting unified live entries.
 */
export function toolCall(source, subSource, { name, args, response, level = "info" }) {
  const ts = new Date().toISOString();
  const d = ts.slice(0, 10);
  const details = `${source}/${subSource}`;
  const input = JSON.stringify(args ?? {});
  let output;
  if (Array.isArray(response)) output = `${response.length} items`;
  else if (response && typeof response === "object" && response.id != null) output = `id=${response.id}`;
  else output = JSON.stringify(response ?? "").slice(0, 100);

  // Plain text (tail format consumed by /tool-logs)
  appendLine(path.join(LOG_DIR, "tool_call"), `${d}.log`, `[${ts}] EVENT name=tool_call details=${details} input=${input}`);
  appendLine(path.join(LOG_DIR, "tool_call"), `${d}.log`, `[${ts}] EVENT name=tool_response details=${details} output=${output}`);
  // Verbose JSONL
  appendLine(path.join(LOG_DIR, "tool_call"), `${d}_verbose.log`, JSON.stringify({ timestamp: ts, name: "tool_call", details, input }));
  appendLine(path.join(LOG_DIR, "tool_call"), `${d}_verbose.log`, JSON.stringify({ timestamp: ts, name: "tool_response", details, output }));
  // Unified live entry (for the Electron Logs viewer)
  log({ source, subSource, level, message: `tool_call ${name}`, data: { name, args: clip(args), response: clip(response) } });
}

/** Notification metadata — preserves logs/notifications/<source>/YYYY-MM-DD.jsonl. */
export function notify(source, type, data) {
  const ts = new Date().toISOString();
  appendLine(path.join(LOG_DIR, "notifications", source), `${ts.slice(0, 10)}.jsonl`, JSON.stringify({ ts, source, type, data }));
  log({ source: "notifications", subSource: source, level: "info", message: type, data });
}

/** Webhook verbose entry — preserves logs/webhook/YYYY-MM-DD_verbose.log. */
export function webhookVerbose(subSource, entry) {
  const ts = new Date().toISOString();
  appendLine(path.join(LOG_DIR, "webhook"), `${ts.slice(0, 10)}_verbose.log`, JSON.stringify({ ts, ...entry }));
  log({
    source: "webhook",
    subSource,
    level: entry.level || "info",
    message: entry.message || entry.type || "webhook event",
    data: entry,
  });
}

/** Webhook plain ERROR line — preserves logs/webhook/YYYY-MM-DD.log. */
export function webhookError(subSource, msg) {
  const ts = new Date().toISOString();
  appendLine(path.join(LOG_DIR, "webhook"), `${ts.slice(0, 10)}.log`, `[${ts}] ERROR: ${msg}`);
  log({ source: "webhook", subSource, level: "error", message: msg });
}

/** Forensic raw-body copy — preserves logs/webhook/raw/YYYY-MM-DD.jsonl. */
export function webhookRaw(source, body) {
  const ts = new Date().toISOString();
  appendLine(
    path.join(LOG_DIR, "webhook", "raw"),
    `${ts.slice(0, 10)}.jsonl`,
    JSON.stringify({ ts, source, body: typeof body === "object" ? body : { raw: String(body) } }),
  );
}

/** Resolve the repo logs dir (used by the Electron logger + file browser). */
export function getLogDir() {
  return LOG_DIR;
}
