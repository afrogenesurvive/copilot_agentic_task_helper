/**
 * Config Loader — plain-JSON config with .env fallback (dual CJS/ESM).
 *
 * Precedence:
 *   1. <repo>/config.json  — a plain JSON object of env key/value pairs. PRIMARY.
 *   2. <repo>/.env         — KEY=VALUE lines. FALLBACK when config.json is absent.
 *
 * Used by:
 *   - The Electron operator (CommonJS `require`) to load config at startup and
 *     manage it via IPC (config:get / save / export / import).
 *   - Every ESM entry point (webhook server, agent runner, MCP servers) via
 *     default import, replacing `import "dotenv/config"`.
 *
 * Existing process.env values are never overwritten by loadEnvInto() (dotenv
 * compatible), so explicit shell/CLI overrides keep winning. applyValues() /
 * importConfig() DO overwrite, and are used after the operator saves/imports.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(REPO, "config.json");
const ENV_PATH = path.join(REPO, ".env");

/**
 * Known config keys with their fallback defaults.
 * Used only for per-key source annotation ("default" source) — these are never
 * written to config.json, so .env / host-env overrides are never shadowed.
 */
const DEFAULTS = {
  LLM_PROVIDER: "deepseek",
  LLM_TEMPERATURE: "0.1",
  DEEPSEEK_MODEL: "deepseek-v4-flash",
  OPENAI_MODEL: "gpt-4o",
  ANTHROPIC_MODEL: "claude-sonnet-4-5",
  ANTHROPIC_MAX_TOKENS: "4096",
  OLLAMA_BASE_URL: "http://127.0.0.1:11434",
  OLLAMA_NUM_CTX: "32768",
  WEBHOOK_PORT: "3199",
  CORS_ORIGINS: "http://localhost:3199",
  APPEARANCE_THEME: "system",
  FRONTDESK_SESSION_TTL: "7200",
  PRIORITY_REMINDER_INTERVAL: "300000",
  AGENT_RUNNER_ENABLED: "true",
  AGENT_TASK_INTERVAL: "60000",
  LOG_LEVEL: "info",
  OPERATOR_AUTOSTART: "true",
  TRUST_PROXY: "1",
};

/** True when config.json exists (primary source present). */
function hasConfigJson() {
  return fs.existsSync(CONFIG_PATH);
}

/** Parse .env text (KEY=VALUE lines) into a flat object. */
function parseEnv(text) {
  const out = {};
  for (const line of String(text || "").split("\n")) {
    const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/** Read .env into a flat object ({} if missing). */
function readEnv() {
  try {
    return parseEnv(fs.readFileSync(ENV_PATH, "utf8"));
  } catch {
    return {};
  }
}

/** Read config.json into a flat object. Throws on invalid JSON / shape. */
function readConfigFile() {
  if (!hasConfigJson()) return null;
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config.json must be a flat JSON object of key/value pairs");
  }
  return raw;
}

/**
 * Effective config: config.json (primary) or .env (fallback).
 * @returns {{present: boolean, source: string, values: object, error?: string}}
 */
function readEffective() {
  if (hasConfigJson()) {
    try {
      return { present: true, source: "config.json", values: readConfigFile() || {} };
    } catch (err) {
      // Corrupt config.json — fall back to .env but surface the error.
      return { present: true, source: "config.json (invalid — using .env)", values: readEnv(), error: err.message };
    }
  }
  return { present: false, source: ".env", values: readEnv() };
}

/**
 * Per-key config with source annotation for the operator's Config editor.
 * Precedence: config.json > .env > default. "default" values are display-only
 * annotations and are never merged into the saved config.
 * @param {object} [defaults] — key → default value map (defaults to DEFAULTS)
 * @returns {{present: boolean, source: string, configPath: string, count: number, values: object, error?: string}}
 */
function readWithSources(defaults = DEFAULTS) {
  let cfg = null;
  let present = false;
  let source = ".env";
  let err = null;
  if (hasConfigJson()) {
    present = true;
    source = "config.json";
    try {
      cfg = readConfigFile() || {};
    } catch (e) {
      err = e.message;
      cfg = null;
    }
  }
  const env = readEnv();
  const keys = new Set([...(defaults ? Object.keys(defaults) : []), ...Object.keys(env), ...(cfg ? Object.keys(cfg) : [])]);
  const values = {};
  for (const k of keys) {
    let value;
    let src;
    if (cfg && k in cfg) {
      value = cfg[k];
      src = "config.json";
    } else if (k in env) {
      value = env[k];
      src = ".env";
    } else {
      value = defaults ? defaults[k] : "";
      src = "default";
    }
    values[k] = { value: String(value), source: src };
  }
  const out = { present, source, configPath: present ? CONFIG_PATH : ENV_PATH, count: Object.keys(values).length, values };
  if (err) out.error = err;
  return out;
}

/**
 * Load the effective config into a target (default process.env).
 * Does NOT overwrite keys already present in the target.
 * @returns {{source: string, loadedKeys: string[]}}
 */
function loadEnvInto(target = process.env) {
  const eff = readEffective();
  const loadedKeys = [];
  for (const [k, v] of Object.entries(eff.values || {})) {
    if (v == null) continue;
    if (!(k in target)) {
      target[k] = String(v);
      loadedKeys.push(k);
    }
  }
  return { source: eff.source, loadedKeys };
}

/** Force-apply a flat object to a target (overwrites). Used after save/import. */
function applyValues(values, target = process.env) {
  for (const [k, v] of Object.entries(values || {})) {
    if (v != null) target[k] = String(v);
  }
}

/** Write the given flat object to config.json (pretty JSON). */
function saveConfig(values) {
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    return { ok: false, error: "config must be a flat JSON object of key/value pairs" };
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(values, null, 2) + "\n", "utf8");
  return { ok: true, path: CONFIG_PATH, count: Object.keys(values).length };
}

/**
 * Set a single key — writes to config.json (primary) or .env (fallback),
 * preserving existing keys. Returns { ok, target, error? }.
 */
function setKey(key, value) {
  const str = value == null ? "" : String(value);
  if (hasConfigJson()) {
    let cfg = {};
    try {
      cfg = readConfigFile() || {};
    } catch {
      /* corrupt — start fresh */
    }
    cfg[key] = str;
    saveConfig(cfg);
    return { ok: true, target: "config.json" };
  }
  try {
    let content = fs.readFileSync(ENV_PATH, "utf8");
    const re = new RegExp(`^${key}=.*$`, "m");
    content = re.test(content)
      ? content.replace(re, `${key}=${str}`)
      : content + (content.endsWith("\n") ? "" : "\n") + `${key}=${str}\n`;
    fs.writeFileSync(ENV_PATH, content);
    return { ok: true, target: ".env" };
  } catch (err) {
    return { ok: false, error: `could not write .env: ${err.message}` };
  }
}

/** Export the effective config as a pretty JSON string. */
function exportConfig() {
  return JSON.stringify(readEffective().values, null, 2);
}

/**
 * Import a JSON config string: parse, validate, save as config.json, and
 * apply it to the target env (overwrites).
 */
function importConfig(raw, target = process.env) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `Invalid JSON: ${err.message}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "config must be a flat JSON object of key/value pairs" };
  }
  saveConfig(parsed);
  applyValues(parsed, target);
  return { ok: true, source: "config.json", path: CONFIG_PATH, count: Object.keys(parsed).length };
}

module.exports = {
  REPO,
  CONFIG_PATH,
  ENV_PATH,
  DEFAULTS,
  hasConfigJson,
  parseEnv,
  readEnv,
  readConfigFile,
  readEffective,
  readWithSources,
  loadEnvInto,
  applyValues,
  saveConfig,
  setKey,
  exportConfig,
  importConfig,
};
