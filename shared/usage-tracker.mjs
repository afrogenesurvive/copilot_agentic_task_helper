/**
 * Usage Tracker — per-API-call LLM usage buffer + push to DS-mon
 *
 * Ported from the ai_transcription_agent DS-mon integration. After every cloud
 * LLM call (deepseek / openai / anthropic) made through shared/model-provider.mjs,
 * token usage is captured and buffered locally in a JSONL file. A periodic timer
 * flushes the buffer to DS-mon's /sync/push endpoint for centralized per-machine
 * usage monitoring across multiple instances sharing the same API key. Ollama
 * (local, no cost) is intentionally excluded.
 *
 * Configuration (all optional — tracking disabled when the master switch is off
 * or no push URL is set). Values are read LAZILY from process.env on each call,
 * so config.json / .env changes apply without a restart, and the JSON-priority
 * + .env-fallback semantics of shared/config-loader.cjs are honored because every
 * entry point boots via config.loadEnvInto() before any LLM call.
 *
 * DS-mon requires the bearer token on /sync/push and fails closed without it, so a
 * 401/403 is a PERMANENT condition, not a transient one: tracking PAUSES (stops the
 * 60s retry, stops buffering new records, keeps every buffered record) and resumes
 * only once the token changes. See pausedReason below.
 *
 *   USAGE_TRACKING_ENABLED   — master switch ("true" enables collection+push)
 *   DSMON_PUSH_URL           — DS-mon push base URL (bare host gets /sync/push)
 *   DSMON_PUSH_TOKEN         — bearer token required by /sync/push. REQUIRED
 *                              whenever DSMON_PUSH_URL is set; DS-mon fails
 *                              closed without it, so tracking refuses to start
 *                              rather than pushing unauthenticated.
 *   DSMON_PUSH_INTERVAL      — flush interval in ms (default: 300000 = 5 min)
 *   DSMON_INSTANCE_ID        — instance identifier (default: auto-generated
 *                              <hostname>-<user>-<uuid>, persisted under logs/)
 *   DSMON_ENCRYPTION_KEY     — base64url 32-byte AES-256 key; when set, each
 *                              push batch is wrapped in an AES-256-GCM envelope
 *                              (matches DS-mon's afrogene/dsmon.key)
 *   DSMON_ENCRYPTION_KEY_ID  — key id placed in each envelope (default: "dsmon")
 *
 * Storage (all under the repo's gitignored logs/):
 *   logs/dsmon_buffer.jsonl  — buffered usage records (crash/offline resilient)
 *   logs/dsmon.log           — persistent push-outcome diagnostics
 *   logs/.dsmon_instance_id  — persistent short instance UUID
 */
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import config from "./config-loader.cjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_BASE = path.resolve(__dirname, "..", "logs");

const BUFFER_FILE = path.join(LOGS_BASE, "dsmon_buffer.jsonl");
const LOG_FILE = path.join(LOGS_BASE, "dsmon.log");
const ID_FILE = path.join(LOGS_BASE, ".dsmon_instance_id");

// Cap the buffer so a permanently-unreachable DS-mon host can't grow it forever.
const MAX_BUFFER_BYTES = 5 * 1024 * 1024; // 5 MB
const PUSH_TIMEOUT_MS = 30000; // 30s — a slow tunnel can exceed 15s
const RETRY_DELAY_MS = 60000; // fast retry after a failed push

// Last-push status (for UI / telemetry visibility via getDsmonStatus).
let lastPush = { at: null, ok: null, count: 0, error: null };
let flushTimer = null;
let retryTimer = null;

// Permanent-failure pause. DS-mon's /sync/push now requires the bearer token and
// fails closed, so a 401/403 is a CONFIGURATION error, not an outage: retrying it
// can never succeed, it only burns attempts until the 5 MB cap starts dropping
// records with a misleading "host unreachable?" message. While paused we stop the
// fast retry AND stop buffering new records (there is nowhere to deliver them), but
// the periodic flush timer stays armed so a corrected DSMON_PUSH_TOKEN replays the
// retained backlog on the next tick.
let pausedReason = null; // "unauthorized" | "token-missing" | null
let pausedToken = null; // token in effect when the pause began ("" when missing)
let pauseLogged = false; // log the pause once, not per call

/* ── lazy config resolution (read live from process.env) ── */

function trackingEnabled() {
  // Belt-and-suspenders: make sure config.json/.env are in process.env even if
  // a direct importer (e.g. a script) didn't run config.loadEnvInto() itself.
  config.loadEnvInto(process.env);
  return process.env.USAGE_TRACKING_ENABLED === "true";
}

function pushUrl() {
  let url = (process.env.DSMON_PUSH_URL || "").trim().replace(/\/+$/, "");
  if (url && !/\/sync\/push$/i.test(url)) url += "/sync/push";
  return url;
}

function pushInterval() {
  return parseInt(process.env.DSMON_PUSH_INTERVAL || "300000", 10);
}

/**
 * True when tracking is enabled and a push URL is configured but no push token is
 * set. DS-mon refuses /sync/push without it, so this is a hard prerequisite of the
 * USAGE_TRACKING_ENABLED block rather than a silent no-op.
 */
function tokenMissing() {
  return trackingEnabled() && !!pushUrl() && !(process.env.DSMON_PUSH_TOKEN || "").trim();
}

/* ── AES-256-GCM envelope (mirrors ai_transcription_agent/agent-runner/crypto.js) ── */

const toB64 = (b) => Buffer.from(b).toString("base64url");
const fromB64 = (s) => Buffer.from(s, "base64url");

function encryptEnvelope(kid, keyB64, payload) {
  const key = crypto.createSecretKey(fromB64(keyB64));
  const nonce = crypto.randomBytes(12); // 96-bit standard GCM IV
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { kid, v: 1, nonce: toB64(nonce), tag: toB64(tag), ct: toB64(ct) };
}

/* ── diagnostics ── */

function _log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + "\n", "utf8");
  } catch {
    // Non-fatal — diagnostics only
  }
}

/** Export current push status + buffer stats (for UI / diagnostics). */
export function getDsmonStatus() {
  let bufferBytes = 0;
  let bufferCount = 0;
  try {
    if (fs.existsSync(BUFFER_FILE)) {
      bufferBytes = fs.statSync(BUFFER_FILE).size;
      bufferCount = fs
        .readFileSync(BUFFER_FILE, "utf8")
        .split("\n")
        .filter((l) => l.trim()).length;
    }
  } catch {
    // ignore
  }
  return {
    ...lastPush,
    bufferBytes,
    bufferCount,
    instanceId: getInstanceId(),
    paused: pausedReason !== null,
    reason: pausedReason,
  };
}

/* ── instance id ── */

/**
 * Stable, human-readable instance identifier:
 *   DSMON_INSTANCE_ID env var > <hostname>-<username>-<short-uuid>
 * The short UUID is persisted to logs/.dsmon_instance_id so it stays stable
 * across restarts while uniquely identifying this machine/user combo.
 */
function getInstanceId() {
  const explicit = process.env.DSMON_INSTANCE_ID;
  if (explicit) return explicit;

  const hostname = os
    .hostname()
    .replace(/\.local$/, "")
    .replace(/\..*$/, "")
    .toLowerCase();
  const username = (os.userInfo().username || "unknown").toLowerCase();

  let shortId;
  try {
    shortId = fs.readFileSync(ID_FILE, "utf8").trim();
    if (shortId) return `${hostname}-${username}-${shortId}`;
  } catch {
    // File doesn't exist yet — generate new ID
  }

  shortId = crypto.randomUUID().split("-")[0];
  try {
    fs.mkdirSync(path.dirname(ID_FILE), { recursive: true });
    fs.writeFileSync(ID_FILE, shortId, "utf8");
  } catch {
    // Non-fatal — use a transient ID
  }
  return `${hostname}-${username}-${shortId}`;
}

/* ── retry scheduling ── */

function _scheduleRetry() {
  // A permanent failure (401/403) must never re-arm the fast retry.
  if (pausedReason) return;
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    flushBuffer();
  }, RETRY_DELAY_MS);
}

/**
 * Clear the permanent-failure pause. Only called once the pause condition is
 * actually resolved: a successful push, or a changed push token.
 */
function _clearPause() {
  if (!pausedReason) return;
  pausedReason = null;
  pausedToken = null;
  pauseLogged = false;
}

/* ── record + flush ── */

/**
 * Record a per-API-call usage entry to the local JSONL buffer.
 * No-op unless USAGE_TRACKING_ENABLED=true AND a DSMON_PUSH_URL is set.
 *
 * @param {object|null} usage — normalized usage object (OpenAI shape):
 *   { prompt_tokens, completion_tokens, total_tokens,
 *     prompt_tokens_details?: { cached_tokens },
 *     completion_tokens_details?: { reasoning_tokens } }
 * @param {object} info — metadata for the call:
 * @param {string} info.providerId — "deepseek" | "openai" | "anthropic" | "ollama"
 * @param {string} info.model      — model name used for the call
 * @param {number} [info.latencyMs] — round-trip latency in ms
 * @param {string} [info.source]   — meta label: which flow made the call
 *   (e.g. "agent-runner" | "webhook-execute" | "electron-chat" | "operator-agent")
 * @param {string|number} [info.step] — optional step/turn/round identifier
 * @param {string} [info.tool]     — optional tool name chosen in that call
 */
export function recordCall(usage, info = {}) {
  if (!usage) return;
  if (!trackingEnabled()) return;
  const url = pushUrl();
  if (!url) return;

  // Paused: don't buffer. The record would only pile up behind a backlog that
  // cannot be delivered, and the cap would eventually drop it silently with the
  // misleading "host unreachable?" message. Logged once, not per call.
  if (pausedReason) {
    if (!pauseLogged) {
      pauseLogged = true;
      _log(`⚠️ [DSMON] Tracking paused (${pausedReason}) — call not buffered. Fix DSMON_PUSH_TOKEN to resume.`);
    }
    return;
  }

  const pid = String(info.providerId || process.env.LLM_PROVIDER || "deepseek").toLowerCase();
  // Ollama is local + free — never sent to DS-mon (reference behavior).
  if (pid === "ollama") return;

  const instanceId = getInstanceId();
  // Endpoint mirrors the actual upstream API shape DS-mon's UsageLogger parses.
  const endpoint = pid === "anthropic" ? "/v1/messages" : "/v1/chat/completions";

  const record = {
    uuid: crypto.randomUUID(),
    timestamp: Date.now() / 1000,
    providerId: pid,
    model: info.model || "unknown",
    endpoint,
    promptTokens: usage.prompt_tokens || 0,
    completionTokens: usage.completion_tokens || 0,
    totalTokens: usage.total_tokens || 0,
    cachedTokens: usage.prompt_tokens_details?.cached_tokens || 0,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens || 0,
    latencyMs: info.latencyMs || 0,
    statusCode: 200,
    userAgent: `task-helper/${instanceId}`,
    sourceIP: instanceId,
    // Meta labelling — which flow originated the call (extra, non-breaking).
    source: info.source || "unknown",
    ...(info.step != null ? { step: info.step } : {}),
    ...(info.tool ? { tool: info.tool } : {}),
  };

  try {
    fs.mkdirSync(path.dirname(BUFFER_FILE), { recursive: true });
    if (fs.existsSync(BUFFER_FILE) && fs.statSync(BUFFER_FILE).size > MAX_BUFFER_BYTES) {
      _log(`⚠️ [DSMON] Buffer exceeds ${MAX_BUFFER_BYTES} bytes — dropping record (host unreachable?)`);
      return;
    }
    fs.appendFileSync(BUFFER_FILE, JSON.stringify(record) + "\n", "utf8");
  } catch (err) {
    _log(`⚠️ [DSMON] Failed to buffer usage record: ${err.message}`);
    return;
  }

  // Auto-start the periodic flush on the first buffered record so long-lived
  // LLM-consuming processes need no extra wiring. Idempotent.
  startFlushTimer();
}

/**
 * Flush buffered records to DS-mon's /sync/push endpoint.
 * On success (HTTP 200) the buffer is truncated and any pause is cleared. On a
 * transient failure (network / non-401) records are retained for retry on the next
 * cycle. On 401/403 the failure is permanent: tracking pauses, records are retained
 * untouched, and nothing is retried until the token changes.
 */
export async function flushBuffer() {
  if (!trackingEnabled()) return;
  const url = pushUrl();
  if (!url) return;

  const token = (process.env.DSMON_PUSH_TOKEN || "").trim();

  // While paused, do not re-attempt the push with the same credential — the
  // failure is permanent, so a repeat only burns a request and logs noise. A
  // changed token clears the pause so the retained backlog flushes on this run.
  if (pausedReason) {
    if (token === pausedToken) return;
    _log(`📊 [DSMON] Push token changed — clearing pause (was: ${pausedReason})`);
    _clearPause();
  }

  if (!fs.existsSync(BUFFER_FILE)) return;

  let records = [];
  try {
    const content = fs.readFileSync(BUFFER_FILE, "utf8");
    records = content
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch (err) {
    _log(`⚠️ [DSMON] Failed to read buffer file: ${err.message}`);
    return;
  }

  if (records.length === 0) return;

  try {
    const headers = { "Content-Type": "application/json" };
    // `token` is resolved (and trimmed) once at the top of this function.
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const encryptionKey = process.env.DSMON_ENCRYPTION_KEY || "";
    const body = encryptionKey
      ? JSON.stringify(
          encryptEnvelope(process.env.DSMON_ENCRYPTION_KEY_ID || "dsmon", encryptionKey, records),
        )
      : JSON.stringify(records);

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });

    if (resp.ok) {
      // Truncate the buffer — write empty (not unlink) to avoid races with
      // concurrent recordCall() appends.
      fs.writeFileSync(BUFFER_FILE, "", "utf8");
      lastPush = { at: Date.now(), ok: true, count: records.length, error: null };
      _clearPause();
      _log(`📊 [DSMON] Pushed ${records.length} usage records to ${url}`);
    } else if (resp.status === 401 || resp.status === 403) {
      // PERMANENT. The DS-mon host now fails closed, so no retry can succeed.
      // Pause, keep every buffered record untouched, and do NOT arm the fast
      // retry — the periodic timer stays armed and resumes on a token change.
      await resp.text().catch(() => "");
      pausedReason = "unauthorized";
      pausedToken = token;
      lastPush = { at: Date.now(), ok: false, count: records.length, error: "unauthorized" };
      if (!pauseLogged) {
        pauseLogged = true;
        _log(
          `⚠️ [DSMON] Push token missing/invalid — tracking paused (fix DSMON_PUSH_TOKEN). ` +
            `${records.length} record(s) retained; no further pushes until the token changes.`,
        );
      }
    } else {
      const text = await resp.text().catch(() => "");
      lastPush = { at: Date.now(), ok: false, count: records.length, error: `HTTP ${resp.status} ${text.slice(0, 100)}` };
      _log(`⚠️ [DSMON] Push failed: HTTP ${resp.status} ${text.slice(0, 100)} — ${records.length} records retained`);
      _scheduleRetry();
    }
  } catch (err) {
    lastPush = { at: Date.now(), ok: false, count: records.length, error: err.message };
    _log(`⚠️ [DSMON] Push error: ${err.message} — ${records.length} records retained for retry`);
    _scheduleRetry();
  }
}

/**
 * Start the periodic flush timer. Also performs an immediate flush to catch
 * records buffered while the process was previously offline. Idempotent.
 */
export function startFlushTimer() {
  if (!trackingEnabled()) return;
  if (!pushUrl()) return;

  // Fail closed, mirroring DS-mon itself: with no token configured every push
  // would be refused, so arming the timer would only burn attempts. Report the
  // condition through getDsmonStatus() instead of pushing unauthenticated.
  if (tokenMissing()) {
    pausedReason = "token-missing";
    pausedToken = "";
    if (!pauseLogged) {
      pauseLogged = true;
      _log("⚠️ [DSMON] DSMON_PUSH_TOKEN missing — tracking disabled until it is set");
    }
    return;
  }

  if (flushTimer) return;

  const interval = pushInterval();
  console.log(`📊 [DSMON] Starting flush timer (interval: ${interval}ms, instance: ${getInstanceId()})`);

  // Arm the interval BEFORE the first flush: a pause raised by that flush must
  // not leave the timer unarmed, otherwise a corrected token would have nothing
  // left to replay the retained backlog.
  flushTimer = setInterval(flushBuffer, interval);

  // Immediate flush on start (catches offline-period records)
  flushBuffer();
}

/** Stop the periodic flush timer. */
export function stopFlushTimer() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
    console.log(`📊 [DSMON] Flush timer stopped`);
  }
}
