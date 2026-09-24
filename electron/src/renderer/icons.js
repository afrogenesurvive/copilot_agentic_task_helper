/**
 * Inline SVG icon set.
 *
 * Deliberately not a webfont or sprite sheet: an icon font would need its own CSP
 * entry and would flash unstyled text before it loads, which is very visible in a
 * desktop app. Every glyph is a single `<path>` so the set is also the source for
 * the macOS app icon (`scripts/make-icon.mjs` reads `PATHS.console`).
 *
 * House convention — 24x24 viewBox, `fill="none"`, `stroke="currentColor"`,
 * stroke-width 1.7, round caps and joins. Callers size via `Icons.svg(name, size)`;
 * dense rows pass 12-14, nav and headers use the 18 default.
 *
 * Exposed as `window.Icons` in the renderer and as a CommonJS export under Node,
 * so the icon generator and the UI can never drift apart.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.Icons = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /**
   * One path per name. Multiple subpaths are fine (each `M` starts a new one) —
   * that is what lets an icon like `console` be a screen *and* a prompt *and* a
   * stand without needing a second element.
   */
  const PATHS = {
    // ── navigation ──
    dashboard: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
    // Notification centre: the bell (and its clapper) — see the sidebar dot, which
    // is drawn in CSS rather than here so it can be coloured by state.
    bell: "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0",
    // An open tray: work arriving that has not been dealt with yet.
    queue: "M3 12h4l1.5 2.5h7L17 12h4M5.5 4h13l2.5 8v7H3v-7z",
    logs: "M6 3h7l5 5v13H6zM13 3v5h5M9 10h2M9 13h6M9 16h6",
    // Two figures: a collaborator plus the operator behind them.
    sessions:
      "M9.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3 20a6.5 6.5 0 0 1 13 0M16.5 4.8a3.5 3.5 0 0 1 0 6.9M17.5 14.4a6.5 6.5 0 0 1 4 5.6",
    analytics: "M4 20V10M10 20V4M16 20v-6M21 20H3",
    // A classic key: bow, shaft and two wards.
    key: "M12.4 11.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zM12.4 11.6l3.1-3.1 3 3L22 8l-3-3-3.5 3.5",
    lock: "M6 10h12v10H6zM9 10V7a3 3 0 0 1 6 0v3M12 14v2",
    // A plug: the tool manifest is a set of things you connect up.
    tools: "M9 3v4M15 3v4M6 7h12v5a6 6 0 0 1-6 6 6 6 0 0 1-6-6zM12 18v3",
    terminal: "M4 4h16v16H4zM8 9l2.5 2.5L8 14M13 14.5h4",
    chat: "M4 5h16v11H9l-5 4zM8 9h8M8 12h5",
    appearance: "M12 3a9 9 0 0 0 0 18c1.7 0 2-1.3 1.2-2.2-.8-.9-.3-2.3 1-2.3H17a4 4 0 0 0 4-4c0-5-4-9.5-9-9.5zM7.5 12a1 1 0 1 0 0-.1M11 8a1 1 0 1 0 0-.1M15.5 9.5a1 1 0 1 0 0-.1",
    info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5v.5",
    settings: "M4 7h10M18 7h2M4 17h4M12 17h8M16 4v6M8 14v6",

    // ── brand mark (also the macOS app icon glyph) ──
    // A monitor with a shell prompt on it and a stand under it.
    console: "M3 4h18v13H3zM7.5 9l2.5 2.5-2.5 2.5M12.5 14h4M9 21h6M12 17v4",

    // ── actions ──
    power: "M12 3v9M7.6 6.6a7 7 0 1 0 8.8 0",
    check: "M5 13l4 4L19 7",
    close: "M6 6l12 12M18 6L6 18",
    warning: "M12 4l9 16H3zM12 10v4M12 17v.5",
    plus: "M12 5v14M5 12h14",
    play: "M7 4l12 8-12 8z",
    stop: "M7 7h10v10H7z",
    refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6",
    search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM16 16l5 5",
    trash: "M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6",
    copy: "M9 9h11v11H9zM5 15H4V4h11v1",
    eye: "M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z",
    external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
    download: "M12 5v14M6 13l6 6 6-6",
    upload: "M12 19V5M6 11l6-6 6 6",
    print: "M7 9V3h10v6M7 18H5v-6h14v6h-2M7 14h10v7H7z",

    // ── services (Dashboard rail) ──
    // One glyph per local service. The rail collapses to icon-only, so each service
    // needs an identity that survives the label disappearing — a column of identical
    // status dots told the operator nothing about which row was which.
    // `webhook` is a request arriving at a door, `agent` a robot head (no mouth), the
    // rest are the platform each MCP server talks to.
    webhook: "M14 4h6v16h-6M4 12h9M13 12l-3.5-3.5M13 12l-3.5 3.5",
    agent: "M12 4v2M8 6h8v10H8zM10 9.5v.5M14 9.5v.5M10 13h4",
    cloud: "M7.5 18a4 4 0 0 1 .5-8 5.5 5.5 0 0 1 10.4 1.6A3.5 3.5 0 0 1 17.5 18z",
    mail: "M3 6h18v12H3zM3.5 7l8.5 6 8.5-6",
    board: "M4 5h5v11H4zM15 5h5v7h-5zM4 19h16",
    calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
    table: "M4 5h16v14H4zM4 10h16M10 10v9",
    image: "M4 5h16v14H4zM8.5 10.5a1.5 1.5 0 1 0 0-.1M4.5 16.5L9 12l5 5",

    // ── structure ──
    "chevron-right": "M9 6l6 6-6 6",
    "chevron-left": "M15 6l-6 6 6 6",
    "chevron-down": "M6 9l6 6 6-6",
    file: "M6 3h7l5 5v13H6zM13 3v5h5",
    folder: "M3 6h6l2 2h10v12H3z",
    link: "M10.5 13.5a4 4 0 0 1 0-5.7l1.4-1.4a4 4 0 0 1 5.7 5.7l-1.4 1.4M13.5 10.5a4 4 0 0 1 0 5.7l-1.4 1.4a4 4 0 0 1-5.7-5.7l1.4-1.4",
    book: "M12 7c-2-1.4-4.8-2-8-2v13c3.2 0 6 .6 8 2 2-1.4 4.8-2 8-2V5c-3.2 0-6 .6-8 2zM12 7v13",
  };

  /** Runtime list of valid names — a type cannot answer this for data-driven UI. */
  const ICON_NAMES = Object.keys(PATHS);

  const warned = new Set();

  /**
   * Render an icon as an SVG string.
   *
   * An unknown name returns an empty (but valid) `<svg>` rather than `undefined`,
   * so string concatenation at a call site can never emit the text "undefined".
   * The name is warned about once so a typo surfaces in the console without
   * flooding it from a render loop.
   */
  function svg(name, size) {
    const key = String(name ?? "");
    if (!Object.prototype.hasOwnProperty.call(PATHS, key)) {
      if (!warned.has(key)) {
        warned.add(key);
        console.warn(`[icons] unknown icon "${key}"`);
      }
      return `<svg class="icon" width="${size || 18}" height="${size || 18}" viewBox="0 0 24 24" aria-hidden="true"></svg>`;
    }
    const px = size || 18;
    return (
      `<svg class="icon" width="${px}" height="${px}" viewBox="0 0 24 24" fill="none" ` +
      `stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ` +
      `aria-hidden="true" focusable="false"><path d="${PATHS[key]}"/></svg>`
    );
  }

  /** True when `name` is a glyph this set can draw. */
  function has(name) {
    return Object.prototype.hasOwnProperty.call(PATHS, String(name ?? ""));
  }

  return { PATHS, ICON_NAMES, svg, has };
});
