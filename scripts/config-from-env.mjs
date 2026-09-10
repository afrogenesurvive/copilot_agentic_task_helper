#!/usr/bin/env node
/**
 * config-from-env.mjs — create/refresh repo-root config.json from .env.
 *
 * Mirrors every key/value in .env into config.json (the primary config source).
 * Merge-safe: keys already present in config.json are preserved (.env values
 * only fill gaps), so re-running never clobbers hand-edited values.
 *
 * .env itself is never modified — it stays in place as the fallback for any key
 * absent from config.json, and as the source for services that boot before the
 * operator UI.
 *
 * Usage:
 *   node scripts/config-from-env.mjs      # or: npm run config:init
 */
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");

const config = require(path.join(REPO, "shared", "config-loader.cjs"));

const env = config.readEnv();
const envKeys = Object.keys(env);
if (envKeys.length === 0) {
  console.error(`❌ No values found in ${config.ENV_PATH} — nothing to mirror.`);
  process.exit(1);
}

// Existing config.json wins on overlap (it is the primary source).
let existing = {};
try {
  existing = config.readConfigFile() || {};
} catch (err) {
  console.warn(`⚠️  Existing config.json unreadable (${err.message}) — writing from .env only.`);
  existing = {};
}
const before = Object.keys(existing).length;
const merged = { ...env, ...existing };
const added = Object.keys(merged).length - before;

const res = config.saveConfig(merged);
if (!res.ok) {
  console.error(`❌ ${res.error}`);
  process.exit(1);
}

console.log(`✅ Wrote ${config.CONFIG_PATH}`);
console.log(`   .env keys available:   ${envKeys.length}`);
console.log(`   keys in config.json:   ${Object.keys(merged).length}${before ? ` (preserved ${before} existing, +${added} new from .env)` : ""}`);
console.log("   .env left untouched — still the fallback for keys absent from config.json.");
