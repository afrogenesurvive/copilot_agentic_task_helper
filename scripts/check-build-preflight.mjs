#!/usr/bin/env node
/**
 * check-build-preflight.mjs — what must be true before `electron-builder --mac` runs.
 *
 * Wired ahead of electron-builder in `electron/package.json`'s `dist:mac`, so a build that
 * cannot work fails HERE (with a reason and a fix) instead of producing an .app that starts
 * up blank. Three of these are hard failures that have each cost a debugging round:
 *
 *   - the icon is generated, not committed — a missing `icon.icns` makes electron-builder
 *     pack Electron's default icon with no warning;
 *   - a build whose `electron/node_modules` is not installed produces an app that cannot
 *     start at all;
 *   - with neither `config.json` nor `.env`, the app has no config and no credentials, so
 *     the gate cannot be passed and every panel is empty.
 *
 * The warnings are the licensing pair: `electron/src/main/dev-centre-trust.json` is the
 * FALLBACK trust a build uses when the `personal_key_manager` store is not readable, and it
 * is a baked snapshot — a stale one refuses licences with `unknown_kid` while a freshly
 * revoked seat still signs in. Comparing it against the store's own ring and blocklist is
 * cheap, so it is worth doing on every build rather than remembering to.
 *
 * Read-only: nothing here writes, bakes or builds. `npm run trust:bake` is the fix it
 * suggests.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const failures = [];
const warnings = [];

const rel = (p) => path.relative(REPO, p) || ".";
const exists = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
const mtime = (p) => {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
};
const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};
const fail = (message, fix) => failures.push({ message, fix });
const warn = (message, fix) => warnings.push({ message, fix });

// ── 1. Is this actually the repo? ──────────────────────────────────────────────
const MARKERS = ["shared/config-loader.cjs", "mcp/webhook-server/index.js", "electron/src/main.js"];
const missingMarkers = MARKERS.filter((m) => !exists(path.join(REPO, m)));
if (missingMarkers.length) {
  fail(
    `this does not look like the Dev Centre repo — missing ${missingMarkers.join(", ")}`,
    `run the preflight from the repo, it resolves itself from ${rel(REPO)}`
  );
}

// ── 2. The app icon (generated, so it can be absent) ───────────────────────────
for (const icon of ["icon.icns", "icon.png"]) {
  if (!exists(path.join(REPO, "electron", "assets", icon))) {
    fail(`electron/assets/${icon} is missing`, "npm --prefix electron run make:icon");
  }
}

// ── 3. The dev dependency the packer needs ────────────────────────────────────
const electronPkg = path.join(REPO, "electron", "node_modules", "electron", "package.json");
if (!exists(electronPkg)) {
  fail(
    "electron/node_modules/electron is not installed — the packer would produce an app that cannot start",
    "npm run electron:install"
  );
}

// ── 4. A config source, or the built app has nothing to run on ────────────────
const configJson = path.join(REPO, "config.json");
const envFile = path.join(REPO, ".env");
if (!exists(configJson) && !exists(envFile)) {
  fail(
    "neither config.json nor .env exists at the repo root — a built app would have no config and no credentials",
    "npm run config:init   (mirrors .env into config.json), or create .env"
  );
}

// ── 5. Baked licence trust: present, and not older than the store it mirrors ──
const trustFile = path.join(REPO, "electron", "src", "main", "dev-centre-trust.json");
const trust = readJson(trustFile);
if (!trust) {
  warn(
    "electron/src/main/dev-centre-trust.json is missing — a build with no readable key store cannot verify ANY licence",
    "npm run trust:bake"
  );
}

/** The store's own copy of the two things the trust file bakes (ring + blocklist). */
function registryDir() {
  const root = (process.env.PKM_ROOT || process.env.PKM_REPO || "").trim();
  const candidates = [
    root,
    path.join(os.homedir(), "Documents", "GitHub", "personal_key_manager"),
    path.join(os.homedir(), "personal_key_manager"),
  ].filter(Boolean);
  const registry = (process.env.PKM_REGISTRY || "frontdesk-agent").trim();
  for (const candidate of candidates) {
    const dir = path.join(candidate, "registries", registry);
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

if (trust) {
  const store = registryDir();
  if (store) {
    const ring = path.join(store, "ring.json");
    const revoked = path.join(store, "revoked-seats.json");
    const newest = Math.max(mtime(ring), mtime(revoked));
    if (newest && mtime(trustFile) < newest) {
      const newer = mtime(ring) > mtime(revoked) ? "ring.json" : "revoked-seats.json";
      warn(
        `the baked trust is older than the key store's ${newer} — a new ring key would fail as unknown_kid and a revoked seat could still sign in`,
        "npm run trust:bake"
      );
    }
  }
}

// ── 6. Would the build have any usable local password? ────────────────────────
// `.env`'s DEV_CENTRE_ADMINS (or a role registry) is what signs an operator in without a
// licence; the compiled list is the last resort. Both of the shipped entries are
// `verifier: null` placeholders, so a build that has ONLY those is licence-only — which is
// fine for a recipient who is given one, and useless for the person who built it.
const provisioned = readJson(path.join(REPO, "electron", "src", "main", "dev-centre-admins.json"));
const admins = Array.isArray(provisioned?.admins) ? provisioned.admins : [];
const withVerifier = admins.filter((a) => a && a.verifier);
const envText = exists(envFile) ? fs.readFileSync(envFile, "utf8") : "";
const cfgText = exists(configJson) ? fs.readFileSync(configJson, "utf8") : "";
const hasEnvAdmins = /DEV_CENTRE_ADMINS=/.test(`${envText}\n${cfgText}`);

if (!withVerifier.length && !hasEnvAdmins) {
  warn(
    "no provisioned admin has a stored verifier and neither .env nor config.json sets DEV_CENTRE_ADMINS — this build can only be entered with a seat licence",
    "add an admin: node scripts/dev-centre-admins.mjs add <email> --password-stdin   (rebuild afterwards)"
  );
}
const placeholders = admins.filter((a) => a && ["a@b.com", "e@f.com"].includes(String(a.email || "").toLowerCase()));
if (placeholders.length) {
  console.log(
    `ℹ️  ${placeholders.length} placeholder admin(s) still in dev-centre-admins.json (${placeholders
      .map((a) => a.email)
      .join(", ")}) — harmless locally, meaningless in a build handed to anyone else.`
  );
}

// ── Report ────────────────────────────────────────────────────────────────────
if (warnings.length) {
  console.log(`\n⚠️  ${warnings.length} warning(s):`);
  for (const w of warnings) {
    console.log(`   • ${w.message}`);
    if (w.fix) console.log(`     fix: ${w.fix}`);
  }
}

if (failures.length) {
  console.log(`\n❌ build preflight failed — ${failures.length} problem(s):`);
  for (const f of failures) {
    console.log(`   • ${f.message}`);
    if (f.fix) console.log(`     fix: ${f.fix}`);
  }
  console.log("");
  process.exit(1);
}

console.log(`\n✅ build preflight ok (repo: ${rel(REPO)})`);
