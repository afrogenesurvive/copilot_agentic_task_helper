#!/usr/bin/env node
/**
 * config-from-env.mjs — create/refresh repo-root config.json from .env.
 *
 * Mirrors every key/value in .env into config.json (the primary config source),
 * EXCEPT the gate-owned keys listed in shared/config-redaction.cjs. Those must stay in
 * .env: `DEV_CENTRE_ADMINS` is `email:secret` pairs, so a config.json copy would both
 * hand it to any signed-in operator (the Config tab renders every key) and outrank the
 * built-in default in the Dev Centre gate's own lookup. Skipping them is what keeps
 * "this file is the only place it can be set" true.
 *
 * Merge-safe: keys already present in config.json are preserved (.env values
 * only fill gaps), so re-running never clobbers hand-edited values. A gate-owned key
 * ALREADY in config.json is removed (and reported) rather than left behind.
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
const redaction = require(path.join(REPO, "shared", "config-redaction.cjs"));

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

// Gate-owned keys never reach config.json. Two cases, reported separately: one that .env
// would have introduced, and a copy already sitting in config.json (removed — leaving it
// would keep the second store the redaction exists to prevent).
const skippedFromEnv = redaction.blockedKeys(env);
const droppedFromConfig = redaction.blockedKeys(existing);
const beforeMerged = redaction.redactConfig(existing);
const before = Object.keys(beforeMerged).length;
const merged = redaction.redactConfig({ ...env, ...existing });
const added = Object.keys(merged).length - before;

if (Object.keys(merged).length === 0) {
  console.error(`❌ Nothing left to mirror after skipping ${skippedFromEnv.length} gate-owned key(s) — ${config.CONFIG_PATH} left untouched.`);
  process.exit(1);
}

const res = config.saveConfig(merged);
if (!res.ok) {
  console.error(`❌ ${res.error}`);
  process.exit(1);
}

console.log(`✅ Wrote ${config.CONFIG_PATH}`);
console.log(`   .env keys available:   ${envKeys.length}`);
console.log(`   keys in config.json:   ${Object.keys(merged).length}${before ? ` (preserved ${before} existing, +${added} new from .env)` : ""}`);
for (const key of skippedFromEnv) console.log(`   ⏭  skipped ${key} — gate-owned, stays in .env only (shared/config-redaction.cjs)`);
for (const key of droppedFromConfig) console.log(`   🧹 removed ${key} from config.json — gate-owned, it must live in .env only`);
console.log("   .env left untouched — still the fallback for keys absent from config.json.");
