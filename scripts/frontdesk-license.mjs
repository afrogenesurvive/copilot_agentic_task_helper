#!/usr/bin/env node
/**
 * frontdesk-license.mjs — READ-ONLY licence verifier + frontdesk↔agent crypto.
 *
 * The key store lives in the sibling **personal_key_manager** repo, which is the
 * single source of truth for every ring, seat, revocation and audit record. This
 * module READS that store; it never mints, revokes or writes anything. Use the
 * `pkm` CLI there (or the operator dashboard's 🔑 Key Manager tab, which shells
 * out to it) for every management operation.
 *
 * ── Store layout (under <PKM_ROOT>/registries/<registry dir>) ──
 *   ring.json            master public keys, by kid      → verify seat certs
 *   revoked-seats.json   authoritative seat blocklist    → read live on every verify
 *   agent/               X25519 peer keypair             → decrypt frontdesk traffic
 *
 * Every path below comes from `pkmPaths()` in scripts/pkm-paths.mjs — nothing
 * is hardcoded here. Relocate the store or pick another registry with the
 * PKM_REPO / PKM_ROOT / PKM_REGISTRY config keys (⚙️ Config). Because these are
 * module constants, changing them requires restarting the webhook server.
 *
 * ── Licence format ──
 *   TA1.<b64url(certJson)>.<b64url(sig)>.<b64url(seatKeys)>
 *     certJson  = { app, v, sub, exp, kid, pub, enc }
 *       pub = seat Ed25519 public key (base64url)
 *       enc = seat X25519 public key (base64url)
 *     sig       = Ed25519 signature by the MASTER private key over the certJson bytes
 *     seatKeys  = base64url raw 64 bytes: 32-byte Ed25519 seed + 32-byte X25519 seed
 *     exp       = 0 means UNLIMITED; otherwise unix seconds
 *
 * Verification order: malformed → malformed_cert → app_mismatch → unknown_kid →
 * retired_kid → revoked_seat → bad_signature → bad_seat_key/key_mismatch → expired.
 * Revocation is checked BEFORE the signature, so a revoked seat is always caught.
 *
 * ── Encryption (frontdesk ↔ agent) ──
 *   ECDH(seat_x25519_priv, agent_x25519_pub) == ECDH(agent_x25519_priv, seat_x25519_pub)
 *     → SHA-256("frontdesk-v1" ‖ shared) → 32-byte AES-256-GCM key, both directions.
 *   The browser mirrors this exactly in webapp/public/crypto.js.
 *
 * Login handshake: the client sends the FULL licence (private seeds) once to prove
 * possession; the server verifies it and keeps only { sub, pub, enc } in the
 * session. Subsequent messages carry only public info + the AES-GCM envelope.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { pkmPaths } from "./pkm-paths.mjs";

/**
 * Resolved once at import from PKM_REPO / PKM_ROOT / PKM_REGISTRY (see
 * scripts/pkm-paths.mjs). Call `pkmPaths()` directly when a live lookup is
 * needed — e.g. after a config change, or for a registry other than this one.
 */
const PATHS = pkmPaths();

/** Root of the personal_key_manager store (PKM_ROOT, defaulting to PKM_REPO). */
export const PKM_ROOT = PATHS.store;
export const PKM_REPO = PATHS.repo;
/** Licensed app id embedded in a cert's `app` field (from the registry index). */
export const APP_ID = PATHS.app;
export const VERSION = 1;

/** This registry's directory inside the pkm store (index `dir`, else its id). */
export const DEV_KEYS_DIR = PATHS.registryDir;
export const RING_FILE = PATHS.ringFile;
export const REVOKED_SEATS_FILE = PATHS.revokedFile;

/** Agent X25519 peer keypair — used to decrypt frontdesk ↔ agent traffic. */
export const AGENT_KEYS_DIR = PATHS.agentDir;
export const AGENT_PUBLIC_KEY_FILE = path.join(AGENT_KEYS_DIR, "agent-public.key");
export const AGENT_PRIVATE_KEY_FILE = path.join(AGENT_KEYS_DIR, "agent-private.key");

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const fromB64u = (s) => Buffer.from(s, "base64url");
const KEY_RE = /^TA1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

// ── Store reads ────────────────────────────────────────────────────────────────

/** The published master key ring ({ keys: [{ kid, publicKey, notAfter }] }). */
export function loadRing() {
  if (!fs.existsSync(RING_FILE)) return { keys: [] };
  try {
    return JSON.parse(fs.readFileSync(RING_FILE, "utf8"));
  } catch {
    return { keys: [] };
  }
}

/**
 * The authoritative per-seat blocklist. Read live on every verify — so a revoke
 * performed in the Key Manager takes effect on the seat's next login, with no
 * restart or rebuild.
 */
export function loadRevokedSeats() {
  if (!fs.existsSync(REVOKED_SEATS_FILE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(REVOKED_SEATS_FILE, "utf8"));
    return Array.isArray(data.seats) ? data.seats : [];
  } catch {
    return [];
  }
}

/** Look up a ring entry by kid. Returns null for an unknown kid. */
export function resolveRingEntry(kid) {
  const ring = loadRing();
  return (ring.keys || []).find((k) => k.kid === kid) || null;
}

/** The agent's X25519 keypair (publicX + privateD). Throws if not provisioned. */
export function loadAgentKeys() {
  if (!fs.existsSync(AGENT_PUBLIC_KEY_FILE) || !fs.existsSync(AGENT_PRIVATE_KEY_FILE)) {
    throw new Error(
      `Agent keypair not found in ${AGENT_KEYS_DIR}/ — create it with \`pkm ring agent-key ${PATHS.registry}\`.`,
    );
  }
  return {
    publicX: fs.readFileSync(AGENT_PUBLIC_KEY_FILE, "utf8").trim(),
    privateD: fs.readFileSync(AGENT_PRIVATE_KEY_FILE, "utf8").trim(),
  };
}

// ── Verify ────────────────────────────────────────────────────────────────────

/**
 * Verify a full licence key (cert + signature + seat-possession proof).
 * @returns {{ok: true, claims: object, encReady: boolean} | {ok: false, reason: string}}
 */
export function verifyLicenseKey(licenseKey, now = Date.now()) {
  const m = KEY_RE.exec(licenseKey);
  if (!m) return { ok: false, reason: "malformed" };
  const [, certB64, sigB64, seatKeysB64] = m;

  let cert;
  try {
    cert = JSON.parse(fromB64u(certB64).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed_cert" };
  }
  if (cert.app !== APP_ID || cert.v !== VERSION) return { ok: false, reason: "app_mismatch" };

  const entry = resolveRingEntry(cert.kid);
  if (!entry) return { ok: false, reason: "unknown_kid" };
  if (entry.notAfter && now >= entry.notAfter * 1000) return { ok: false, reason: "retired_kid" };
  if (loadRevokedSeats().includes(cert.sub)) return { ok: false, reason: "revoked_seat" };

  const masterPub = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: entry.publicKey }, format: "jwk" });
  const sigValid = crypto.verify(null, fromB64u(certB64), masterPub, fromB64u(sigB64));
  if (!sigValid) return { ok: false, reason: "bad_signature" };

  // Seat possession check: the Ed25519 private seed (first 32 bytes of seatKeys)
  // must derive the same public key as cert.pub.
  let seatKeys = null;
  try {
    seatKeys = fromB64u(seatKeysB64);
  } catch {
    return { ok: false, reason: "bad_seat_key" };
  }
  const edD = seatKeys.subarray(0, 32).toString("base64url");
  let derivedPub;
  try {
    const seatPriv = crypto.createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", x: cert.pub, d: edD }, format: "jwk" });
    derivedPub = seatPriv.export({ format: "jwk" }).x;
  } catch {
    return { ok: false, reason: "bad_seat_key" };
  }
  if (derivedPub !== cert.pub) return { ok: false, reason: "key_mismatch" };

  // Encryption readiness: seatKeys must contain the X25519 seed (64 bytes total).
  const encReady = seatKeys.length === 64 && typeof cert.enc === "string";

  if (cert.exp !== 0 && now >= cert.exp * 1000) return { ok: false, reason: "expired" };

  return {
    ok: true,
    claims: { app: cert.app, v: cert.v, sub: cert.sub, exp: cert.exp, kid: cert.kid, pub: cert.pub, enc: cert.enc ?? null },
    encReady,
  };
}

/**
 * Verify a bare cert + signature (no seat-possession check). Used by the
 * degraded `[fd1]` fallback path, where the client sends only the PUBLIC cert +
 * signature. Possession is proven separately by the fact that only the seat's
 * X25519 private key can produce a decryptable envelope. This only proves the
 * cert is genuinely issued by the master ring (and not revoked/expired).
 * Returns { ok, claims } or { ok: false, reason }.
 */
export function verifyCert(certB64, sigB64, now = Date.now()) {
  let cert;
  try {
    cert = JSON.parse(fromB64u(certB64).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed_cert" };
  }
  if (cert.app !== APP_ID || cert.v !== VERSION) return { ok: false, reason: "app_mismatch" };
  const entry = resolveRingEntry(cert.kid);
  if (!entry) return { ok: false, reason: "unknown_kid" };
  if (entry.notAfter && now >= entry.notAfter * 1000) return { ok: false, reason: "retired_kid" };
  if (loadRevokedSeats().includes(cert.sub)) return { ok: false, reason: "revoked_seat" };
  if (cert.exp !== 0 && now >= cert.exp * 1000) return { ok: false, reason: "expired" };
  if (!cert.enc) return { ok: false, reason: "no_enc_key" };
  const masterPub = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: entry.publicKey }, format: "jwk" });
  let sigValid = false;
  try {
    sigValid = crypto.verify(null, fromB64u(certB64), masterPub, fromB64u(sigB64));
  } catch {
    sigValid = false;
  }
  if (!sigValid) return { ok: false, reason: "bad_signature" };
  return { ok: true, claims: cert };
}

// ── ECDH → AES-256-GCM (frontdesk ↔ agent encryption) ─────────────────────────

const DOMAIN = Buffer.from("frontdesk-v1", "utf8");

/**
 * Server side: derive the AES key from a seat's PUBLIC enc key + the agent's
 * private key → ECDH(agent_priv, seat_pub). This is what the webhook server
 * uses to decrypt client messages and encrypt replies. Only the seat's PUBLIC
 * key is needed — the seat private seeds never reach the server after login.
 */
export function deriveAesKeyServer(seatEncPubX, agentPrivateD) {
  const agentPriv = crypto.createPrivateKey({ key: { kty: "OKP", crv: "X25519", x: seatEncPubX, d: agentPrivateD }, format: "jwk" });
  const seatPub = crypto.createPublicKey({ key: { kty: "OKP", crv: "X25519", x: seatEncPubX }, format: "jwk" });
  const shared = crypto.diffieHellman({ privateKey: agentPriv, publicKey: seatPub });
  return crypto.createHash("sha256").update(Buffer.concat([DOMAIN, shared])).digest();
}

/**
 * Client side: derive the AES key from the user's license (seat X25519 private
 * seed) + the agent's PUBLIC key → ECDH(seat_priv, agent_pub). Used by the
 * webapp to encrypt sends and decrypt agent replies.
 */
export function deriveAesKeyClient(licenseKey, agentPubX) {
  const m = KEY_RE.exec(licenseKey);
  if (!m) throw new Error("malformed license key");
  const seatKeys = fromB64u(m[3]);
  if (seatKeys.length !== 64) throw new Error("license key has no X25519 seat key (cannot encrypt)");
  const xPrivD = seatKeys.subarray(32, 64).toString("base64url");
  let cert;
  try {
    cert = JSON.parse(fromB64u(m[1]).toString("utf8"));
  } catch {
    throw new Error("malformed cert");
  }
  if (typeof cert.enc !== "string") throw new Error("cert has no enc key (cannot encrypt)");
  const seatPriv = crypto.createPrivateKey({ key: { kty: "OKP", crv: "X25519", x: cert.enc, d: xPrivD }, format: "jwk" });
  const agentPub = crypto.createPublicKey({ key: { kty: "OKP", crv: "X25519", x: agentPubX }, format: "jwk" });
  const shared = crypto.diffieHellman({ privateKey: seatPriv, publicKey: agentPub });
  return crypto.createHash("sha256").update(Buffer.concat([DOMAIN, shared])).digest();
}

export function encryptAes(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  return { iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ct: ct.toString("base64url") };
}

export function decryptAes(envelope, key) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, fromB64u(envelope.iv));
  decipher.setAuthTag(fromB64u(envelope.tag));
  const pt = Buffer.concat([decipher.update(fromB64u(envelope.ct)), decipher.final()]);
  return pt.toString("utf8");
}
