/**
 * Cross-check the two browser UIs.
 *
 * Neither the Electron renderer nor the collaborator webapp has tests or a build
 * step, and both build a lot of markup from template strings — so a class renamed
 * in CSS with no matching change in JS renders silently unstyled.
 *
 *   Electron renderer : every id app.js looks up must exist, every glyph name it
 *                       references must be in the set, every referenced asset must
 *                       resolve, and every class either side emits must be styled.
 *   Webapp            : the same class/id checks. `webapp/public/style.css` is
 *                       pushed straight to Netlify, so a regression there is live.
 *
 * Run:  node scripts/check-renderer-wiring.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");
const RENDERER = path.join(REPO, "electron", "src", "renderer");

const appJs = fs.readFileSync(path.join(RENDERER, "app.js"), "utf8");
const html = fs.readFileSync(path.join(RENDERER, "index.html"), "utf8");
const iconsJs = fs.readFileSync(path.join(RENDERER, "icons.js"), "utf8");
// The menu-bar popover is a SECOND renderer document (tray.html + tray.js), loaded
// with loadFile() exactly like the dashboard. It gets the same checks, because it
// has the same failure mode: a hand-written id in the markup that the script
// looks up under a slightly different name renders nothing and says nothing.
// The two documents are checked as one set — both share styles/** and the glyph
// set, so a class or glyph introduced for the panel is legitimately "declared"
// from either file.
const trayHtml = fs.readFileSync(path.join(RENDERER, "tray.html"), "utf8");
const trayJs = fs.readFileSync(path.join(RENDERER, "tray.js"), "utf8");
// The gate is a THIRD document (gate.html + gate.js), loaded into the main window
// while there is no session. It is checked here for the same reason as the panel: it
// is hand-written markup that a script looks up by id, and it is what a locked
// operator sees — so a broken id there has no working screen behind it to fall back to.
const gateHtml = fs.readFileSync(path.join(RENDERER, "gate.html"), "utf8");
const gateJs = fs.readFileSync(path.join(RENDERER, "gate.js"), "utf8");
const htmlAll = `${html}\n${trayHtml}\n${gateHtml}`;
const jsAll = `${appJs}\n${trayJs}\n${gateJs}`;

/** Collect all CSS across a directory tree. */
function readCssTree(dir) {
  const files = [];
  (function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".css")) files.push(full);
    }
  })(dir);
  return files.map((f) => fs.readFileSync(f, "utf8")).join("\n");
}

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.log(`  FAIL ${msg}`);
};

/** Names a file declares as `class="a b c"` (skipping interpolated fragments). */
function declaredClasses(source) {
  return new Set(
    [...source.matchAll(/class="([^"$]*?)"/g)]
      .flatMap((m) => m[1].split(/\s+/))
      .filter((c) => c && !c.includes("{")),
  );
}

/** Class names that appear anywhere in a JS file, including template fragments. */
function jsClassTokens(source) {
  return new Set(
    [...source.matchAll(/(?:class="|className = "|className = `|`)\s*([a-z][a-z0-9_-]*(?:\s+[a-z][a-z0-9_-]*)*)/g)]
      .flatMap((m) => m[1].split(/\s+/))
      .filter(Boolean),
  );
}

const styledIn = (css, cls) => new RegExp(`\\.${cls}(?![A-Za-z0-9_-])`).test(css);

// ════════════════════════════════════════════════════════════════════════════
// Electron renderer
// ════════════════════════════════════════════════════════════════════════════
const css = readCssTree(path.join(RENDERER, "styles"));

console.log("\n══ Electron renderer ══");

// ── 1. ids the renderers look up via $("…") ─────────────────────────────────
// Some ids are created by app.js itself inside its own template strings (e.g. the
// service log pane), so "not in the HTML" is only a failure if no script declares
// it either.
const ids = new Set([...jsAll.matchAll(/\$\("([A-Za-z0-9_-]+)"\)/g)].map((m) => m[1]));
const missingIds = [...ids].filter(
  (id) => !htmlAll.includes(`id="${id}"`) && !jsAll.includes(`id="${id}"`),
);
console.log(`\n[1] ids referenced by the renderers: ${ids.size}`);
if (missingIds.length) fail(`never defined in the markup or by a script: ${missingIds.join(", ")}`);
else console.log("  ok   all defined");

// ── 2. icons used by name must exist in the glyph set ─────────────────────────
const iconNames = new Set([...iconsJs.matchAll(/^\s{4}"?([a-z-]+)"?:\s*"/gm)].map((m) => m[1]));
const usedIcons = new Set([
  ...[...htmlAll.matchAll(/data-icon="([a-z-]+)"/g)].map((m) => m[1]),
  ...[...jsAll.matchAll(/Icons\.svg\("([a-z-]+)"/g)].map((m) => m[1]),
  ...[...jsAll.matchAll(/iconLabel\("([a-z-]+)"/g)].map((m) => m[1]),
]);
const missingIcons = [...usedIcons].filter((n) => !iconNames.has(n));
console.log(`\n[2] glyph names used: ${usedIcons.size} (set has ${iconNames.size})`);
if (missingIcons.length) fail(`no such glyph: ${missingIcons.join(", ")}`);
else console.log("  ok   every referenced glyph exists");

// ── 3. every <link>/<script> resolves ────────────────────────────────────────
console.log("\n[3] assets referenced by the renderer documents");
const before = failures;
for (const ref of [
  ...[...htmlAll.matchAll(/href="([^"]+\.css)"/g)].map((m) => m[1]),
  ...[...htmlAll.matchAll(/src="([^"]+\.js)"/g)].map((m) => m[1]),
]) {
  if (!fs.existsSync(path.join(RENDERER, ref))) fail(`missing file: ${ref}`);
}
if (failures === before) console.log("  ok   all present");

// ── 4. classes must be styled ────────────────────────────────────────────────
const htmlClasses = declaredClasses(htmlAll);
const htmlUnstyled = [...htmlClasses].filter((c) => !styledIn(css, c));
console.log(`\n[4] classes declared in the renderer documents: ${htmlClasses.size}`);
if (htmlUnstyled.length) fail(`unstyled: ${htmlUnstyled.join(", ")}`);
else console.log("  ok   all styled");

const jsClasses = declaredClasses(appJs);
const jsUnstyled = [...jsClasses].filter((c) => !styledIn(css, c));
console.log(`\n[5] static classes app.js emits: ${jsClasses.size}`);
if (jsUnstyled.length) fail(`unstyled: ${jsUnstyled.join(", ")}`);
else console.log("  ok   all styled");

// ════════════════════════════════════════════════════════════════════════════
// Collaborator webapp
// ════════════════════════════════════════════════════════════════════════════
const WEBAPP = path.join(REPO, "webapp", "public");
const waHtml = fs.readFileSync(path.join(WEBAPP, "index.html"), "utf8");
const waJs = fs.readFileSync(path.join(WEBAPP, "app.js"), "utf8");
const waCss = fs.readFileSync(path.join(WEBAPP, "style.css"), "utf8");

console.log("\n══ Webapp (webapp/public) ══");

const waIds = new Set([...waJs.matchAll(/getElementById\("([A-Za-z0-9_-]+)"\)/g)].map((m) => m[1]));
const waMissingIds = [...waIds].filter((id) => !waHtml.includes(`id="${id}"`));
console.log(`\n[6] ids the webapp looks up: ${waIds.size}`);
if (waMissingIds.length) fail(`missing from index.html: ${waMissingIds.join(", ")}`);
else console.log("  ok   all present");

const waClasses = new Set([...declaredClasses(waHtml), ...declaredClasses(waJs)]);
// Classes the webapp assigns wholesale (`el.className = "…"`), building each name
// from quoted fragments.
for (const m of waJs.matchAll(/className\s*=\s*(.+?);/g)) {
  for (const q of m[1].matchAll(/"([a-z][a-z0-9_-]*)"/g)) waClasses.add(q[1]);
  for (const q of m[1].matchAll(/'([a-z][a-z0-9_-]*)'/g)) waClasses.add(q[1]);
}
const waUnstyled = [...waClasses].filter((c) => !styledIn(waCss, c));
console.log(`\n[7] classes the webapp uses: ${waClasses.size}`);
if (waUnstyled.length) fail(`unstyled: ${waUnstyled.join(", ")}`);
else console.log("  ok   all styled");

console.log(failures ? `\n${failures} problem(s)\n` : "\nall checks passed\n");
process.exit(failures ? 1 : 0);

