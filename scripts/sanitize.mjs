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
 *   - Detects known prompt injection patterns (case-insensitive)
 *   - Replaces injection attempts with a visible sanitization marker
 *   - Recursively walks objects/arrays to sanitize all string fields
 *   - Appends a warning prefix when injection content is detected
 */

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
 * @param {string} str - The string to check
 * @returns {{ injected: boolean, patterns: string[] }} - Detection result
 */
export function detectInjection(str) {
  if (typeof str !== "string" || !str) return { injected: false, patterns: [] };

  const matched = [];
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(str)) {
      matched.push(pattern.source.slice(0, 60)); // Truncate for log readability
    }
  }

  return { injected: matched.length > 0, patterns: matched };
}

/**
 * Sanitize a single string — replaces injection content with a safe marker.
 * If injection is detected, the entire content is replaced with the marker
 * to prevent any partial bypass.
 *
 * @param {string} str - Input string to sanitize
 * @returns {string} - Sanitized string
 */
export function sanitize(str) {
  if (typeof str !== "string" || !str) return str || "";

  const { injected } = detectInjection(str);
  if (!injected) return str;

  return WARNING_PREFIX + SANITIZED_MARKER;
}

/**
 * Recursively walk an object/array and sanitize all string values.
 * Modifies the object in-place and returns it.
 *
 * @param {*} obj - Object, array, or primitive to sanitize
 * @param {object} [options]
 * @param {string[]} [options.skipKeys] - Object keys to skip (e.g., "id", "url")
 * @returns {*} - Sanitized object
 */
export function sanitizeObject(obj, options = {}) {
  const skipKeys = options.skipKeys || ["id", "url", "shortLink", "idShort", "timestamp", "queuedAt", "pos", "type", "source"];

  if (typeof obj === "string") {
    return sanitize(obj);
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeObject(item, options));
  }

  if (obj && typeof obj === "object") {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      if (skipKeys.includes(key)) {
        result[key] = value;
      } else {
        result[key] = sanitizeObject(value, options);
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
 */
export function logInjectionWarning(source, field, patterns) {
  const ts = new Date().toISOString();
  console.error(`[sanitize] [${ts}] ⚠️ Prompt injection detected in ${source} field "${field}": ${patterns.join(", ")}`);
}
