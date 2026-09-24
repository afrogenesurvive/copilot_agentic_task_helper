/**
 * Persist the operator's Google refresh token (GMAIL_REFRESH_TOKEN).
 *
 * Both minting flows use this — the CLI (`scripts/gmail-auth.mjs`) and the
 * dashboard button (`electron/src/main/oauth.js`) — because writing to the wrong
 * file silently does nothing.
 *
 * The trap this exists to close: `config.json` is PRIMARY and `.env` is only a
 * fallback for keys config.json omits (see shared/config-loader.cjs). This repo's
 * config.json DOES define GMAIL_REFRESH_TOKEN, so the CLI's old
 * write-`.env`-only behaviour was a no-op — a freshly granted token was written to
 * a file that could never win, and the stack kept using the old one with no error
 * anywhere (found 2026-09-24).
 *
 * So: write whichever store actually wins, back it up first, and report which one
 * it was. CJS because it is consumed from both a CJS main-process module and an
 * ESM script.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(REPO, "config.json");
const ENV_PATH = path.join(REPO, ".env");

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function readConfigObject() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return null;
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null; // absent or corrupt — fall through to .env
  }
}

/** Which store holds the key that currently wins. Never returns the value. */
function describeTokenStore() {
  const cfg = readConfigObject();
  const inConfig = !!(cfg && cfg.GMAIL_REFRESH_TOKEN);
  const inEnv = fs.existsSync(ENV_PATH) && /^GMAIL_REFRESH_TOKEN=/m.test(fs.readFileSync(ENV_PATH, "utf8"));
  return {
    configJson: inConfig,
    env: inEnv,
    winner: inConfig ? "config.json" : inEnv ? ".env" : null,
  };
}

/**
 * Save the operator refresh token to the winning store.
 * @param {string} refreshToken
 * @returns {{ok:boolean, store?:string, path?:string, backup?:string, error?:string}}
 */
function saveOperatorRefreshToken(refreshToken) {
  if (typeof refreshToken !== "string" || refreshToken.length < 20) {
    return { ok: false, error: "refusing to save an empty or implausibly short refresh token" };
  }

  const cfg = readConfigObject();
  if (cfg && cfg.GMAIL_REFRESH_TOKEN) {
    const backup = `${CONFIG_PATH}.bak-${stamp()}`;
    try {
      fs.copyFileSync(CONFIG_PATH, backup);
      cfg.GMAIL_REFRESH_TOKEN = refreshToken;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    } catch (err) {
      return { ok: false, error: `could not write config.json: ${err.message}` };
    }
    return { ok: true, store: "config.json", path: CONFIG_PATH, backup: path.basename(backup) };
  }

  if (!fs.existsSync(ENV_PATH)) {
    return { ok: false, error: `no GMAIL_REFRESH_TOKEN in config.json and no .env at ${ENV_PATH}` };
  }
  try {
    const backup = `${ENV_PATH}.bak-${stamp()}`;
    fs.copyFileSync(ENV_PATH, backup);
    const lines = fs.readFileSync(ENV_PATH, "utf8").split("\n");
    let replaced = 0;
    // Anchored on '=' so GMAIL_REFRESH_TOKEN_2 (the second account) cannot match.
    const out = lines.map((line) => {
      if (/^GMAIL_REFRESH_TOKEN=/.test(line)) {
        replaced++;
        return `GMAIL_REFRESH_TOKEN=${refreshToken}`;
      }
      return line;
    });
    if (!replaced) out.push(`GMAIL_REFRESH_TOKEN=${refreshToken}`);
    fs.writeFileSync(ENV_PATH, out.join("\n"), "utf8");
    return { ok: true, store: ".env", path: ENV_PATH, backup: path.basename(backup), replaced: !!replaced };
  } catch (err) {
    return { ok: false, error: `could not write .env: ${err.message}` };
  }
}

module.exports = { saveOperatorRefreshToken, describeTokenStore, CONFIG_PATH, ENV_PATH };
