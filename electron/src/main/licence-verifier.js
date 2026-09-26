/**
 * Seat licence VERIFIER — a CommonJS port of `scripts/frontdesk-license.mjs` and
 * `scripts/pkm-paths.mjs`, for the Dev Centre sign-in gate.
 *
 * WHY THIS IS A PORT, NOT A RE-IMPLEMENTATION
 * -------------------------------------------
 * The key store in the sibling `personal_key_manager` repo is the single source of truth
 * for every ring, seat, revocation and audit record. Dev Centre now accepts a seat
 * licence as a sign-in credential, so the app has to reach the *identical* verdict the
 * frontdesk verifier would reach — otherwise the same key would be valid for the webapp
 * and invalid here, or worse, the reverse.
 *
 * So every rule below is deliberately a line-for-line port, including the check ORDER,
 * because the order is what decides which `reason` a caller sees:
 *
 *     malformed → malformed_cert → app_mismatch → unknown_kid → retired_kid →
 *     revoked_seat → bad_signature → bad_seat_key → key_mismatch → expired
 *
 * `scripts/check-licence-wiring.mjs` loads BOTH implementations and asserts they return
 * identical verdicts for a fixture matrix, so drift is caught rather than trusted. If
 * `frontdesk-license.mjs` changes, this file must change with it.
 *
 * ── The one intentional divergence ──
 * `verifyLicenseKey()` in `scripts/frontdesk-license.mjs` builds its `claims` from a
 * FIXED FIELD LIST (`app`, `v`, `sub`, `exp`, `kid`, `pub`, `enc`) and therefore drops
 * the optional `email` claim a cert may carry. The whole point of this port is that
 * claim, so this version reads it — normalised, as `claims.email`. Nothing else differs.
 *
 * ── What is deliberately NOT ported ──
 * The ECDH / AES-GCM half (`deriveAesKeyServer`, the agent keypair, `loadAgentKeys`).
 * That exists to decrypt frontdesk chat traffic; the gate has no chat to decrypt. The
 * agent directory is never touched, so a store without one still verifies here.
 *
 * ── Posture ──
 * Pure filesystem + `node:crypto`: no `pkm` CLI, no child process, no network. A broken,
 * moved or unmounted key store cannot lock the operator out of their own desktop app —
 * the gate falls back to `.env` / the role registry, which is why `storeStatus()` reports
 * a reason instead of throwing.
 *
 * FAIL CLOSED on the ring (a missing ring means `unknown_kid`, so nothing verifies) but
 * FAIL OPEN on the blocklist, exactly as the frontdesk verifier does: `revoked-seats.json`
 * is absent or corrupt ⇒ it reads as no revocations. That asymmetry is a real weakness
 * and `storeStatus()` reports it so the gate can warn loudly rather than stay quiet.
 *
 * The licence string is a SECRET (it carries the seat's private seeds). It is never
 * logged, returned in an error message, or written anywhere by this module.
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { tryNormalizeEmail } = require("./password-verifier");

/** Fallback checkout location when PKM_REPO / PKM_ROOT are unset. */
const DEFAULT_PKM_REPO = path.join(os.homedir(), "Documents", "GitHub", "personal_key_manager");
/** Registry the frontdesk stack signs and verifies with when PKM_REGISTRY is unset. */
const DEFAULT_PKM_REGISTRY = "frontdesk-agent";
/** Licensed app id embedded in a certificate's `app` field when the index has no entry. */
const DEFAULT_PKM_APP_ID = "frontdesk-agent";

/**
 * Cert format version this build understands. pkm never bumps it for a claim (that is
 * what makes `email` backward-compatible), so `v` stays 1 and a cert carrying claims
 * verifies here exactly as one without them does.
 */
const VERSION = 1;

/** `TA1.<b64url(certJson)>.<b64url(sig)>.<b64url(seatKeys)>` */
const KEY_RE = /^TA1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const fromB64u = (s) => Buffer.from(s, "base64url");

// ── Path resolution (port of scripts/pkm-paths.mjs) ───────────────────────────

const clean = (v) => (typeof v === "string" && v.trim() ? v.trim() : "");

/** `JSON.parse` or the fallback — never throws. */
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Resolve every path the key store needs.
 *
 * Reads `process.env` by default, which is correct for the Electron main process:
 * `main.js` runs `config.loadEnvInto(process.env)` at module scope, so `PKM_ROOT` from
 * `config.json` / `.env` is already present before any sign-in. Resolution is per-call,
 * never cached at import, so a store moved while the app is running is picked up.
 *
 * The registry DIRECTORY comes from the index's `dir` field, not from the registry id —
 * the index is authoritative, and older stores where `dir === id` still work.
 *
 * @param {object} [env] - environment to read (defaults to `process.env`)
 * @param {string} [registry] - registry id/dir override (defaults to `PKM_REGISTRY`)
 */
function pkmPaths(env = process.env, registry) {
  const repo = clean(env.PKM_REPO) || DEFAULT_PKM_REPO;
  const store = clean(env.PKM_ROOT) || repo;
  const wanted = clean(registry) || clean(env.PKM_REGISTRY) || DEFAULT_PKM_REGISTRY;

  const registriesDir = path.join(store, "registries");
  const indexFile = path.join(registriesDir, "registry.json");
  const index = readJson(indexFile, { registries: [] });
  const entries = Array.isArray(index?.registries) ? index.registries : [];

  const needle = wanted.toLowerCase();
  const entry =
    entries.find((e) => String(e.id).toLowerCase() === needle || String(e.dir ?? "").toLowerCase() === needle) || null;

  const registryDir = path.join(registriesDir, entry?.dir || entry?.id || wanted);

  return {
    repo,
    store,
    registry: entry?.id || wanted,
    app: clean(env.PKM_APP) || entry?.app || DEFAULT_PKM_APP_ID,
    indexFile,
    registriesDir,
    registryDir,
    ringFile: path.join(registryDir, "ring.json"),
    revokedFile: path.join(registryDir, "revoked-seats.json"),
  };
}

// ── Store reads ───────────────────────────────────────────────────────────────

/** The published master key ring ({ keys: [{ kid, publicKey, notAfter }] }). */
function loadRing(paths = pkmPaths()) {
  const ring = readJson(paths.ringFile, { keys: [] });
  return ring && typeof ring === "object" ? ring : { keys: [] };
}

/**
 * The blocklist, with the read error kept SEPARATE from the list.
 *
 * This split is the whole reason `readRevoked()` exists next to `loadRevokedSeats()`:
 * pkm's own `readJson()` collapses "the file is absent" and "the file is unreadable"
 * into the same empty list, and for a BLOCKLIST those could not be further apart.
 * `loadRevokedSeats()` deliberately keeps the frontdesk-identical (collapsing)
 * behaviour so verdicts match; `storeStatus()` uses this one to warn.
 *
 * @returns {{seats: string[], problem: string|null, state: "present"|"absent"|"unreadable"}}
 */
function readRevoked(paths = pkmPaths()) {
  let text;
  try {
    text = fs.readFileSync(paths.revokedFile, "utf8");
  } catch (err) {
    const absent = err && err.code === "ENOENT";
    return {
      seats: [],
      problem: absent ? null : `the seat blocklist is unreadable (${paths.revokedFile})`,
      state: absent ? "absent" : "unreadable",
    };
  }
  try {
    const data = JSON.parse(text);
    return { seats: Array.isArray(data.seats) ? data.seats : [], problem: null, state: "present" };
  } catch {
    return { seats: [], problem: `the seat blocklist is corrupt (${paths.revokedFile}) — no revocation is enforced`, state: "unreadable" };
  }
}

/**
 * The authoritative per-seat blocklist, read live on every verify — so a revoke performed
 * in the Key Manager takes effect on the seat's next sign-in, with no restart or rebuild.
 *
 * Exactly as in `scripts/frontdesk-license.mjs`: absent or corrupt reads as `[]`.
 */
function loadRevokedSeats(paths = pkmPaths()) {
  return readRevoked(paths).seats;
}

/** Look up a ring entry by kid. Returns null for an unknown kid. */
function resolveRingEntry(kid, paths = pkmPaths()) {
  const ring = loadRing(paths);
  return (ring.keys || []).find((k) => k.kid === kid) || null;
}

// ── Verify ────────────────────────────────────────────────────────────────────

/**
 * Cheap "is this even a licence?" test — mirrors `looksLikeVerifier()`'s role in
 * `password-verifier.js`, and is deliberately SEPARATE from verification.
 *
 * The gate uses it to decide whether a typed secret should be treated as a licence at
 * all, before any store read happens. Keeping it separate is what makes the fallback to
 * a plaintext `.env` secret possible without a malformed licence ever being compared as
 * a password.
 */
function looksLikeLicenseKey(value) {
  return typeof value === "string" && value.startsWith("TA1.");
}

/**
 * Verify a full licence key (cert + signature + seat-possession proof).
 *
 * @param {string} licenseKey - the `TA1…` string. NEVER logged by this module.
 * @param {number} [now] - injection point for tests; defaults to the wall clock
 * @param {object} [paths] - resolved store paths; defaults to `pkmPaths()`
 * @returns {{ok: true, claims: object, encReady: boolean} | {ok: false, reason: string}}
 *   `claims.email` is the normalised `email` claim, or `null` when the cert carries none
 *   (or carries a malformed one). A null email can never match the admin list.
 */
function verifyLicenseKey(licenseKey, now = Date.now(), paths = pkmPaths()) {
  const m = KEY_RE.exec(String(licenseKey ?? ""));
  if (!m) return { ok: false, reason: "malformed" };
  const [, certB64, sigB64, seatKeysB64] = m;

  let cert;
  try {
    cert = JSON.parse(fromB64u(certB64).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed_cert" };
  }
  if (cert.app !== paths.app || cert.v !== VERSION) return { ok: false, reason: "app_mismatch" };

  const entry = resolveRingEntry(cert.kid, paths);
  if (!entry) return { ok: false, reason: "unknown_kid" };
  if (entry.notAfter && now >= entry.notAfter * 1000) return { ok: false, reason: "retired_kid" };
  if (loadRevokedSeats(paths).includes(cert.sub)) return { ok: false, reason: "revoked_seat" };

  const masterPub = crypto.createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: entry.publicKey },
    format: "jwk",
  });
  let sigValid = false;
  try {
    sigValid = crypto.verify(null, fromB64u(certB64), masterPub, fromB64u(sigB64));
  } catch {
    sigValid = false;
  }
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
    const seatPriv = crypto.createPrivateKey({
      key: { kty: "OKP", crv: "Ed25519", x: cert.pub, d: edD },
      format: "jwk",
    });
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
    claims: {
      app: cert.app,
      v: cert.v,
      sub: cert.sub,
      exp: cert.exp,
      kid: cert.kid,
      pub: cert.pub,
      enc: cert.enc ?? null,
      // The divergence from scripts/frontdesk-license.mjs, and the reason this port
      // exists. Lower-cased and shape-checked; `null` when absent or malformed, which
      // is what stops a claim-less legacy seat from ever reaching tier_1.
      email: tryNormalizeEmail(cert.email),
    },
    encReady,
  };
}

/**
 * Verify a bare cert + signature (no seat-possession check). Ported for parity with the
 * frontdesk module's degraded `[fd1]` path and not used by the gate — the gate always
 * receives the full key, because possessing it is what proves identity.
 *
 * Returns `{ ok, claims }` or `{ ok: false, reason }`.
 */
function verifyCert(certB64, sigB64, now = Date.now(), paths = pkmPaths()) {
  let cert;
  try {
    cert = JSON.parse(fromB64u(certB64).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed_cert" };
  }
  if (cert.app !== paths.app || cert.v !== VERSION) return { ok: false, reason: "app_mismatch" };
  const entry = resolveRingEntry(cert.kid, paths);
  if (!entry) return { ok: false, reason: "unknown_kid" };
  if (entry.notAfter && now >= entry.notAfter * 1000) return { ok: false, reason: "retired_kid" };
  if (loadRevokedSeats(paths).includes(cert.sub)) return { ok: false, reason: "revoked_seat" };
  if (cert.exp !== 0 && now >= cert.exp * 1000) return { ok: false, reason: "expired" };
  if (!cert.enc) return { ok: false, reason: "no_enc_key" };
  const masterPub = crypto.createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: entry.publicKey },
    format: "jwk",
  });
  let sigValid = false;
  try {
    sigValid = crypto.verify(null, fromB64u(certB64), masterPub, fromB64u(sigB64));
  } catch {
    sigValid = false;
  }
  if (!sigValid) return { ok: false, reason: "bad_signature" };
  return { ok: true, claims: { ...cert, email: tryNormalizeEmail(cert.email) } };
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

/**
 * Can the store be read at all, and is revocation actually being enforced?
 *
 * Never throws and never reads a secret — this is what `state()` calls to decide whether
 * to offer the licence path and whether to show the operator a warning. A store that is
 * missing entirely is NOT a problem worth shouting about: the gate still works off `.env`
 * and the role registry, which is exactly the degraded posture the module header
 * describes.
 *
 * @returns {{ready: boolean, registry: string, ringFile: string, revokedFile: string, reason: string|null, problems: string[]}}
 */
function storeStatus(paths = pkmPaths()) {
  const ring = loadRing(paths);
  const keys = Array.isArray(ring.keys) ? ring.keys : [];
  const revoked = readRevoked(paths);
  const problems = [];
  let reason = null;

  if (!keys.length) {
    reason = "no master ring — no licence can verify";
    // Only worth reporting when the operator has clearly pointed at something: an
    // absent store just means this deployment does not use licences yet.
    if (fs.existsSync(paths.registriesDir)) {
      problems.push(`licence sign-in is unavailable: ${reason} (${paths.ringFile})`);
    }
  }
  if (revoked.problem) problems.push(revoked.problem);
  if (revoked.state === "absent" && keys.length) {
    problems.push(`no seat blocklist at ${paths.revokedFile} — nothing is currently revoked, so revocation is not enforced`);
  }

  return {
    ready: keys.length > 0,
    registry: paths.registry,
    ringFile: paths.ringFile,
    revokedFile: paths.revokedFile,
    reason,
    problems,
  };
}

module.exports = {
  VERSION,
  DEFAULT_PKM_REPO,
  DEFAULT_PKM_REGISTRY,
  DEFAULT_PKM_APP_ID,
  pkmPaths,
  loadRing,
  loadRevokedSeats,
  readRevoked,
  resolveRingEntry,
  looksLikeLicenseKey,
  verifyLicenseKey,
  verifyCert,
  storeStatus,
};
