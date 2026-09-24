/**
 * Appearance: theme tokens, accent colour, font scale and sidebar width.
 *
 * Ported from the Study Aide design system. Everything is applied as CSS custom
 * properties on `<html>`, so the stylesheets never need to know about themes —
 * they just use `var(--bg)` and friends.
 *
 * IMPORTANT — this module writes tokens with `root.style.setProperty()`, i.e. the
 * CSSOM, not a `<style>` element or an inline `style` attribute. That matters:
 * `index.html` pins `style-src 'self'` with no `'unsafe-inline'`, which blocks
 * inline style *attributes* but not CSSOM writes. Do not "simplify" this into
 * markup, and do not add inline `style="…"` anywhere in the app.
 *
 * The sub-sizes across every stylesheet are in `em`, not `px`, which is exactly
 * what makes the font-scale presets rescale the whole UI — a token-based `px`
 * scale would not.
 */
(function (root) {
  "use strict";

  const FONT_SIZE_PRESETS = [
    { label: "Small", value: "small", scale: 0.85, description: "Compact view" },
    { label: "Medium", value: "medium", scale: 1.0, description: "Default size" },
    { label: "Large", value: "large", scale: 1.15, description: "Easier reading" },
    { label: "X-Large", value: "x-large", scale: 1.35, description: "Extra large" },
    { label: "XX-Large", value: "xx-large", scale: 1.6, description: "Double extra large" },
  ];

  const DEFAULT_APPEARANCE = {
    theme: "system",
    accentColor: "#2f81f7",
    fontSize: "medium",
    sidebarWidth: 260,
  };

  const MIN_SIDEBAR_WIDTH = 200;
  const MAX_SIDEBAR_WIDTH = 420;

  /** Base body font size in px at scale 1. `--fs-scale` multiplies the ROOT font
   *  size, so every `rem`/`em` in the stylesheets rescales — while the `px`
   *  paddings, radii and borders stay put. That split is deliberate: it is what
   *  makes a larger preset feel like bigger type rather than a zoomed-in window. */
  const BASE_FONT_SIZE = 16;

  /** Status colours are deliberately NOT theme-customisable — they mean the same
   *  thing in light and dark, and `--accent` must never be confused with "bad". */
  const STATUS_COLOURS = {
    "--color-red": "#f85149",
    "--color-yellow": "#d29922",
    "--color-green": "#3fb950",
  };

  const DARK = {
    bg: "#0d1117",
    surface: "#161b22",
    surfaceHover: "#1c2333",
    border: "#30363d",
    text: "#e6edf3",
    textMuted: "#8b949e",
  };

  const LIGHT = {
    bg: "#ffffff",
    surface: "#f6f8fa",
    surfaceHover: "#eaeef2",
    border: "#d0d7de",
    text: "#1f2328",
    textMuted: "#656d76",
  };

  /** The palette for whichever theme is currently effective — used by main.js's
   *  window background too, so the two can never disagree. */
  const WINDOW_BACKGROUND = { dark: DARK.bg, light: LIGHT.bg };

  // ── small helpers ────────────────────────────────────────────────────────────

  function normalizeHex(value) {
    const text = String(value ?? "").trim();
    return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toLowerCase() : null;
  }

  function clampSidebarWidth(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return DEFAULT_APPEARANCE.sidebarWidth;
    return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(numeric)));
  }

  /** Back-compat: older configs stored a pixel size rather than a preset name. */
  function numericToPreset(px) {
    if (px <= 12) return "small";
    if (px >= 22) return "xx-large";
    if (px >= 18) return "x-large";
    if (px >= 15.5) return "large";
    return "medium";
  }

  function readFontPreset(config) {
    const value = (config || {}).fontSize;
    if (typeof value === "number") return numericToPreset(value);
    const match = FONT_SIZE_PRESETS.find((preset) => preset.value === value);
    return match ? match.value : "medium";
  }

  function fontScale(preset) {
    const match = FONT_SIZE_PRESETS.find((candidate) => candidate.value === preset);
    return match ? match.scale : 1;
  }

  function prefersDark() {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
    );
  }

  function resolveTheme(setting) {
    if (setting === "dark" || setting === "light") return setting;
    return prefersDark() ? "dark" : "light";
  }

  /** Map the main process's `getAppearanceInfo()` shape onto an AppearanceConfig. */
  function appearanceFromInfo(info) {
    const source = info || {};
    return {
      theme: ["light", "dark", "system"].includes(source.theme) ? source.theme : "system",
      accentColor: source.accentColor || DEFAULT_APPEARANCE.accentColor,
      fontSize: readFontPreset(source),
      sidebarWidth: loadSidebarWidth(),
    };
  }

  // ── sidebar width (per-machine UI preference, so localStorage not config) ────

  const SIDEBAR_WIDTH_KEY = "frontdesk.sidebarWidth";

  function loadSidebarWidth() {
    try {
      const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
      return raw === null ? DEFAULT_APPEARANCE.sidebarWidth : clampSidebarWidth(raw);
    } catch {
      return DEFAULT_APPEARANCE.sidebarWidth;
    }
  }

  function saveSidebarWidth(value) {
    const width = clampSidebarWidth(value);
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
    } catch {
      /* private mode / disabled storage — the live value still applies */
    }
    return width;
  }

  // ── applying ─────────────────────────────────────────────────────────────────

  /** Apply every appearance token to the document root. */
  function applyAppearance(config) {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const settings = Object.assign({}, DEFAULT_APPEARANCE, config || {});
    const theme = resolveTheme(settings.theme);
    const palette = theme === "dark" ? DARK : LIGHT;

    root.style.setProperty("--bg", palette.bg);
    root.style.setProperty("--surface", palette.surface);
    root.style.setProperty("--surface-hover", palette.surfaceHover);
    root.style.setProperty("--border", palette.border);
    root.style.setProperty("--text", palette.text);
    root.style.setProperty("--text-muted", palette.textMuted);

    // A hook for light-only overrides. Dark is the default, so the attribute is
    // absent rather than set to "dark".
    if (theme === "light") root.setAttribute("data-theme", "light");
    else root.removeAttribute("data-theme");

    const accent = normalizeHex(settings.accentColor) || DEFAULT_APPEARANCE.accentColor;
    root.style.setProperty("--accent", accent);
    root.style.setProperty("--accent-hover", accent + "cc"); // 80% alpha
    root.style.setProperty("--accent-border", accent + "44"); // 27% alpha

    const preset = readFontPreset(settings);
    const scale = fontScale(preset);
    root.style.setProperty("--fs-scale", String(scale));
    root.dataset.fontSize = preset;

    root.style.setProperty("--sidebar-width", clampSidebarWidth(settings.sidebarWidth) + "px");

    for (const key of Object.keys(STATUS_COLOURS)) {
      root.style.setProperty(key, STATUS_COLOURS[key]);
    }

    return { theme: theme, accent: accent, fontSize: preset };
  }

  // ── live OS theme tracking ───────────────────────────────────────────────────

  let mediaQuery = null;
  let mediaListener = null;

  /** Track OS theme changes. Only meaningful while `theme === "system"`. */
  function watchSystemTheme(onChange) {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    unwatchSystemTheme();
    mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    mediaListener = function () {
      onChange();
    };
    mediaQuery.addEventListener("change", mediaListener);
  }

  function unwatchSystemTheme() {
    if (mediaQuery && mediaListener) mediaQuery.removeEventListener("change", mediaListener);
    mediaQuery = null;
    mediaListener = null;
  }

  root.Appearance = {
    FONT_SIZE_PRESETS,
    DEFAULT_APPEARANCE,
    MIN_SIDEBAR_WIDTH,
    MAX_SIDEBAR_WIDTH,
    BASE_FONT_SIZE,
    WINDOW_BACKGROUND,
    applyAppearance,
    appearanceFromInfo,
    watchSystemTheme,
    unwatchSystemTheme,
    resolveTheme,
    prefersDark,
    normalizeHex,
    clampSidebarWidth,
    readFontPreset,
    fontScale,
    loadSidebarWidth,
    saveSidebarWidth,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
