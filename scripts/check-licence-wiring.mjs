/**
 * Guard the hidden tier_1 admin list and the licence verifier port.
 *
 * Three things can silently go wrong with the licence-based Dev Centre login, and none of
 * them produce an error at runtime:
 *
 *   1. THE LIST LEAKS INTO A UI SURFACE. `dev-centre-admin-emails.js` lives in the main
 *      process and is never sent anywhere, but nothing stops a future edit from importing
 *      it into the renderer or the preload — at which point the whole list is one
 *      `console.log` from an operator's screen, and the reason it is a source constant
 *      instead of a config key is defeated.
 *   2. THE LIST BECOMES A CONFIG KEY. `readWithSources()` returns every key in
 *      `DEFAULTS ∪ .env ∪ config.json`, and the Config tab's RAW JSON view serialises all
 *      of them (`renderConfigForm` in app.js). A new key there is visible to any signed-in
 *      operator regardless of tier, so an admin list published as config is not hidden.
 *   3. THE PORT DRIFTS FROM THE ORIGINAL. `licence-verifier.js` has to reach the same
 *      verdict as `scripts/frontdesk-license.mjs` for the same key, or one of the two
 *      planes accepts a licence the other rejects.
 *
 * This is the same hand-rolled shape as `check-renderer-wiring.mjs` / `check-pkm-wiring.mjs`
 * — no test framework, one process, a non-zero exit when something is wrong.
 *
 * Run:  node scripts/check-licence-wiring.mjs     (also part of `npm run check:wiring`)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");
const require = createRequire(import.meta.url);

const gate = require(path.join(REPO, "electron", "src", "main", "dev-centre-auth.js"));
const adminEmails = require(path.join(REPO, "electron", "src", "main", "dev-centre-admin-emails.js"));
const licences = require(path.join(REPO, "electron", "src", "main", "licence-verifier.js"));

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.log(`  FAIL ${msg}`);
};

/** Every file under a directory (recursively), skipping the usual noise. */
function filesUnder(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) filesUnder(full, out);
    else out.push(full);
  }
  return out;
}

/** The surfaces a locked OR signed-in renderer can read. */
const UI_SURFACES = [
  ...filesUnder(path.join(REPO, "electron", "src", "renderer")),
  path.join(REPO, "electron", "src", "preload.js"),
  ...filesUnder(path.join(REPO, "webapp")),
].filter((f) => fs.existsSync(f));

/** Documentation that is committed to the public repo. `docs/safe/` is internal, so the
 *  non-recursive glob over `docs/` deliberately excludes it. */
const PUBLIC_DOCS = [
  ...fs.readdirSync(path.join(REPO, "docs")).filter((n) => n.endsWith(".md")).map((n) => path.join(REPO, "docs", n)),
  ...filesUnder(path.join(REPO, "electron", "docs")).filter((f) => f.endsWith(".md")),
  path.join(REPO, "README.md"),
].filter((f) => fs.existsSync(f));

const read = (f) => fs.readFileSync(f, "utf8");
const rel = (f) => path.relative(REPO, f);

/**
 * Extract the argument text of every `name(...)` CALL (balanced parens), skipping the
 * `function name(...)` declaration. A regex to the first `);` would mis-handle nested
 * calls, and this is short enough to just do properly.
 */
function callSites(source, name) {
  const out = [];
  const needle = `${name}(`;
  let at = source.indexOf(needle);
  while (at !== -1) {
    const isDeclaration = /\bfunction\s+$/.test(source.slice(Math.max(0, at - 12), at));
    let depth = 0;
    let end = -1;
    for (let i = at + needle.length - 1; i < source.length; i++) {
      const ch = source[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (!isDeclaration && end !== -1) out.push(source.slice(at + needle.length, end));
    at = source.indexOf(needle, at + needle.length);
  }
  return out;
}

// ── [1] the hidden module never reaches a UI surface ──────────────────────────

const HIDDEN_TOKENS = ["dev-centre-admin-emails", "TIER_1_EMAILS", "isTier1Email", "adminListProblems", "hasTier1Emails"];
const licensed = [];
for (const file of UI_SURFACES) {
  const text = read(file);
  for (const token of HIDDEN_TOKENS) {
    if (text.includes(token)) licensed.push(`${rel(file)} references ${token}`);
  }
}
console.log(`\n[1] hidden admin list reachable from a UI surface: ${UI_SURFACES.length} file(s) scanned`);
if (licensed.length) fail(`the list must stay in the main process — ${licensed.join("; ")}`);
else console.log("  ok   renderer, preload and webapp never reference it");

// ── [2] no admin address in a UI surface or a public doc ──────────────────────

const addresses = adminEmails.TIER_1_EMAILS;
const leaked = [];
for (const file of [...UI_SURFACES, ...PUBLIC_DOCS]) {
  const text = read(file).toLowerCase();
  for (const address of addresses) {
    if (text.includes(String(address).toLowerCase())) leaked.push(`${rel(file)} contains ${address}`);
  }
}
console.log(`\n[2] admin addresses in UI surfaces or public docs: ${addresses.length} address(es), ${PUBLIC_DOCS.length} public doc(s)`);
if (leaked.length) fail(`an address is not a secret but must not be published — ${leaked.join("; ")}`);
else console.log("  ok   no address appears in the renderer, preload, webapp or any published doc");

// ── [3] the list is not (and must not become) a config key ────────────────────

const configLoader = read(path.join(REPO, "shared", "config-loader.cjs"));
const mainJs = read(path.join(REPO, "electron", "src", "main.js"));
const appJs = read(path.join(REPO, "electron", "src", "renderer", "app.js"));

const SUSPECT_KEY = /["'][A-Z0-9_]*(ADMIN_EMAIL|TIER1|TIER_1_EMAIL)[A-Z0-9_]*["']/g;
const configKeys = [...configLoader.matchAll(SUSPECT_KEY), ...appJs.matchAll(SUSPECT_KEY)].map((m) => m[0]);
const redactedMatch = mainJs.match(/REDACTED_CONFIG_KEYS\s*=\s*new Set\(\[([^\]]*)\]\)/);
const redacted = redactedMatch ? redactedMatch[1] : "";

console.log("\n[3] the hidden list is not a config key");
if (configKeys.length) fail(`an admin-email config key exists (${[...new Set(configKeys)].join(", ")}) — it would render in the Config tab's Raw JSON view`);
else console.log("  ok   no admin-email key in config-loader DEFAULTS or the Config tab's field list");
if (!redacted.includes('"DEV_CENTRE_ADMINS"')) fail("DEV_CENTRE_ADMINS is no longer redacted from the config surfaces");
else if (/ADMIN_EMAIL|TIER1/i.test(redacted)) fail(`REDACTED_CONFIG_KEYS gained an admin-email key — keep the list in source instead`);
else console.log("  ok   DEV_CENTRE_ADMINS is still the redacted secret, and no admin-email key joined it");
if (!configLoader.includes("DEV_CENTRE_ADMINS")) fail("config-loader no longer mentions DEV_CENTRE_ADMINS at all — did the redaction note get dropped?");
if (!licences || !gate) fail("could not load the main-process modules");

// ── [4] runtime shape of the list ─────────────────────────────────────────────

console.log(`\n[4] runtime shape of the list: ${addresses.length} entr(ies)`);
if (!Object.isFrozen(addresses)) fail("TIER_1_EMAILS is not frozen — it could be mutated at runtime");
else console.log("  ok   frozen");

const unnormalised = addresses.filter((a) => a !== String(a).trim().toLowerCase());
if (unnormalised.length) fail(`entries must be stored pre-normalised: ${unnormalised.join(", ")}`);
else console.log("  ok   every entry is already lower-cased and trimmed");

if (!adminEmails.isTier1Email(addresses[0]?.toUpperCase?.() ?? "") && addresses.length) {
  fail("isTier1Email is case-sensitive — a mixed-case claim would silently miss");
} else console.log("  ok   lookup is case-insensitive");

const problems = adminEmails.adminListProblems();
const leaky = problems.filter((p) => p.includes("@"));
console.log(`\n[5] load-time problems must not name an address: ${problems.length} problem(s)`);
if (leaky.length) fail(`a problem message names an address, which a LOCKED gate renders: ${leaky.join(" | ")}`);
else console.log("  ok   problems are reported by entry number only");

// ── [6] the gate never logs a secret or a licence ─────────────────────────────

const authSrc = read(path.join(REPO, "electron", "src", "main", "dev-centre-auth.js"));
const SECRET_IDENTIFIERS = ["secret", "typed", "licenceKey", "licenseKey"];
const logLeaks = [];
for (const args of callSites(authSrc, "logEvent")) {
  for (const identifier of SECRET_IDENTIFIERS) {
    // `secret` appears legitimately in `secret: admins.get(...)`-shaped code OUTSIDE
    // logEvent, so only the call arguments are inspected here.
    if (new RegExp(`\\b${identifier}\\b`).test(args)) logLeaks.push(`${identifier} in logEvent(${args.slice(0, 60).trim()}…)`);
  }
}
console.log(`\n[6] logEvent call sites carrying a secret identifier: ${logLeaks.length}`);
if (logLeaks.length) fail(`a secret must never reach the audit log — ${logLeaks.join("; ")}`);
else console.log("  ok   no logEvent call passes a secret, a typed value or a licence");

// ── [7] every state field the gate reads actually exists ──────────────────────

// The gate is hand-written markup plus a hand-written script, so `state.licenceRdy`
// renders as the string "undefined" and says nothing. Exactly the failure mode
// `check-renderer-wiring.mjs` exists for, applied to the object main hands the gate.
const gateJs = read(path.join(REPO, "electron", "src", "renderer", "gate.js"));
const stateFields = new Set([...gateJs.matchAll(/\bstate\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
const realState = gate.state();
const missingFields = [...stateFields].filter((f) => !(f in realState));
console.log(`\n[7] state fields the gate reads: ${stateFields.size}`);
if (missingFields.length) {
  fail(`gate.js reads state.${missingFields.join(", state.")} but state() does not provide it`);
} else {
  console.log("  ok   every field gate.js reads is produced by state()");
}

// ── [8] verdict parity with the frontdesk verifier ────────────────────────────

const store = fs.mkdtempSync(path.join(os.tmpdir(), "licence-parity-"));
const REG = path.join(store, "registries", "frontdesk-agent");
fs.mkdirSync(REG, { recursive: true });

const b64u = (b) => Buffer.from(b).toString("base64url");
const fromB64u = (s) => Buffer.from(s, "base64url");
const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");

const master = crypto.generateKeyPairSync("ed25519");
const masterX = master.publicKey.export({ format: "jwk" }).x;
const KID = "mk-parity";
const REVOKED = "revoked@parity.test";

writeJson(path.join(store, "registries", "registry.json"), {
  registries: [{ id: "frontdesk-agent", app: "frontdesk-agent", dir: "frontdesk-agent" }],
});
writeJson(path.join(REG, "revoked-seats.json"), { seats: [REVOKED] });
const NOT_AFTER = Math.floor(Date.now() / 1000) + 60;

function mint({ sub, email, exp = 0, kid = KID, app = "frontdesk-agent", v = 1, omitEmail = false, breakKey = false, signWith = master.privateKey }) {
  const ed = crypto.generateKeyPairSync("ed25519");
  const x = crypto.generateKeyPairSync("x25519");
  const edPub = ed.publicKey.export({ format: "jwk" }).x;
  const cert = { app, v, sub, exp, kid, pub: edPub, enc: x.publicKey.export({ format: "jwk" }).x, ...(omitEmail ? {} : { email }), metaV: 1 };
  const certB64 = b64u(Buffer.from(JSON.stringify(cert), "utf8"));
  const sig = b64u(crypto.sign(null, fromB64u(certB64), signWith));
  const seed = breakKey
    ? crypto.generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }).d
    : ed.privateKey.export({ format: "jwk" }).d;
  return `TA1.${certB64}.${sig}.${b64u(Buffer.concat([fromB64u(seed), fromB64u(x.privateKey.export({ format: "jwk" }).d)]))}`;
}

writeJson(path.join(REG, "ring.json"), {
  keys: [
    { kid: KID, publicKey: masterX, notAfter: null },
    { kid: "mk-retired", publicKey: masterX, notAfter: Math.floor(Date.now() / 1000) - 60 },
  ],
});

const future = Math.floor(Date.now() / 1000) + 3600;
const past = Math.floor(Date.now() / 1000) - 3600;
const fixtures = [
  ["valid", mint({ sub: "ok@parity.test", email: "ok@parity.test", exp: future })],
  ["claim-less", mint({ sub: "legacy@parity.test", exp: future, omitEmail: true })],
  ["revoked", mint({ sub: REVOKED, email: REVOKED, exp: future })],
  ["expired", mint({ sub: "old@parity.test", email: "old@parity.test", exp: past })],
  ["retired kid", mint({ sub: "r@parity.test", email: "r@parity.test", kid: "mk-retired" })],
  ["unknown kid", mint({ sub: "u@parity.test", email: "u@parity.test", kid: "nope" })],
  ["app mismatch", mint({ sub: "a@parity.test", email: "a@parity.test", app: "other" })],
  ["key mismatch", mint({ sub: "m@parity.test", email: "m@parity.test", breakKey: true })],
  ["bad signature", mint({ sub: "s@parity.test", email: "s@parity.test", signWith: crypto.generateKeyPairSync("ed25519").privateKey })],
  ["malformed", "TA1.zzz"],
  ["not a licence", "hunter2"],
];

// Set the environment BEFORE importing the ESM original — it resolves its paths at import.
const savedEnv = { PKM_ROOT: process.env.PKM_ROOT, PKM_REGISTRY: process.env.PKM_REGISTRY, PKM_REPO: process.env.PKM_REPO };
process.env.PKM_ROOT = store;
process.env.PKM_REGISTRY = "frontdesk-agent";
delete process.env.PKM_REPO;

const esm = await import(pathToFileURL(path.join(REPO, "scripts", "frontdesk-license.mjs")).href);
const paths = licences.pkmPaths(process.env, "frontdesk-agent");

const drift = [];
for (const [label, key] of fixtures) {
  const mine = licences.verifyLicenseKey(key, Date.now(), paths);
  let theirs;
  try {
    theirs = esm.verifyLicenseKey(key);
  } catch (err) {
    drift.push(`${label}: the frontdesk verifier threw (${err.message})`);
    continue;
  }
  if (mine.ok !== theirs.ok) drift.push(`${label}: ok ${mine.ok} vs ${theirs.ok}`);
  else if (!mine.ok && mine.reason !== theirs.reason) drift.push(`${label}: reason ${mine.reason} vs ${theirs.reason}`);
  else if (mine.ok) {
    const { email, ...rest } = mine.claims;
    if (JSON.stringify(rest) !== JSON.stringify(theirs.claims)) drift.push(`${label}: claim set differs`);
  }
}
console.log(`\n[8] verdict parity with scripts/frontdesk-license.mjs: ${fixtures.length} fixture(s)`);
if (drift.length) fail(`the port has drifted — ${drift.join("; ")}`);
else console.log("  ok   identical verdicts and claim sets (plus the added email claim)");

// The divergence itself is asserted, not assumed: the original DROPS the email claim.
const validKey = fixtures[0][1];
const theirsValid = esm.verifyLicenseKey(validKey);
const mineValid = licences.verifyLicenseKey(validKey, Date.now(), paths);
console.log("\n[9] the documented divergence: this port must READ the email claim the original drops");
if (theirsValid.claims.email !== undefined) fail("the frontdesk verifier now returns email — the port's reason for existing changed, review it");
else if (mineValid.claims.email !== "ok@parity.test") fail(`the port did not surface the email claim (got ${JSON.stringify(mineValid.claims.email)})`);
else console.log("  ok   original drops it, the port reads it — the only intentional difference");

for (const [k, v] of Object.entries(savedEnv)) if (v === undefined) delete process.env[k];
else process.env[k] = v;
fs.rmSync(store, { recursive: true, force: true });

console.log(failures ? `\n${failures} problem(s)\n` : "\nall checks passed\n");
process.exit(failures ? 1 : 0);
