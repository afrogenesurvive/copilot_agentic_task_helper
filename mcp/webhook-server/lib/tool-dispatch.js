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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_FILE = path.resolve(__dirname, "..", "..", "..", "safe", "webhook-tool-rules.json");

let rules = [];

function loadRules() {
  try {
    if (fs.existsSync(RULES_FILE)) {
      const content = fs.readFileSync(RULES_FILE, "utf8");
      const parsed = JSON.parse(content);
      rules = (parsed.rules || []).filter((r) => r.enabled !== false);
      console.log(`[tool-dispatch] Loaded ${rules.length} rules from ${RULES_FILE}`);
    } else {
      console.log(`[tool-dispatch] No rules file at ${RULES_FILE}`);
    }
  } catch (err) {
    console.error(`[tool-dispatch] Error loading rules: ${err.message}`);
  }
}

/**
 * Resolve a dotted path like "data.card.name" from an object.
 */
function resolvePath(obj, pathStr) {
  return pathStr.split(".").reduce((acc, part) => (acc && acc[part] !== undefined ? acc[part] : undefined), obj);
}

/**
 * Check if a condition matches a value.
 * Supports: { contains, equals, regex, exists }
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

    // Rule matched — enqueue the tool call
    const params = {};
    if (rule.params) {
      for (const [key, value] of Object.entries(rule.params)) {
        params[key] = typeof value === "string" ? interpolate(value, event) : value;
      }
    }

    enqueueEvent({
      source: "tool_dispatch",
      type: "pending_tool_call",
      data: {
        rule: rule.name,
        tool: rule.tool,
        params,
        originalEvent: { source: event.source, type: event.type, data: event.data },
      },
    });

    console.log(`[tool-dispatch] Rule "${rule.name}" matched → tool: ${rule.tool}`);
    matched = true;
  }

  if (!matched) {
    console.log(`[tool-dispatch] No rules matched for ${event.source}/${event.type}`);
  }

  return matched;
}

// Load rules on module init
loadRules();
