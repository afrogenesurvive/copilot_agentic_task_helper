/**
 * Cross-check the Key Manager's licence surface.
 *
 * The Key Manager is a client of a separate key store, and the boundary between
 * them is the *capability gate*: `electron/src/main/key-manager.mjs` declares
 * every command it may run in `COMMANDS`, and refuses a command before spawning
 * anything when the store cannot support it. That guarantee only holds if four
 * things stay true, none of which the compiler checks:
 *
 *   1. the preload bridge and the main-process handlers agree, in both directions;
 *   2. every channel is documented (so the gate's contract is discoverable);
 *   3. every channel is actually reachable — a preload method with no call site is
 *      a feature that was implemented and then silently never used (this is how
 *      `pkm:exportBundle` shipped: command, channel, preload method and docs, but
 *      no control and no caller);
 *   4. every `pkm()` call carries a capability that is declared, and every write
 *      that can be invoked has a UI control whose disabled state comes from the
 *      same report the gate uses.
 *
 * Run:  node scripts/check-pkm-wiring.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");

const read = (...p) => fs.readFileSync(path.join(REPO, ...p), "utf8");

const keyManager = read("electron", "src", "main", "key-manager.mjs");
const mainJs = read("electron", "src", "main.js");
const preload = read("electron", "src", "preload.js");
const appJs = read("electron", "src", "renderer", "app.js");
const html = read("electron", "src", "renderer", "index.html");
const ipcs = read("docs", "ipcs.md");
const ipcsSafe = read("docs", "safe", "ipcs.md");

/** Written commands that are declared but have no call site, each for a reason. */
const KNOWN_UNCALLED = new Set(["authority"]);

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.log(`  FAIL ${msg}`);
};

const sorted = (set) => [...set].sort();

// ── Declared capabilities ────────────────────────────────────────────────────
const commands = new Map();
{
  const start = keyManager.indexOf("const COMMANDS = {");
  const end = keyManager.indexOf("\n};", start);
  const body = keyManager.slice(start, end === -1 ? undefined : end);
  for (const m of body.matchAll(
    /^\s{2}([A-Za-z]+):\s*\{\s*write:\s*(true|false)(?:,\s*needs:\s*\[([^\]]*)\])?/gm,
  )) {
    commands.set(m[1], {
      write: m[2] === "true",
      needs: (m[3] || "")
        .split(",")
        .map((s) => s.replace(/["\s]/g, ""))
        .filter(Boolean),
    });
  }
}
const declaredWrites = sorted(new Set([...commands].filter(([, c]) => c.write).map(([k]) => k)));

// ── Capability literals at `pkm()` call sites ────────────────────────────────
// Every call site is single-line, and the capability is always the last string
// argument: `pkm(args, registry, "cap")`.
const invoked = new Set();
for (const line of keyManager.split("\n")) {
  if (!/^\s*(?:return\s+)?pkm\(/.test(line)) continue;
  const m = /,\s*"([A-Za-z]+)"\s*\)\s*;?\s*$/.exec(line.trim());
  if (m) invoked.add(m[1]);
}

// ── Channels ─────────────────────────────────────────────────────────────────
// Channels come from the bridge, not from the method names: some take arguments
// (`invoke("pkm:list", registry, days)`), so match on the string only.
const channels = new Set([...preload.matchAll(/ipcRenderer\.invoke\("(pkm:[A-Za-z]+)"/g)].map((m) => m[1]));
const methods = new Set([...preload.matchAll(/^\s*(pkm[A-Za-z]+)\s*:/gm)].map((m) => m[1]));
const handled = new Set([...mainJs.matchAll(/ipcMain\.handle\("(pkm:[A-Za-z]+)"/g)].map((m) => m[1]));
const calledInRenderer = new Set([
  // Direct: api.pkmIssue(…)
  ...[...appJs.matchAll(/\bapi\.(pkm[A-Za-z]+)\s*\(/g)].map((m) => m[1]),
  // Indirect: the per-check table dispatches api[action](…), action: "pkmChallenge"
  ...[...appJs.matchAll(/"(pkm[A-Za-z]+)"/g)].map((m) => m[1]),
]);

// ── UI gate tags ─────────────────────────────────────────────────────────────
const tagNames = new Set([
  ...[...html.matchAll(/data-pkm-write="([A-Za-z]+)"/g)].map((m) => m[1]),
  ...[...appJs.matchAll(/gatedWrite\("([A-Za-z]+)"/g)].map((m) => m[1]),
]);

// ── 1. preload ⇄ main, both directions ───────────────────────────────────────
console.log(`\n[1] pkm channels: ${channels.size} exposed, ${handled.size} handled`);
const unhandled = sorted(new Set([...channels].filter((c) => !handled.has(c))));
const orphanHandlers = sorted(new Set([...handled].filter((c) => !channels.has(c))));
if (unhandled.length) fail(`exposed in preload with no ipcMain.handle: ${unhandled.join(", ")}`);
if (orphanHandlers.length) fail(`ipcMain.handle with no preload method: ${orphanHandlers.join(", ")}`);
if (!unhandled.length && !orphanHandlers.length) console.log("  ok   every channel handled, every handler reachable");

// ── 2. every channel documented ──────────────────────────────────────────────
console.log(`\n[2] channels documented in docs/ipcs.md + docs/safe/ipcs.md`);
const undocPublic = sorted(new Set([...channels].filter((c) => !ipcs.includes(c))));
const undocSafe = sorted(new Set([...channels].filter((c) => !ipcsSafe.includes(c))));
if (undocPublic.length) fail(`missing from docs/ipcs.md: ${undocPublic.join(", ")}`);
if (undocSafe.length) fail(`missing from docs/safe/ipcs.md: ${undocSafe.join(", ")}`);
if (!undocPublic.length && !undocSafe.length) console.log("  ok   all documented in both");

// ── 3. every channel reachable ───────────────────────────────────────────────
console.log(`\n[3] preload methods called by the renderer: ${calledInRenderer.size}/${methods.size}`);
const unreachable = sorted(new Set([...methods].filter((m) => !calledInRenderer.has(m))));
if (unreachable.length) fail(`preload method(s) never called in app.js: ${unreachable.join(", ")}`);
else console.log("  ok   no orphan channels");
const unknownApi = sorted(new Set([...calledInRenderer].filter((m) => !methods.has(m))));
if (unknownApi.length) fail(`app.js calls api.<method> not exposed in preload: ${unknownApi.join(", ")}`);

// ── 4. gate tags name declared writes ────────────────────────────────────────
console.log(`\n[4] UI controls gated by capability: ${tagNames.size}`);
const badTags = sorted(new Set([...tagNames].filter((t) => !commands.has(t))));
const readOnlyTags = sorted(new Set([...tagNames].filter((t) => commands.has(t) && !commands.get(t).write)));
if (badTags.length) fail(`data-pkm-write/gatedWrite names a command that is not declared: ${badTags.join(", ")}`);
if (readOnlyTags.length) fail(`gated a read-only command: ${readOnlyTags.join(", ")}`);
if (!badTags.length && !readOnlyTags.length) console.log("  ok   all name declared write commands");

// ── 5. every invocable write has a control ───────────────────────────────────
// The bite check: a write the app can run but no button can trigger is either a
// renderer that lost its control or a capability that should not be invocable.
console.log(`\n[5] write capabilities invoked: ${sorted(new Set([...invoked].filter((c) => commands.get(c)?.write))).length}`);
const writelessControls = sorted(
  new Set([...invoked].filter((c) => commands.get(c)?.write && !tagNames.has(c))),
);
if (writelessControls.length) fail(`invocable write with no UI control: ${writelessControls.join(", ")}`);
else console.log("  ok   every invocable write has a control");

// ── 6. capability literals are declared ──────────────────────────────────────
console.log(`\n[6] capability literals at pkm() call sites: ${invoked.size}`);
const undeclared = sorted(new Set([...invoked].filter((c) => !commands.has(c))));
if (undeclared.length) fail(`pkm() called with an undeclared capability: ${undeclared.join(", ")}`);
else console.log("  ok   all declared (an undeclared one fails loudly at runtime)");

// ── 7. declared writes that cannot be invoked ────────────────────────────────
const uncalled = declaredWrites.filter((c) => !invoked.has(c));
const unexpected = uncalled.filter((c) => !KNOWN_UNCALLED.has(c));
const expected = uncalled.filter((c) => KNOWN_UNCALLED.has(c));
if (expected.length) {
  console.log(`\n[7] declared but never invoked: ${expected.join(", ")}`);
  console.log("  note kept in COMMANDS so the gate covers them if a caller is added");
}
if (unexpected.length) fail(`declared write with no pkm() call site: ${unexpected.join(", ")}`);

console.log(failures ? `\n${failures} problem(s)\n` : "\nall checks passed\n");
process.exit(failures ? 1 : 0);
