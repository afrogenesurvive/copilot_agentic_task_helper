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
const { app, BrowserWindow, dialog, Tray, Menu, Notification, ipcMain, nativeImage, nativeTheme } = require("electron");
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

// ── Docs (About → Guide) — markdown end-user guides under <repo>/electron/docs ──
const DOCS_DIR = path.join(REPO, "electron", "docs");

function docTitle(file) {
  const base = String(file || "")
    .replace(/\.md$/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
  return base ? base.replace(/\b\w/g, (c) => c.toUpperCase()) : file;
}

function docsList() {
  if (!fs.existsSync(DOCS_DIR)) return { ok: true, files: [] };
  let names;
  try {
    names = fs.readdirSync(DOCS_DIR);
  } catch {
    return { ok: true, files: [] };
  }
  const files = names
    .filter((n) => n.toLowerCase().endsWith(".md"))
    .sort()
    .map((file) => ({ file, title: docTitle(file) }));
  return { ok: true, files };
}

function readDoc(file) {
  const name = String(file || "");
  const resolved = path.resolve(DOCS_DIR, name);
  if (name.includes("..") || !resolved.startsWith(DOCS_DIR)) {
    return { ok: false, error: "invalid doc name" };
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return { ok: false, error: "no such doc" };
  }
  try {
    return { ok: true, content: fs.readFileSync(resolved, "utf8") };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Config loader (config.json first, .env fallback) ──
const config = require("../../shared/config-loader.cjs");
config.loadEnvInto(process.env);

let mainWindow = null; // hoisted so applyTheme() can reference it at module load

// ── Appearance / theme (APPEARANCE_THEME = light | dark | system)
//    + accent color (APPEARANCE_ACCENT_COLOR) + font size (APPEARANCE_FONT_SIZE) ──
function resolveTheme() {
  const t = (process.env.APPEARANCE_THEME || "system").toLowerCase();
  return ["light", "dark", "system"].includes(t) ? t : "system";
}
function getThemeInfo() {
  return { theme: resolveTheme(), effective: nativeTheme.shouldUseDarkColors ? "dark" : "light" };
}

const FONT_SIZES = ["small", "medium", "large", "x-large", "xx-large"];
const ACCENT_RE = /^#[0-9a-fA-F]{6}$/;
/** Accent override — "" means "use the theme's built-in accent". */
function getAccentColor() {
  const v = (process.env.APPEARANCE_ACCENT_COLOR || "").trim();
  return ACCENT_RE.test(v) ? v : "";
}
function getFontSize() {
  const v = (process.env.APPEARANCE_FONT_SIZE || "medium").toLowerCase();
  return FONT_SIZES.includes(v) ? v : "medium";
}
/** Theme + accent + font size — what the renderer's Appearance tab needs. */
function getAppearanceInfo() {
  return { ...getThemeInfo(), accentColor: getAccentColor(), fontSize: getFontSize() };
}

function applyTheme() {
  nativeTheme.themeSource = resolveTheme();
  if (mainWindow) {
    mainWindow.setBackgroundColor(getThemeInfo().effective === "dark" ? "#12121c" : "#f6f8fa");
  }
}
function updateEnvKey(key, value) {
  config.setKey(key, value); // writes to config.json (primary) or .env (fallback)
  process.env[key] = value;
}
/** Apply + persist any subset of {theme, accentColor, fontSize}. */
function setAppearance(patch = {}) {
  if (patch.theme !== undefined) {
    const t = ["light", "dark", "system"].includes(patch.theme) ? patch.theme : "system";
    updateEnvKey("APPEARANCE_THEME", t);
  }
  if (patch.accentColor !== undefined) {
    const a = String(patch.accentColor || "").trim();
    updateEnvKey("APPEARANCE_ACCENT_COLOR", ACCENT_RE.test(a) ? a : "");
  }
  if (patch.fontSize !== undefined) {
    const f = String(patch.fontSize || "").toLowerCase();
    updateEnvKey("APPEARANCE_FONT_SIZE", FONT_SIZES.includes(f) ? f : "medium");
  }
  applyTheme();
  return getAppearanceInfo();
}
function setAppTheme(theme) {
  return setAppearance({ theme });
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
const MCP_NAMES = ["trello", "gmail", "drive", "calendar", "photos", "sheets", "web-search", "whatsapp"];
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

  const child = spawn(def.cmd, def.args, {
    cwd: def.cwd || REPO,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    // Own process group per service so a quit/stop can kill the whole tree (negative pid).
    detached: process.platform !== "win32",
  });
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

// Signal a process AND its whole tree. Children are spawned detached (own
// process group on macOS/Linux), so a negative pid hits every descendant.
function signalTree(proc, sig) {
  if (!proc || typeof proc.pid !== "number") return;
  if (process.platform !== "win32") {
    try {
      process.kill(-proc.pid, sig);
      return;
    } catch {
      /* not a group leader / already gone — fall through to direct kill */
    }
  }
  try {
    proc.kill(sig);
  } catch {
    /* already gone */
  }
}

function stopService(name) {
  const entry = running[name];
  if (!entry) return { ok: true, already: true };
  liveLog.addLog({ source: "electron", subSource: name, level: "info", message: `stopping "${name}"` });
  signalTree(entry.proc, "SIGTERM");
  setTimeout(() => signalTree(entry.proc, "SIGKILL"), 3000);
  delete running[name];
  return { ok: true };
}

async function serviceHealth(name) {
  const def = serviceDefs[name] || {};
  const entry = running[name];
  // "managed" = Electron spawned this process and it's still alive.
  const managed = !!entry && entry.proc.exitCode === null && entry.proc.signalCode === null && !entry.proc.killed;
  // Live /health probe on the service port. Also detects services that are up
  // but were started OUTSIDE the dashboard (e.g. webhook launched via nohup) —
  // they report running:true with managed:false so Start/Restart/Stop stay disabled.
  let health = null;
  if (def.port) {
    try {
      const res = await fetch(`http://localhost:${def.port}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) health = await res.json();
    } catch {
      health = null;
    }
  }
  const isUp = managed || (def.port != null && health !== null);
  const external = isUp && !managed;
  return {
    name,
    label: (entry && entry.label) || def.label || name,
    configured: (def.args && def.args.length > 0) || !!entry,
    running: isUp,
    managed,
    external,
    pid: managed ? entry.proc.pid : null,
    health,
  };
}

function serviceTail(name, lines = 40) {
  const entry = running[name];
  const out = entry ? entry.out : [];
  return out.slice(-lines);
}

// ── User-script runner (scripts/user allowlist) ──────────────────────────────
// Runs executables found under <repo>/scripts/user/ (bash/node/python3 by
// extension, or direct exec for files with the executable bit). Manual only —
// a human clicks Run in the renderer; no agent/LLM path triggers these.
const SCRIPT_ROOT = path.join(REPO, "scripts", "user");
const SCRIPT_RUNNERS = {
  ".sh": ["bash"],
  ".command": ["bash"],
  ".bash": ["bash"],
  ".mjs": ["node"],
  ".js": ["node"],
  ".cjs": ["node"],
  ".py": ["python3"],
};
const scriptRuns = {}; // runId -> { runId, script, proc, out: [], startedAt }
const RUN_OUT_MAX = 1000;

function isInsideScriptsUser(p) {
  const rel = path.relative(SCRIPT_ROOT, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// Pull a one-line usage summary from the file header comment (shebang skipped).
function readScriptUsage(file) {
  try {
    const src = fs.readFileSync(file, "utf8");
    const lines = src.split("\n");
    let i = lines[0] && lines[0].startsWith("#!") ? 1 : 0;
    const out = [];
    for (; i < lines.length && i < 24; i++) {
      const t = lines[i].replace(/^\s*#+\s?/, "").trim();
      if (!t) break; // stop at first blank or non-comment line
      out.push(t);
    }
    const joined = out.join(" ").trim();
    return joined.length > 260 ? joined.slice(0, 260) + "…" : joined;
  } catch {
    return "";
  }
}

// Load a script's UI manifest from a sidecar JSON placed next to the script
// (<script>.params.json in the same folder). Drives the Scripts-tab form:
// typed fields whose values get assembled into argv in buildArgv(). The .json
// sidecars are never listed as runnable scripts (no runner for .json).
function readScriptManifest(full) {
  try {
    const raw = fs.readFileSync(full + ".params.json", "utf8");
    const m = JSON.parse(raw);
    if (!m || typeof m !== "object") return null;
    return {
      params: Array.isArray(m.params) ? m.params : [],
      positionals: Array.isArray(m.positionals) ? m.positionals : [],
    };
  } catch {
    return null;
  }
}

function manifestValue(values, key) {
  const v = values ? values[key] : undefined;
  return v === undefined || v === null ? "" : String(v).trim();
}

// Required-field check against form values; returns an error string or null.
function validateForm(manifest, values) {
  const errors = [];
  const check = (p) => {
    if (!p || typeof p !== "object" || !p.key || !p.required) return;
    const filled =
      p.type === "flag"
        ? values[p.key] === true || values[p.key] === "true" || values[p.key] === "on"
        : manifestValue(values, p.key) !== "";
    if (!filled) errors.push(`"${p.label || p.key}" is required`);
  };
  for (const p of manifest.positionals || []) check(p);
  for (const p of manifest.params || []) check(p);
  return errors.length ? errors.join("; ") : null;
}

// Convert form values (+ optional raw extra-args text) into an argv array using
// the manifest. Order: positionals first, then named params (each sorted by the
// optional numeric `position`), then any raw extra args appended verbatim.
function buildArgv(manifest, values, extraText) {
  const val = values && typeof values === "object" ? values : {};
  const argv = [];
  const pushParam = (p) => {
    if (!p || typeof p !== "object" || !p.key) return;
    if (p.type === "flag") {
      const on = val[p.key] === true || val[p.key] === "true" || val[p.key] === "on" || val[p.key] === 1;
      if (!on) return;
      if (p.arg) argv.push(p.arg);
      if (p.optionalValue) {
        const vv = manifestValue(val, p.key + ":value");
        if (vv) argv.push(vv);
      }
      return;
    }
    const v = manifestValue(val, p.key);
    if (v === "") return;
    if (p.arg) argv.push(p.arg);
    argv.push(v);
  };
  const order = (a, b) => {
    const pa = typeof a.position === "number" ? a.position : 0;
    const pb = typeof b.position === "number" ? b.position : 0;
    return pa - pb;
  };
  for (const p of (manifest.positionals || []).slice().sort(order)) pushParam(p);
  for (const p of (manifest.params || []).slice().sort(order)) pushParam(p);
  argv.push(...parseArgs(extraText));
  return argv;
}

function scanUserScripts() {
  if (!fs.existsSync(SCRIPT_ROOT)) return [];
  // Scripts may live directly under scripts/user/ or (private/local-only) under
  // scripts/user/safe/ — list both so references resolve whichever exists.
  const safeDir = path.join(SCRIPT_ROOT, "safe");
  const dirs = [SCRIPT_ROOT];
  if (fs.existsSync(safeDir)) dirs.push(safeDir);
  const scripts = [];
  for (const dir of dirs) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const prefix = dir === safeDir ? "safe/" : "";
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const full = path.join(dir, name);
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const ext = path.extname(name).toLowerCase();
      let runner = SCRIPT_RUNNERS[ext] || null;
      if (!runner && st.mode & 0o111) runner = [full]; // executable-bit fallback
      if (!runner) continue; // only runnable files become cards (skips *.params.json sidecars)
      scripts.push({
        name: prefix + name,
        ext: ext || "(none)",
        runner: runner[0],
        size: st.size,
        usage: readScriptUsage(full),
        manifest: readScriptManifest(full),
      });
    }
  }
  return scripts.sort((a, b) => a.name.localeCompare(b.name));
}

function activeRuns() {
  return Object.values(scriptRuns).map((r) => ({
    runId: r.runId,
    script: r.script,
    pid: r.proc.pid,
    startedAt: r.startedAt,
  }));
}

function sendScripts(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      w.webContents.send(channel, payload);
    } catch {
      /* window gone */
    }
  }
}

async function probeTools() {
  const exists = (cmd) =>
    new Promise((res) => {
      try {
        const p = spawn("which", [cmd], { stdio: "ignore" });
        p.on("error", () => res(false));
        p.on("exit", (c) => res(c === 0));
      } catch {
        res(false);
      }
    });
  const [awsB, nodeB, pyB] = await Promise.all([exists("aws"), exists("node"), exists("python3")]);
  let awsVersion = "";
  if (awsB) {
    try {
      const v = await new Promise((res) => {
        const p = spawn("aws", ["--version"]);
        let s = "";
        p.stdout.on("data", (d) => (s += d));
        p.stderr.on("data", (d) => (s += d));
        p.on("close", () => res(s.trim()));
        p.on("error", () => res(""));
      });
      awsVersion = v.replace(/^aws-cli\//, "").split(" ")[0] || v;
    } catch {
      /* ignore */
    }
  }
  return {
    aws: awsB,
    awsVersion,
    node: nodeB,
    python3: pyB,
    awsCreds: !!(process.env.AWS_ACCESS_KEY_ID || process.env.AWS_SECRET_ACCESS_KEY),
    awsProfile: process.env.AWS_PROFILE || "",
    awsRegion: process.env.AWS_DEFAULT_REGION || process.env.AWS_REGION || "",
  };
}

// Accepts a JSON array string (["--dry-run", "-i", "i-0abc"]) or a plain
// whitespace/quoted list; returns a string array.
function parseArgs(text) {
  const s = String(text || "").trim();
  if (!s) return [];
  try {
    const j = JSON.parse(s);
    if (Array.isArray(j)) return j.map(String);
  } catch {
    /* not JSON — fall through */
  }
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  const out = [];
  let m;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// Run a script. `payload` is either:
//   - the legacy string of raw args (JSON array or whitespace-separated), or
//   - an object { values: {key: v}, extra: "raw text" } produced by the Scripts
//     tab form (manifest-driven). argv is built HERE from the manifest so the
//     renderer never hand-assembles shell tokens.
function runUserScript(scriptName, payload) {
  const name = String(scriptName || "");
  const full = path.join(SCRIPT_ROOT, name);
  if (!isInsideScriptsUser(full)) return { ok: false, error: "script must live under scripts/user/" };
  if (!fs.existsSync(full) || !fs.statSync(full).isFile())
    return { ok: false, error: `no such script: ${name}` };
  if (Object.values(scriptRuns).some((r) => r.script === name))
    return { ok: false, error: `"${name}" is already running` };

  const ext = path.extname(full).toLowerCase();
  let runner = SCRIPT_RUNNERS[ext] || null;
  if (!runner && fs.statSync(full).mode & 0o111) runner = [full];
  if (!runner)
    return {
      ok: false,
      error: `no runner for .${ext || "unknown"} (supported: .sh .command .mjs .js .py, or an executable file)`,
    };

  let args;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    // Form-driven: { values, extra }. The manifest must exist; required fields
    // are enforced here (the renderer only gives fast client-side feedback).
    const manifest = readScriptManifest(full);
    if (!manifest)
      return { ok: false, error: `no UI manifest (${path.basename(full)}.params.json) for this script` };
    const problem = validateForm(manifest, payload.values);
    if (problem) return { ok: false, error: problem };
    args = buildArgv(manifest, payload.values, payload.extra);
  } else {
    args = parseArgs(payload); // legacy raw text
  }
  const runId = `run-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
  const child = spawn(runner[0], [...runner.slice(1), full, ...args], {
    cwd: REPO,
    env: process.env,
    // Own process group so quitting can kill the script AND the commands it ran.
    detached: process.platform !== "win32",
  });
  const rec = { runId, script: name, proc: child, out: [], startedAt: new Date().toISOString() };
  scriptRuns[runId] = rec;

  const push = (chunk) => {
    const text = chunk.toString();
    const lines = text.split("\n").filter((l) => l.length);
    if (rec.out.push(...lines) > RUN_OUT_MAX) rec.out.splice(0, rec.out.length - RUN_OUT_MAX);
    if (lines.length) sendScripts("scripts:output", { runId, script: name, text: lines.join("\n") + "\n" });
  };
  child.stdout.on("data", push);
  child.stderr.on("data", push);
  child.on("error", (err) => {
    const msg = `[spawn error: ${err.message}]`;
    rec.out.push(msg);
    sendScripts("scripts:output", { runId, script: name, text: msg + "\n" });
  });
  child.on("exit", (code) => {
    const msg = `[exit code=${code}]`;
    rec.out.push(msg);
    sendScripts("scripts:output", { runId, script: name, text: msg + "\n" });
    delete scriptRuns[runId];
    liveLog.addLog({
      source: "electron",
      subSource: "scripts",
      level: code === 0 ? "info" : "warn",
      message: `script "${name}" exited (code=${code})`,
    });
    sendScripts("scripts:update", { runs: activeRuns() });
  });
  liveLog.addLog({
    source: "electron",
    subSource: "scripts",
    level: "info",
    message: `started script "${name}" (pid ${child.pid})`,
  });
  sendScripts("scripts:update", { runs: activeRuns() });
  return { ok: true, runId, pid: child.pid };
}

function stopUserScript(target) {
  const rec = Object.values(scriptRuns).find((r) => r.runId === target || r.script === target);
  if (!rec) return { ok: true, already: true };
  signalTree(rec.proc, "SIGTERM");
  setTimeout(() => signalTree(rec.proc, "SIGKILL"), 3000);
  return { ok: true };
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

// ── Key Manager ──
// Every licensing operation lives in the sibling personal_key_manager repo. This
// is a thin adapter: it shells out to `pkm … --json`. See main/key-manager.mjs.
let keyManagerMod = null;
async function keyManager() {
  if (!keyManagerMod) {
    keyManagerMod = await import(pathToFileURL(path.join(__dirname, "main", "key-manager.mjs")).href);
  }
  return keyManagerMod;
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

async function whatsappAction(action, params = {}) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!token) return { ok: false, error: "WHATSAPP_ACCESS_TOKEN not set (⚙️ Config → WhatsApp)" };
  const version = process.env.WHATSAPP_API_VERSION || "v25.0";
  const base = `https://graph.facebook.com/${version}`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  try {
    if (action === "list_numbers") {
      const waba = params.wabaId || process.env.WHATSAPP_WABA_ID;
      if (!waba) return { ok: false, error: "WHATSAPP_WABA_ID not set" };
      const res = await fetch(`${base}/${waba}/phone_numbers`, { headers });
      const data = await res.json();
      if (!res.ok) return { ok: false, status: res.status, error: (data.error && data.error.message) || res.statusText };
      const numbers = (data.data || []).map((n) => ({ id: n.id, display: n.display_phone_number, name: n.verified_name, quality: n.quality_rating }));
      return { ok: true, result: numbers };
    }
    if (action === "status") {
      const pid = params.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;
      const info = {
        configured: {
          token: true,
          wabaId: process.env.WHATSAPP_WABA_ID || null,
          activePhoneId: process.env.WHATSAPP_PHONE_NUMBER_ID || null,
          testPhoneId: process.env.WHATSAPP_TEST_PHONE_NUMBER_ID || null,
        },
        connected: false,
      };
      if (pid) {
        const res = await fetch(
          `${base}/${pid}?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status,status`,
          { headers },
        );
        const data = await res.json();
        info.connected = res.ok && data && data.status === "CONNECTED";
        info.activeNumber = res.ok ? data : (data.error && data.error.message);
      } else {
        info.hint = "Set WHATSAPP_PHONE_NUMBER_ID (find IDs via the WhatsApp → Numbers quick action).";
      }
      return { ok: true, result: info };
    }
    return { ok: false, error: `unknown whatsapp action ${action}` };
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

// ── Electron chat (prompt the configured LLM from the dashboard) ─────────────
// Each chat session persists to its own JSONL file under logs/electron_chat/
// (already covered by the repo-wide `logs/` gitignore rule).
const CHAT_DIR = path.join(REPO, "logs", "electron_chat");

// Chat origin/channel — lets the assistant know whether it is the local
// Electron "operator" console or the Netlify-hosted "frontdesk" (web visitor)
// assistant. Origin is fixed once per session (chat:new) and persisted on every
// entry; it is NEVER inferred from message text or hostname, and the transport
// (HMAC/passphrase/_authorized for frontdesk) enforces what each origin may do.
const CHAT_ORIGINS = new Set(["operator", "frontdesk"]);
const CHAT_ORIGIN_DEFAULT = "operator";
const CHAT_SYSTEM_PROMPTS = {
  operator:
    process.env.ELECTRON_CHAT_SYSTEM_PROMPT ||
    "You are the Frontdesk Operator console assistant, running inside the Electron dashboard (channel: operator). " +
      "You have operator access and may discuss local service state, logs, config, and dashboards. Answer directly and concisely.",
  frontdesk:
    process.env.FRONTDESK_CHAT_SYSTEM_PROMPT ||
    "You are the Netlify-hosted Frontdesk assistant, chatting with website visitors (channel: frontdesk). " +
      "Answer general questions with read-only information only. Never reveal secrets, credentials, internals, or implementation details, and never perform actions.",
};
function chatOriginOf(entries) {
  const sys = (entries || []).find((e) => e.role === "system");
  return sys && CHAT_ORIGINS.has(sys.origin) ? sys.origin : CHAT_ORIGIN_DEFAULT;
}

// Stream a chat step (new persisted entry or an approval request) to every
// window — the renderer appends/re-renders from these so the chat is live.
function chatBroadcast(payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      w.webContents.send("chat:step", payload);
    } catch {
      /* window gone */
    }
  }
}

// One pending operator approval per session; resolved via chat:decide. A
// session's agent loop can also be aborted (Stop button).
const pendingApprovals = new Map(); // token -> { resolve, sessionId, timer }
const chatAborts = new Map(); // sessionId -> AbortController
const operatorChatToolsEnabled = () => process.env.OPERATOR_CHAT_TOOLS !== "false";

function chatSessionPath(id) {
  const safe = String(id || "").replace(/[^A-Za-z0-9._-]/g, "");
  return safe ? path.join(CHAT_DIR, `${safe}.jsonl`) : null;
}
function chatAppend(id, entry) {
  const p = chatSessionPath(id);
  if (!p) return { ok: false, error: "invalid session id" };
  fs.mkdirSync(CHAT_DIR, { recursive: true });
  const stamped = { ts: new Date().toISOString(), ...entry };
  fs.appendFileSync(p, JSON.stringify(stamped) + "\n", "utf8");
  return { ok: true, path: p, entry: stamped };
}
function chatReadHistory(id) {
  const p = chatSessionPath(id);
  if (!p || !fs.existsSync(p)) return { ok: true, entries: [] };
  const entries = [];
  for (const l of fs.readFileSync(p, "utf8").split("\n").filter(Boolean)) {
    try {
      entries.push(JSON.parse(l));
    } catch {
      /* skip malformed line */
    }
  }
  return { ok: true, entries };
}
function chatListSessions() {
  if (!fs.existsSync(CHAT_DIR)) return [];
  const out = [];
  for (const f of fs.readdirSync(CHAT_DIR)) {
    if (!f.endsWith(".jsonl")) continue;
    const p = path.join(CHAT_DIR, f);
    let count = 0;
    let lastTs = null;
    let lastRole = null;
    let origin = CHAT_ORIGIN_DEFAULT;
    try {
      const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
      count = lines.length;
      const last = lines[lines.length - 1];
      if (last) {
        const o = JSON.parse(last);
        lastTs = o.ts || null;
        lastRole = o.role || null;
      }
      for (const l of lines) {
        try {
          const o = JSON.parse(l);
          if (o.origin && CHAT_ORIGINS.has(o.origin)) {
            origin = o.origin;
            break;
          }
        } catch {
          /* skip malformed line */
        }
      }
    } catch {
      /* skip */
    }
    let mtime = "";
    try {
      mtime = fs.statSync(p).mtime.toISOString();
    } catch {
      /* ignore */
    }
    out.push({ id: f.replace(/\.jsonl$/, ""), file: f, count, lastTs, lastRole, origin, mtime });
  }
  out.sort((a, b) => String(b.lastTs || b.mtime).localeCompare(String(a.lastTs || a.mtime)));
  return out;
}
async function chatSend(id, message) {
  const text = String(message || "").trim();
  if (!text) return { ok: false, error: "empty message" };
  if (!chatSessionPath(id)) return { ok: false, error: "invalid session id" };
  const hist = chatReadHistory(id);
  const origin = chatOriginOf(hist.entries); // channel is fixed per session — never from message text
  const userEntry = chatAppend(id, { role: "user", content: text, origin }).entry;
  const basePrompt = CHAT_SYSTEM_PROMPTS[origin] || CHAT_SYSTEM_PROMPTS[CHAT_ORIGIN_DEFAULT];
  // The operator channel is the agentic VS Code-chat mirror; frontdesk stays read-only chat.
  const toolsEnabled = origin === "operator" && operatorChatToolsEnabled();
  const systemMessage = toolsEnabled
    ? `${basePrompt}\n\nYou are running in an agentic desktop console with operator tool access. ` +
      "Read-only tools (list/get/search) run automatically; every state-changing action is shown to the operator " +
      "for approval before it executes — do not ask permission or apologize for mutating actions, just propose them. " +
      "Use tools to actually complete requests and then answer concisely with what you did. Never fabricate tool results."
    : basePrompt;
  try {
    const provider = await import(pathToFileURL(path.join(REPO, "shared", "model-provider.mjs")).href);
    const { callChat, getModelName } = provider;
    const model = typeof getModelName === "function" ? getModelName() : undefined;

    if (!toolsEnabled) {
      // Legacy single-shot Q&A (also covers any frontdesk-channel session).
      const transcript = (hist.entries || [])
        .slice(-40)
        .map((e) => `${e.role === "user" ? "User" : e.role === "system" ? "System" : "Assistant"}: ${e.content}`)
        .join("\n\n");
      const context = transcript ? `${transcript}\n\nUser: ${text}` : text;
      const { reply, usage } = await callChat({ systemMessage, userContext: context, tools: [], meta: { source: "electron-chat" } });
      const replyText = reply != null ? String(reply) : "(no reply)";
      chatBroadcast({ sessionId: id, entry: chatAppend(id, { role: "assistant", content: replyText, model, origin, usage: usage || undefined }).entry });
      return { ok: true, reply: replyText, model, origin };
    }

    // Agentic operator path — multi-turn tool loop with approval gating.
    const agent = await import(pathToFileURL(path.join(__dirname, "main", "chat-agent.mjs")).href);
    // Operator-only local tools (scoped fs/tasks/queues) ride alongside the
    // shared executor's cloud tools. Local reads auto-run; local writes ask.
    const local = await import(pathToFileURL(path.join(__dirname, "main", "local-tools.mjs")).href);
    const localNames = new Set(local.LOCAL_TOOLS.map((t) => t.name));
    const executor = await import(pathToFileURL(path.join(REPO, "mcp", "agent-runner", "tool-executor.js")).href);
    const executeTool = async (name, args) =>
      localNames.has(name) ? local.runLocalTool(REPO, name, args) : executor.executeToolCall(name, args, { isFrontdesk: false });
    const controller = new AbortController();
    chatAborts.set(id, controller);
    const persistEntry = (entry) => {
      const r = chatAppend(id, { ...entry, origin });
      if (r.ok && r.entry) chatBroadcast({ sessionId: id, entry: r.entry });
      return r.entry || entry;
    };
    const requestApproval = (proposal) =>
      new Promise((resolve) => {
        const token = `ap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const timer = setTimeout(() => {
          pendingApprovals.delete(token);
          resolve({ approved: false, reason: "approval timed out (no response)" });
        }, 120000);
        pendingApprovals.set(token, { resolve, sessionId: id, timer });
        chatBroadcast({ sessionId: id, kind: "approval", token, name: proposal.name, args: proposal.args });
      });
    const res = await agent.runOperatorAgent({
      systemMessage,
      entries: [...hist.entries, userEntry], // full prior history + the new user message
      persistEntry,
      requestApproval,
      signal: controller.signal,
      model,
      tools: [...agent.OPERATOR_TOOLS, ...local.LOCAL_TOOLS],
      readTools: new Set([...agent.OPERATOR_READ_TOOLS, ...local.LOCAL_READ_NAMES]),
      execute: executeTool,
    });
    chatAborts.delete(id);
    return { ok: true, origin, model, reply: res.reply, usage: res.usage, maxSteps: res.maxSteps };
  } catch (err) {
    chatAborts.delete(id);
    if (err && err.code === "ABORTED") {
      chatBroadcast({ sessionId: id, entry: chatAppend(id, { role: "assistant", content: "■ stopped by user", origin }).entry });
      return { ok: true, stopped: true, origin };
    }
    const msg = `⚠️ ${err.message || err}`;
    chatBroadcast({ sessionId: id, entry: chatAppend(id, { role: "assistant", content: msg, origin, error: true }).entry });
    return { ok: false, error: err.message || err, origin };
  }
}

// ── LLM provider config ─────────────────────────────────────────────────────
// Env keys that select / configure the LLM provider (see shared/model-provider.mjs).
// Saving any of these in the ⚙️ Config tab restarts the spawned LLM-consuming
// services (runner + webhook) so the new provider/model applies right away.
const PROVIDER_KEYS = new Set([
  "LLM_PROVIDER",
  "LLM_TEMPERATURE",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_MODEL",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MAX_TOKENS",
  "OLLAMA_BASE_URL",
  "OLLAMA_MODEL",
  "OLLAMA_NUM_CTX",
]);

// Env keys whose change must restart the spawned runner/webhook children (they
// read process.env at spawn). Includes the LLM provider keys plus the DS-mon
// usage-tracking keys consumed by shared/usage-tracker.mjs.
const USAGE_KEYS = new Set([
  "USAGE_TRACKING_ENABLED",
  "DSMON_PUSH_URL",
  "DSMON_PUSH_TOKEN",
  "DSMON_PUSH_INTERVAL",
  "DSMON_INSTANCE_ID",
  "DSMON_ENCRYPTION_KEY",
  "DSMON_ENCRYPTION_KEY_ID",
]);
const RESTART_KEYS = new Set([...PROVIDER_KEYS, ...USAGE_KEYS]);

// ── Usage tracking (DS-mon) — local buffer aggregation for the Usage tab ─────
const USAGE_BUFFER = path.join(REPO, "logs", "dsmon_buffer.jsonl");

function readUsageRecords() {
  try {
    return fs
      .readFileSync(USAGE_BUFFER, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function zeroTotals() {
  return { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function usageBucket(map, key) {
  if (!map[key]) map[key] = zeroTotals();
  return map[key];
}

function addUsage(bucket, r) {
  bucket.calls += 1;
  bucket.promptTokens += r.promptTokens || 0;
  bucket.completionTokens += r.completionTokens || 0;
  bucket.totalTokens += r.totalTokens || 0;
}

/** Aggregate the local DS-mon usage buffer + push status for the Usage tab. */
async function usageAggregate() {
  const records = readUsageRecords();
  const totals = zeroTotals();
  const byProvider = {};
  const bySource = {};
  const byModel = {};
  for (const r of records) {
    addUsage(totals, r);
    addUsage(usageBucket(byProvider, r.providerId || "unknown"), r);
    addUsage(usageBucket(bySource, r.source || "unknown"), r);
    addUsage(usageBucket(byModel, r.model || "unknown"), r);
  }
  let dsmon = { at: null, ok: null, count: 0, error: null, bufferBytes: 0, bufferCount: records.length, instanceId: "" };
  try {
    const mod = await import(pathToFileURL(path.join(REPO, "shared", "usage-tracker.mjs")).href);
    dsmon = { ...dsmon, ...mod.getDsmonStatus() };
  } catch {
    // Non-fatal — the tab still renders local totals.
  }
  const enabled = (process.env.USAGE_TRACKING_ENABLED || "false") === "true";
  const rawUrl = (process.env.DSMON_PUSH_URL || "").trim().replace(/\/+$/, "");
  return { ok: true, enabled, pushUrl: rawUrl, totals, byProvider, bySource, byModel, dsmon };
}

/**
 * DeepSeek credit balance (mirrors the transcription agent's Usage tab card).
 * The API key never leaves the main process.
 */
async function usageCredits() {
  const provider = (process.env.LLM_PROVIDER || "deepseek").toLowerCase();
  if (provider === "ollama") return { available: false, provider, balance: null, error: "Local LLM — no cost to track." };
  if (provider !== "deepseek") return { available: false, provider, balance: null, error: `${provider} has no public usage/balance endpoint.` };
  const key = process.env.DEEPSEEK_API_KEY || "";
  if (!key) return { available: false, provider, balance: null, error: "No DeepSeek API key configured." };
  try {
    const res = await fetch("https://api.deepseek.com/user/balance", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { available: false, provider, balance: null, error: `HTTP ${res.status}` };
    const data = await res.json();
    const first = Array.isArray(data.balance_infos) ? data.balance_infos[0] : null;
    const raw = first && first.total_balance != null ? first.total_balance : data.balance != null ? data.balance : null;
    return { available: data.is_available !== false, provider, balance: raw == null ? null : String(raw), error: null };
  } catch (err) {
    return { available: false, provider, balance: null, error: err.message };
  }
}

// Restart a running service so it re-reads the (updated) process.env. Returns
// true when a service was actually restarted. Waits briefly so the old process
// releases its port (e.g. webhook on 3199) before the new one binds.
async function restartService(name) {
  if (!running[name]) return false;
  stopService(name);
  await new Promise((r) => setTimeout(r, 700));
  startService(name);
  return true;
}

// ── Re-register webhook push sources (Trello/Gmail/Calendar/Drive) ──
// Run each setup script with `node` (repo cwd; the scripts load .env themselves
// via config-loader), capture their output, then restart the webhook service so
// it picks up the new registrations + any updated code.
const WEBHOOK_SETUP_SCRIPTS = [
  { file: "mcp/webhook-server/scripts/setup-trello-webhook.js", label: "Trello webhooks" },
  { file: "mcp/webhook-server/scripts/setup-gmail-watch.js", label: "Gmail watch" },
  { file: "mcp/webhook-server/scripts/setup-calendar-watch.js", label: "Calendar watch" },
  { file: "mcp/webhook-server/scripts/setup-drive-watch.js", label: "Drive watch" },
];

function runScriptCapture(cmd, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd: REPO, env: process.env });
    } catch (err) {
      return resolve({ ok: false, code: -1, output: `spawn failed: ${err.message}` });
    }
    let out = "";
    let done = false;
    const finish = (res) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(res);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      finish({ ok: false, code: -1, output: out + `\n[timed out after ${timeoutMs}ms]` });
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("error", (err) => finish({ ok: false, code: -1, output: out, error: err.message }));
    child.on("close", (code) => finish({ ok: code === 0, code, output: out }));
  });
}

async function reregisterWebhooks() {
  const steps = [];
  for (const s of WEBHOOK_SETUP_SCRIPTS) {
    const r = await runScriptCapture("node", [s.file]);
    const output = String(r.output || "").trim().slice(-3000);
    steps.push({ label: s.label, ok: !!r.ok, code: r.code ?? null, output, error: r.error || "" });
    liveLog.addLog({
      source: "electron",
      subSource: "webhook",
      level: r.ok ? "info" : "warn",
      message: `reregister ${s.label}: ${r.ok ? "ok" : "failed"}`,
      data: { output },
    });
  }
  // Restart the webhook service so it loads the new registrations + code.
  // If the webhook is up but was started outside the dashboard (nohup), it
  // can't be managed/restarted here — the re-registration alone still applies.
  let webhookRestarted = false;
  const whStatus = await serviceHealth("webhook");
  if (whStatus.running && whStatus.managed) webhookRestarted = await restartService("webhook");
  else if (!whStatus.running) startService("webhook");
  return { ok: true, steps, webhookRestarted };
}

// Resolve the active provider + model label for UI display (mirrors the
// per-provider defaults in shared/model-provider.mjs without importing it).
function effectiveLlmLabel() {
  const p = (process.env.LLM_PROVIDER || "deepseek").toLowerCase();
  const model =
    p === "openai"
      ? process.env.OPENAI_MODEL || "gpt-4o"
      : p === "anthropic"
        ? process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5"
        : p === "ollama"
          ? process.env.OLLAMA_MODEL || "(set OLLAMA_MODEL)"
          : process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
  return { llmProvider: p, llmModel: model };
}

// ── IPC ──────────────────────────────────────────────────────────────────────
function registerIpc() {
  ipcMain.handle("svc:list", () => Promise.all(Object.keys(serviceDefs).map(serviceHealth)));
  ipcMain.handle("svc:start", (_e, name) => startService(name));
  ipcMain.handle("svc:stop", (_e, name) => stopService(name));
  ipcMain.handle("svc:restart", (_e, name) => restartService(name));
  ipcMain.handle("svc:log", (_e, name, lines) => serviceTail(name, lines));
  ipcMain.handle("webhook:reregister", () => reregisterWebhooks());

  // User-script runner (scripts/user allowlist, manual run only)
  ipcMain.handle("scripts:list", async () => ({
    ok: true,
    preflight: await probeTools(),
    scripts: scanUserScripts(),
    runs: activeRuns(),
  }));
  ipcMain.handle("scripts:run", (_e, name, payload) => runUserScript(name, payload));
  ipcMain.handle("scripts:stop", (_e, target) => stopUserScript(target));
  ipcMain.handle("scripts:running", () => ({ ok: true, runs: activeRuns() }));
  // Native file/folder picker for `file`-type script fields (Browse…).
  ipcMain.handle("scripts:pick", async (_e, opts) => {
    try {
      const o = opts && typeof opts === "object" ? opts : {};
      const win =
        BrowserWindow.getFocusedWindow() || (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null);
      const common = { title: o.title || "Choose", buttonLabel: o.buttonLabel || "Choose" };
      let result;
      if (o.browseFor === "saveFile") {
        result = win
          ? await dialog.showSaveDialog(win, common)
          : await dialog.showSaveDialog(common);
      } else if (o.browseFor === "openDirectory") {
        result = win
          ? await dialog.showOpenDialog(win, { ...common, properties: ["openDirectory", "createDirectory"] })
          : await dialog.showOpenDialog({ ...common, properties: ["openDirectory", "createDirectory"] });
      } else {
        result = win
          ? await dialog.showOpenDialog(win, { ...common, properties: ["openFile"] })
          : await dialog.showOpenDialog({ ...common, properties: ["openFile"] });
      }
      if (result.canceled || !result.filePaths || !result.filePaths.length) return { ok: true, canceled: true };
      return { ok: true, path: result.filePaths[0] };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

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
  ipcMain.handle("events:clearAll", (_e, queue) => webhookApi(`/events?queue=${encodeURIComponent(queue || "misc_notifications")}`, "DELETE"));
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

  // Key Manager — pkm-backed (all licensing logic/data lives in personal_key_manager).
  // Every handler takes the registry id first, so the dashboard drives every
  // registry in the store (frontdesk-agent, transcription-agent, …). Omitting it
  // falls back to PKM_REGISTRY (⚙️ Config).
  ipcMain.handle("pkm:status", async (_e, registry) => (await keyManager()).status(registry));
  ipcMain.handle("pkm:registries", async () => (await keyManager()).registries());
  ipcMain.handle("pkm:list", async (_e, registry, days) => (await keyManager()).listSeats(registry, days));
  ipcMain.handle("pkm:issue", async (_e, registry, sub, exp) => (await keyManager()).issueSeat(registry, sub, exp));
  ipcMain.handle("pkm:revoke", async (_e, registry, sub, reason) => (await keyManager()).revokeSeat(registry, sub, reason));
  ipcMain.handle("pkm:unrevoke", async (_e, registry, sub) => (await keyManager()).unrevokeSeat(registry, sub));
  ipcMain.handle("pkm:archive", async (_e, registry) => (await keyManager()).archiveExpired(registry));
  ipcMain.handle("pkm:audit", async (_e, registry) => (await keyManager()).audit(registry));
  ipcMain.handle("pkm:validate", async (_e, registry, key) => (await keyManager()).validate(registry, key));
  // Rings (master keypairs) + cross-app blocklist sync
  ipcMain.handle("pkm:rings", async (_e, registry) => (await keyManager()).rings(registry));
  ipcMain.handle("pkm:ringCreate", async (_e, registry, kid) => (await keyManager()).ringCreate(registry, kid));
  ipcMain.handle("pkm:ringRetire", async (_e, registry, kid, at) => (await keyManager()).ringRetire(registry, kid, at));
  ipcMain.handle("pkm:agentKey", async (_e, registry) => (await keyManager()).agentKey(registry));
  ipcMain.handle("pkm:setDefaultKid", async (_e, registry, kid) => (await keyManager()).setDefaultKid(registry, kid));
  ipcMain.handle("pkm:syncRevocation", async (_e, registry) => (await keyManager()).syncRevocation(registry));

  ipcMain.handle("config:get", () => {
    const eff = config.readEffective();
    return {
      present: eff.present,
      source: eff.source,
      configPath: eff.present ? config.CONFIG_PATH : config.ENV_PATH,
      values: eff.values || {},
      webhookBaseUrl: process.env.WEBHOOK_BASE_URL || `http://localhost:${WEBHOOK_PORT}`,
      agentPub: process.env.FRONTDESK_AGENT_PUBKEY || "",
      corsOrigins: process.env.CORS_ORIGINS || "",
      tunnelDomain: process.env.CLOUDFLARE_TUNNEL_DOMAIN || "",
      useTrello: process.env.FRONTDESK_USE_TRELLO === "true",
      logToTrello: process.env.FRONTDESK_LOG_TO_TRELLO === "true",
      ...effectiveLlmLabel(),
    };
  });
  ipcMain.handle("config:getWithSources", () => {
    const res = config.readWithSources();
    return { ok: true, present: res.present, source: res.source, configPath: res.configPath, count: res.count, values: res.values, ...(res.error ? { error: res.error } : {}) };
  });
  ipcMain.handle("config:save", async (_e, values) => {
    const payload = values || {};
    // Merge (not overwrite): a partial edit must not clobber other keys already
    // in config.json. Empty strings are dropped (they mean "revert to
    // .env/default"), mirroring the transcription agent's save semantics.
    const clean = {};
    for (const [k, v] of Object.entries(payload)) {
      if (v === undefined || v === null || v === "") continue;
      clean[k] = String(v);
    }
    if (Object.keys(clean).length === 0) return { ok: true, path: config.CONFIG_PATH, count: 0, changed: 0, restarted: [] };
    const res = config.mergeConfig(clean);
    if (!res.ok) return res;
    config.applyValues(clean, process.env);
    // Provider + usage-tracking changes affect the LLM path. The in-process Chat
    // reads env live (shared/model-provider.mjs resolves per call), but the
    // spawned runner + webhook read it at startup — restart them so changes apply.
    const restarted = [];
    if (Object.keys(clean).some((k) => RESTART_KEYS.has(k))) {
      for (const name of ["runner", "webhook"]) {
        if (await restartService(name)) restarted.push(name);
      }
    }
    return { ...res, restarted, provider: process.env.LLM_PROVIDER || "deepseek" };
  });
  ipcMain.handle("config:export", () => ({
    ok: true,
    present: config.hasConfigJson(),
    source: config.readEffective().source,
    json: config.exportConfig(),
  }));
  ipcMain.handle("config:import", (_e, raw) => config.importConfig(raw));

  // Usage (DS-mon LLM token usage + DeepSeek credit balance)
  ipcMain.handle("usage:aggregate", () => usageAggregate());
  ipcMain.handle("usage:credits", () => usageCredits());
  ipcMain.handle("usage:flush", async () => {
    try {
      const mod = await import(pathToFileURL(path.join(REPO, "shared", "usage-tracker.mjs")).href);
      await mod.flushBuffer();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("tools:manifest", () => toolsManifest());
  ipcMain.handle("tools:trello", (_e, action, params) => trelloAction(action, params));
  ipcMain.handle("tools:gmail", (_e, action, params) => gmailAction(action, params));
  ipcMain.handle("tools:whatsapp", (_e, action, params) => whatsappAction(action, params));
  ipcMain.handle("google:status", () => googleStatus());

  ipcMain.handle("accounts:list", async () => {
    try {
      const acc = await accountsApi();
      const rows = acc.listAccounts();
      // Seats come from the pkm-backed Key Manager (single source of truth), so a
      // freshly issued seat shows up here before it has any account binding.
      const lic = await (await keyManager()).listSeats();
      const subs = new Set(rows.map((r) => r.sub));
      for (const s of lic.ok ? lic.data.rows || [] : []) {
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

  ipcMain.handle("app:version", () => {
    try {
      const pkg = require(path.join(__dirname, "..", "package.json"));
      return { ok: true, name: pkg.productName || pkg.name || "Frontdesk Operator", version: pkg.version || "" };
    } catch {
      return { ok: true, name: "Frontdesk Operator", version: "" };
    }
  });

  // Docs (About → Guide — electron/docs/*.md)
  ipcMain.handle("docs:list", () => docsList());
  ipcMain.handle("docs:get", (_e, file) => readDoc(file));

  // Chat — prompt the configured LLM; each chat persists to logs/electron_chat/<id>.jsonl
  ipcMain.handle("chat:list", () => ({ ok: true, sessions: chatListSessions() }));
  ipcMain.handle("chat:new", (_e, title, origin) => {
    const slug = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const id = `chat-${slug}`;
    const safeTitle = String(title || "").trim().replace(/[^A-Za-z0-9 _-]/g, "").slice(0, 60);
    const safeOrigin = CHAT_ORIGINS.has(origin) ? origin : CHAT_ORIGIN_DEFAULT;
    chatAppend(id, { role: "system", content: "session created", title: safeTitle || undefined, origin: safeOrigin });
    return { ok: true, id, origin: safeOrigin };
  });
  ipcMain.handle("chat:history", (_e, id) => chatReadHistory(id));
  ipcMain.handle("chat:send", (_e, id, message) => chatSend(id, message));
  // Agentic-chat approvals: renderer Approve/Deny/Edit on a proposed tool call.
  ipcMain.handle("chat:decide", (_e, token, approved, editedArgs) => {
    const p = pendingApprovals.get(token);
    if (!p) return { ok: false, error: "no such pending approval" };
    clearTimeout(p.timer);
    pendingApprovals.delete(token);
    const answer = { approved: !!approved };
    if (approved && editedArgs && typeof editedArgs === "object") answer.editedArgs = editedArgs;
    p.resolve(answer);
    return { ok: true };
  });
  // Stop the running agentic loop for a session (and any pending approval in it).
  ipcMain.handle("chat:stop", (_e, id) => {
    const ctrl = chatAborts.get(id);
    if (ctrl) {
      try {
        ctrl.abort();
      } catch {
        /* ignore */
      }
    }
    for (const [token, p] of pendingApprovals) {
      if (p.sessionId === id) {
        clearTimeout(p.timer);
        pendingApprovals.delete(token);
        p.resolve({ approved: false, reason: "stopped by user" });
      }
    }
    return { ok: true };
  });

  ipcMain.handle("open:external", (_e, url) => {
    const { shell } = require("electron");
    if (url) shell.openExternal(url);
  });
  ipcMain.handle("app:getTheme", () => getAppearanceInfo());
  ipcMain.handle("app:setTheme", (_e, theme) => setAppTheme(theme));
  ipcMain.handle("app:setAppearance", (_e, patch) => setAppearance(patch || {}));
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
      { label: "Quit", click: () => app.quit() }, // before-quit drains every service + script
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

// ── Full teardown ────────────────────────────────────────────────────────────
// Stops EVERYTHING the app started itself: all services (incl. per-seat MCPs)
// AND all user-script runs. Because children are detached into their own
// process groups, signalTree() can reap each one's whole subtree. The wait
// loop here replaces the old fire-and-forget SIGKILL timer, which never fired
// during a fast quit and left strays behind.

function isAlive(proc) {
  return !!proc && proc.exitCode === null && proc.signalCode === null;
}

async function shutdownEverything() {
  if (notifTimer) clearInterval(notifTimer);
  const procs = [
    ...Object.values(running).map((r) => r.proc),
    ...Object.values(scriptRuns).map((r) => r.proc),
  ].filter(isAlive);
  if (procs.length === 0) return;

  for (const p of procs) signalTree(p, "SIGTERM");
  // Bounded wait for a clean exit (waits here — no timer that can be lost)…
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && procs.some(isAlive)) {
    await new Promise((r) => setTimeout(r, 50));
  }
  // …then force-kill any survivors (whole groups, so stragglers don't linger).
  for (const p of procs) {
    if (isAlive(p)) signalTree(p, "SIGKILL");
  }
  await new Promise((r) => setTimeout(r, 150)); // let SIGKILL land before we exit
}

let quitting = false;
function beginQuit() {
  if (quitting) return; // re-entry guard: before-quit + signal handlers can overlap
  quitting = true;
  void shutdownEverything().finally(() => app.exit(0));
}

app.on("before-quit", (e) => {
  e.preventDefault();
  beginQuit();
});

// OS-level termination (kill <pid> / SIGTERM, Ctrl+C / SIGINT, SIGHUP) — same
// clean drain so nothing the app spawned survives the process being ended.
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, beginQuit);
}
