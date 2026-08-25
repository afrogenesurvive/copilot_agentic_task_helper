/**
 * Frontdesk v2 — license-authenticated, E2E-encrypted chat backend.
 *
 * Replaces the old HMAC + passphrase frontdesk flow with license keys
 * (safe/frontdesk-keys) and ECDH → AES-256-GCM message encryption.
 *
 * Endpoints wired in index.js:
 *   POST /api/license/verify   — verify license → issue short-lived session token
 *   POST /api/frontdesk/send   — decrypt envelope, sanitize, enqueue (priority)
 *   GET  /api/frontdesk/poll   — return this seat's encrypted agent replies
 *   POST /api/frontdesk/reply  — internal: agent posts a reply (encrypted for seat)
 *   POST /api/session-log      — direct local session logging (+ Trello mirror if env-gated)
 *
 * Security model:
 *   - Login: client sends the FULL license (incl. seat private seeds) once; the
 *     server verifies via the Ed25519 master ring + live revoked-seats blocklist,
 *     then keeps ONLY { sub, pub, enc } in the session. Seeds never persist here.
 *   - Messages: client encrypts with ECDH(seat_x25519_priv, agent_pub); server
 *     decrypts with ECDH(agent_priv, seat_enc_pub). Replies go the other way with
 *     the same derived AES-256-GCM key. Agent keypair lives in
 *     safe/frontdesk-keys/agent/ (gitignored).
 *   - All decrypted text is passed through sanitizeObject() before the agent or
 *     any log sees it.
 *   - Agent replies are stored as ciphertext at rest (logs/frontdesk/output/).
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { enqueueEvent } from "./event-queue.js";
import { sanitizeObject } from "../../../scripts/sanitize.stub.mjs";
import {
  verifyLicenseKey,
  verifyCert,
  loadAgentKeys,
  deriveAesKeyServer,
  encryptAes,
  decryptAes,
} from "../../../scripts/frontdesk-license.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");
const FRONTDESK_DIR = path.join(ROOT, "logs", "frontdesk");
const INPUT_DIR = path.join(FRONTDESK_DIR, "input");
const OUTPUT_DIR = path.join(FRONTDESK_DIR, "output");
const SESSION_DIR = path.join(FRONTDESK_DIR, "sessions");
const SEATS_FILE = path.join(FRONTDESK_DIR, "seats.json");

const SESSION_TTL_MS = parseInt(process.env.FRONTDESK_SESSION_TTL || "7200", 10) * 1000;
import { log as logEvent } from "../../../shared/logger.mjs";

const LOG_TO_TRELLO = process.env.FRONTDESK_LOG_TO_TRELLO === "true";

// Sessions: token -> { sub, enc, pub, createdAt, expiresAt }
const sessions = new Map();

function dayFile(dir) {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(dir, `${day}.jsonl`);
}

function appendJsonl(dir, entry) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(dayFile(dir), JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    console.error(`   ❌ [FRONTDESK] Failed to append ${dir}: ${err.message}`);
  }
}

/* ── Seat registry (persisted so replies can be encrypted after restart) ────── */

function loadSeats() {
  try {
    if (fs.existsSync(SEATS_FILE)) return JSON.parse(fs.readFileSync(SEATS_FILE, "utf8")).seats || {};
  } catch {
    /* ignore */
  }
  return {};
}

function saveSeat(sub, enc, pub) {
  try {
    const seats = loadSeats();
    seats[sub] = { enc, pub, lastLoginAt: new Date().toISOString() };
    fs.mkdirSync(FRONTDESK_DIR, { recursive: true });
    fs.writeFileSync(SEATS_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), seats }, null, 2) + "\n", "utf8");
  } catch (err) {
    console.error(`   ❌ [FRONTDESK] Failed to persist seat registry: ${err.message}`);
  }
}

function getSeatEnc(sub) {
  return loadSeats()[sub]?.enc || null;
}

/* ── Sessions ───────────────────────────────────────────────────────────────── */

function cleanupExpired() {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (now >= s.expiresAt) sessions.delete(token);
  }
}

/** Verify a license and issue a session token. Returns { ok, token?, sub?, ... } or { ok:false, reason }. */
export function verifyLogin(license) {
  cleanupExpired();
  if (!license || typeof license !== "string") return { ok: false, reason: "license_required" };
  const res = verifyLicenseKey(license.trim());
  if (!res.ok) return { ok: false, reason: res.reason };
  if (!res.encReady) return { ok: false, reason: "no_enc_key" };

  const token = crypto.randomBytes(24).toString("hex");
  const now = Date.now();
  sessions.set(token, { sub: res.claims.sub, enc: res.claims.enc, pub: res.claims.pub, createdAt: now, expiresAt: now + SESSION_TTL_MS });
  saveSeat(res.claims.sub, res.claims.enc, res.claims.pub);

  console.log(`   🔑 [FRONTDESK] Login: "${res.claims.sub}" — session ${SESSION_TTL_MS / 60000}m`);
  return {
    ok: true,
    token,
    sub: res.claims.sub,
    exp: res.claims.exp,
    encReady: true,
    sessionExpiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
  };
}

/** Resolve a session token → session or null (also validates expiry). */
export function getSession(token) {
  cleanupExpired();
  if (!token || typeof token !== "string") return null;
  return sessions.get(token) || null;
}

/* ── Send (frontdesk → agent) ──────────────────────────────────────────────── */

/**
 * Core ingest: decrypt an envelope for a seat, sanitize, log, enqueue to the
 * priority queue. Shared by the direct /send path and the degraded `[fd1]` path.
 * @param {string} sub — seat id
 * @param {string} enc — seat X25519 public key (base64url)
 * @param {object} envelope — { iv, tag, ct }
 * @param {string} auditSource — label for the sanitizer
 * @param {object} flags — extra event data (e.g. _direct / _degraded)
 */
function processIncoming(sub, enc, envelope, auditSource, flags = {}) {
  if (!envelope || !envelope.iv || !envelope.tag || !envelope.ct) {
    return { ok: false, error: "missing_or_invalid_envelope" };
  }
  let agentKeys;
  try {
    agentKeys = loadAgentKeys();
  } catch (err) {
    return { ok: false, error: err.message };
  }

  // Server side: ECDH(agent_priv, seat_enc_pub)
  const key = deriveAesKeyServer(enc, agentKeys.privateD);
  let plaintext;
  try {
    plaintext = decryptAes(envelope, key);
  } catch {
    return { ok: false, error: "decrypt_failed" };
  }

  let parsed;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    parsed = { text: plaintext };
  }
  const text = typeof parsed?.text === "string" ? parsed.text : plaintext;
  const ts = parsed?.ts || new Date().toISOString();

  // Sanitize before the agent or any log sees it.
  const data = sanitizeObject(
    {
      sub,
      text,
      ts,
      _authorized: true,
      _verified: true,
      ...flags,
    },
    { auditSource: auditSource || "frontdesk/incoming" },
  );

  const id = crypto.randomBytes(8).toString("hex");
  appendJsonl(INPUT_DIR, { id, ts, sub, text: data.text });
  logEvent({ source: "frontdesk", subSource: "send", level: "info", message: `incoming from ${sub}`, data: { sub, id } });

  const event = {
    source: "frontdesk",
    type: "frontdesk_message",
    data,
    queuedAt: new Date().toISOString(),
    _frontdesk: true,
  };
  enqueueEvent(event, "priority");
  console.log(`   💬 [FRONTDESK] ${sub}: "${String(data.text).slice(0, 60)}" → priority queue`);

  return { ok: true, id };
}

/**
 * Direct send: decrypt an incoming message envelope for an authenticated session.
 * @param {object} session — from getSession()
 * @param {object} envelope — { iv, tag, ct }
 */
export function sendMessage(session, envelope) {
  if (!session) return { ok: false, error: "invalid_session" };
  return processIncoming(session.sub, session.enc, envelope, "frontdesk/send", { _direct: true });
}

/**
 * Degraded-mode ingest: verify the `[fd1]` cert+sig, then process the envelope.
 * The client sends only the PUBLIC cert + signature (never the seat private
 * seeds). Possession is proven by successful decryption.
 */
export function ingestDegradedEnvelope(certB64u, sigB64u, envelope) {
  const vc = verifyCert(certB64u, sigB64u);
  if (!vc.ok) return { ok: false, error: vc.reason };
  if (!vc.claims.enc) return { ok: false, error: "no_enc_key" };
  return processIncoming(vc.claims.sub, vc.claims.enc, envelope, "frontdesk/degraded", { _degraded: true });
}

/* ── Reply (agent → frontdesk) ─────────────────────────────────────────────── */

/**
 * Encrypt a reply for a seat and append it to the encrypted output store so
 * GET /api/frontdesk/poll can deliver it. Called by POST /api/frontdesk/reply
 * (internal — the agent runner).
 */
export function postReply({ sub, text }) {
  if (!sub || typeof text !== "string" || !text.trim()) return { ok: false, error: "sub_and_text_required" };
  const enc = getSeatEnc(sub);
  if (!enc) return { ok: false, error: `unknown_seat:${sub}` };

  let agentKeys;
  try {
    agentKeys = loadAgentKeys();
  } catch (err) {
    return { ok: false, error: err.message };
  }

  const safe = sanitizeObject({ text }, { auditSource: "frontdesk/reply" }).text;
  const key = deriveAesKeyServer(enc, agentKeys.privateD);
  const envelope = encryptAes(safe, key);
  const ts = new Date().toISOString();
  const id = crypto.randomBytes(8).toString("hex");

  appendJsonl(OUTPUT_DIR, { id, sub, ts, envelope });
  console.log(`   📨 [FRONTDESK] Reply to "${sub}": "${String(safe).slice(0, 60)}" (encrypted)`);
  logEvent({ source: "frontdesk", subSource: "reply", level: "info", message: `reply to ${sub}`, data: { sub, id } });
  return { ok: true, id, ts };
}

/**
 * Read encrypted replies for a seat since a cursor (ISO timestamp). The webapp
 * decrypts each envelope with ECDH(seat_priv, agent_pub).
 */
export function pollReplies(session, since) {
  if (!session) return { ok: false, error: "invalid_session" };
  const replies = [];
  let dir = OUTPUT_DIR;
  if (!fs.existsSync(dir)) return { ok: true, replies: [], serverNow: new Date().toISOString() };
  const files = fs.readdirSync(dir).sort();
  const sinceTs = since ? new Date(since).getTime() : 0;
  for (const f of files) {
    if (!f.endsWith(".jsonl")) continue;
    const lines = fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (e.sub !== session.sub) continue;
        const t = new Date(e.ts).getTime();
        if (t > sinceTs) replies.push({ id: e.id, ts: e.ts, envelope: e.envelope });
      } catch {
        /* skip malformed */
      }
    }
  }
  replies.sort((a, b) => a.ts.localeCompare(b.ts));
  return { ok: true, replies, serverNow: new Date().toISOString() };
}

/* ── Session logging (direct local; Trello mirror when env-gated) ──────────── */

export function logSession({ user, action, ip, userAgent, timezone, language }) {
  const ts = new Date().toISOString();
  const entry = { ts, user, action, ip: ip || null, userAgent: userAgent || null, timezone: timezone || null, language: language || null };
  appendJsonl(SESSION_DIR, entry);
  logEvent({ source: "frontdesk", subSource: "session", level: "info", message: `${action} — ${user}`, data: { user, action, ip } });

  // Optional Trello mirror (default: local only).
  if (LOG_TO_TRELLO) {
    const key = process.env.TRELLO_KEY;
    const token = process.env.TRELLO_TOKEN;
    const listId = process.env.TRELLO_LIST_SESSION_LOGS;
    if (key && token && listId) {
      const cardName = `${action === "login" ? "🔓" : "🔒"} ${String(action).charAt(0).toUpperCase() + String(action).slice(1)} — ${user} — ${ip || "unknown"}`;
      fetch(`https://api.trello.com/1/cards?idList=${encodeURIComponent(listId)}&key=${encodeURIComponent(key)}&token=${encodeURIComponent(token)}&name=${encodeURIComponent(cardName)}&desc=${encodeURIComponent(JSON.stringify(entry))}`, { method: "POST" })
        .then((r) => r.ok && console.log(`   📋 [FRONTDESK] Session log mirrored to Trello (${action} — ${user})`))
        .catch((e) => console.error(`   ❌ [FRONTDESK] Trello session-log mirror failed: ${e.message}`));
    } else {
      console.warn(`   ⚠️ [FRONTDESK] FRONTDESK_LOG_TO_TRELLO=true but TRELLO_KEY/TOKEN/LIST_SESSION_LOGS missing — local only`);
    }
  }
  return { ok: true, ts };
}
