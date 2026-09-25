/**
 * Seat password VERIFIERS + email normalisation — a CommonJS port of
 * `personal_key_manager`'s `src/creds.mjs`.
 *
 * WHY THIS IS A PORT, NOT A RE-IMPLEMENTATION
 * -------------------------------------------
 * pkm stores a self-describing scrypt verifier on a seat's signed cert as the
 * `pwdv` claim:
 *
 *     scrypt$<N>$<r>$<p>$<b64url(salt)>$<b64url(hash)>
 *
 * pkm's own docs call this a cross-language contract, and the architecture note
 * says it explicitly: `creds.mjs` has no `fs` "because a consumer app needs the
 * identical claim rules to read a cert". Dev Centre is such a consumer — an
 * operator pastes a verifier minted by `pkm claims set <seat> --password-stdin`
 * into the admin list, and the app has to accept it. So every rule below is
 * deliberately identical to pkm's, including the parts that look like quirks:
 *
 *   - the password is UTF-8 **exactly as typed**, with NO Unicode normalisation
 *     (node: `Buffer.from(password, "utf8")`)
 *   - the parameters come from the verifier string, so the cost can be raised
 *     later without invalidating existing verifiers
 *   - 32-byte key, 16-byte salt for new verifiers
 *   - the comparison is constant-time over the raw hash bytes
 *   - `maxmem` must be passed explicitly: `128*N*r` is exactly 32 MiB for the
 *     defaults, which is also node's default cap, so relying on the default
 *     makes scrypt throw `Invalid scrypt params`
 *   - the base64url charset is checked by hand, because `Buffer.from(x,
 *     "base64url")` silently ignores junk instead of throwing
 *
 * If pkm's format changes, THIS FILE must change with it. The parity test in
 * `scripts/check-pwdv-parity.mjs` loads both implementations and asserts they
 * agree, so drift is caught rather than trusted.
 *
 * Pure — no filesystem access and no child processes, so the login path works
 * with the pkm store absent, unmounted or broken.
 */
"use strict";

const crypto = require("crypto");

/** Verifier algorithm tag — pkm's `PWDV_ALGO`. */
const PWDV_ALGO = "scrypt";

/** Cost parameters used for NEW verifiers (reading honours whatever is stored). */
const PWDV_PARAMS = { N: 32768, r: 8, p: 1, keylen: 32, saltBytes: 16 };

/**
 * `128 * N * r` is exactly 32 MiB for the defaults — which is also node's
 * default `maxmem` cap, so the default can throw `Invalid scrypt params`.
 * Always pass an explicit, larger cap instead of relying on the default.
 */
const MAXMEM = 64 * 1024 * 1024;

/** Refuse absurd parameters read back from a (possibly hostile) verifier. */
const MAX_N = 2 ** 22;

const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 1024;
const EMAIL_MAX_LENGTH = 254;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const B64U_RE = /^[A-Za-z0-9_-]+$/;

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const fromB64u = (s) => Buffer.from(s, "base64url");

// ── Email ─────────────────────────────────────────────────────────────────────

/**
 * Lower-case and validate an email. Deliberately permissive (mailbox shape
 * only) — the address is an identity label, not something we deliver to.
 * Throws on anything malformed, exactly like pkm's `normalizeEmail`.
 */
function normalizeEmail(value) {
  const email = String(value ?? "").trim().toLowerCase();
  if (!email) throw new Error("email must not be empty");
  if (email.length > EMAIL_MAX_LENGTH) {
    throw new Error(`email is longer than ${EMAIL_MAX_LENGTH} characters`);
  }
  if (!EMAIL_RE.test(email)) throw new Error(`"${value}" is not a valid email address`);
  return email;
}

/** Same as `normalizeEmail`, but returns null instead of throwing. */
function tryNormalizeEmail(value) {
  try {
    return normalizeEmail(value);
  } catch {
    return null;
  }
}

// ── Password verifiers ────────────────────────────────────────────────────────

function checkPasswordInput(password) {
  const value = String(password ?? "");
  if (value.length < PASSWORD_MIN_LENGTH) {
    throw new Error(`password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }
  if (value.length > PASSWORD_MAX_LENGTH) {
    throw new Error(`password is longer than ${PASSWORD_MAX_LENGTH} characters`);
  }
  return value;
}

/** Hash a password into a `scrypt$…` verifier string. Mirrors `makePasswordVerifier`. */
function makePasswordVerifier(password, params = {}) {
  const value = checkPasswordInput(password);
  const { N, r, p, keylen, saltBytes } = { ...PWDV_PARAMS, ...params };
  const salt = crypto.randomBytes(saltBytes);
  const hash = crypto.scryptSync(Buffer.from(value, "utf8"), salt, keylen, { N, r, p, maxmem: MAXMEM });
  return [PWDV_ALGO, N, r, p, b64u(salt), b64u(hash)].join("$");
}

/** Parse a verifier string; null when it is not one we know how to check. */
function parsePasswordVerifier(verifier) {
  const parts = String(verifier ?? "").split("$");
  if (parts.length !== 6) return null;
  const [algo, n, r, p, saltB64, hashB64] = parts;
  if (algo !== PWDV_ALGO) return null;
  const N = Number(n);
  const rN = Number(r);
  const pN = Number(p);
  if (!Number.isInteger(N) || !Number.isInteger(rN) || !Number.isInteger(pN)) return null;
  if (N < 2 || N > MAX_N || rN < 1 || pN < 1) return null;
  // `Buffer.from(x, "base64url")` ignores junk instead of throwing, so the
  // charset has to be checked by hand.
  if (!B64U_RE.test(saltB64) || !B64U_RE.test(hashB64)) return null;
  const salt = fromB64u(saltB64);
  const hash = fromB64u(hashB64);
  if (salt.length === 0 || hash.length === 0) return null;
  return { algo, N, r: rN, p: pN, salt, hash };
}

function isPasswordVerifier(verifier) {
  return parsePasswordVerifier(verifier) !== null;
}

/**
 * Cheap shape test for "should this secret be treated as a verifier?" — true for
 * anything that starts with the `scrypt$` tag, even if it then fails to parse.
 *
 * Deliberately separate from `isPasswordVerifier`: a *malformed* verifier must
 * fail closed (it can never fall through to a plaintext comparison), while
 * `isPasswordVerifier` stays the strict "is this usable" question.
 */
function looksLikeVerifier(value) {
  return String(value ?? "").trim().startsWith(`${PWDV_ALGO}$`);
}

/**
 * Constant-time password check. False for a missing or malformed verifier —
 * never throws, so callers can use it directly in a verification chain.
 */
function checkPasswordVerifier(verifier, password) {
  const parsed = parsePasswordVerifier(verifier);
  if (!parsed) return false;
  const value = String(password ?? "");
  if (!value) return false;
  let candidate;
  try {
    candidate = crypto.scryptSync(Buffer.from(value, "utf8"), parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: MAXMEM,
    });
  } catch {
    return false;
  }
  return candidate.length === parsed.hash.length && crypto.timingSafeEqual(candidate, parsed.hash);
}

/** Parameters only — never the salt or hash. For `claims show`. */
function passwordVerifierInfo(verifier) {
  const parsed = parsePasswordVerifier(verifier);
  if (!parsed) return null;
  return {
    algo: parsed.algo,
    N: parsed.N,
    r: parsed.r,
    p: parsed.p,
    saltBytes: parsed.salt.length,
    hashBytes: parsed.hash.length,
  };
}

module.exports = {
  PWDV_ALGO,
  PWDV_PARAMS,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  EMAIL_MAX_LENGTH,
  normalizeEmail,
  tryNormalizeEmail,
  makePasswordVerifier,
  parsePasswordVerifier,
  isPasswordVerifier,
  looksLikeVerifier,
  checkPasswordVerifier,
  passwordVerifierInfo,
};
