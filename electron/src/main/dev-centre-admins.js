/**
 * Dev Centre tier_1 admins — the HIDDEN admin list, provisioned from the REPO.
 *
 * ── WHAT THIS IS ──
 * The loader + validator for `dev-centre-admins.json` (same directory), which names the
 * tier_1 identities (`tier_1` = the Key Manager and Accounts & Keys tabs, and the `pkm:*` /
 * `accounts:*` channels behind them) and, optionally, their local credentials.
 *
 * Two shapes of entry, and the difference is the whole point:
 *
 *   { "email": "you@example.com", "verifier": "scrypt$…" }
 *       A LOCAL credential. `verifier` is a pkm-compatible scrypt verifier, NEVER the
 *       password itself, so committing it does not publish a usable secret.
 *
 *   { "email": "you@example.com", "verifier": null }
 *       LICENCE-ONLY. The address is tier_1, and the only way in is a seat licence, which
 *       is verified against the key store on every sign-in and every launch — signature,
 *       expiry, retired signing key, the seat blocklist and the cert's `email` claim all
 *       apply. This is the shape to prefer: nothing secret is stored here at all.
 *
 * ── WHY THE REPO AND NOT `.env` ──
 * `.env` is gitignored and is NOT packaged (`electron/package.json`'s `extraResources`
 * copies `scripts`, `shared`, `mcp`, `webapp`, `electron/docs`), so a released build has no
 * `.env` and therefore no admins at all — `no_admins_configured`, un-sign-in-able. Anything
 * under `electron/src/**` is compiled into the app, so this file is what a build actually
 * carries. `.env` remains the LOCAL override (see `adminState()` in dev-centre-auth.js).
 *
 * ── WHAT THIS IS NOT ──
 * It is hidden, not secret. Anyone holding the `.app` can read the asar and see this list.
 * Its jobs are (a) to keep *who else has admin* off the dashboard for a signed-in `tier_2`
 * operator, and (b) to be a valid source that does not depend on the operator's machine.
 * It is not a cryptographic control, and a verifier in it is not a credential — the
 * password or the licence still is.
 *
 * ── RULES FOR AN ENTRY (enforced at load; see `validate`) ──
 *   - a plain mailbox, no display name and no angle brackets; compared lower-cased
 *   - `verifier` is either `null` or a well-formed `scrypt$…` string
 *   - a PLAINTEXT secret is refused: this file is committed and ships, so a password here
 *     would be published. Mint a verifier instead (the CLI does it for you).
 *   - a `TA1…` licence is refused as well. A licence is the seat's private key; storing it
 *     would publish the credential AND would make the address a stored secret instead of a
 *     verified one. Use `"verifier": null` and sign in with the licence.
 *   - problems are reported by ENTRY NUMBER and never by value, because `state().problems`
 *     is rendered on the LOCKED login screen — a message naming the address would let
 *     anyone at that screen enumerate the list.
 *
 * ── HOW TO CHANGE IT ──
 *   node scripts/dev-centre-admins.mjs list
 *   node scripts/dev-centre-admins.mjs add   someone@example.com --password-stdin
 *   node scripts/dev-centre-admins.mjs add   someone@example.com --licence-only
 *   node scripts/dev-centre-admins.mjs remove someone@example.com
 *   node scripts/dev-centre-admins.mjs check
 *
 * Then rebuild the app. That is the whole procedure — but the CLI writes this JSON rather
 * than the loader, so the file stays reviewable in a diff.
 *
 * Replaces `dev-centre-admin-emails.js`, which held the addresses only. Keeping the two
 * apart let an address be tier_1 for a licence while a *different* (stale) credential
 * authenticated the same address from `.env`; one file cannot drift from itself.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const { tryNormalizeEmail, isPasswordVerifier, looksLikeVerifier } = require("./password-verifier");

/** The committed list. Compiled into the app by electron-builder's `files` glob over `src`. */
const ADMINS_FILE = path.join(__dirname, "dev-centre-admins.json");

/** Label recorded in the session log and `state()` — the file, not an absolute path. */
const SOURCE_LABEL = "electron/src/main/dev-centre-admins.json";

/** Fallback stamp when the file carries none. */
const FALLBACK_STAMP = "unknown";

/**
 * Read the file. A missing or corrupt file is "no admins" plus a problem, never a throw:
 * the gate must still start and still accept `.env` / registry credentials.
 *
 * @returns {{stamp: string, admins: Array<{email: string, verifier: string|null}>, problems: string[]}}
 */
function read() {
  let raw;
  try {
    raw = fs.readFileSync(ADMINS_FILE, "utf8");
  } catch (err) {
    const absent = err && err.code === "ENOENT";
    return {
      stamp: FALLBACK_STAMP,
      admins: [],
      problems: [absent ? "the provisioned admin list is missing (electron/src/main/dev-centre-admins.json)" : `the provisioned admin list is unreadable (${err.message})`],
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { stamp: FALLBACK_STAMP, admins: [], problems: [`the provisioned admin list is not valid JSON (${err.message})`] };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { stamp: FALLBACK_STAMP, admins: [], problems: ["the provisioned admin list must be a JSON object"] };
  }

  const { admins, problems } = validate(parsed.admins);
  return { stamp: typeof parsed.stamp === "string" && parsed.stamp.trim() ? parsed.stamp.trim() : FALLBACK_STAMP, admins, problems };
}

/**
 * Validate a raw `admins` array into normalised entries plus address-free complaints.
 *
 * Exported so `scripts/dev-centre-admins.mjs` refuses to WRITE something this loader would
 * only complain about — the two must agree, and the check asserts they do.
 *
 * @param {unknown} raw
 * @returns {{admins: Array<{email: string, verifier: string|null}>, problems: string[]}}
 */
function validate(raw) {
  const admins = [];
  const problems = [];
  const entries = Array.isArray(raw) ? raw : [];

  if (!Array.isArray(raw)) problems.push("the provisioned admin list has no `admins` array");

  entries.forEach((entry, index) => {
    const position = index + 1; // 1-based for humans
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      problems.push(`provisioned admin entry #${position} is not an object — ignored`);
      return;
    }

    const email = tryNormalizeEmail(entry.email);
    if (!email) {
      problems.push(`provisioned admin entry #${position} is not a valid email address — ignored`);
      return;
    }
    if (admins.some((a) => a.email === email)) {
      problems.push(`provisioned admin entry #${position} duplicates an earlier entry — ignored`);
      return;
    }

    const verifier = entry.verifier === null || entry.verifier === undefined || entry.verifier === "" ? null : entry.verifier;

    if (verifier !== null) {
      if (typeof verifier !== "string") {
        problems.push(`provisioned admin entry #${position} has a non-string verifier — ignored`);
        return;
      }
      if (String(verifier).startsWith("TA1.")) {
        problems.push(
          `provisioned admin entry #${position} stores a LICENCE — a licence is the seat's private key and must never be committed; use "verifier": null and sign in with the licence`,
        );
        return;
      }
      if (!looksLikeVerifier(verifier) || !isPasswordVerifier(verifier)) {
        problems.push(
          `provisioned admin entry #${position} is not a usable scrypt verifier — a PLAINTEXT secret must not be committed; mint one with scripts/dev-centre-admins.mjs`,
        );
        return;
      }
    }

    admins.push({ email, verifier });
  });

  return { admins, problems };
}

const LOADED = read();
const NORMALIZED = { admins: LOADED.admins, problems: LOADED.problems };
const LIST = new Set(LOADED.admins.map((a) => a.email));
const CREDENTIALS = new Map(LOADED.admins.filter((a) => a.verifier).map((a) => [a.email, a.verifier]));

// ── API ───────────────────────────────────────────────────────────────────────

/**
 * Is this address a provisioned tier_1 admin? The tier decision for a VERIFIED licence
 * goes through here, so normalisation must match `tryNormalizeEmail` exactly — a cert
 * claim with unexpected casing still resolves.
 */
function isTier1Email(email) {
  const wanted = tryNormalizeEmail(email);
  return wanted !== null && LIST.has(wanted);
}

/**
 * The LOCAL credential this list holds for an address, if any. `null` = licence-only (or
 * not an admin at all — `isTier1Email()` is the predicate for the latter).
 *
 * @returns {{email: string, secret: string, source: string}|null}
 */
function credentialForAdmin(email) {
  const wanted = tryNormalizeEmail(email);
  if (wanted === null) return null;
  const secret = CREDENTIALS.get(wanted);
  if (!secret) return null;
  return { email: wanted, secret, source: SOURCE_LABEL };
}

/** Every provisioned LOCAL credential, for merging with `.env` in the gate. Map<email, secret>. */
function adminCredentials() {
  return new Map(CREDENTIALS);
}

/**
 * Load-time complaints, for `state().problems`. Address-free by construction.
 * @returns {string[]}
 */
function adminListProblems() {
  return [...NORMALIZED.problems];
}

/** True when the list names at least one admin — a BOOLEAN, never the count or contents. */
function hasTier1Emails() {
  return LIST.size > 0;
}

module.exports = {
  ADMINS_FILE,
  SOURCE_LABEL,
  TIER_1_ADMINS: Object.freeze(LOADED.admins.map((a) => Object.freeze({ ...a }))),
  ADMIN_LIST_UPDATED: LOADED.stamp,
  validate,
  isTier1Email,
  credentialForAdmin,
  adminCredentials,
  adminListProblems,
  hasTier1Emails,
};
