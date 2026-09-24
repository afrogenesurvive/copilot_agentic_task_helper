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
 * PROMPT-INJECTION DEFENCE: data written here can contain text that arrived from
 * the outside world (Trello cards, email subjects, WhatsApp messages, web pages)
 * and logs/live/*.jsonl is rendered by the Electron Logs viewer, so every sink
 * runs its payload through the sanitizer. Callers are expected to sanitize too —
 * this is the backstop, not a replacement.
 *
 * The single exception is `webhookRaw()`, which exists to keep an untouched
 * forensic copy of a webhook body for debugging. Those files are never replayed
 * into a model or a UI; see the note on that function.
 *
 * Env: LOG_DIR (default <repo>/logs), LOG_LEVEL, LOG_CONSOLE (=1 to also echo to stderr)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { sanitizeObject } from "../scripts/sanitize.stub.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
// Resolve LOG_DIR against the repo root, NOT the cwd. .env sets LOG_DIR=logs
// (relative); when a process is started from a subfolder (e.g. the webhook
// server launched from mcp/webhook-server/) a cwd-relative resolve would scatter
// logs into that subfolder — which for the webhook server sits inside the
// directory it watches in dev mode. Anchoring to REPO keeps every component's
// logs in <repo>/logs no matter where it was started. Absolute LOG_DIR values
// pass through path.resolve unchanged.
const LOG_DIR = process.env.LOG_DIR ? path.resolve(REPO, process.env.LOG_DIR) : path.join(REPO, "logs");

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

/**
 * Backstop sanitizer for log payloads (objects, arrays, or scalars).
 *
 * Uses the same skip-id/url semantics as the MCP servers so log correlation IDs
 * stay intact, and walks arrays explicitly because a list payload (Trello cards,
 * Gmail messages) is common here.
 */
function cleanPayload(value, auditSource) {
  if (typeof value === "string") return sanitizeObject({ text: value }, { auditSource }).text;
  if (Array.isArray(value)) return value.map((item) => cleanPayload(item, auditSource));
  if (value && typeof value === "object") return sanitizeObject(value, { auditSource });
  return value;
}

/** Unified structured entry (the canonical live-log format). */
export function log({ source = "app", subSource, level = "info", message = "", data }) {
  const lvl = LEVELS[level] ?? LEVELS.info;
  if (lvl < MIN_LEVEL) return;
  // `message` is sanitized as well as `data`: several callers build it from live
  // request/envelope values (e.g. `${req.method} ${req.path}`, `incoming from <seat>`),
  // which is enough for a crafted path or seat id to land in the live log — and
  // logs/live is what the Electron Logs viewer renders.
  const safeMessage = typeof message === "string" ? cleanPayload(message, `log/${source}`) : message;
  const entry = { source, subSource, level, message: safeMessage };
  if (data !== undefined) entry.data = cleanPayload(data, `log/${source}`);
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
  // `args` are model-authored, but a value copied out of an email or card can end
  // up in them (e.g. gmail_send_message body), so they are sanitized on the way in.
  const input = JSON.stringify(cleanPayload(args ?? {}, `toolCall/${details}`));
  let output;
  if (Array.isArray(response)) output = `${response.length} items`;
  else if (response && typeof response === "object" && response.id != null) output = `id=${response.id}`;
  else output = JSON.stringify(cleanPayload(response ?? "", `toolCall/${details}`)).slice(0, 100);

  // Plain text (tail format consumed by /tool-logs)
  appendLine(path.join(LOG_DIR, "tool_call"), `${d}.log`, `[${ts}] EVENT name=tool_call details=${details} input=${input}`);
  appendLine(path.join(LOG_DIR, "tool_call"), `${d}.log`, `[${ts}] EVENT name=tool_response details=${details} output=${output}`);
  // Verbose JSONL
  appendLine(path.join(LOG_DIR, "tool_call"), `${d}_verbose.log`, JSON.stringify({ timestamp: ts, name: "tool_call", details, input }));
  appendLine(path.join(LOG_DIR, "tool_call"), `${d}_verbose.log`, JSON.stringify({ timestamp: ts, name: "tool_response", details, output }));
  // Unified live entry (for the Electron Logs viewer)
  log({ source, subSource, level, message: `tool_call ${name}`, data: { name, args: clip(cleanPayload(args ?? {}, `toolCall/${details}`)), response: clip(cleanPayload(response, `toolCall/${details}`)) } });
}

/** Notification metadata — preserves logs/notifications/<source>/YYYY-MM-DD.jsonl. */
export function notify(source, type, data) {
  const ts = new Date().toISOString();
  const safeData = cleanPayload(data, `notify/${source}`);
  appendLine(path.join(LOG_DIR, "notifications", source), `${ts.slice(0, 10)}.jsonl`, JSON.stringify({ ts, source, type, data: safeData }));
  log({ source: "notifications", subSource: source, level: "info", message: type, data: safeData });
}

/** Webhook verbose entry — preserves logs/webhook/YYYY-MM-DD_verbose.log. */
export function webhookVerbose(subSource, entry) {
  const ts = new Date().toISOString();
  const safe = cleanPayload(entry, `webhook/${subSource}`);
  appendLine(path.join(LOG_DIR, "webhook"), `${ts.slice(0, 10)}_verbose.log`, JSON.stringify({ ts, ...safe }));
  log({
    source: "webhook",
    subSource,
    level: entry.level || "info",
    message: entry.message || entry.type || "webhook event",
    data: safe,
  });
}

/** Webhook plain ERROR line — preserves logs/webhook/YYYY-MM-DD.log. */
export function webhookError(subSource, msg) {
  const ts = new Date().toISOString();
  appendLine(path.join(LOG_DIR, "webhook"), `${ts.slice(0, 10)}.log`, `[${ts}] ERROR: ${msg}`);
  log({ source: "webhook", subSource, level: "error", message: msg });
}

/**
 * Forensic raw-body copy — preserves logs/webhook/raw/YYYY-MM-DD.jsonl.
 *
 * THE ONE INTENTIONAL EXCEPTION to the sanitizing sinks above: this keeps the
 * webhook payload exactly as it arrived, which is the point of a forensic copy.
 * Nothing may replay these files into a model or a UI — they exist for grep/manual
 * inspection when a webhook misbehaves. If you ever feed one to an LLM, sanitize
 * it first.
 */
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
