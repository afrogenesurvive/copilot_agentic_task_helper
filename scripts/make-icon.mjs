/**
 * Generate the macOS app icon + tray template images.
 *
 * MUST be run under Electron, not Node — it rasterises SVG with a real Chromium
 * renderer:
 *
 *   node_modules/.bin/electron scripts/make-icon.mjs      # from electron/
 *   npm --prefix electron run make:icon                   # from the repo root
 *
 * One glyph is read straight out of `electron/src/renderer/icons.js`, so the app
 * icon can never drift from the UI's own icon set. Everything else (plate, corner
 * radius, glyph scale, colours) is derived from the design tokens in
 * `electron/src/renderer/tokens.js`.
 *
 * Output (electron/assets/, deliberately NOT electron/build/ — the repo's
 * .gitignore has an unanchored `build/` rule that would swallow it):
 *   icon.png              1024x1024  dock / Finder / electron-builder source
 *   icon.icns                        derived with sips + iconutil
 *   trayTemplate.png      16x16      alpha-only menu-bar template image
 *   trayTemplate@2x.png   32x32
 */
import { app, BrowserWindow, nativeImage, screen } from "electron";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const ELECTRON_DIR = path.join(REPO, "electron");
const OUT_DIR = path.join(ELECTRON_DIR, "assets");
const require = createRequire(import.meta.url);

// ── the glyph ────────────────────────────────────────────────────────────────
// Default is the brand mark: a monitor with a shell prompt on it.
const GLYPH_NAME = (process.env.ICON_GLYPH || "").trim() || "console";

const { PATHS } = require(path.join(ELECTRON_DIR, "src", "renderer", "icons.js"));
const GLYPH = PATHS[GLYPH_NAME];

if (!GLYPH) {
  console.error(
    `[make-icon] no such glyph "${GLYPH_NAME}" in electron/src/renderer/icons.js.\n` +
      `            available: ${Object.keys(PATHS).join(", ")}`,
  );
  process.exit(1);
}

// ── the recipe ───────────────────────────────────────────────────────────────
// macOS app icons are a rounded "squircle" plate inset from a square canvas.
const CANVAS = 1024;
const INSET_RATIO = 0.06; // plate inset from the canvas edge
const RADIUS_RATIO = 0.225; // macOS squircle corner radius, as a fraction of the plate
const GLYPH_RATIO = 0.46; // glyph size, as a fraction of the canvas
const GLYPH_STROKE = 1.7; // matches the icon set's stroke-width at 24x24

// Tray icons are smaller, so the glyph needs a proportionally heavier stroke to
// stay legible at 16px, and macOS template images must be alpha-only (black).
const TRAY_TARGETS = [
  { file: "trayTemplate.png", px: 16, stroke: 2.4 },
  { file: "trayTemplate@2x.png", px: 32, stroke: 2.2 },
];

// ── colours (kept in sync with tokens.js by hand — see the comment there) ────
const PLATE_TOP = "#161b22"; // --surface
const PLATE_BOTTOM = "#0d1117"; // --bg
const PLATE_EDGE = "#30363d"; // --border
const GLYPH_COLOUR = "#2f81f7"; // default --accent

/** The rounded plate with the glyph centred on it. */
function appIconSvg() {
  const inset = Math.round(CANVAS * INSET_RATIO);
  const plate = CANVAS - inset * 2;
  const radius = Math.round(plate * RADIUS_RATIO);
  const glyphPx = Math.round(CANVAS * GLYPH_RATIO);
  const offset = (CANVAS - glyphPx) / 2;
  const scale = glyphPx / 24;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}">
  <defs>
    <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${PLATE_TOP}"/>
      <stop offset="1" stop-color="${PLATE_BOTTOM}"/>
    </linearGradient>
  </defs>
  <rect x="${inset}" y="${inset}" width="${plate}" height="${plate}" rx="${radius}" ry="${radius}"
        fill="url(#plate)" stroke="${PLATE_EDGE}" stroke-width="4"/>
  <path d="${GLYPH}" transform="translate(${offset} ${offset}) scale(${scale})"
        fill="none" stroke="${GLYPH_COLOUR}" stroke-width="${GLYPH_STROKE}"
        stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}

/** The bare glyph, for macOS menu-bar template images (alpha only). */
function traySvg(stroke) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <path d="${GLYPH}" fill="none" stroke="#000000" stroke-width="${stroke}"
        stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}

function page(svg) {
  return (
    "<!doctype html><html><head><meta charset=\"utf-8\"><style>" +
    "html,body{margin:0;padding:0;background:transparent;overflow:hidden}" +
    "svg{display:block;width:100vw;height:100vh}" +
    `</style></head><body>${svg}</body></html>`
  );
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Rasterise `svg` to exactly `px` x `px` and return the PNG buffer.
 *
 * One hidden window is reused for every size on purpose: creating a second
 * transparent window immediately after destroying the first makes its load fail
 * with ERR_FAILED.
 */
async function renderToPng(win, svg, px, scaleFactor) {
  // Ask for a CSS-pixel size that captures to exactly `px` device pixels.
  const cssSize = Math.max(1, Math.round(px / scaleFactor));
  win.setContentSize(cssSize, cssSize);

  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(page(svg)));
  await wait(60); // let the compositor settle before grabbing the frame

  const image = await win.webContents.capturePage();
  const size = image.getSize();

  // The device scale factor is not always what the display claims, so normalise
  // rather than trusting the arithmetic above.
  const final =
    size.width === px && size.height === px
      ? image
      : image.resize({ width: px, height: px, quality: "best" });

  const png = final.toPNG();
  if (!png || png.length === 0) throw new Error(`capture produced no PNG for ${px}px`);
  return png;
}

function run(cmd, args) {
  return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }).toString();
}

/** Build icon.icns from the 1024px master with the macOS toolchain. */
function buildIcns(masterPng, outFile) {
  const iconset = path.join(OUT_DIR, "icon.iconset");
  fs.rmSync(iconset, { recursive: true, force: true });
  fs.mkdirSync(iconset, { recursive: true });

  // iconutil requires this exact set of names — the @2x variants are the next
  // size up, which is why 1024px appears as 512x512@2x.
  const variants = [
    [16, "icon_16x16.png"],
    [32, "icon_16x16@2x.png"],
    [32, "icon_32x32.png"],
    [64, "icon_32x32@2x.png"],
    [128, "icon_128x128.png"],
    [256, "icon_128x128@2x.png"],
    [256, "icon_256x256.png"],
    [512, "icon_256x256@2x.png"],
    [512, "icon_512x512.png"],
    [1024, "icon_512x512@2x.png"],
  ];

  for (const [size, name] of variants) {
    const target = path.join(iconset, name);
    if (size === 1024) {
      fs.copyFileSync(masterPng, target);
    } else {
      // sips needs a file to work from; copy the master next to the target first.
      fs.copyFileSync(masterPng, target);
      run("sips", ["-z", String(size), String(size), target]);
    }
  }

  run("iconutil", ["-c", "icns", iconset, "-o", outFile]);
  fs.rmSync(iconset, { recursive: true, force: true });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const scaleFactor = screen.getPrimaryDisplay().scaleFactor || 1;
  const win = new BrowserWindow({
    width: 64,
    height: 64,
    show: false,
    transparent: true,
    frame: false,
    useContentSize: true,
    webPreferences: { backgroundThrottling: false, offscreen: false },
  });

  const written = [];

  try {
    // 1. the app icon master
    const iconPng = await renderToPng(win, appIconSvg(), CANVAS, scaleFactor);
    const iconPath = path.join(OUT_DIR, "icon.png");
    fs.writeFileSync(iconPath, iconPng);
    written.push([iconPath, `${CANVAS}x${CANVAS}`, iconPng.length]);

    // 2. tray template images (alpha-only)
    for (const target of TRAY_TARGETS) {
      const png = await renderToPng(win, traySvg(target.stroke), target.px, scaleFactor);
      const file = path.join(OUT_DIR, target.file);
      fs.writeFileSync(file, png);
      written.push([file, `${target.px}x${target.px}`, png.length]);
    }
  } finally {
    win.destroy();
  }

  // 3. the .icns (macOS only — sips and iconutil do not exist elsewhere)
  const icnsPath = path.join(OUT_DIR, "icon.icns");
  if (process.platform === "darwin") {
    buildIcns(path.join(OUT_DIR, "icon.png"), icnsPath);
    written.push([icnsPath, "icns", fs.statSync(icnsPath).size]);
  } else {
    console.warn("[make-icon] skipping icon.icns — sips/iconutil are macOS only");
  }

  console.log(`[make-icon] glyph "${GLYPH_NAME}" → ${OUT_DIR}`);
  for (const [file, size, bytes] of written) {
    console.log(`  ${path.basename(file).padEnd(20)} ${size.padEnd(10)} ${bytes} bytes`);
  }
}

app.whenReady().then(async () => {
  try {
    await main();
    app.exit(0);
  } catch (err) {
    console.error("[make-icon] failed:", err && err.message ? err.message : err);
    app.exit(1);
  }
});
