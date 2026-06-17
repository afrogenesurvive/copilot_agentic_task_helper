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
import { sanitizeObject } from "../../../scripts/sanitize.mjs";

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
function interpolate(template, event) {
  return template.replace(/\{\{event\.([^}]+)\}\}/g, (match, path) => {
    const value = resolvePath(event, path);
    return value !== undefined ? String(value) : match;
  });
}

/**
 * Evaluate rules against an incoming event.
 * If a rule matches, enqueue it as a pending tool call.
 * @param {object} event - Event object with source, type, data
 */
export function dispatch(event) {
  if (rules.length === 0) loadRules();

  let matched = false;
  // console.log("DEBUG - tool call dispatch", event);

  for (const rule of rules) {
    // Check source
    if (rule.match.source && rule.match.source !== event.source) continue;
    if (rule.match.type && rule.match.type !== event.type) continue;

    // Check conditions
    if (rule.match.conditions) {
      let conditionsMet = true;
      for (const [fieldPath, condition] of Object.entries(rule.match.conditions)) {
        const value = resolvePath(event, fieldPath);
        if (!matchCondition(value, condition)) {
          conditionsMet = false;
          break;
        }
      }
      if (!conditionsMet) continue;
    }

    // Rule matched — enqueue the tool call (interpolated params are sanitized)
    const params = {};
    if (rule.params) {
      for (const [key, value] of Object.entries(rule.params)) {
        params[key] = typeof value === "string" ? sanitizeObject(interpolate(value, event), { auditSource: "tool-dispatch/interpolate" }) : value;
      }
    }

    // Route to PRIORITY queue — matched rules need agent attention
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
    matched = true;
  }

  if (!matched) {
    console.log(`   🤖 [TOOL] No rules matched for ${event.source}/${event.type}`);
  }

  return matched;
}

// Load rules on module init
loadRules();
