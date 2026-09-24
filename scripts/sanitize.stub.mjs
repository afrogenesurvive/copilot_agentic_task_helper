#!/usr/bin/env node

/**
 * sanitize.stub.mjs — Tracked facade for the prompt-injection sanitizer.
 *
 * The real sanitizer lives in `./sanitize.private.mjs`, which is gitignored
 * (it holds private detection patterns that should not be published). All MCP
 * servers import THIS module instead:
 *
 *   - When `./sanitize.private.mjs` exists (this machine), it is loaded and
 *     the real sanitizer is used.
 *   - When it is absent (a fresh clone of the public repo), this module falls
 *     back to safe no-op passthrough functions so the servers still boot.
 *
 * Exports the same interface as the private module:
 *   - sanitize(str, audit) -> string
 *   - sanitizeObject(obj, options) -> obj
 *   - sanitizeWithAudit(str, opts) -> { sanitized, originalHash, injected, patterns, hadHidden }
 */

let impl = null;

try {
  impl = await import("./sanitize.private.mjs");
} catch (err) {
  if (err && err.code !== "ERR_MODULE_NOT_FOUND") {
    throw err; // Real load error (e.g. syntax) — surface it, don't mask a broken private file
  }
  // Private file not present → fall back to no-op passthrough.
  //
  // This is a SECURITY downgrade, not a benign mode: every Trello card body, email
  // subject, web page and chat message then reaches the model unfiltered. Say so
  // loudly, once, with the fix in the message.
  console.warn(
    "\n" +
      "⚠️  ────────────────────────────────────────────────────────\n" +
      "⚠️  PROMPT-INJECTION PROTECTION IS OFF\n" +
      "⚠️  ./sanitize.private.mjs is missing, so the no-op passthrough\n" +
      "⚠️  sanitizer is in use. External content (Trello/Gmail/Drive/\n" +
      "⚠️  Calendar/web/WhatsApp/frontdesk) reaches the model UNFILTERED.\n" +
      "⚠️  Restore scripts/sanitize.private.mjs to enable protection.\n" +
      "⚠️  /health reports sanitizer.active:false while this is the case.\n" +
      "⚠️  ────────────────────────────────────────────────────────\n",
  );
}

/** True when the real sanitizer loaded; false means the no-op passthrough is in use. */
export const sanitizerActive = impl !== null;

/**
 * Sanitizer status, for /health and startup banners.
 * @returns {{active: boolean, impl: string|null, detail: string}}
 */
export function sanitizerStatus() {
  return {
    active: sanitizerActive,
    impl: sanitizerActive ? "scripts/sanitize.private.mjs" : null,
    detail: sanitizerActive
      ? "prompt-injection sanitizer loaded"
      : "sanitize.private.mjs missing — no-op passthrough in use, external content is NOT sanitized",
  };
}

/* ── Fallback: no-op passthrough (identity) sanitizer ── */

const toStr = (str) => (typeof str === "string" ? str : String(str));

const noopSanitize = (str, audit) => toStr(str);

function noopSanitizeObject(obj) {
  return obj;
}

const noopSanitizeWithAudit = (str, opts) => ({
  sanitized: toStr(str),
  originalHash: "",
  injected: false,
  patterns: [],
  hadHidden: false,
});

export const sanitize = impl ? impl.sanitize : noopSanitize;
export const sanitizeObject = impl ? impl.sanitizeObject : noopSanitizeObject;
export const sanitizeWithAudit = impl ? impl.sanitizeWithAudit : noopSanitizeWithAudit;
