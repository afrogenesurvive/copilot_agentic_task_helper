/**
 * Child-process runtime — which `node`, and what PATH.
 *
 * Two things break a GUI-launched app that a terminal launch hides:
 *
 *   1. **PATH.** A double-clicked .app inherits launchd's PATH (`/usr/bin:/bin:/usr/sbin:
 *      /sbin`), not yours, so `node`, `python3`, `aws` and `cloudflared` installed via nvm
 *      or Homebrew are simply not found. `childEnv()` prepends the places those live.
 *   2. **The binary itself.** When no real `node` exists anywhere, `process.execPath` with
 *      `ELECTRON_RUN_AS_NODE=1` turns the running Electron binary into a plain Node — the
 *      same trick `main/key-manager.mjs` uses for the `pkm` CLI. Nothing has to be shipped
 *      or installed for the app's own services to start.
 *
 * A real `node` is preferred: the repo's scripts (and anything they shell out to) expect a
 * genuine Node, and `NODE_BIN` overrides the choice outright.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

/** Standard locations, most specific first. */
const WELL_KNOWN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/** Cached `nodeCommand()` result — the answer cannot change while the app runs. */
let cachedNode = null;

function isExecutable(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Every node version installed by nvm, newest first. */
function nvmBinDirs() {
  const versions = path.join(os.homedir(), ".nvm", "versions", "node");
  try {
    return fs
      .readdirSync(versions)
      .sort()
      .reverse()
      .map((v) => path.join(versions, v, "bin"))
      .filter((dir) => fs.existsSync(dir));
  } catch {
    return [];
  }
}

/**
 * The PATH a child should get: our well-known (and nvm) directories FIRST, then whatever
 * this process already had — so a Finder launch finds nvm/Homebrew tools, while a
 * terminal launch still wins the tie with its own, more specific entries.
 */
function augmentedPath() {
  const existing = (process.env.PATH || "").split(":").filter(Boolean);
  const seen = new Set(existing);
  const extra = [...nvmBinDirs(), ...WELL_KNOWN_DIRS].filter((dir) => !seen.has(dir) && fs.existsSync(dir));
  return [...extra, ...existing].join(":");
}

/**
 * The environment for a spawned child: this process's env, a repaired PATH, and whatever
 * the caller adds. `extra` is applied last, so a caller can override a single variable
 * without losing the PATH fix.
 */
function childEnv(extra = {}) {
  return { ...process.env, PATH: augmentedPath(), ...extra };
}

/**
 * How to run Node: `{ cmd, env }`. `env` holds ONLY the extra variables the command needs
 * (an empty object for a real node, `ELECTRON_RUN_AS_NODE` for the Electron fallback) — a
 * caller spreads it into `childEnv()`.
 *
 * Order: `NODE_BIN` → a real `node` on the repaired PATH → Electron-as-Node.
 */
function nodeCommand() {
  if (cachedNode) return cachedNode;

  const override = (process.env.NODE_BIN || "").trim();
  if (override) {
    return (cachedNode = { cmd: override, env: {}, kind: "override" });
  }

  for (const dir of augmentedPath().split(":")) {
    const candidate = path.join(dir, "node");
    if (isExecutable(candidate)) {
      return (cachedNode = { cmd: candidate, env: {}, kind: "node" });
    }
  }

  // No Node installed: run the Electron binary as Node.
  return (cachedNode = { cmd: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" }, kind: "electron" });
}

/**
 * What `probeTools()` reports to the Scripts tab, so the preflight tells the truth about
 * the runtime the scripts will actually get rather than running `which node` again.
 */
function runtimeInfo() {
  const { cmd, kind } = nodeCommand();
  return { nodeCmd: cmd, nodeKind: kind, childPath: augmentedPath() };
}

module.exports = {
  nodeCommand,
  childEnv,
  augmentedPath,
  runtimeInfo,
  WELL_KNOWN_DIRS,
};
