#!/usr/bin/env node
/**
 * Print the Key Manager status as JSON.
 *
 * Why a CLI: the `keys` capacity in the operator UI comes from the external
 * `personal_key_manager` store, reached through `electron/src/main/key-manager.mjs`.
 * That module is plain Node (no Electron dependency), but it lives under `electron/`
 * and is only reachable from the app — so any non-Electron consumer (the
 * `/api/menubar` endpoint, a native menu-bar client, a script) had no way to ask.
 *
 *   node scripts/pkm-status.mjs            # human-readable summary
 *   node scripts/pkm-status.mjs --json     # machine-readable (what a UI should parse)
 *   node scripts/pkm-status.mjs --registry <name>
 *
 * Exit codes: 0 = status printed, 1 = the store could not be read (the JSON still
 * carries `ok:false` + `error` so a caller can show the reason rather than a blank).
 */
import config from "../shared/config-loader.cjs";
import { status, defaultRegistry } from "../electron/src/main/key-manager.mjs";

config.loadEnvInto(process.env);

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const regIdx = argv.indexOf("--registry");
const registry = regIdx >= 0 && argv[regIdx + 1] ? argv[regIdx + 1] : defaultRegistry();

if (argv.includes("--help") || argv.includes("-h")) {
  console.log("Usage: node scripts/pkm-status.mjs [--json] [--registry NAME]");
  process.exit(0);
}

let out;
try {
  out = await status(registry);
} catch (err) {
  out = { ok: false, error: err && err.message ? err.message : String(err) };
}

if (asJson) {
  console.log(JSON.stringify({ registry, ...out }, null, 2));
} else if (out && out.ok === false) {
  console.error(`❌ Key Manager unavailable (registry "${registry}"): ${out.error || "unknown error"}`);
} else {
  // Summarize the fields a status display actually wants; `--json` has the rest
  // (paths, doctor report, per-action permissions).
  const d = (out && out.data) || {};
  const entry = d.entry || {};
  const caps = d.capabilities || {};
  const state = caps.state || (d.present ? "present" : "missing");
  console.log(`Key Manager — registry "${registry}"`);
  console.log(`  state            ${state}${caps.writable === false ? " (read-only)" : ""}${caps.reason ? ` — ${caps.reason}` : ""}`);
  console.log(`  engine           ${entry.engine || "?"}   default key: ${entry.defaultKid || "?"}`);
  console.log(`  seats            ${entry.seats ?? "?"} (${entry.revoked ?? 0} revoked)`);
  console.log(`  rings            ${entry.rings ?? "?"}`);
  console.log(`  store            ${d.storeRoot || "?"}${d.present ? "" : "  ⚠️ not found"}`);
  console.log(`  loose perms      ${d.loosePermissions ?? 0}`);
  console.log("  (full detail: add --json)");
}

process.exit(out && out.ok === false ? 1 : 0);
