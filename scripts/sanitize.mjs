#!/usr/bin/env node

/**
 * sanitize.mjs — Prompt injection sanitization for MCP tool responses
 *
 * Strips or flags known prompt-injection patterns from external data
 * (Trello, Gmail, etc.) before it reaches the agent.
 *
 * Usage:
 *   import { sanitize, sanitizeObject } from "./scripts/sanitize.mjs";
 *
 *   const safe = sanitize(userProvidedString);
 *   const safeObj = sanitizeObject(apiResponseData);
 *
 * What it does:
 *   - Strips hidden/invisible Unicode characters (zero-width spaces, etc.)
 *   - Detects known prompt injection patterns (case-insensitive)
 *   - Replaces injection attempts with a visible sanitization marker
 *   - Recursively walks objects/arrays to sanitize all string fields
 *   - Appends a warning prefix when injection content is detected
 *   - Computes an integrity hash of the original input for forensic audit
 *   - Logs all detection hits to logs/security/injection-detected/
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SECURITY_LOG_DIR = path.resolve(__dirname, "..", "logs", "security", "injection-detected");

/* ── Zero-width / invisible Unicode characters ── */

const HIDDEN_CHARS = [
  "\u200B", // Zero Width Space
  "\u200C", // Zero Width Non-Joiner
  "\u200D", // Zero Width Joiner
  "\u200E", // Left-to-Right Mark
  "\u200F", // Right-to-Left Mark
  "\uFEFF", // Zero Width No-Break Space (BOM)
  "\u2060", // Word Joiner
  "\u2061", // Function Application
  "\u2062", // Invisible Times
  "\u2063", // Invisible Separator
  "\u2064", // Invisible Plus
  "\u2066", // Left-to-Right Isolate
  "\u2067", // Right-to-Left Isolate
  "\u2068", // First Strong Isolate
  "\u2069", // Pop Directional Isolate
  "\u180E", // Mongolian Vowel Separator
  "\u00AD", // Soft Hyphen
  "\u034F", // Combining Grapheme Joiner
  "\u061C", // Arabic Letter Mark
  "\u115F", // Hangul Choseong Filler
  "\u1160", // Hangul Jungseong Filler
  "\u17B4", // Khmer Vowel Inherent AQ
  "\u17B5", // Khmer Vowel Inherent AA
];

const HIDDEN_CHARS_PATTERN = new RegExp(`[${HIDDEN_CHARS.join("")}]`, "gu");

/**
 * Strip hidden/invisible Unicode characters from a string.
 * @param {string} str
 * @returns {string}
 */
function stripHiddenChars(str) {
  return str.replace(HIDDEN_CHARS_PATTERN, "");
}

/**
 * Check if a string contains hidden/invisible Unicode characters.
 * @param {string} str
 * @returns {boolean}
 */
export function hasHiddenChars(str) {
  return HIDDEN_CHARS_PATTERN.test(str);
}

/**
 * Preprocess a string by stripping hidden characters and normalizing
 * before injection detection. Returns both the cleaned string and
 * whether hidden characters were found.
 * @param {string} str
 * @returns {{ cleaned: string, hadHidden: boolean }}
 */
export function preprocess(str) {
  const hadHidden = HIDDEN_CHARS_PATTERN.test(str);
  // Reset regex state after test()
  const cleaned = stripHiddenChars(str);
  return { cleaned, hadHidden };
}

/* ── Known prompt injection patterns (case-insensitive) ── */

const INJECTION_PATTERNS = [
  // Instruction override attempts
  /\bignore\s+(all\s+)?previous\s+instructions/i,
  /\bignore\s+(all\s+)?prior\s+(instructions|directives|commands)/i,
  /\bdisregard\s+(all\s+)?(previous|prior)\s+(instructions|directives)/i,
  /\bforget\s+(all\s+)?(previous|prior)\s+(instructions|context|conversation)/i,
  /\bdo\s+not\s+(follow|obey|listen\s+to)\s+(your|the)\s+(previous|prior)/i,
  /\bnew\s+instructions/i,
  /\boverride\s+(instructions|prompt|directives)/i,
  /\byou\s+are\s+now\b.{0,50}(?:ai|assistant|agent|bot|model)/i,

  // Role-playing / system prompt extraction
  /\b(?:act|pretend)\s+as\s+if/i,
  /\bfrom\s+now\s+on\s+you\s+are/i,
  /\byour\s+(new|updated)\s+(role|persona|identity)/i,
  /\bsystem\s+prompt/i,
  /\bprompt\s+injection/i,

  // Base64-encoded content (suspicious long base64 strings)
  /[A-Za-z0-9+/]{80,}={0,2}/,

  // Hidden markdown / code block manipulation
  /```\s*\n.*?(?:ignore|override|forget).*?\n```/is,
];

const SANITIZED_MARKER = "[🛡️ Sanitized — potential injection content removed]";
const WARNING_PREFIX = "⚠️ [Input contained potential prompt injection patterns and was sanitized] ";

/**
 * Check if a string matches any injection pattern.
 * Automatically strips hidden/invisible Unicode characters before checking.
 * @param {string} str - The string to check
 * @returns {{ injected: boolean, patterns: string[], hadHidden: boolean }} - Detection result
 */
export function detectInjection(str) {
  if (typeof str !== "string" || !str) return { injected: false, patterns: [], hadHidden: false };

  const { cleaned, hadHidden } = preprocess(str);

  const matched = [];
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(cleaned)) {
      matched.push(pattern.source.slice(0, 60)); // Truncate for log readability
    }
  }

  return { injected: matched.length > 0, patterns: matched, hadHidden };
}

/**
 * Sanitize a single string — replaces injection content with a safe marker.
 * Strips hidden/invisible Unicode characters before detection.
 * If injection is detected, the entire content is replaced with the marker
 * to prevent any partial bypass.
 *
 * When `logHits` is true, detection events are persisted to the security audit log
 * at logs/security/injection-detected/ for centralized monitoring.
 *
 * @param {string} str - Input string to sanitize
 * @param {object} [audit] - Optional audit context for hit logging
 * @param {string} [audit.source] - Source label (e.g. "mcp/trello")
 * @param {string} [audit.field] - Field name (e.g. "card.name")
 * @returns {string} - Sanitized string
 */
export function sanitize(str, audit) {
  if (typeof str !== "string" || !str) return str || "";

  const { cleaned, hadHidden } = preprocess(str);
  const { injected, patterns } = detectInjection(cleaned);

  if (hadHidden && !injected) {
    // Hidden characters found but no injection pattern — still flag it
    if (audit) {
      logInjectionHit({
        source: audit.source || "unknown",
        field: audit.field || "unknown",
        patterns: [],
        hadHidden: true,
        originalPreview: str.slice(0, 200),
        integrityHash: computeIntegrityHash(str),
      });
    }
    return WARNING_PREFIX + SANITIZED_MARKER;
  }

  if (!injected) return str;

  // Injection detected — log hit if audit context provided
  if (audit) {
    logInjectionHit({
      source: audit.source || "unknown",
      field: audit.field || "unknown",
      patterns,
      hadHidden,
      originalPreview: str.slice(0, 200),
      integrityHash: computeIntegrityHash(str),
    });
  }

  return WARNING_PREFIX + SANITIZED_MARKER;
}

/**
 * Recursively walk an object/array and sanitize all string values.
 * Modifies the object in-place and returns it.
 *
 * @param {*} obj - Object, array, or primitive to sanitize
 * @param {object} [options]
 * @param {string[]} [options.skipKeys] - Object keys to skip (e.g., "id", "url")
 * @param {string} [options.auditSource] - Source label for hit logging (e.g. "mcp/trello").
 *        When set, injection detection hits are auto-logged to the security audit file.
 * @returns {*} - Sanitized object
 */
/**
 * Recursively walk an object/array and sanitize all string values.
 * Modifies the object in-place and returns it.
 *
 * @param {*} obj - Object, array, or primitive to sanitize
 * @param {object} [options]
 * @param {string[]} [options.skipKeys] - Object keys to skip (e.g., "id", "url")
 * @param {string} [options.auditSource] - Source label for hit logging (e.g. "mcp/trello").
 *        When set, injection detection hits are auto-logged to the security audit file.
 * @param {string} [options._fieldPath] - Internal: current field path for audit context
 * @returns {*} - Sanitized object
 */
export function sanitizeObject(obj, options = {}) {
  const skipKeys = options.skipKeys || ["id", "url", "shortLink", "idShort", "timestamp", "queuedAt", "pos", "type", "source"];
  const auditSource = options.auditSource || null;
  const fieldPath = options._fieldPath || "";

  if (typeof obj === "string") {
    return sanitize(obj, auditSource ? { source: auditSource, field: fieldPath || "<string>" } : undefined);
  }

  if (Array.isArray(obj)) {
    return obj.map((item, i) => sanitizeObject(item, { ...options, _fieldPath: `${fieldPath}[${i}]` }));
  }

  if (obj && typeof obj === "object") {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      if (skipKeys.includes(key)) {
        result[key] = value;
      } else {
        result[key] = sanitizeObject(value, { ...options, _fieldPath: fieldPath ? `${fieldPath}.${key}` : key });
      }
    }
    return result;
  }

  return obj;
}

/**
 * Log a warning when injection is detected in a tool response.
 * @param {string} source - e.g. "trello/trello_get_card_actions"
 * @param {string} field - e.g. "data.text" or "body"
 * @param {string[]} patterns - Matched pattern descriptions
 * @param {boolean} [hadHidden=false] - Whether hidden Unicode characters were found
 */
export function logInjectionWarning(source, field, patterns, hadHidden = false) {
  const ts = new Date().toISOString();
  const hiddenNote = hadHidden ? " [hidden Unicode chars stripped]" : "";
  console.error(`[sanitize] [${ts}] ⚠️ Prompt injection detected in ${source} field "${field}": ${patterns.join(", ")}${hiddenNote}`);
}

/**
 * Compute a SHA-256 integrity hash of the original input string.
 * This is stored alongside the sanitized output so you can later
 * verify that the sanitized version matches the original.
 *
 * @param {string} input - The original raw input string
 * @returns {string} Hex-encoded SHA-256 hash
 */
export function computeIntegrityHash(input) {
  if (typeof input !== "string") input = JSON.stringify(input);
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Log an injection detection hit to the centralized security audit file
 * at logs/security/injection-detected/YYYY-MM-DD.jsonl.
 *
 * This provides a queryable record of every sanitizer trigger for monitoring
 * and forensic analysis, separate from the regular tool/webhook logs.
 *
 * @param {object} opts
 * @param {string} opts.source  - e.g. "trello_handler" or "mcp/trello"
 * @param {string} opts.field   - e.g. "data.text" or "card.name"
 * @param {string[]} opts.patterns - Matched injection patterns
 * @param {boolean} opts.hadHidden - Whether hidden Unicode characters were found
 * @param {string} [opts.originalPreview] - First 200 chars of the original input for context
 * @param {string} [opts.integrityHash] - SHA-256 of the original input for cross-reference
 */
export function logInjectionHit({ source, field, patterns, hadHidden, originalPreview, integrityHash }) {
  const ts = new Date().toISOString();
  const day = ts.slice(0, 10);
  const entry = {
    ts,
    source,
    field,
    patterns,
    hadHidden: !!hadHidden,
    ...(originalPreview && { originalPreview }),
    ...(integrityHash && { integrityHash }),
  };

  try {
    fs.mkdirSync(SECURITY_LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(SECURITY_LOG_DIR, `${day}.jsonl`), JSON.stringify(entry) + "\n");
  } catch (err) {
    console.error(`[sanitize] Failed to write injection hit log: ${err.message}`);
  }

  // Also emit to stderr as before
  const hiddenNote = hadHidden ? " [hidden Unicode chars stripped]" : "";
  console.error(`[sanitize] [${ts}] ⚠️ Prompt injection detected in ${source} field "${field}": ${patterns.join(", ")}${hiddenNote}`);
}

/**
 * Sanitize a string with full audit metadata.
 * Like sanitize(), but also returns the integrity hash and detection info
 * so callers can persist a forensic trail.
 *
 * @param {string} str - Input string to sanitize
 * @param {object} [opts]
 * @param {string} [opts.source] - Source label for audit logging (e.g. "trello_handler")
 * @param {string} [opts.field] - Field name for audit logging (e.g. "card.name")
 * @param {boolean} [opts.logHit=true] - Whether to log detection hits to the security log
 * @returns {{ sanitized: string, originalHash: string, injected: boolean, patterns: string[], hadHidden: boolean }}
 */
export function sanitizeWithAudit(str, opts = {}) {
  const { source = "unknown", field = "unknown", logHit = true } = opts;
  const result = { sanitized: "", originalHash: "", injected: false, patterns: [], hadHidden: false };

  if (typeof str !== "string" || !str) {
    result.sanitized = str || "";
    result.originalHash = computeIntegrityHash(str || "");
    return result;
  }

  const { cleaned, hadHidden } = preprocess(str);
  const detection = detectInjection(cleaned);

  result.originalHash = computeIntegrityHash(str);
  result.injected = detection.injected;
  result.patterns = detection.patterns;
  result.hadHidden = hadHidden;

  if (hadHidden && !detection.injected) {
    result.sanitized = WARNING_PREFIX + SANITIZED_MARKER;
  } else if (detection.injected) {
    result.sanitized = WARNING_PREFIX + SANITIZED_MARKER;
  } else {
    result.sanitized = str;
  }

  // Log hit to the security audit file
  if ((detection.injected || hadHidden) && logHit) {
    logInjectionHit({
      source,
      field,
      patterns: detection.patterns,
      hadHidden,
      originalPreview: str.slice(0, 200),
      integrityHash: result.originalHash,
    });
  }

  return result;
}
