/**
 * Tool Dispatch — Map webhook events to pending tool calls
 *
 * Reads the webhook tool rules from safe/webhook-tool-rules.json
 * and enqueues matching tool calls when events come in.
 *
 * Each rule defines:
 *   - match.source / match.type / match.conditions
 *   - tool (MCP tool name)
 *   - params (template with {{event.data.field}} interpolation)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { enqueueEvent } from "./event-queue.js";
import { sanitizeObject } from "../../../scripts/sanitize.stub.mjs";
import { log as logEvent } from "../../../shared/logger.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_FILE = path.resolve(__dirname, "..", "..", "..", "safe", "webhook-tool-rules.json");

let rules = [];

function loadRules() {
  try {
    if (fs.existsSync(RULES_FILE)) {
      const content = fs.readFileSync(RULES_FILE, "utf8");
      const parsed = JSON.parse(content);
      rules = (parsed.rules || []).filter((r) => r.enabled !== false);
      console.log(`   🤖 [TOOL] Loaded ${rules.length} rules from ${RULES_FILE}`);
    } else {
      console.log(`   🤖 [TOOL] No rules file at ${RULES_FILE}`);
    }
  } catch (err) {
    console.error(`   ❌ [TOOL] Error loading rules: ${err.message}`);
  }
}

/** Re-read the rules file into memory (used by POST /api/rules/reload). */
export function reloadRules() {
  loadRules();
  return rules.length;
}

/** The in-memory rules (enabled-only, matching loadRules' filter). */
export function getRules() {
  return rules;
}

/**
 * Resolve a dotted path like "data.card.name" from an object.
 * Used to extract values from webhook events for rule matching and template interpolation.
 * Example: resolvePath({data:{card:{name:"test"}}}, "data.card.name") → "test"
 */
function resolvePath(obj, pathStr) {
  return pathStr.split(".").reduce((acc, part) => (acc && acc[part] !== undefined ? acc[part] : undefined), obj);
}

/**
 * Check if a condition matches a value.
 * Supports: { contains, equals, regex, exists }
 *
 * Used by the rules engine to compare event fields against rule conditions.
 * Example: { list: { name: { contains: "frontdesk" } } }
 */
function matchCondition(value, condition) {
  if (condition === null || condition === undefined) return value === null || value === undefined;

  if (typeof condition === "object" && !Array.isArray(condition)) {
    if ("equals" in condition) return value === condition.equals;
    if ("contains" in condition) return typeof value === "string" && value.includes(condition.contains);
    if ("regex" in condition) return typeof value === "string" && new RegExp(condition.regex).test(value);
    if ("exists" in condition) return condition.exists ? value !== undefined : value === undefined;
    return false;
  }

  return value === condition;
}

/**
 * Interpolate {{event.data.field}} placeholders in a template string.
 */
export function interpolate(template, event) {
  return template.replace(/\{\{event\.([^}]+)\}\}/g, (match, path) => {
    const value = resolvePath(event, path);
    return value !== undefined ? String(value) : match;
  });
}

/**
 * Does a single rule match an event? Pure — no side effects.
 */
export function evaluateRule(rule, event) {
  if (rule.match?.source && rule.match.source !== event.source) return false;
  if (rule.match?.type && rule.match.type !== event.type) return false;
  if (rule.match?.conditions) {
    for (const [fieldPath, condition] of Object.entries(rule.match.conditions)) {
      if (!matchCondition(resolvePath(event, fieldPath), condition)) return false;
    }
  }
  return true;
}

/**
 * Interpolate a rule's params against an event (pure — no enqueue). Used by the
 * rules UI's test endpoint to preview a rule without side effects.
 */
export function buildParams(rule, event) {
  const params = {};
  if (rule.params) {
    for (const [key, value] of Object.entries(rule.params)) {
      params[key] = typeof value === "string" ? interpolate(value, event) : value;
    }
  }
  return params;
}

/**
 * Evaluate rules against an incoming event.
 * If a rule matches, enqueue it as a pending tool call.
 * @param {object} event - Event object with source, type, data
 */
export function dispatch(event) {
  if (rules.length === 0) loadRules();

  // Outcome the handlers use to decide queue placement:
  //   matched    — at least one tool rule fired (pending_tool_call enqueued)
  //   routedTo   — a `route` rule wants the raw event in this queue (no tool)
  //   suppressed — a `suppress` rule matched: the handler must NOT enqueue
  const outcome = { matched: false, routedTo: null, suppressed: false };

  for (const rule of rules) {
    if (!evaluateRule(rule, event)) continue;

    const action = rule.action || "tool";

    // Suppress: drop the event entirely — but never silently (audit line).
    if (action === "suppress") {
      outcome.suppressed = true;
      logEvent({
        source: "webhook",
        subSource: "tool-dispatch",
        level: "info",
        message: `rule "${rule.name}" suppressed ${event.source}/${event.type}`,
        data: { rule: rule.name, eventSource: event.source, eventType: event.type },
      });
      console.log(`   🤖 [TOOL] Rule "${rule.name}" → suppress (${event.source}/${event.type})`);
      return outcome;
    }

    // Route: send the RAW event to a named queue (no tool attached).
    if (action === "route") {
      const queue = rule.queue || "priority";
      outcome.routedTo = queue;
      outcome.matched = true;
      logEvent({
        source: "webhook",
        subSource: "tool-dispatch",
        level: "info",
        message: `rule "${rule.name}" routed ${event.source}/${event.type} → ${queue}`,
        data: { rule: rule.name, queue, eventSource: event.source, eventType: event.type },
      });
      console.log(`   🤖 [TOOL] Rule "${rule.name}" → route → ${queue}`);
      continue;
    }

    // Tool (default): enqueue a pending_tool_call with interpolated params.
    const params = buildParams(rule, event);
    enqueueEvent(
      {
        source: "tool_dispatch",
        type: "pending_tool_call",
        data: {
          rule: rule.name, // Human-readable rule name (e.g., "Frontdesk input")
          tool: rule.tool, // MCP tool to call (e.g., "trello_add_comment")
          params: sanitizeObject(params, { auditSource: "tool-dispatch/enqueue" }), // Pre-interpolated params for the tool
          originalEvent: { source: event.source, type: event.type, data: event.data },
        },
      },
      "priority", // ← This is the key: tool dispatch = priority
    );

    console.log(`   🤖 [TOOL] Rule "${rule.name}" → ${rule.tool}`);
    logEvent({ source: "webhook", subSource: "tool-dispatch", level: "info", message: `rule "${rule.name}" → ${rule.tool}`, data: { rule: rule.name, tool: rule.tool, eventSource: event.source, eventType: event.type } });
    outcome.matched = true;
  }

  if (!outcome.matched && !outcome.suppressed) {
    console.log(`   🤖 [TOOL] No rules matched for ${event.source}/${event.type}`);
  }

  return outcome;
}

// Load rules on module init
loadRules();
