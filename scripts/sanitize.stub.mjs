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
  console.warn(
    "[sanitize.stub] ./sanitize.private.mjs not found — using no-op passthrough sanitizer. " +
      "Restore the private sanitizer file to enable real prompt-injection protection."
  );
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
