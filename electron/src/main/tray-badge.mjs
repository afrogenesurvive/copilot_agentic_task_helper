/**
 * Menu-bar badge: the tray glyph with a red count beside it.
 *
 * WHY THIS EXISTS
 * ---------------
 * The tray icon is a macOS *template* image (main.js calls `setTemplateImage(true)`,
 * and electron/assets/trayTemplate.png is alpha-only). macOS paints a template
 * image black or white to match the menu bar, which is exactly what you want for
 * a mark — and exactly why a red badge cannot be drawn into it: a template image
 * has no colour to give.
 *
 * So the badged icon is an ordinary (non-template) image, rasterised here at
 * runtime with the same technique as `scripts/make-icon.mjs`: a real Chromium
 * renderer draws the SVG. The glyph path is read from the renderer's own icon set
 * (`electron/src/renderer/icons.js`), so the menu-bar mark cannot drift from the
 * app icon, and the badge red is the same `--color-red` as the in-app dots.
 *
 * Because a template image no longer does the light/dark adaptation for us, there
 * are two families: a black glyph for a light menu bar, white for a dark one.
 * main.js picks between them with `nativeTheme.shouldUseDarkColors`.
 *
 * COST CONTROL
 * ------------
 * One hidden window is created and then reused for every variant — deliberately
 * never destroyed between renders, because creating a second transparent window
 * immediately after destroying the first makes its load fail with ERR_FAILED (the
 * note in make-icon.mjs is from hitting it). Rendered images are cached per
 * variant, and the whole set is pre-warmed in the background so the first
 * notification does not wait on a window spin-up.
 */
import { BrowserWindow, nativeImage, screen } from "electron";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/** The app's own glyph set — the same source scripts/make-icon.mjs draws from. */
const GLYPH = (() => {
  try {
    return require(path.join(HERE, "..", "renderer", "icons.js")).PATHS.console;
  } catch {
    return null;
  }
})();

// ── geometry, in menu-bar points ─────────────────────────────────────────────
// The icon half is the existing 16x16 tray image, so the mark does not change
// size when a badge appears — the item just gets wider, exactly as DS-mon's
// status item does when it reserves room for its badge.
const GLYPH_BOX = 16;
const GLYPH_STROKE = 2.4; // matches make-icon.mjs's tray recipe (user units, 24x24)
const BADGE_GAP = 2;
const BADGE_HEIGHT = 11;
const BADGE_RADIUS = 5.5;
const BADGE_FONT = 8;
const BADGE_RED = "#f85149"; // --color-red: the same red as the in-app unread dots
const NARROW_PILL = 10; // "1".."9"
const WIDE_PILL = 14; // "9+"

const CACHE = new Map();
// Renders in flight, so two callers asking for the same variant — a notification
// landing while the pre-warm walks the set — share one rasterisation instead of
// racing two loads onto the same window.
const INFLIGHT = new Map();
let win = null;

/**
 * "9+" beyond a single digit: menu-bar space is scarce, and the exact number is
 * in the panel. Same cap as DS-mon's `unreadBadgeText`.
 */
export function labelFor(count) {
  const n = Math.max(0, Math.round(Number(count) || 0));
  return n > 9 ? "9+" : String(n);
}

function pillWidth(label) {
  return label === "9+" ? WIDE_PILL : NARROW_PILL;
}

/** Total width in points of the badged icon for `label`. */
function badgeWidth(label) {
  return GLYPH_BOX + BADGE_GAP + pillWidth(label);
}

/**
 * The glyph plus a red pill with the count.
 *
 * The glyph keeps the existing tray recipe verbatim: a nested 16x16 viewport over
 * the icons.js 24x24 coordinate space, so its stroke scales by 16/24 exactly as
 * it does in electron/assets/trayTemplate.png.
 */
function svgFor(label, dark) {
  const pillW = pillWidth(label);
  const width = badgeWidth(label);
  const pillX = GLYPH_BOX + BADGE_GAP;
  const pillY = (GLYPH_BOX - BADGE_HEIGHT) / 2;
  const glyphColour = dark ? "#ffffff" : "#000000";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${GLYPH_BOX}" viewBox="0 0 ${width} ${GLYPH_BOX}">
  <svg x="0" y="0" width="${GLYPH_BOX}" height="${GLYPH_BOX}" viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet">
    <path d="${GLYPH}" fill="none" stroke="${glyphColour}" stroke-width="${GLYPH_STROKE}"
          stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
  <rect x="${pillX}" y="${pillY}" width="${pillW}" height="${BADGE_HEIGHT}" rx="${BADGE_RADIUS}" fill="${BADGE_RED}"/>
  <text x="${pillX + pillW / 2}" y="${pillY + BADGE_HEIGHT / 2 + 0.5}" text-anchor="middle"
        font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="${BADGE_FONT}"
        font-weight="600" fill="#ffffff">${label}</text>
</svg>`;
}

/** Transparent page so the capture has no background of its own. */
function page(markup) {
  return (
    "<!doctype html><html><head><meta charset=\"utf-8\"><style>" +
    "html,body{margin:0;padding:0;background:transparent;overflow:hidden}" +
    "svg{display:block}" +
    `</style></head><body>${markup}</body></html>`
  );
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Serialises EVERY rasterisation, not just the ones sharing a cache key.
 *
 * `INFLIGHT` below dedupes a key that is already being drawn, but two DIFFERENT keys
 * still ran at once — prewarm()'s twenty sequential renders racing the
 * `updateTrayBadge()` for the count actually on screen. There is only one window, so
 * the second `loadURL` aborts the first (that is the ERR_ABORTED pair in the log on
 * every launch) and the loser's `capturePage()` then lands on a webContents that is
 * mid-navigation. That has segfaulted the browser process — intermittently, because
 * it depends on the timing of the grab against the abort.
 *
 * `draw` is passed as both handlers so one failed render cannot poison the chain.
 */
let renderChain = Promise.resolve();

/** The reused rasteriser window. Created on first use, never destroyed after. */
function renderWindow() {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    width: GLYPH_BOX,
    height: GLYPH_BOX,
    show: false,
    transparent: true,
    frame: false,
    useContentSize: true,
    webPreferences: { backgroundThrottling: false, offscreen: false },
  });
  return win;
}

/** The display's backing scale, so the badge is crisp on Retina and 1:1 otherwise. */
function scaleFactor() {
  try {
    return screen.getPrimaryDisplay().scaleFactor || 1;
  } catch {
    return 1;
  }
}

/**
 * Draw `markup` at `width` x `GLYPH_BOX` points and return it as a nativeImage
 * whose logical size is those points (the capture itself is at device pixels).
 * Returns null on any failure — the caller keeps the plain template icon.
 */
async function rasterize(markup, width) {
  const scale = scaleFactor();
  const w = Math.round(width * scale);
  const h = Math.round(GLYPH_BOX * scale);
  try {
    const w0 = renderWindow();
    w0.setContentSize(Math.round(width), GLYPH_BOX);
    await w0.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(page(markup)));
    await wait(60); // let the compositor settle before grabbing the frame
    const shot = await w0.webContents.capturePage();
    const size = shot.getSize();
    const final =
      size.width === w && size.height === h ? shot : shot.resize({ width: w, height: h, quality: "best" });
    const png = final.toPNG();
    if (!png || !png.length) return null;
    return nativeImage.createFromBuffer(png, { scaleFactor: scale });
  } catch (err) {
    console.log("[tray-badge] render failed:", err && err.message);
    return null;
  }
}

/**
 * The badged tray icon for `count`, or null when there is nothing to badge or the
 * render could not happen.
 *
 * @param {number} count
 * @param {{ dark?: boolean }} [opts] — menu-bar appearance to draw the glyph for
 * @returns {Promise<Electron.NativeImage|null>}
 */
export async function badgeImage(count, { dark = false } = {}) {
  if (!GLYPH) return null;
  const n = Math.max(0, Math.round(Number(count) || 0));
  if (n <= 0) return null;

  const label = labelFor(n);
  const key = `${dark ? "dark" : "light"}:${label}`;
  const cached = CACHE.get(key);
  if (cached) return cached;
  const pending = INFLIGHT.get(key);
  if (pending) return pending;

  const draw = () => rasterize(svgFor(label, dark), badgeWidth(label));
  const job = (renderChain = renderChain.then(draw, draw))
    .then((image) => {
      if (!image || image.isEmpty()) return null;
      CACHE.set(key, image);
      return image;
    })
    .finally(() => INFLIGHT.delete(key));
  INFLIGHT.set(key, job);
  return job;
}

/**
 * Render every variant in the background so the first notification is instant.
 * Sequential on purpose: it is one window, and these are ~60 ms each.
 */
export async function prewarm() {
  if (!GLYPH) return 0;
  let made = 0;
  for (const dark of [false, true]) {
    for (let n = 1; n <= 10; n += 1) {
      // 10 renders as "9+" — and so does any larger count.
      const before = CACHE.size;
      await badgeImage(n, { dark });
      if (CACHE.size > before) made += 1;
    }
  }
  return made;
}
