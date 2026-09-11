/**
 * pkm-paths.mjs — the SINGLE place every `personal_key_manager` path is resolved.
 *
 * Nothing here is hardcoded except the *defaults*: the store root, the checkout
 * location, the registry id and the CLI binary are all config-driven, so moving
 * the key store or adding a registry never requires a code change.
 *
 * ── Config keys (all optional, all non-secret) ──
 *   PKM_REPO      checkout of the personal_key_manager repo        (default ~/Documents/GitHub/personal_key_manager)
 *   PKM_ROOT      the key STORE root (registries/, export/, authority/)
 *                 — defaults to PKM_REPO when unset (the store lives in the repo)
 *   PKM_REGISTRY  active registry id                               (default frontdesk-agent)
 *   PKM_BIN       absolute path to bin/pkm.mjs                     (default <PKM_REPO>/bin/pkm.mjs)
 *   PKM_NODE      node binary used to run pkm                      (default: the current runtime)
 *   PKM_TIMEOUT_MS  per-command pkm timeout                        (default 20000)
 *
 * ── Store layout (per registry) ──
 *   registries/registry.json          AUTHORITATIVE index (id, name, app, dir, engine, defaultKid, verifierTargets)
 *   registries/<dir>/ring.json        public master key ring, by kid
 *   registries/<dir>/revoked-seats.json   per-seat blocklist (read live on every verify)
 *   registries/<dir>/audit.jsonl      append-only action log
 *   registries/<dir>/agent/           X25519 peer keypair (ed25519+x25519 registries only)
 *   registries/<dir>/<kid>/           master private/public key + issued/, revoked/, expired/ ledgers
 *
 * The index is authoritative, so the registry DIRECTORY comes from its `dir`
 * field — not from the registry id. Older stores where `dir === id` still work.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Fallback checkout location when PKM_REPO / PKM_ROOT are unset. */
export const DEFAULT_PKM_REPO = path.join(os.homedir(), "Documents", "GitHub", "personal_key_manager");
/** Registry the frontdesk stack signs and verifies with when PKM_REGISTRY is unset. */
export const DEFAULT_PKM_REGISTRY = "frontdesk-agent";
/** Licensed app id embedded in a certificate's `app` field when the index has no entry. */
export const DEFAULT_PKM_APP_ID = "frontdesk-agent";
/** Per-command pkm timeout — a hung CLI must never freeze the UI. */
export const DEFAULT_PKM_TIMEOUT_MS = 20000;

const clean = (v) => (typeof v === "string" && v.trim() ? v.trim() : "");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Resolve every path the pkm store needs.
 * @param {object} [env] - environment to read (defaults to process.env)
 * @param {string} [registry] - registry id/dir override (defaults to PKM_REGISTRY)
 * @returns {object} resolved paths + the registry's index entry
 */
export function pkmPaths(env = process.env, registry) {
  const repo = clean(env.PKM_REPO) || DEFAULT_PKM_REPO;
  const store = clean(env.PKM_ROOT) || repo;
  const wanted = clean(registry) || clean(env.PKM_REGISTRY) || DEFAULT_PKM_REGISTRY;

  const registriesDir = path.join(store, "registries");
  const indexFile = path.join(registriesDir, "registry.json");
  const index = readJson(indexFile, { registries: [] });
  const entries = Array.isArray(index?.registries) ? index.registries : [];

  const needle = wanted.toLowerCase();
  const entry =
    entries.find((e) => String(e.id).toLowerCase() === needle || String(e.dir ?? "").toLowerCase() === needle) || null;

  // `dir` is authoritative; fall back to the id for stores created before the index existed.
  const registryDir = path.join(registriesDir, entry?.dir || entry?.id || wanted);

  return {
    repo,
    store,
    registry: entry?.id || wanted,
    app: clean(env.PKM_APP) || entry?.app || DEFAULT_PKM_APP_ID,
    engine: entry?.engine || "ed25519",
    defaultKid: entry?.defaultKid || null,
    verifierTargets: entry?.verifierTargets || {},
    entry,
    entries,
    indexFile,
    registriesDir,
    registryDir,
    bin: clean(env.PKM_BIN) || path.join(repo, "bin", "pkm.mjs"),
    ringFile: path.join(registryDir, "ring.json"),
    revokedFile: path.join(registryDir, "revoked-seats.json"),
    auditFile: path.join(registryDir, "audit.jsonl"),
    agentDir: path.join(registryDir, "agent"),
    exportDir: path.join(store, "export"),
    authorityDir: path.join(store, "authority"),
    /** Per-command CLI timeout in ms (PKM_TIMEOUT_MS). */
    timeoutMs: Number(clean(env.PKM_TIMEOUT_MS)) > 0 ? Number(clean(env.PKM_TIMEOUT_MS)) : DEFAULT_PKM_TIMEOUT_MS,
    /** Node binary used to run the CLI; the Electron runtime is only used as a fallback. */
    node: clean(env.PKM_NODE) || null,
  };
}

/** Registry index entries only (no filesystem access beyond registry.json). */
export function pkmRegistryEntries(env = process.env) {
  return pkmPaths(env).entries;
}

/** Convenience: the registry ids present in the store. */
export function pkmRegistryIds(env = process.env) {
  return pkmPaths(env).entries.map((e) => e.id);
}
