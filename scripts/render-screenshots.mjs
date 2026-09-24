/**
 * Dev tool: render the Electron renderer and write a PNG per tab.
 *
 * The renderer is plain HTML/CSS with no build step and no tests, so the only way
 * to catch a visual regression is to look at it. This renders the real
 * `index.html` through Chromium and captures each tab, which works even when the
 * app is not in the foreground.
 *
 * The preload is intentionally NOT attached, so every panel shows its own load
 * error instead of live data — that is fine (and useful): the shell, tokens,
 * typography, icons and every panel's chrome are all static markup.
 *
 *   cd electron && ./node_modules/.bin/electron ../scripts/render-screenshots.mjs
 *
 * Output: /tmp/frontdesk-shots/<tab>.png
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const INDEX = path.join(REPO, "electron", "src", "renderer", "index.html");
const OUT = "/tmp/frontdesk-shots";

const TABS = (process.env.SHOT_TABS || "dashboard,appearance,config,scripts,chat,licenses,about")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const LIGHT = process.env.SHOT_THEME === "light";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: LIGHT ? "#ffffff" : "#0d1117",
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });

  // Surface renderer errors in this process's stdout.
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) console.log(`  [renderer:${level === 3 ? "error" : "warn"}] ${message}`);
  });

  await win.loadFile(INDEX);
  await wait(500);

  // Force a tab + theme + font preset without the main process, so each can be
  // captured. `window.Appearance` exists because tokens.js loads before app.js.
  const selectTab = (tab, theme, font) =>
    `(() => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll("#sidebar-nav .sidebar-btn").forEach((b) => b.classList.remove("sidebar-btn--active"));
      const btn = document.querySelector('#sidebar-nav .sidebar-btn[data-tab="' + ${JSON.stringify(tab)} + '"]');
      if (btn) btn.classList.add("sidebar-btn--active");
      const section = document.getElementById("tab-" + ${JSON.stringify(tab)});
      if (section) section.classList.add("active");
      // Clear the "loading…" placeholders and the error toasts, which are only
      // there because there is no preload in this harness.
      document.querySelectorAll(".loading-block").forEach((el) => el.remove());
      const stack = document.getElementById("toast-stack");
      if (stack) stack.innerHTML = "";
      if (window.Appearance) {
        window.Appearance.applyAppearance({
          theme: ${JSON.stringify(theme)},
          accentColor: "#2f81f7",
          fontSize: ${JSON.stringify(font)},
          sidebarWidth: 260,
        });
      }
      return true;
    })()`;

  for (const tab of TABS) {
    await win.webContents.executeJavaScript(selectTab(tab, LIGHT ? "light" : "dark", "medium"));
    await wait(220);
    const image = await win.webContents.capturePage();
    const file = path.join(OUT, `${LIGHT ? "light-" : ""}${tab}.png`);
    fs.writeFileSync(file, image.toPNG());
    console.log(`  wrote ${file}`);
  }

  console.log(`\n[render-screenshots] ${TABS.length} shot(s) → ${OUT}`);
  win.destroy();
  app.exit(0);
});
