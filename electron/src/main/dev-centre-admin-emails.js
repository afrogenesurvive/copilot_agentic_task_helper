/**
 * Dev Centre tier_1 admin emails — the HIDDEN admin list.
 *
 * ── WHAT THIS IS ──
 * A source-level constant naming the mailboxes that get `tier_1` (the Key Manager and
 * Accounts & Keys tabs, and the `pkm:*` / `accounts:*` IPC channels behind them) when
 * they sign in to Dev Centre with a SEAT LICENCE.
 *
 * It is deliberately NOT a config key. `config.json` and `.env` values are rendered by
 * the Config tab's Raw JSON view (`renderConfigForm` in electron/src/renderer/app.js
 * serialises every key `config:getWithSources` returns), so anything kept there is one
 * click away from a signed-in operator's screen. A constant compiled into the main
 * process appears in no config surface at all — form view, Raw JSON, export or import.
 *
 * ── WHAT THIS IS NOT ──
 * It is hidden, not secret. Anyone holding the `.app` can read the asar bundle and see
 * this list. Its only job is to keep *who else has admin* off the dashboard for a
 * signed-in `tier_2` operator. It is not a cryptographic control, and it is not the
 * credential: the licence is. A full `TA1…` carries the seat's private seeds, so
 * possessing one is the proof of identity (see `licence-verifier.js`).
 *
 * ── HOW TO CHANGE IT ──
 * Edit the array below and rebuild the app. That is the whole procedure — nothing else
 * reads this file, and `scripts/check-licence-wiring.mjs` asserts that the renderer and
 * the preload never reference it (so it cannot leak into a UI surface by accident).
 *
 * Removing an address takes effect at the NEXT LAUNCH for a session already running, and
 * at the next sign-in for everyone else — the same latency the `.env` admin list has.
 * See `hydrate()` in dev-centre-auth.js.
 *
 * ── RULES FOR AN ENTRY ──
 *   - a plain mailbox, no display name and no angle brackets
 *   - compared LOWER-CASED, so casing here does not matter
 *   - must match a seat's `email` claim in the key store. A seat issued without one
 *     (`pkm claims set <registry> <sub> --email <addr> --resign`, then hand over the NEW
 *     key string) can never match, and therefore can never be tier_1.
 *   - a typo is caught at load: it is reported at the gate as a problem by INDEX, never
 *     by address, so the list cannot be enumerated from a locked login screen.
 */
"use strict";

const { tryNormalizeEmail } = require("./password-verifier");

/**
 * The list. Order is irrelevant. Keep it a literal — a computed entry would make the
 * "edit and rebuild" procedure a lie, and this array is meant to be greppable.
 *
 * Seeded 2026-09-26 from the key store: `a@b.com` is the ONLY seat in the
 * `frontdesk-agent` registry that is valid (not revoked, not expired) AND carries an
 * `email` claim — and it is the same licence already used as the `.env` admin. Every
 * other seat in that registry is either a revoked test seat or lacks the claim.
 *
 * To find the addresses that can actually match, ask the store rather than guessing —
 * a revoked or claim-less seat can never be tier_1 however it is spelled here:
 *
 *   node -e 'const b=require(process.env.HOME+"/Documents/GitHub/personal_key_manager/export/devmon.json");
 *            for (const r of b.registries) for (const k of r.rings) for (const s of k.seats)
 *              if (s.email && s.status==="valid") console.log(r.id, s.email)'
 */
const TIER_1_EMAILS = Object.freeze([
  "a@b.com",
]);

/** Human-readable stamp for the last edit. Cosmetic; shown nowhere but the source. */
const ADMIN_LIST_UPDATED = "2026-09-26";

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Normalise the literal into lower-cased, de-duplicated addresses plus a list of
 * problems for the operator.
 *
 * Problems are reported by ENTRY NUMBER and never by value. `state()` hands its
 * `problems[]` to a LOCKED renderer (gate.js renders them before anyone signs in), so a
 * message naming the address would let anyone at the login screen enumerate the list —
 * which is the one thing this module exists to prevent.
 *
 * @returns {{emails: string[], problems: string[]}}
 */
function normalizeList(raw) {
  const emails = [];
  const problems = [];
  const entries = Array.isArray(raw) ? raw : [];

  if (!Array.isArray(raw)) problems.push("the hidden admin list is not an array");

  entries.forEach((entry, index) => {
    const position = index + 1; // 1-based for humans
    const email = tryNormalizeEmail(entry);
    if (!email) {
      problems.push(`hidden admin list entry #${position} is not a valid email address — ignored`);
      return;
    }
    if (emails.includes(email)) {
      problems.push(`hidden admin list entry #${position} duplicates an earlier entry — ignored`);
      return;
    }
    emails.push(email);
  });

  return { emails, problems };
}

const NORMALIZED = normalizeList(TIER_1_EMAILS);
const LIST = new Set(NORMALIZED.emails);

// ── API ───────────────────────────────────────────────────────────────────────

/**
 * Is this address in the hidden list? The ONLY intended consumer.
 *
 * Normalises before lookup, so a caller holding a raw cert claim or a value typed at
 * the gate gets the same answer as one holding an already-normalised address. `false`
 * for anything unparseable — a malformed address is not an admin.
 */
function isTier1Email(email) {
  const wanted = tryNormalizeEmail(email);
  return wanted !== null && LIST.has(wanted);
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
  TIER_1_EMAILS,
  ADMIN_LIST_UPDATED,
  normalizeList,
  isTier1Email,
  adminListProblems,
  hasTier1Emails,
};
