/**
 * Guard the hidden tier_1 admin list and the licence verifier port.
 *
 * Three things can silently go wrong with the licence-based Dev Centre login, and none of
 * them produce an error at runtime:
 *
 *   1. THE LIST LEAKS INTO A UI SURFACE. `dev-centre-admins.json` (loaded by
 *      `dev-centre-admins.js`) lives in the main process and is never sent anywhere, but
 *      nothing stops a future edit from importing it into the renderer or the preload — at
 *      which point the whole list is one
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
const adminAdmins = require(path.join(REPO, "electron", "src", "main", "dev-centre-admins.js"));
const pwdv = require(path.join(REPO, "electron", "src", "main", "password-verifier.js"));
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

const HIDDEN_TOKENS = ["dev-centre-admins", "TIER_1_ADMINS", "TIER_1_EMAILS", "isTier1Email", "credentialForAdmin", "adminListProblems", "hasTier1Emails"];
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

const addresses = adminAdmins.TIER_1_ADMINS.map((a) => a.email);
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

// ── [3b] the redaction is WIRED, not merely declared ──────────────────────────
//
// §3 asserts the source text; this asserts the shape of the wiring, because the realistic
// failure is a handler that quietly stops calling the helper — or a NEW surface that never
// starts. `shared/config-redaction.cjs` is exercised directly too, so the behaviour is
// covered without launching Electron.

console.log("\n[3b] the redaction is wired into every config surface");
const redaction = require(path.join(REPO, "shared", "config-redaction.cjs"));
const mainList = (redacted.match(/"([^"]+)"/g) || []).map((s) => s.slice(1, -1));
const sharedList = [...redaction.REDACTED_CONFIG_KEYS];
if (!mainList.length) fail("could not read the key list out of main.js's REDACTED_CONFIG_KEYS literal");
else if (mainList.slice().sort().join(",") !== sharedList.slice().sort().join(",")) {
  fail(`main.js's list (${mainList.join(", ")}) and shared/config-redaction.cjs (${sharedList.join(", ")}) disagree — keep them identical`);
} else {
  console.log(`  ok   main.js and shared/config-redaction.cjs agree on ${sharedList.length} key(s)`);
}

/** The text of one `ipcMain.handle("<channel>", …)` registration, up to the next one. */
function handlerBody(source, channel) {
  const at = source.indexOf(`ipcMain.handle("${channel}"`);
  if (at === -1) return "";
  const next = source.indexOf("ipcMain.handle(", at + 10);
  return source.slice(at, next === -1 ? source.length : next);
}

const CONFIG_HANDLERS = ["config:get", "config:getWithSources", "config:save", "config:export", "config:import"];
const handlers = {};
for (const channel of CONFIG_HANDLERS) handlers[channel] = handlerBody(mainJs, channel);
const missing = CONFIG_HANDLERS.filter((c) => !handlers[c]);
if (missing.length) fail(`could not find the config handler(s) in main.js: ${missing.join(", ")}`);

/** Where `needle` sits inside a handler body, or -1. */
const posIn = (channel, needle) => handlers[channel].indexOf(needle);

if (!missing.length) {
  let surfaceProblems = 0;
  const surfaceFail = (msg) => {
    surfaceProblems += 1;
    fail(msg);
  };

  if (posIn("config:get", "redactConfig(") === -1) surfaceFail("config:get no longer redacts its values");
  if (posIn("config:getWithSources", "redactConfig(") === -1) surfaceFail("config:getWithSources no longer redacts its values");
  else if (posIn("config:getWithSources", "count: Object.keys(values).length") === -1) {
    surfaceFail("config:getWithSources' count is not derived from the redacted map — the count itself would hint a hidden key exists");
  }
  if (posIn("config:export", "redactConfig(") === -1) surfaceFail("config:export no longer redacts the JSON it hands out");
  if (posIn("config:import", "blockedKeys(") === -1) surfaceFail("config:import no longer refuses the gate-owned keys");

  const saveBlocked = posIn("config:save", "blockedKeys(");
  const saveWrite = posIn("config:save", "mergeConfig(");
  if (saveBlocked === -1) surfaceFail("config:save no longer refuses the gate-owned keys");
  else if (saveWrite === -1) surfaceFail("config:save no longer merges into config.json — did the write path move?");
  else if (saveBlocked > saveWrite) surfaceFail("config:save checks the gate-owned keys AFTER mergeConfig — the write must be refused before it happens");

  const importBlocked = posIn("config:import", "blockedKeys(");
  const importWrite = posIn("config:import", "importConfig(");
  if (importBlocked !== -1 && importWrite !== -1 && importBlocked > importWrite) {
    surfaceFail("config:import checks the gate-owned keys AFTER importConfig — the write must be refused before it happens");
  }

  if (surfaceProblems === 0) {
    console.log("  ok   all five config surfaces strip or refuse the gate-owned keys (count derived after redaction)");
  }
}

// The CLI half of the same rule: `npm run config:init` must not mirror the key into
// config.json, which is the second store the gate would then read.
const fromEnvSrc = read(path.join(REPO, "scripts", "config-from-env.mjs"));
const feStrip = fromEnvSrc.indexOf("redactConfig(");
const feWrite = fromEnvSrc.indexOf("saveConfig(");
if (!fromEnvSrc.includes("config-redaction.cjs")) {
  fail("scripts/config-from-env.mjs does not import shared/config-redaction.cjs — `npm run config:init` would write the admin list into config.json");
} else if (feStrip === -1 || feWrite === -1 || feStrip > feWrite) {
  fail("scripts/config-from-env.mjs must strip the gate-owned keys BEFORE saveConfig()");
} else {
  console.log("  ok   config-from-env.mjs strips the gate-owned keys before writing config.json");
}

// The behaviour itself, on the shared module (no Electron needed).
const sample = { DEV_CENTRE_ADMINS: "a@b.com:not-a-real-secret", LOG_LEVEL: "info" };
if ("DEV_CENTRE_ADMINS" in redaction.redactConfig(sample)) fail("redactConfig() left a gate-owned key in the map");
else if (JSON.stringify(redaction.redactConfig(sample)) !== JSON.stringify({ LOG_LEVEL: "info" })) fail("redactConfig() altered a key it must keep");
else console.log("  ok   redactConfig() strips only the gate-owned key");

if (redaction.blockedKeys(sample).join(",") !== "DEV_CENTRE_ADMINS") fail("blockedKeys() missed the gate-owned key in a mixed payload");
else if (redaction.blockedKeys({ LOG_LEVEL: "info" }).length) fail("blockedKeys() reported a benign payload as blocked");
else console.log("  ok   blockedKeys() finds the key in a mixed payload and nothing in a clean one");

// main.js passes its OWN literal set into the helpers, so prove the parameter governs the
// outcome — otherwise the literal could be decorative and the default would silently win.
const wider = new Set([...sharedList, "ANOTHER_SECRET"]);
if ("ANOTHER_SECRET" in redaction.redactConfig({ ANOTHER_SECRET: "y", LOG_LEVEL: "z" }, wider)) {
  fail("redactConfig() ignored the key set it was given — main.js passes its own literal");
} else if ("LOG_LEVEL" in redaction.redactConfig({ LOG_LEVEL: "z" }, wider) === false) {
  fail("redactConfig() dropped a non-redacted key when given a wider set");
} else {
  console.log("  ok   the caller-supplied key set governs redactConfig() (main.js passes its literal)");
}

// The adjacent boundary that already protects the same secret: the operator chat's file
// tools are allow-listed, and .env / config.json / safe/ must stay out of that list.
const localTools = read(path.join(REPO, "electron", "src", "main", "local-tools.mjs"));
const roots = (localTools.match(/const DIR_ROOTS = \[([^\]]*)\]/) || [])[1] || "";
const fileRoot = (localTools.match(/const FILE_ROOT = "([^"]*)"/) || [])[1] || "";
const reachable = [".env", "config.json", "safe"].filter((p) => roots.includes(p) || fileRoot.includes(p));
if (!roots || !fileRoot) fail("could not read the operator chat's read allow-list out of local-tools.mjs");
else if (reachable.length) fail(`the operator chat's allow-list now reaches ${reachable.join(", ")} — the admin list and every other secret live there`);
else console.log("  ok   the operator chat's read allow-list still excludes .env, config.json and safe/");

// ── [4] runtime shape of the list, and what it refuses to hold ────────────────

const entries = adminAdmins.TIER_1_ADMINS;
console.log(`\n[4] runtime shape of the list: ${entries.length} entr(ies)`);
if (!Object.isFrozen(entries)) fail("TIER_1_ADMINS is not frozen — it could be mutated at runtime");
else if (entries.some((entry) => !Object.isFrozen(entry))) fail("TIER_1_ADMINS holds a mutable entry object");
else console.log("  ok   frozen, entries included");

const unnormalised = entries.filter((e) => e.email !== String(e.email).trim().toLowerCase());
if (unnormalised.length) fail("an entry is not stored pre-normalised (lower-cased and trimmed)");
else console.log("  ok   every entry is already lower-cased and trimmed");

if (entries.length && !adminAdmins.isTier1Email(entries[0].email.toUpperCase())) {
  fail("isTier1Email is case-sensitive — a mixed-case cert claim would silently miss");
} else console.log("  ok   lookup is case-insensitive");

// The file is committed AND ships inside the app, so these four refusals are the difference
// between "a verifier" and "a published credential". Exercised through the loader's own
// `validate()`, which is also what the CLI writes through — so the two cannot disagree.
const goodVerifier = pwdv.makePasswordVerifier("a-throwaway-password-for-the-check");
const accepted = adminAdmins.validate([
  { email: "Local@Example.test", verifier: goodVerifier },
  { email: "licence-only@example.test", verifier: null },
]);
// expected = how many entries may survive that input. A duplicate must keep the FIRST one
// (the second is the offending entry), so "expect 0" would be wrong there.
const refused = [
  ["a plaintext secret", adminAdmins.validate([{ email: "a@example.test", verifier: "hunter2" }]), 0],
  ["a TA1 licence", adminAdmins.validate([{ email: "a@example.test", verifier: `TA1.${Buffer.from("{}").toString("base64url")}.x.y` }]), 0],
  ["a duplicate address", adminAdmins.validate([{ email: "a@example.test", verifier: null }, { email: "A@example.test", verifier: null }]), 1],
  ["a non-address", adminAdmins.validate([{ email: "not an address", verifier: null }]), 0],
];
console.log("\n[4b] what the provisioned list refuses to hold");
if (accepted.problems.length) fail(`the provisioned list rejected valid entries: ${accepted.problems.join("; ")}`);
else if (accepted.admins.length !== 2) fail("the provisioned list dropped a valid entry");
else console.log("  ok   a verifier entry and a licence-only entry are both accepted");

const acceptedAnyway = refused.filter(([, r]) => !r.problems.length).map(([label]) => label);
const wrongSurvivors = refused.filter(([, r, expected]) => r.admins.length !== expected).map(([label]) => label);
if (acceptedAnyway.length) fail(`the provisioned list accepts ${acceptedAnyway.join(", ")} — it is committed and shipped`);
else if (wrongSurvivors.length) fail(`a refused entry survived: ${wrongSurvivors.join(", ")}`);
else console.log(`  ok   refuses ${refused.map(([label]) => label).join(", ")}, keeping nothing of the offending entry`);
if (accepted.admins[0]?.email !== "local@example.test") fail("an accepted address was not normalised");
else console.log("  ok   accepted addresses are normalised");

const cliSrc = read(path.join(REPO, "scripts", "dev-centre-admins.mjs"));
if (!cliSrc.includes("dev-centre-admins.js")) fail("the CLI does not validate through the loader — a hand-written entry could reach the committed file");
else if (!cliSrc.includes("validate(")) fail("the CLI does not call the loader's validate()");
else console.log("  ok   the CLI writes through the loader's own validate()");

const problems = adminAdmins.adminListProblems();
const stateProblems = gate.state().problems.filter((p) => String(p).includes("@"));
console.log(`\n[5] load-time problems must not name an address: ${problems.length} list problem(s), ${stateProblems.length} state problem(s)`);
if (problems.length && problems.some((p) => p.includes("@"))) {
  fail("a list problem names an address, which a LOCKED gate renders");
} else if (stateProblems.length) {
  fail(`state().problems names an address, and gate.js renders it while LOCKED: ${stateProblems.join(" | ")}`);
} else console.log("  ok   problems are reported by entry number only, in both surfaces");

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

// ── [10] a licence-valued ADMIN credential is verified, not merely compared ───
//
// The fix for "the seat is revoked but I still signed in with it": an entry in `.env` or in
// the provisioned list used to be a bare string compare, so revocation, expiry and a retired
// signing key were never consulted. The temp store built in §8 is the fixture.

console.log("\n[10] licence validity applies to an admin credential too");
const byLabel = (label) => fixtures.find(([l]) => l === label)[1];
const claimsOf = (key) => licences.verifyLicenseKey(key, Date.now(), paths).claims;

const revokedCred = { email: REVOKED, role: "tier_1", secret: byLabel("revoked"), source: "test" };
const revokedVerdict = gate.verifyCredential(revokedCred, revokedCred.secret);
if (revokedVerdict.ok) fail("a REVOKED licence in an admin credential still signed in — the bug this exists to close");
else if (revokedVerdict.reason !== "revoked_seat") fail(`a revoked admin credential failed with ${revokedVerdict.reason}, expected revoked_seat`);
else console.log("  ok   revoked: refused with revoked_seat even though the string matched");

const okKey = byLabel("valid");
const validCred = { email: claimsOf(okKey).email, role: "tier_1", secret: okKey, source: "test" };
if (!gate.verifyCredential(validCred, okKey).ok) fail("a VALID licence in an admin credential was refused");
else console.log("  ok   valid: accepted");

const expiredCred = { email: "old@parity.test", role: "tier_1", secret: byLabel("expired"), source: "test" };
const retiredCred = { email: "r@parity.test", role: "tier_1", secret: byLabel("retired kid"), source: "test" };
const mismatchCred = { email: "someone.else@parity.test", role: "tier_1", secret: okKey, source: "test" };
const claimlessCred = { email: "legacy@parity.test", role: "tier_1", secret: byLabel("claim-less"), source: "test" };

const refusals = [
  ["expired", gate.verifyCredential(expiredCred, expiredCred.secret), "expired"],
  ["retired signing key", gate.verifyCredential(retiredCred, retiredCred.secret), "retired_kid"],
  ["a licence filed under another address", gate.verifyCredential(mismatchCred, okKey), "email_mismatch"],
  ["a claim-less licence", gate.verifyCredential(claimlessCred, claimlessCred.secret), "licence_no_email"],
];
const wrongReason = refusals.filter(([, verdict, expected]) => verdict.ok || verdict.reason !== expected);
if (wrongReason.length) {
  fail(`an admin credential that must be refused was not: ${wrongReason.map(([label, v]) => `${label} → ${v.ok ? "ACCEPTED" : v.reason}`).join("; ")}`);
} else console.log(`  ok   refused: ${refusals.map(([label]) => label).join(", ")}`);

// Non-licence credentials must be untouched: nothing can revoke a password, so there is
// nothing to check, and adding the check must not change how they behave.
const plainCred = { email: "plain@parity.test", role: "tier_1", secret: "not-a-licence", source: "test" };
if (!gate.verifyCredential(plainCred, "not-a-licence").ok) fail("a plaintext admin credential stopped working");
else if (gate.verifyCredential(plainCred, "wrong").ok) fail("a WRONG plaintext secret was accepted");
else if (!gate.licenceValidity(plainCred).ok) fail("licenceValidity() rejected a non-licence credential — it must be a no-op for one");
else console.log("  ok   plaintext/verifier credentials are unchanged (validity is a no-op for them)");

// Both entry points must go through it: `login` (validity, then possession) and `hydrate`
// (validity only — a resumed session holds no typed secret), so a revocation that happened
// while the app was closed is not inherited for the rest of the 12 hours.
if (typeof gate.verifyCredential !== "function") fail("verifyCredential is not exported — this section cannot assert the behaviour");
else if (!/const check = verifyCredential\(credential, typed\)/.test(authSrc)) fail("login() no longer calls verifyCredential — a revoked admin licence would sign in again");
else if (!/const validity = licenceValidity\(credential\)/.test(authSrc)) fail("hydrate() no longer re-checks licence validity — a revocation during a closed app would be inherited");
else console.log("  ok   login() verifies, hydrate() re-verifies");

// ── [11] the embedded trust fallback (a build with no key store) ──────────────

console.log("\n[11] embedded trust for builds with no key store");
const gitignore = read(path.join(REPO, ".gitignore"));
if (!gitignore.includes("electron/src/main/dev-centre-trust.json")) fail("dev-centre-trust.json is not gitignored — the seat blocklist is a list of addresses");
else console.log("  ok   the baked trust file is gitignored");

const examplePath = path.join(REPO, "electron", "src", "main", "dev-centre-trust.example.json");
let example = null;
try {
  example = JSON.parse(read(examplePath));
} catch (err) {
  fail(`dev-centre-trust.example.json is missing or invalid: ${err.message}`);
}
if (example && (!Array.isArray(example.ring) || !Array.isArray(example.revoked))) fail("dev-centre-trust.example.json no longer documents the shape");
else if (example) console.log("  ok   the committed example documents the shape");

const trustFile = path.join(store, "dev-centre-trust.json");
writeJson(trustFile, { stamp: "2026-01-01", ring: [{ kid: "mk-embedded", publicKey: masterX, notAfter: null }], revoked: ["embedded@parity.test"] });
const barePaths = { ...paths, ringFile: path.join(store, "absent-ring.json"), revokedFile: path.join(store, "absent-blocklist.json") };

const embeddedRing = licences.ringSource(barePaths, trustFile);
if (embeddedRing.source !== "embedded" || !embeddedRing.keys.length) fail(`the ring does not fall back to the embedded copy (source=${embeddedRing.source})`);
else console.log("  ok   the ring falls back to the embedded copy");

const embeddedRevoked = licences.revokedSource(barePaths, trustFile);
if (embeddedRevoked.source !== "embedded" || !embeddedRevoked.seats.includes("embedded@parity.test")) fail("the blocklist does not fall back to the embedded copy");
else if (!embeddedRevoked.note) fail("the embedded-blocklist fallback does not warn that it is stale by construction");
else console.log("  ok   the blocklist falls back, and warns that it is stale by construction");

if (licences.ringSource(paths, trustFile).source !== "store") fail("a readable store ring is no longer preferred over the embedded copy");
else if (licences.revokedSource(paths, trustFile).source !== "store") fail("a readable store blocklist is no longer preferred over the embedded copy");
else console.log("  ok   a readable store always wins (fallback, not override)");

const licencesSrc = read(path.join(REPO, "electron", "src", "main", "licence-verifier.js"));
if (!/function loadRevokedSeats\(paths = pkmPaths\(\)\) \{\s*return revokedSource\(paths\)\.seats;/.test(licencesSrc)) {
  fail("loadRevokedSeats no longer goes through revokedSource() — a baked blocklist would be ignored");
} else if (!/function loadRing\(paths = pkmPaths\(\)\) \{\s*return \{ keys: ringSource\(paths\)\.keys \};/.test(licencesSrc)) {
  fail("loadRing no longer goes through ringSource() — a baked ring would be ignored");
} else console.log("  ok   the verifier reads through ringSource()/revokedSource()");

for (const [k, v] of Object.entries(savedEnv)) if (v === undefined) delete process.env[k];
else process.env[k] = v;
fs.rmSync(store, { recursive: true, force: true });

console.log(failures ? `\n${failures} problem(s)\n` : "\nall checks passed\n");
process.exit(failures ? 1 : 0);
