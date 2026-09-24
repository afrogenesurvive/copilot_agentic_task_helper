/**
 * Rename the Electron development shell to this app's real identity.
 *
 * WHY THIS EXISTS
 * ---------------
 * In development (`npm start`) the process runs out of
 * `electron/node_modules/electron/dist/Electron.app`, so the macOS dock tooltip,
 * the bold application menu and the About panel all say "Electron" and show
 * Electron's own icon. `package.json`'s `productName` only takes effect at
 * *package* time (electron-builder rewrites the bundle's Info.plist), and
 * `app.setName()` explicitly "does not affect the name that the OS uses" — it
 * only changes the name Electron uses internally.
 *
 * So the only way to get the right name in dev is to rewrite the bundle's
 * Info.plist. This script does that, idempotently, and is wired to
 * `electron/package.json`'s `postinstall` so it survives a reinstall.
 *
 * SAFETY
 * ------
 * - macOS only; a no-op everywhere else.
 * - A no-op when Electron is not installed yet (so it can never fail an install).
 * - Backs the original Info.plist up once, to `Info.plist.electron-default`.
 * - The npm Electron bundle ships ad-hoc, **linker-signed** with
 *   `Info.plist=not bound` and no `_CodeSignature` directory, so editing the
 *   plist does not invalidate it and needs no re-signing. If a future Electron
 *   version *is* sealed, this script re-signs ad-hoc to keep it launchable.
 * - Touches the bundle afterwards so macOS drops its cached icon for the path.
 *
 * Run manually:  node scripts/patch-electron-app-name.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

// Kept in sync with electron/package.json's build.productName / build.appId.
const APP_NAME = "Frontdesk Operator";
const BUNDLE_ID = "com.frontdesk.operator";
const ICON_BASENAME = "frontdesk.icns";

const APP = path.join(REPO, "electron", "node_modules", "electron", "dist", "Electron.app");
const PLIST = path.join(APP, "Contents", "Info.plist");
const BACKUP = path.join(APP, "Contents", "Info.plist.electron-default");
const RESOURCES = path.join(APP, "Contents", "Resources");
const ICON_SOURCE = path.join(REPO, "electron", "assets", "icon.icns");

/** Replace the `<string>` that follows `<key>key</key>`, if the key is present. */
function setPlistString(xml, key, value) {
  const re = new RegExp(`(<key>${key}</key>\\s*<string>)([\\s\\S]*?)(</string>)`);
  if (!re.test(xml)) return null;
  return xml.replace(re, (_match, open, _old, close) => open + value + close);
}

/** Same, but append the key before `</dict>` when it is missing entirely. */
function upsertPlistString(xml, key, value) {
  const replaced = setPlistString(xml, key, value);
  if (replaced !== null) return replaced;
  return xml.replace(/(<\/dict>\s*<\/plist>)/, `\t<key>${key}</key>\n\t<string>${value}</string>\n$1`);
}

function info(message) {
  console.log(`[patch-electron-name] ${message}`);
}

function skip(reason) {
  info(`${reason} — nothing to do`);
  process.exit(0);
}

if (process.platform !== "darwin") {
  skip("not macOS");
}
if (!fs.existsSync(PLIST)) {
  skip("Electron.app not installed (run `npm install` in electron/)");
}

let xml = fs.readFileSync(PLIST, "utf8");

// ── the icon must be in place before we point the plist at it ────────────────
let iconInstalled = false;
if (fs.existsSync(ICON_SOURCE)) {
  const target = path.join(RESOURCES, ICON_BASENAME);
  const incoming = fs.readFileSync(ICON_SOURCE);
  const existing = fs.existsSync(target) ? fs.readFileSync(target) : null;
  if (!existing || !existing.equals(incoming)) {
    fs.writeFileSync(target, incoming);
    iconInstalled = true;
  } else {
    iconInstalled = true;
  }
} else {
  info(`no ${path.relative(REPO, ICON_SOURCE)} yet — leaving the icon alone`);
}

// ── rewrite the identity keys ───────────────────────────────────────────────
let next = xml;
next = upsertPlistString(next, "CFBundleName", APP_NAME);
next = upsertPlistString(next, "CFBundleDisplayName", APP_NAME);
next = upsertPlistString(next, "CFBundleIdentifier", BUNDLE_ID);
if (iconInstalled) next = upsertPlistString(next, "CFBundleIconFile", ICON_BASENAME);

if (next === xml) {
  skip("already patched");
}

// ── write, keeping one pristine copy for reference / rollback ───────────────
if (!fs.existsSync(BACKUP)) {
  fs.writeFileSync(BACKUP, xml);
  info(`original saved to ${path.relative(APP, BACKUP)}`);
}

fs.writeFileSync(PLIST, next);
info(`set CFBundleName/CFBundleDisplayName = "${APP_NAME}", CFBundleIdentifier = ${BUNDLE_ID}`);

// ── keep the bundle launchable ──────────────────────────────────────────────
// The npm bundle is not sealed, so this is normally a no-op. It only matters if a
// future Electron ships a sealed signature that our plist edit just invalidated.
const sealed = fs.existsSync(path.join(APP, "Contents", "_CodeSignature"));
if (sealed) {
  try {
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", APP], { stdio: "pipe" });
    info("bundle was sealed — re-signed ad-hoc");
  } catch (err) {
    console.warn(
      `[patch-electron-name] could not re-sign the bundle (${err.message}).\n` +
        "            If Electron stops launching, restore Info.plist.electron-default.",
    );
  }
}

// ── drop macOS's cached icon/name for this bundle path ─────────────────────
const now = new Date();
for (const target of [PLIST, path.join(APP, "Contents"), APP]) {
  try {
    fs.utimesSync(target, now, now);
  } catch {
    /* best effort */
  }
}

info(`done — relaunch Electron (and restart the dock if the tooltip still says "Electron")`);
