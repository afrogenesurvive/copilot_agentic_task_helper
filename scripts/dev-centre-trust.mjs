#!/usr/bin/env node
/**
 * dev-centre-trust.mjs — bake the master ring + seat blocklist into the app.
 *
 * WHY. A packaged build read `ring.json` and `revoked-seats.json` from a key store on the
 * operator's machine (`PKM_ROOT`). On any other machine that store is absent, and
 * `licence-verifier.js` then (a) fails CLOSED on the ring — no licence can verify, so a
 * licence-only admin cannot sign in at all — and (b) fails OPEN on the blocklist, where an
 * absent file reads as "nothing is revoked", so revocation silently stops being enforced.
 * Both are wrong for a release. This script copies the two files into the app instead.
 *
 * WHAT IT WRITES. `electron/src/main/dev-centre-trust.json`:
 *
 *   { "stamp": "YYYY-MM-DD", "ring": [{kid, publicKey, notAfter}], "revoked": ["<sub>"…] }
 *
 * The file is GITIGNORED (the blocklist is a list of seat identifiers, i.e. addresses) and
 * ships inside the app because it lives under `electron/src/**`. `dev-centre-trust.example.json`
 * is the committed shape. The runtime always prefers a readable store, so this is a fallback:
 * a dev machine with the store keeps reading it live.
 *
 * Usage:
 *   node scripts/dev-centre-trust.mjs              # write the file from the store
 *   node scripts/dev-centre-trust.mjs --print      # print it, write nothing
 *   node scripts/dev-centre-trust.mjs --check      # compare store vs file, exit 1 on drift
 *   node scripts/dev-centre-trust.mjs --registry <id>
 *
 * Paths come from the SAME resolver the app uses (`licence-verifier.pkmPaths()`), so
 * PKM_ROOT / PKM_REPO / PKM_REGISTRY in .env / config.json are honoured identically.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");

// Load .env / config.json the way every other entry point does, so PKM_ROOT is in scope.
const config = require(path.join(REPO, "shared", "config-loader.cjs"));
config.loadEnvInto(process.env);

const licences = require(path.join(REPO, "electron", "src", "main", "licence-verifier.js"));

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback = null) => {
  const at = argv.indexOf(name);
  return at !== -1 && argv[at + 1] ? argv[at + 1] : fallback;
};

const registry = value("--registry", undefined);
const paths = licences.pkmPaths(process.env, registry);
const OUT = licences.TRUST_FILE;

/** The store's ring + blocklist, as the trust file needs them. */
function readStore() {
  const ring = licences.loadRingFromStore(paths).map((k) => ({
    kid: k.kid,
    publicKey: k.publicKey,
    notAfter: k.notAfter ?? null,
  }));
  const revoked = [...new Set(licences.readRevoked(paths).seats)].sort();
  return { ring, revoked };
}

function serialise(store) {
  return `${JSON.stringify({ stamp: new Date().toISOString().slice(0, 10), note: `Baked from ${paths.registry} by scripts/dev-centre-trust.mjs — store wins when readable; this is the fallback for builds.`, ring: store.ring, revoked: store.revoked }, null, 2)}\n`;
}

const store = readStore();
const text = serialise(store);

if (!store.ring.length) {
  console.error(`❌ No master ring at ${paths.ringFile} — nothing to bake.`);
  console.error(`   Point PKM_ROOT / PKM_REGISTRY at the store (PKM_ROOT=${paths.store}, registry=${paths.registry}).`);
  process.exit(1);
}

if (flag("--print")) {
  process.stdout.write(text);
  process.exit(0);
}

if (flag("--check")) {
  let onDisk = null;
  try {
    onDisk = JSON.parse(fs.readFileSync(OUT, "utf8"));
  } catch {
    onDisk = null;
  }
  const same =
    onDisk &&
    JSON.stringify(onDisk.ring || []) === JSON.stringify(store.ring) &&
    JSON.stringify([...(onDisk.revoked || [])].sort()) === JSON.stringify(store.revoked);
  if (same) {
    console.log(`✅ ${path.relative(REPO, OUT)} matches the store (${store.ring.length} ring key(s), ${store.revoked.length} revoked seat(s)).`);
    process.exit(0);
  }
  console.error(`❌ ${path.relative(REPO, OUT)} is missing or STALE against the store (${store.ring.length} ring key(s), ${store.revoked.length} revoked seat(s)).`);
  console.error("   Run `node scripts/dev-centre-trust.mjs` and rebuild — an embedded blocklist is stale by construction.");
  process.exit(1);
}

fs.writeFileSync(OUT, text, "utf8");
console.log(`✅ Wrote ${path.relative(REPO, OUT)}`);
console.log(`   registry:     ${paths.registry}`);
console.log(`   ring keys:    ${store.ring.length} (kids: ${store.ring.map((k) => k.kid).join(", ") || "none"})`);
console.log(`   revoked:      ${store.revoked.length} seat(s)`);
console.log("   The store always wins when it is readable — this file is the build-time fallback.");
console.log("   It is gitignored; re-run this before every release build that must verify licences offline.");
