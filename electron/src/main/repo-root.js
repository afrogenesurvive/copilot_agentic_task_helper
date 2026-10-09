/**
 * Repo root resolution — where the working copy actually lives.
 *
 * A DEV run is easy: the code sits in the repo, so the root is three levels above this
 * file. A PACKAGED build is not: the app runs from /Applications, `process.resourcesPath`
 * is the bundle, and every repo-relative path (config.json, .env, safe/, logs/, mcp/,
 * scripts/user, node_modules) would resolve inside `Contents/Resources` instead — which is
 * why a built copy could not read its config, sign anyone in, or start a service.
 *
 * So the root is RESOLVED, in this order:
 *
 *   1. `DEV_CENTRE_REPO` in the environment — an explicit override, honoured in both dev
 *      and a packaged app launched from a terminal.
 *   2. In dev (`!app.isPackaged`) the tree this file lives in. Always correct, so a stale
 *      pointer can never divert a dev run.
 *   3. A pointer file in userData (`repo.json`), written the first time the operator picks
 *      the folder.
 *   4. An upward search from the app bundle — succeeds while the .app still sits inside
 *      `electron/dist`, so an in-place build needs no picker.
 *
 * When none of those is valid the caller gets the UNRESOLVED sentinel: a path under
 * userData that is safe to `path.join()` (so module-load constants can still be built
 * before the app is ready) but holds nothing. `isResolved()` is what main.js turns into
 * the folder picker.
 *
 * This module is main-process only. Its `__dirname` is therefore the app source (inside
 * the asar when packaged), and it deliberately does NOT try to guess a repo from a
 * relative path in that case — a wrong guess is worse than asking.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

/** `app` is optional so the module can be required outside Electron (scripts, checks). */
let app = null;
try {
  ({ app } = require("electron"));
} catch {
  /* not running under Electron */
}

/** Pointer file name inside userData. */
const POINTER_NAME = "repo.json";
/** Sentinel directory name inside userData — see the header. */
const UNRESOLVED_DIRNAME = "__repo_unresolved__";
/** `package.json` name that must match, so a random folder cannot be accepted. */
const EXPECTED_PACKAGE_NAME = "copilot_agentic_task_helper";
/** Files that only this repo has. Checked in addition to the package name. */
const MARKERS = ["shared/config-loader.cjs", "mcp/webhook-server/index.js"];
/**
 * How far up to look for the repo when the bundle sits inside it. Sized for the real
 * packaged paths, which are deep: `<repo>/electron/dist/mac-arm64/Dev Centre.app/Contents/
 * Resources/app.asar` is SEVEN levels below the repo root, so a shallow search would miss it
 * and prompt for a folder the app is effectively already inside.
 */
const UPWARD_DEPTH = 10;

/** { root, via } for the last successful resolve; `via === null` means unresolved. */
let cached = null;

function userDataDir() {
  try {
    return app.getPath("userData");
  } catch {
    return path.join(os.tmpdir(), "dev-centre");
  }
}

/** The path handed back when nothing valid was found. Safe to join, holds nothing. */
function unresolvedRoot() {
  return path.join(userDataDir(), UNRESOLVED_DIRNAME);
}

/**
 * Is `dir` the Dev Centre repo? Cheap on purpose — it runs at startup and from the
 * picker. Returns `{ok: true, dir, name}` or `{ok: false, reason}` with a message that
 * can be shown to the operator verbatim.
 */
function validateRepoRoot(dir) {
  const target = String(dir || "").trim();
  if (!target) return { ok: false, reason: "no folder was given" };
  const abs = path.resolve(target);

  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return { ok: false, reason: `${abs} does not exist` };
  }
  if (!stat.isDirectory()) return { ok: false, reason: `${abs} is not a folder` };

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(abs, "package.json"), "utf8"));
  } catch {
    return { ok: false, reason: `${abs} has no readable package.json` };
  }
  if (pkg && pkg.name !== EXPECTED_PACKAGE_NAME) {
    return { ok: false, reason: `${abs} is the "${pkg.name}" project, not ${EXPECTED_PACKAGE_NAME}` };
  }
  for (const marker of MARKERS) {
    if (!fs.existsSync(path.join(abs, marker))) {
      return { ok: false, reason: `${abs} is missing ${marker}` };
    }
  }
  return { ok: true, dir: abs, name: pkg.name };
}

/** The remembered repo path, or null. Never throws. */
function readRepoPointer() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(userDataDir(), POINTER_NAME), "utf8"));
    return typeof raw?.repo === "string" && raw.repo ? raw.repo : null;
  } catch {
    return null;
  }
}

/** Remember `dir` as the repo root (atomic: tmp + rename). */
function writeRepoPointer(dir) {
  const target = path.join(userDataDir(), POINTER_NAME);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    fs.writeFileSync(
      tmp,
      `${JSON.stringify({ repo: path.resolve(String(dir)), updatedAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8"
    );
    fs.renameSync(tmp, target);
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Walk up from `startDir` looking for the repo (used when the bundle sits inside it). */
function searchUpward(startDir) {
  let dir = path.resolve(startDir);
  for (let i = 0; i < UPWARD_DEPTH; i++) {
    if (validateRepoRoot(dir).ok) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return null;
}

/** The dev tree this module lives in: electron/src/main → repo root. */
function devTreeRoot() {
  return path.resolve(__dirname, "..", "..", "..");
}

function remember(root, via) {
  cached = { root, via };
  return cached.root;
}

/**
 * Resolve the repo root. Always returns a usable string — callers that need to know
 * whether it is real ask `isResolved()`.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force] - re-resolve instead of returning the cached answer.
 */
function resolveRepoRoot({ force = false } = {}) {
  if (cached && !force) return cached.root;

  const override = (process.env.DEV_CENTRE_REPO || "").trim();
  if (override) {
    const verdict = validateRepoRoot(override);
    if (verdict.ok) return remember(verdict.dir, "DEV_CENTRE_REPO");
    console.warn(`[repo-root] DEV_CENTRE_REPO is not the Dev Centre repo — ${verdict.reason}`);
  }

  if (!(app && app.isPackaged)) {
    const dev = validateRepoRoot(devTreeRoot());
    if (dev.ok) return remember(dev.dir, "dev tree");
  }

  const pointed = readRepoPointer();
  if (pointed) {
    const verdict = validateRepoRoot(pointed);
    if (verdict.ok) return remember(verdict.dir, "userData pointer");
    console.warn(`[repo-root] the remembered repo is no longer valid — ${verdict.reason}`);
  }

  // Two starting points, because they differ by two levels: `getAppPath()` is the asar,
  // `resourcesPath` is the directory holding it. Either can sit under the repo (a build left
  // in `electron/dist`), and checking both costs a few stat calls.
  for (const start of [app && app.getAppPath ? app.getAppPath() : null, process.resourcesPath, __dirname]) {
    if (!start) continue;
    try {
      const near = searchUpward(start);
      if (near) return remember(near, "bundle location");
    } catch {
      /* unreadable start point — try the next */
    }
  }

  return remember(unresolvedRoot(), null);
}

/** True when `resolveRepoRoot()` found a real repo (not the sentinel). */
function isResolved() {
  return Boolean(cached && cached.via);
}

/** Where the last successful resolve came from, for the log line: "dev tree", null… */
function resolvedVia() {
  return cached ? cached.via : null;
}

/** The absolute path of the sentinel, so a caller can recognise it. */
function unresolved() {
  return unresolvedRoot();
}

/** The pointer file's path (shown in errors so the operator can delete a stale one). */
function pointerPath() {
  return path.join(userDataDir(), POINTER_NAME);
}

module.exports = {
  POINTER_NAME,
  EXPECTED_PACKAGE_NAME,
  validateRepoRoot,
  resolveRepoRoot,
  searchUpward,
  isResolved,
  resolvedVia,
  unresolved,
  pointerPath,
  readRepoPointer,
  writeRepoPointer,
};
