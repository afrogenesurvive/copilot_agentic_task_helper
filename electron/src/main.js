/**
 * Frontdesk Operator — Electron main process.
 *
 * A lightweight macOS control plane for the frontdesk v2 stack. It:
 *   - Spawns / monitors the webhook server, agent runner, and (optionally) the
 *     Cloudflare tunnel as child processes
 *   - Serves the renderer (local HTML — no build step) with an IPC bridge
 *   - Exposes read-only + quick-action access to the same tools the agent uses
 *     (Trello REST, Gmail via googleapis) and the shared tool manifest
 *   - Shows a system tray + native notifications when the priority queue grows
 *
 * No operator license is required. Run:  cd electron && npm start
 */
const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, nativeImage, nativeTheme } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { pathToFileURL } = require("url");
const { createRequire } = require("module");
const { connectGoogleForSeat } = require("./main/oauth");
const liveLog = require("./main/logger");

// ── Paths ──
const ROOT = app.isPackaged ? path.join(process.resourcesPath, "..", "..") : path.resolve(__dirname, "..", "..");
// In dev, electron/ is directly under the repo root; packaged, extraResources
// carry the repo pieces into resourcesPath.
const REPO = app.isPackaged ? path.join(process.resourcesPath) : ROOT;
const RENDERER_HTML = path.join(__dirname, "renderer", "index.html");

// ── .env loader (avoid a dotenv dependency) ──
function loadEnv() {
  const envFile = path.join(REPO, ".env");
  try {
    const content = fs.readFileSync(envFile, "utf8");
    for (const line of content.split("\n")) {
      const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
      if (m) process.env[m[1]] = m[2].trim();
    }
  } catch {
    /* no .env — dev-only features disabled */
  }
}
loadEnv();

let mainWindow = null; // hoisted so applyTheme() can reference it at module load

// ── Appearance / theme (APPEARANCE_THEME = light | dark | system) ──
function resolveTheme() {
  const t = (process.env.APPEARANCE_THEME || "system").toLowerCase();
  return ["light", "dark", "system"].includes(t) ? t : "system";
}
function getThemeInfo() {
  return { theme: resolveTheme(), effective: nativeTheme.shouldUseDarkColors ? "dark" : "light" };
}
function applyTheme() {
  nativeTheme.themeSource = resolveTheme();
  if (mainWindow) {
    mainWindow.setBackgroundColor(getThemeInfo().effective === "dark" ? "#12121c" : "#f6f8fa");
  }
}
function updateEnvKey(key, value) {
  const envFile = path.join(REPO, ".env");
  try {
    let content = fs.readFileSync(envFile, "utf8");
    const re = new RegExp(`^${key}=.*$`, "m");
    if (re.test(content)) content = content.replace(re, `${key}=${value}`);
    else content += (content.endsWith("\n") ? "" : "\n") + `${key}=${value}\n`;
    fs.writeFileSync(envFile, content);
    process.env[key] = value;
  } catch {
    /* best effort — theme still applies for this session */
  }
}
function setAppTheme(theme) {
  const t = ["light", "dark", "system"].includes(theme) ? theme : "system";
  updateEnvKey("APPEARANCE_THEME", t);
  applyTheme();
  return getThemeInfo();
}
applyTheme();

const WEBHOOK_PORT = parseInt(process.env.WEBHOOK_PORT || "3199", 10);
const API_TOKEN = process.env.WEBHOOK_API_TOKEN || "";

// ── Service manager ──────────────────────────────────────────────────────────
const serviceDefs = {
  webhook: { label: "Webhook server", cmd: "node", args: ["mcp/webhook-server/index.js"], cwd: REPO, port: WEBHOOK_PORT },
  runner: { label: "Agent runner", cmd: "node", args: ["mcp/agent-runner/index.js"], cwd: REPO },
  tunnel: {
    label: "Cloudflare tunnel",
    cmd: "cloudflared",
    args: process.env.CLOUDFLARE_TUNNEL_TOKEN
      ? ["tunnel", "--no-autoupdate", "run", "--token", process.env.CLOUDFLARE_TUNNEL_TOKEN]
      : process.env.CLOUDFLARE_TUNNEL_ID
        ? ["tunnel", "--no-autoupdate", "--config", path.join(REPO, "safe", "cloudflared", "config.yml"), "run", process.env.CLOUDFLARE_TUNNEL_ID]
        : [],
    cwd: REPO,
    required: !!process.env.CLOUDFLARE_TUNNEL_TOKEN || !!process.env.CLOUDFLARE_TUNNEL_ID,
  },
};

// The same MCP servers VS Code runs (same .env → same credentials). Separate
// per-seat instances can be spawned from the Accounts tab (accounts:spawnForSeat).
const MCP_NAMES = ["trello", "gmail", "drive", "calendar", "sheets", "web-search"];
for (const n of MCP_NAMES) {
  serviceDefs[`mcp:${n}`] = { label: `MCP ${n}`, cmd: "node", args: [`mcp/${n}/index.js`], cwd: REPO };
}

const running = {}; // name -> { proc, out: [] (ring buffer) }
const OUT_MAX = 500;

function startService(name, opts = {}) {
  const def = opts.def || serviceDefs[name];
  if (!def) return { ok: false, error: `unknown service ${name}` };
  if (running[name]) return { ok: true, already: true };
  if (!def.args || def.args.length === 0) return { ok: false, error: "not configured (set env vars in .env)" };

  const child = spawn(def.cmd, def.args, { cwd: def.cwd || REPO, env: opts.env ? { ...process.env, ...opts.env } : process.env });
  running[name] = { proc: child, out: [], label: def.label || name };
  const buf = running[name].out;
  const push = (chunk) => {
    const lines = chunk.toString().split("\n");
    for (const l of lines) {
      if (buf.push(l) > OUT_MAX) buf.shift();
    }
  };
  child.stdout.on("data", push);
  child.stderr.on("data", push);
  child.on("exit", (code) => {
    buf.push(`[process exited code=${code}]`);
    liveLog.addLog({ source: "electron", subSource: name, level: code === 0 ? "info" : "warn", message: `service "${name}" exited (code=${code})` });
    delete running[name];
  });
  if (liveLog.RAW_CAPTURE_SOURCES.has(name)) liveLog.captureService(name, child);
  liveLog.addLog({ source: "electron", subSource: name, level: "info", message: `started "${name}" (pid ${child.pid})` });
  console.log(`[operator] started ${name} (pid ${child.pid})`);
  return { ok: true, pid: child.pid };
}

function stopService(name) {
  const entry = running[name];
  if (!entry) return { ok: true, already: true };
  try {
    entry.proc.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  liveLog.addLog({ source: "electron", subSource: name, level: "info", message: `stopping "${name}"` });
  setTimeout(() => {
    try {
      entry.proc.kill("SIGKILL");
    } catch {
      /* fine */
    }
  }, 3000);
  delete running[name];
  return { ok: true };
}

async function serviceHealth(name) {
  const def = serviceDefs[name] || {};
  const entry = running[name];
  const isUp = !!entry && entry.proc.exitCode === null && entry.proc.signalCode === null && !entry.proc.killed;
  let port = null;
  if (isUp && def.port) {
    try {
      const res = await fetch(`http://localhost:${def.port}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) port = await res.json();
    } catch {
      port = null;
    }
  }
  return {
    name,
    label: (entry && entry.label) || def.label || name,
    configured: (def.args && def.args.length > 0) || !!entry,
    running: isUp,
    pid: entry ? entry.proc.pid : null,
    health: port,
  };
}

function serviceTail(name, lines = 40) {
  const entry = running[name];
  const out = entry ? entry.out : [];
  return out.slice(-lines);
}

// ── Webhook API client (uses the local API token) ────────────────────────────
async function webhookApi(pathname, method = "GET", body) {
  const headers = { "Content-Type": "application/json" };
  if (API_TOKEN) headers.Authorization = `Bearer ${API_TOKEN}`;
  const res = await fetch(`http://localhost:${WEBHOOK_PORT}${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

// ── Frontdesk sessions ───────────────────────────────────────────────────────
function frontdeskSessions() {
  const dir = path.join(REPO, "logs", "frontdesk", "sessions");
  const entries = [];
  if (!fs.existsSync(dir)) return entries;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  for (const f of files) {
    const lines = fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean);
    for (const l of lines) {
      try {
        entries.push(JSON.parse(l));
      } catch {
        /* skip */
      }
    }
  }
  entries.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  return entries.slice(-200);
}

// ── Licenses (structured, via the shared engine) ─────────────────────────────
async function licensesList() {
  try {
    const mod = await import(pathToFileURL(path.join(REPO, "scripts", "frontdesk-license.mjs")).href);
    const now = Date.now();
    const rows = mod.collectSeatRecords().map((r) => {
      let status = r.revoked ? "revoked" : r.exp === 0 ? "valid" : now >= r.exp * 1000 ? "expired" : "valid";
      return {
        sub: r.sub,
        kid: r.kid,
        status,
        exp: r.exp === 0 ? "unlimited" : new Date(r.exp * 1000).toISOString(),
        issuedAt: r.issuedAt,
        enc: !!r.enc,
      };
    });
    rows.sort((a, b) => String(a.sub).localeCompare(String(b.sub)));
    return { ok: true, seats: rows };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Tool access (shared manifest + quick actions) ────────────────────────────
async function toolsManifest() {
  try {
    const mod = await import(pathToFileURL(path.join(REPO, "shared", "tool-manifest.js")).href);
    return { ok: true, tools: mod.allTools };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function trelloAction(action, params = {}) {
  const key = process.env.TRELLO_KEY;
  const token = process.env.TRELLO_TOKEN;
  if (!key || !token) return { ok: false, error: "TRELLO_KEY/TRELLO_TOKEN not set" };
  const base = "https://api.trello.com/1";
  const qs = (extra = {}) => new URLSearchParams({ key, token, ...extra }).toString();

  let url, method = "GET", body;
  switch (action) {
    case "list_boards":
      url = `${base}/members/me/boards?fields=name,id,url&${qs()}`;
      break;
    case "list_lists":
      url = `${base}/boards/${params.boardId}/lists?fields=name,id&${qs()}`;
      break;
    case "list_cards":
      url = `${base}/lists/${params.listId}/cards?fields=name,id,url,due&${qs()}`;
      break;
    case "add_comment":
      url = `${base}/cards/${params.cardId}/actions/comments?${qs()}`;
      method = "POST";
      body = new URLSearchParams({ text: params.text });
      break;
    default:
      return { ok: false, error: `unknown trello action ${action}` };
  }
  try {
    const res = await fetch(url, { method, body: body ? body.toString() : undefined });
    const data = await res.json();
    return { ok: res.ok, status: res.status, result: data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function gmailAction(action, params = {}) {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    return { ok: false, error: "Gmail not connected — use the frontdesk 'Connect Google' flow first" };
  }
  try {
    const rootRequire = createRequire(path.join(REPO, "package.json"));
    const { google } = rootRequire("googleapis");
    const { OAuth2Client } = rootRequire("google-auth-library");
    const oauth = new OAuth2Client(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
    oauth.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
    const gmail = google.gmail({ version: "v1", auth: oauth });
    if (action === "list_messages") {
      const res = await gmail.users.messages.list({ userId: "me", q: params.q || "", maxResults: params.maxResults || 10 });
      return { ok: true, result: res.data.messages || [] };
    }
    if (action === "get_message") {
      const res = await gmail.users.messages.get({ userId: "me", id: params.id, format: "metadata", metadataHeaders: ["From", "To", "Subject", "Date"] });
      return { ok: true, result: res.data };
    }
    return { ok: false, error: `unknown gmail action ${action}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function googleStatus() {
  return {
    connected: !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_REFRESH_TOKEN),
    user: process.env.GMAIL_USER || null,
    consentUrl: process.env.WEBHOOK_BASE_URL ? `${process.env.WEBHOOK_BASE_URL}/oauth/google/start` : null,
  };
}

// ── Priority-queue change notifications ──────────────────────────────────────
let lastPriorityPending = null;
let notifTimer = null;

async function checkPriority() {
  try {
    const { json } = await webhookApi("/api/queue-status");
    const pending = json?.priority?.pending || 0;
    if (lastPriorityPending !== null && pending > lastPriorityPending && pending > 0) {
      const n = new Notification({
        title: "Frontdesk — new priority item",
        body: `${pending} item(s) now pending in the priority queue.`,
      });
      n.on("click", () => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
          win.show();
          win.focus();
        }
      });
      n.show();
    }
    lastPriorityPending = pending;
  } catch {
    /* server not up — ignore */
  }
}

function startPriorityWatch() {
  if (notifTimer) clearInterval(notifTimer);
  notifTimer = setInterval(checkPriority, 15000);
}

// ── IPC ──────────────────────────────────────────────────────────────────────
function registerIpc() {
  ipcMain.handle("svc:list", () => Promise.all(Object.keys(serviceDefs).map(serviceHealth)));
  ipcMain.handle("svc:start", (_e, name) => startService(name));
  ipcMain.handle("svc:stop", (_e, name) => stopService(name));
  ipcMain.handle("svc:log", (_e, name, lines) => serviceTail(name, lines));

  ipcMain.handle("health", async () => {
    try {
      const res = await fetch(`http://localhost:${WEBHOOK_PORT}/health`, { signal: AbortSignal.timeout(2000) });
      return { ok: res.ok, json: await res.json() };
    } catch {
      return { ok: false };
    }
  });
  ipcMain.handle("queue:get", async () => {
    try {
      return await webhookApi("/api/queue-status");
    } catch {
      return { status: 0, json: { error: "webhook server not reachable" } };
    }
  });
  ipcMain.handle("events:clear", (_e, id, queue) => webhookApi(`/events/${id}?queue=${queue}`, "PATCH"));
  ipcMain.handle("logs:tool", (_e, lines) => webhookApi(`/tool-logs?lines=${lines || 40}`));
  ipcMain.handle("logs:get", (_e, filters) => liveLog.query(filters || {}));
  ipcMain.handle("logs:files", () => liveLog.listLogFiles(path.join(REPO, "logs")));
  ipcMain.handle("logs:file", (_e, filePath, maxLines) => {
    const logsDir = path.join(REPO, "logs");
    const resolved = path.resolve(filePath || "");
    if (!resolved.startsWith(logsDir)) return { ok: false, error: "path outside logs/" };
    return { ok: true, lines: liveLog.readLogFile(resolved, maxLines || 0) };
  });
  ipcMain.handle("logs:clear", () => {
    liveLog.clear();
    return { ok: true };
  });
  ipcMain.handle("frontdesk:sessions", () => ({ ok: true, entries: frontdeskSessions() }));

  ipcMain.handle("licenses:list", () => licensesList());
  ipcMain.handle("config:get", () => ({
    webhookBaseUrl: process.env.WEBHOOK_BASE_URL || `http://localhost:${WEBHOOK_PORT}`,
    agentPub: process.env.FRONTDESK_AGENT_PUBKEY || "",
    corsOrigins: process.env.CORS_ORIGINS || "",
    tunnelDomain: process.env.CLOUDFLARE_TUNNEL_DOMAIN || "",
    useTrello: process.env.FRONTDESK_USE_TRELLO === "true",
    logToTrello: process.env.FRONTDESK_LOG_TO_TRELLO === "true",
  }));

  ipcMain.handle("tools:manifest", () => toolsManifest());
  ipcMain.handle("tools:trello", (_e, action, params) => trelloAction(action, params));
  ipcMain.handle("tools:gmail", (_e, action, params) => gmailAction(action, params));
  ipcMain.handle("google:status", () => googleStatus());

  ipcMain.handle("accounts:list", async () => {
    try {
      const acc = await accountsApi();
      const rows = acc.listAccounts();
      const lic = await licensesList();
      const subs = new Set(rows.map((r) => r.sub));
      for (const s of lic.ok ? lic.seats : []) {
        if (!subs.has(s.sub)) rows.push({ sub: s.sub, googleConnected: false, googleUser: null, trelloConfigured: false });
      }
      rows.sort((a, b) => a.sub.localeCompare(b.sub));
      return { ok: true, rows };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle("accounts:connectGoogle", (_e, sub) => connectGoogleForSeat(REPO, sub));
  ipcMain.handle("accounts:setTrello", async (_e, sub, key, token) => {
    try {
      const acc = await accountsApi();
      acc.setSeatTrello(sub, { key, token });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle("accounts:clear", async (_e, sub) => {
    try {
      const acc = await accountsApi();
      acc.clearSeat(sub);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle("accounts:spawnForSeat", (_e, sub) => spawnMcpForSeat(sub));
  ipcMain.handle("accounts:stopForSeat", (_e, sub) => {
    stopService(`mcp:gmail:${sub}`);
    stopService(`mcp:trello:${sub}`);
    return { ok: true };
  });

  ipcMain.handle("open:external", (_e, url) => {
    const { shell } = require("electron");
    if (url) shell.openExternal(url);
  });
  ipcMain.handle("app:getTheme", () => getThemeInfo());
  ipcMain.handle("app:setTheme", (_e, theme) => setAppTheme(theme));
  ipcMain.handle("app:quit", () => {
    app.quit();
    return { ok: true };
  });
}

// ── Window + tray ────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    title: "Frontdesk Operator",
    backgroundColor: getThemeInfo().effective === "dark" ? "#12121c" : "#f6f8fa",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(RENDERER_HTML);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function createTray() {
  try {
    const icon = nativeImage.createFromDataURL(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    );
    const tray = new Tray(icon);
    tray.setToolTip("Frontdesk Operator");
    const menu = Menu.buildFromTemplate([
      { label: "Open dashboard", click: () => mainWindow && mainWindow.show() },
      { type: "separator" },
      { label: "Start webhook server", click: () => startService("webhook") },
      { label: "Start agent runner", click: () => startService("runner") },
      { type: "separator" },
      { label: "Quit", click: () => { stopService("webhook"); stopService("runner"); stopService("tunnel"); app.quit(); } },
    ]);
    tray.setContextMenu(menu);
  } catch (err) {
    console.log("[operator] tray unavailable:", err.message);
  }
}

// ── Lifecycle ────────────────────────────────────────────────────────────────
async function accountsApi() {
  return import(pathToFileURL(path.join(REPO, "scripts", "frontdesk-accounts.mjs")).href);
}

async function spawnMcpForSeat(sub) {
  const acc = await accountsApi();
  const seat = acc.getSeatAccounts(sub);
  const spawned = [];
  if (seat.google && seat.google.refreshToken) {
    const r = startService(`mcp:gmail:${sub}`, {
      def: { label: `MCP gmail (${sub})`, cmd: "node", args: ["mcp/gmail/index.js"], cwd: REPO },
      env: {
        GMAIL_REFRESH_TOKEN: seat.google.refreshToken,
        GMAIL_USER: seat.google.user || process.env.GMAIL_USER,
        GMAIL_CLIENT_ID: seat.google.clientId || process.env.GMAIL_CLIENT_ID,
        GMAIL_CLIENT_SECRET: seat.google.clientSecret || process.env.GMAIL_CLIENT_SECRET,
      },
    });
    spawned.push({ name: `mcp:gmail:${sub}`, ...r });
  }
  if (seat.trello && seat.trello.key && seat.trello.token) {
    const r = startService(`mcp:trello:${sub}`, {
      def: { label: `MCP trello (${sub})`, cmd: "node", args: ["mcp/trello/index.js"], cwd: REPO },
      env: { TRELLO_KEY: seat.trello.key, TRELLO_TOKEN: seat.trello.token },
    });
    spawned.push({ name: `mcp:trello:${sub}`, ...r });
  }
  return { ok: true, spawned };
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  createTray();
  startPriorityWatch();

  // Live log: seed from the unified stream, tail it, and push to the renderer.
  const LOGS_DIR = path.join(REPO, "logs");
  liveLog.seedFromLive(LOGS_DIR);
  setInterval(() => {
    try {
      liveLog.tailLive(LOGS_DIR);
    } catch (err) {
      console.error("[live-tail] tailLive failed:", err);
    }
  }, 2000);
  liveLog.subscribe((entry) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.send("logs:entry", entry);
      } catch {
        /* renderer may be mid-navigation */
      }
    }
  });

  // Autostart the whole stack: webhook + runner + all MCP servers (+ tunnel if configured).
  if (process.env.OPERATOR_AUTOSTART !== "false") {
    const auto = ["webhook", "runner", ...MCP_NAMES.map((n) => `mcp:${n}`)];
    if (serviceDefs.tunnel.args.length > 0) auto.push("tunnel");
    for (const n of auto) startService(n);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // Keep running in the tray/background — the operator dashboard monitors services.
  // Quit from the tray menu or Cmd+Q.
});

app.on("before-quit", () => {
  for (const name of Object.keys(running)) stopService(name);
  if (notifTimer) clearInterval(notifTimer);
});
