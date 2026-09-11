/**
 * Key Manager — Electron main process only.
 *
 * A thin GUI adapter over the `pkm` CLI in the sibling **personal_key_manager**
 * repo, which is the single source of truth for all licensing (registries,
 * rings, seats, revocation, audit). This repo contains NO licence logic: every
 * function here builds an argv, spawns `pkm … --json`, and returns the parsed
 * result.
 *
 * ── MULTI-REGISTRY ──────────────────────────────────────────────────────────
 * Every command takes a registry id as its first argument, so the dashboard can
 * drive *all* registries in the store (e.g. `frontdesk-agent` AND
 * `transcription-agent`), not just the one the webhook server verifies against.
 * Omitting it falls back to `PKM_REGISTRY` (⚙️ Config).
 *
 * ── PATHS ───────────────────────────────────────────────────────────────────
 * Nothing is hardcoded: repo, store, registry, binary and timeout all come from
 * `pkmPaths()` (scripts/pkm-paths.mjs), so relocating the store is a config
 * change. Paths are resolved per call, so a config edit takes effect on the next
 * click — no restart.
 *
 * ── SECURITY ────────────────────────────────────────────────────────────────
 * `pkm issue` prints the licence string, which EMBEDS the seat's Ed25519 and
 * X25519 private seeds. We surface it once, for the display-once modal. stdout
 * is never logged, never buffered to disk, and never included in an error — on
 * failure we return stderr only.
 *
 * Every command is serialised through a single promise chain: mutations make
 * `pkm` rewrite `export/*.json`, so overlapping runs would race on those files.
 * Each run is therefore hard-bounded by a timeout — a hung CLI can delay the
 * queue but can never freeze it forever.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";

import { DEFAULT_PKM_REGISTRY, pkmPaths } from "../../../scripts/pkm-paths.mjs";

/** Registry used when the caller does not name one. */
export function defaultRegistry(env = process.env) {
  return (env.PKM_REGISTRY || "").trim() || DEFAULT_PKM_REGISTRY;
}

/** Resolved paths + index entry for a registry (live lookup — no caching). */
export function pkmInfo(registry) {
  return pkmPaths(process.env, registry);
}

/** Shape every export returns: { ok: true, data } or { ok: false, error }. */
const fail = (error) => ({ ok: false, error });

/* ── pkm runner ────────────────────────────────────────────────────────────── */

let chain = Promise.resolve();

/**
 * The binary to run the CLI with.
 *
 * `process.execPath` inside Electron is the **Electron binary**, not node —
 * spawning it bare makes Electron try to open `pkm.mjs` as an app, which never
 * exits and deadlocks the whole queue. `ELECTRON_RUN_AS_NODE=1` turns that same
 * binary into a plain Node runtime, and `PKM_NODE` overrides it with a real
 * node when you have one.
 */
function nodeRuntime() {
  const override = (process.env.PKM_NODE || "").trim();
  return override
    ? { cmd: override, env: { ...process.env } }
    : { cmd: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } };
}

/**
 * Invoke `pkm <args> --json` and parse its stdout.
 * @param {string[]} args - e.g. ["revoke", registryId, "seat@example.com"]
 * @param {string} [registry] - registry id the command applies to
 * @returns {Promise<{ok: boolean, data?: any, error?: string}>}
 */
function pkm(args, registry) {
  const P = pkmInfo(registry);

  const run = () =>
    new Promise((resolve) => {
      if (!fs.existsSync(P.bin)) {
        return resolve(fail(`pkm not found at ${P.bin} — set PKM_REPO in ⚙️ Config.`));
      }

      let out = "";
      let err = "";
      let settled = false;
      let child;
      let killTimer = null;

      const done = (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        resolve(v);
      };

      // A hung pkm must never wedge the UI: kill it and report, so the queue drains.
      const timer = setTimeout(() => {
        try {
          child?.kill("SIGTERM");
        } catch {
          /* already gone */
        }
        killTimer = setTimeout(() => {
          try {
            child?.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }, 1500);
        done(fail(`pkm ${args[0]} timed out after ${Math.round(P.timeoutMs / 1000)}s and was killed.`));
      }, P.timeoutMs);

      try {
        const { cmd, env } = nodeRuntime();
        child = spawn(cmd, [P.bin, ...args, "--json"], { cwd: P.repo, env });
      } catch (e) {
        return done(fail(`could not run pkm: ${e.message}`));
      }

      child.stdout.on("data", (d) => (out += d.toString()));
      child.stderr.on("data", (d) => (err += d.toString()));
      child.on("error", (e) => done(fail(`could not run pkm: ${e.message}`)));
      child.on("close", (code) => {
        if (code !== 0) {
          // stderr only — stdout may hold a licence string.
          const detail = err.trim().split("\n").filter(Boolean).slice(-3).join("\n");
          return done(fail(detail || `pkm exited with code ${code}`));
        }
        try {
          done({ ok: true, data: JSON.parse(out) });
        } catch {
          done(fail("pkm returned output that was not valid JSON"));
        }
      });
    });

  chain = chain.then(run, run);
  return chain;
}

/* ── Registries ────────────────────────────────────────────────────────────── */

/**
 * Every registry in the store, with its app id, engine, default ring, ring and
 * seat counts, and any embedded-blocklist verifier targets.
 */
export function registries() {
  return pkm(["registry", "list"]);
}

/* ── Host status ───────────────────────────────────────────────────────────── */

/**
 * Is pkm reachable, and what does the store contain?
 * Backs the tab header + the registry picker so a missing repo or a store that
 * moved is obvious rather than mysterious.
 */
export async function status(registry) {
  const P = pkmInfo(registry);
  const base = {
    pkmRepo: P.repo,
    pkmBin: P.bin,
    storeRoot: P.store,
    indexFile: P.indexFile,
    registry: P.registry,
    timeoutMs: P.timeoutMs,
  };
  if (!fs.existsSync(P.bin)) return { ok: true, data: { ...base, present: false, registries: [], entry: null } };

  // doctor = health (loose permissions, authority key, per-registry revocation
  // counts); registry list = the authoritative roster incl. verifier targets.
  const [doc, list] = await Promise.all([pkm(["doctor"], registry), registries()]);
  if (!doc.ok) return { ok: false, error: doc.error };

  const byId = new Map();
  for (const r of (list.ok && list.data.registries) || []) byId.set(r.id, { ...r });
  for (const r of doc.data.registries || []) {
    const cur = byId.get(r.id) || { id: r.id };
    byId.set(r.id, { ...cur, ...r, verifierTargets: cur.verifierTargets || {} });
  }
  const all = [...byId.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));

  return {
    ok: true,
    data: {
      ...base,
      present: true,
      registries: all,
      entry: all.find((r) => r.id === P.registry) || null,
      loosePermissions: doc.data.loosePermissions ?? null,
      authorityPublicKey: doc.data.authorityPublicKey ?? null,
    },
  };
}

/* ── Rings ─────────────────────────────────────────────────────────────────── */

/** Master key rings for a registry (kid, publicKey, notAfter, retired). */
export function rings(registry) {
  return pkm(["ring", "list", pkmInfo(registry).registry]);
}

/** Mint a new master ring. The first ring in a registry also becomes its default. */
export function ringCreate(registry, kid) {
  const id = pkmInfo(registry).registry;
  return pkm(["ring", "create", id, "--kid", String(kid || "").trim()]);
}

/** Retire a ring (sets notAfter) — verifiers then reject licences signed by it. */
export function ringRetire(registry, kid, at) {
  const id = pkmInfo(registry).registry;
  const args = ["ring", "retire", id, "--kid", String(kid || "").trim()];
  if (at) args.push("--at", String(at).trim());
  return pkm(args);
}

/** Regenerate the X25519 agent keypair (ed25519+x25519 registries only). */
export function agentKey(registry) {
  return pkm(["ring", "agent-key", pkmInfo(registry).registry]);
}

/** Choose which ring signs newly issued seats. */
export function setDefaultKid(registry, kid) {
  const id = pkmInfo(registry).registry;
  return pkm(["registry", "set-default", id, "--kid", String(kid || "").trim()]);
}

/* ── Seats ─────────────────────────────────────────────────────────────────── */

/**
 * Every seat with its status and days left, worst-first.
 * Uses `check-exp` rather than `list` on purpose. NOTE: `check-exp` archives
 * already-expired ledger records as a side effect (it never revokes anything);
 * the explicit "Archive expired" button is for the deliberate case.
 */
export function listSeats(registry, days = 30) {
  const id = pkmInfo(registry).registry;
  return pkm(["check-exp", id, "--days", String(days)]);
}

/** Issue a seat licence. Returns `data.licenseKey` — display once, never log. */
export function issueSeat(registry, sub, exp) {
  const id = pkmInfo(registry).registry;
  return pkm(["issue", id, String(sub), "--exp", String(exp)]);
}

/** Revoke a seat (tombstones the ledger record; live-enforced on next verify). */
export function revokeSeat(registry, sub, reason) {
  const id = pkmInfo(registry).registry;
  const args = ["revoke", id, String(sub)];
  if (reason) args.push("--reason", String(reason));
  return pkm(args);
}

/** Reinstate a previously revoked seat. */
export function unrevokeSeat(registry, sub) {
  return pkm(["unrevoke", pkmInfo(registry).registry, String(sub)]);
}

/** Archive expired ledger records (explicit — Refresh only does this implicitly). */
export function archiveExpired(registry) {
  return pkm(["archive-expired", pkmInfo(registry).registry]);
}

/** Seat issue/revoke/expiry history. */
export function audit(registry) {
  return pkm(["audit", pkmInfo(registry).registry]);
}

/* ── Verify ────────────────────────────────────────────────────────────────── */

/** Validate a licence string against the live ring + revocation blocklist. */
export function validate(registry, licenseKey) {
  return pkm(["validate", pkmInfo(registry).registry, String(licenseKey)]);
}

/* ── Sync into consumer apps ───────────────────────────────────────────────── */

/**
 * Rewrite the blocklist embedded in a registry's verifier source files.
 * Required for registries that embed their blocklist (e.g. `transcription-agent`
 * — electron/src/main/license.ts + python-backend/license.py); the consumer app
 * must then be rebuilt for an offline revoke to take effect.
 */
export function syncRevocation(registry) {
  return pkm(["sync-revocation", pkmInfo(registry).registry]);
}
