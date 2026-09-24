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
 * ── CAPABILITY GATE ────────────────────────────────────────────────────────
 * The app is a client of the key store, never a second implementation of it.
 * `COMMANDS` declares every command this file may run and whether it writes;
 * `gateFor()` refuses a command *before spawning* when the store cannot support
 * it (no `pkm` binary, no readable index, no master ring, an ed25519 registry
 * asked for an agent key, an unreadable revocation blocklist). `capabilities()`
 * is the same verdict reported to the renderer, so a disabled button and a
 * refused call always agree — and the refusal lives here, not in the UI.
 *
 * Every command is serialised through a single promise chain: mutations make
 * `pkm` rewrite `export/*.json`, so overlapping runs would race on those files.
 * Each run is therefore hard-bounded by a timeout — a hung CLI can delay the
 * queue but can never freeze it forever.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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

/* ── Capabilities — the declared sensitive surface ─────────────────────────── */

/**
 * Every command this adapter may run, and what the store must satisfy first.
 *
 * This map IS the app's licence surface: the renderer can only ask for one of
 * these names, and `pkm()` refuses *before spawning anything* when the store
 * cannot support the request. Nothing in this repo mints, revokes, retires or
 * re-signs a licence — `personal_key_manager` owns all of that, and the gate is
 * what keeps the boundary intact even if a renderer bug re-enables a button.
 *
 *   write        the command mutates the store
 *   needs:ring   at least one master ring exists (issue/set-default)
 *   needs:agent  the registry is ed25519+x25519, so it has (or can have) an
 *                X25519 peer key — `ring agent-key` throws on ed25519, which is
 *                why the Key Manager's Agent key button used to be clickable and
 *                always fail (see the hint in renderPkmRingsHint())
 *
 * The blocklist check is not a `needs` entry: an unreadable/missing blocklist
 * blocks EVERY write (see `gateFor`), because while revocation is not being
 * enforced there is no safe seat change — and a `revoke` writes to that very file.
 */
const COMMANDS = {
  // Reads
  doctor: { write: false },
  registryList: { write: false },
  ringList: { write: false },
  seats: { write: false },
  audit: { write: false },
  validate: { write: false },
  challenge: { write: false },
  selfTest: { write: false },
  revocation: { write: false },
  bundle: { write: false },
  perms: { write: false },
  // `pkm authority` calls ensureAuthority(), which MINTS the export-signing keypair
  // when it is missing — a read-shaped command that writes, so it is gated.
  authority: { write: true, needs: [] },
  // Writes
  issue: { write: true, needs: ["ring"] },
  revoke: { write: true, needs: [] },
  unrevoke: { write: true, needs: [] },
  archive: { write: true, needs: [] },
  ringCreate: { write: true, needs: [] },
  ringRetire: { write: true, needs: [] },
  agentKey: { write: true, needs: ["agent"] },
  setDefault: { write: true, needs: ["ring"] },
  syncRevocation: { write: true, needs: [] },
  permsFix: { write: true, needs: [] },
  exportBundle: { write: true, needs: [] },
};

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
 * Invoke `pkm <args> --json` and parse its stdout. UNGATED.
 *
 * Only the capability probe calls this directly: it cannot ask the gate whether
 * the gate is able to run. Every other caller goes through `pkm()` below.
 *
 * @param {string[]} args - e.g. ["revoke", registryId, "seat@example.com"]
 * @param {object} P - resolved paths from pkmInfo()
 * @returns {Promise<{ok: boolean, data?: any, error?: string}>}
 */
function runPkm(args, P) {
  return new Promise((resolve) => {
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
}

/* ── The gate ──────────────────────────────────────────────────────────────── */

/** Read a JSON file, distinguishing "absent" from "present but unparseable". */
function readStoreJson(file) {
  if (!fs.existsSync(file)) return { state: "absent", data: null };
  try {
    return { state: "ok", data: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {
    return { state: "corrupt", data: null };
  }
}

/**
 * Cheap filesystem view of the store — no CLI spawn, so it is safe to consult
 * before every command.
 *
 * This exists because `pkm` itself cannot express these states: its `readJson()`
 * turns a corrupt file and a missing one into the same fallback, so
 * "revocation is broken" and "nothing has ever been revoked" are indistinguishable
 * from the CLI alone.
 *
 * @param {object} P - resolved paths from pkmInfo()
 */
export function storeFiles(P) {
  const index = readStoreJson(P.indexFile);
  const ring = readStoreJson(P.ringFile);
  const revoked = readStoreJson(P.revokedFile);

  const ringKeys = ring.state === "ok" && Array.isArray(ring.data?.keys) ? ring.data.keys : [];
  const revokedSeats = revoked.state === "ok" && Array.isArray(revoked.data?.seats) ? revoked.data.seats : [];

  // Tombstoned seat records on disk. A registry that HAS revocations but no
  // blocklist file is the dangerous combination: the login path
  // (scripts/frontdesk-license.mjs → loadRevokedSeats) silently reads [] there,
  // so revocation stops applying while everything else looks healthy.
  let revokedLedger = 0;
  let registryDir = false;
  try {
    registryDir = fs.existsSync(P.registryDir);
    if (registryDir) {
      for (const kidBase of fs.readdirSync(P.registryDir)) {
        const dir = path.join(P.registryDir, kidBase, "revoked");
        if (!fs.existsSync(dir)) continue;
        revokedLedger += fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length;
      }
    }
  } catch {
    /* unreadable registry dir — the caller reports it as missing */
  }

  // `absent` with no tombstoned seats is the normal state of a fresh registry
  // (pkm only writes the file on the first revoke), so it is not a fault.
  const blocklist =
    revoked.state === "corrupt" ? "unreadable" : revoked.state === "absent" ? (revokedLedger > 0 ? "missing" : "none") : "ok";

  return {
    bin: fs.existsSync(P.bin),
    store: fs.existsSync(P.store),
    indexOk: index.state === "ok" && Array.isArray(index.data?.registries),
    indexState: index.state,
    registryKnown: Boolean(P.entry),
    registryDir,
    ringKeys: ringKeys.length,
    ringState: ring.state,
    blocklist,
    revokedSeats: revokedSeats.length,
    revokedLedger,
    engine: P.engine,
    hasAgentKey: fs.existsSync(path.join(P.agentDir, "agent-private.key")),
    verifierTargets: Object.keys(P.verifierTargets || {}),
  };
}

/** Human sentence for a blocklist that is not being enforced. */
function blocklistReason(P, f) {
  return f.blocklist === "unreadable"
    ? `${P.revokedFile} could not be parsed, so revoked seats are NOT being blocked.`
    : `${f.revokedLedger} revoked seat record(s) exist on disk but ${P.revokedFile} is missing, so revoked seats are NOT being blocked.`;
}

/**
 * Gate one command against the store.
 * @returns {{ok: true} | {ok: false, error: string}} - the error is shown verbatim.
 */
function gateFor(P, cap) {
  const f = storeFiles(P);

  if (!f.bin) return { ok: false, error: `read-only: pkm not found at ${P.bin} — set PKM_REPO in ⚙️ Config.` };
  if (!f.indexOk) {
    return {
      ok: false,
      error: `read-only: no readable registry index at ${P.indexFile} — set PKM_ROOT / PKM_REPO in ⚙️ Config.`,
    };
  }
  if (!cap.write) return { ok: true };

  // A write is scoped to one registry, so an unknown one must not reach `pkm`
  // either — otherwise the per-action verdicts would say "ok" for commands that
  // pkm is certain to reject ("Unknown registry").
  if (!f.registryKnown || !f.registryDir) {
    return { ok: false, error: `read-only: registry "${P.registry}" is not in the store (${P.indexFile}).` };
  }

  if (f.blocklist === "unreadable" || f.blocklist === "missing") {
    return { ok: false, error: `read-only: ${blocklistReason(P, f)} Fix the blocklist before changing seats.` };
  }

  for (const need of cap.needs || []) {
    if (need === "ring" && f.ringKeys === 0) {
      return { ok: false, error: `read-only: registry "${P.registry}" has no master ring yet — create one first.` };
    }
    if (need === "agent" && f.engine !== "ed25519+x25519") {
      return {
        ok: false,
        error: `read-only: registry "${P.registry}" uses engine "${f.engine}", so its certs carry no agent (enc) key.`,
      };
    }
  }
  return { ok: true };
}

/**
 * Invoke a gated `pkm <args> --json`.
 *
 * @param {string[]} args - argv, without the trailing --json (added here)
 * @param {string} [registry] - registry id the command applies to
 * @param {keyof COMMANDS} capability - which declared command this is; the gate
 *   refuses it (without spawning) when the store cannot support it
 * @returns {Promise<{ok: boolean, data?: any, error?: string}>}
 */
function pkm(args, registry, capability) {
  const P = pkmInfo(registry);
  const cap = capability === undefined ? null : COMMANDS[capability];

  if (capability !== undefined && !cap) {
    return Promise.resolve(fail(`internal: unknown capability "${capability}"`));
  }
  if (cap) {
    const gate = gateFor(P, cap);
    if (!gate.ok) return Promise.resolve(gate);
  }

  const run = () => runPkm(args, P);
  chain = chain.then(run, run);
  return chain;
}

/* ── Capability report (for the dashboard) ─────────────────────────────────── */

/** CLI liveness is a process spawn, so cache it per registry. */
const cliCache = new Map();
const CLI_TTL_MS = 60000;

/**
 * Can the app act, and if not, why not?
 *
 * One report drives every disabled control: `state` is the headline, `reason` is
 * the sentence to show, and `actions` carries a per-command verdict so a button
 * that is unavailable for a narrower reason (Agent key on an ed25519 registry)
 * says so itself rather than inheriting the headline.
 *
 * @param {string} [registry]
 * @param {{fresh?: boolean}} [opts] - `fresh` bypasses the cached CLI probe
 */
export async function capabilities(registry, { fresh = false } = {}) {
  const P = pkmInfo(registry);
  const key = P.registry;

  const cached = cliCache.get(key);
  let cli;
  if (!fresh && cached && Date.now() - cached.checkedAt < CLI_TTL_MS) {
    cli = cached;
  } else {
    // `doctor` is a pure report (no writes, no export refresh), so it is safe to
    // run outside the serialised chain. Its payload is cached with the verdict so
    // status() can reuse it instead of spawning a second doctor.
    const res = await runPkm(["doctor"], P);
    cli = {
      ok: res.ok,
      error: res.ok ? null : res.error || "pkm doctor failed",
      data: res.ok ? res.data : null,
      checkedAt: Date.now(),
    };
    cliCache.set(key, cli);
  }

  const f = storeFiles(P);

  let state = "ready";
  let reason = null;
  if (!f.bin) {
    state = "cli-missing";
    reason = `pkm was not found at ${P.bin}. Set PKM_REPO / PKM_BIN in ⚙️ Config to point at the personal_key_manager checkout.`;
  } else if (!f.indexOk) {
    state = "store-missing";
    reason = `No readable registry index at ${P.indexFile}. Set PKM_ROOT / PKM_REPO in ⚙️ Config to point at the key store.`;
  } else if (!f.registryKnown || !f.registryDir) {
    state = "store-missing";
    reason = `Registry "${P.registry}" is not in the store (${P.indexFile}).`;
  } else if (!cli.ok) {
    state = "cli-broken";
    reason = `pkm is present but not answering: ${cli.error}`;
  } else if (f.blocklist === "unreadable" || f.blocklist === "missing") {
    state = `blocklist-${f.blocklist}`;
    reason = `${blocklistReason(P, f)} Logins still work — but seat changes are disabled until this is fixed.`;
  } else if (f.ringKeys === 0) {
    state = "read-only";
    reason = `Registry "${P.registry}" has no master ring yet, so no seat can be issued. Create one first.`;
  }

  const actions = {};
  for (const [name, cap] of Object.entries(COMMANDS)) {
    if (!cap.write) continue;
    const gate = gateFor(P, cap);
    actions[name] = { ok: gate.ok, reason: gate.ok ? null : gate.error.replace(/^read-only: /, "") };
  }

  return {
    ok: true,
    data: {
      state,
      // A mutation is allowed only in the two states where the store is intact.
      writable: state === "ready" || state === "read-only",
      reason,
      cli: { ok: cli.ok, error: cli.error, checkedAt: cli.checkedAt },
      // The raw `pkm doctor` report (paths, counts, loose permissions, the export
      // authority public key). No secrets — read commands never print a licence.
      doctor: cli.data,
      actions,
      checkedAt: Date.now(),
      files: {
        bin: f.bin,
        store: f.store,
        indexOk: f.indexOk,
        registryKnown: f.registryKnown,
        registryDir: f.registryDir,
        ringKeys: f.ringKeys,
        blocklist: f.blocklist,
        revokedSeats: f.revokedSeats,
        revokedLedger: f.revokedLedger,
        engine: f.engine,
        hasAgentKey: f.hasAgentKey,
        verifierTargets: f.verifierTargets,
      },
      paths: {
        repo: P.repo,
        store: P.store,
        registry: P.registry,
        bin: P.bin,
        registryDir: P.registryDir,
        indexFile: P.indexFile,
        ringFile: P.ringFile,
        revokedFile: P.revokedFile,
      },
    },
  };
}

/* ── Registries ────────────────────────────────────────────────────────────── */

/**
 * Every registry in the store, with its app id, engine, default ring, ring and
 * seat counts, and any embedded-blocklist verifier targets.
 */
export function registries() {
  return pkm(["registry", "list"], undefined, "registryList");
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

  // The capability report is what the renderer gates every control on, so it is
  // part of this payload even when the CLI is absent (the fs checks still answer).
  const caps = await capabilities(registry);

  if (!fs.existsSync(P.bin)) {
    return { ok: true, data: { ...base, present: false, registries: [], entry: null, capabilities: caps.data } };
  }

  // doctor = health (loose permissions, authority key, per-registry revocation
  // counts); registry list = the authoritative roster incl. verifier targets.
  // The doctor payload comes from the capability probe's cache, so this is one
  // spawn, not two.
  const list = await registries();
  const doc = { ok: caps.data.cli.ok, error: caps.data.cli.error, data: caps.data.doctor || {} };
  if (!doc.ok) {
    // A CLI that is present but broken is its own state, not a missing store.
    return { ok: false, error: doc.error, data: { ...base, present: true, registries: [], entry: null, capabilities: caps.data } };
  }

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
      capabilities: caps.data,
    },
  };
}

/* ── Rings ─────────────────────────────────────────────────────────────────── */

/** Master key rings for a registry (kid, publicKey, notAfter, retired). */
export function rings(registry) {
  return pkm(["ring", "list", pkmInfo(registry).registry], registry, "ringList");
}

/** Mint a new master ring. The first ring in a registry also becomes its default. */
export function ringCreate(registry, kid) {
  const id = pkmInfo(registry).registry;
  return pkm(["ring", "create", id, "--kid", String(kid || "").trim()], registry, "ringCreate");
}

/** Retire a ring (sets notAfter) — verifiers then reject licences signed by it. */
export function ringRetire(registry, kid, at) {
  const id = pkmInfo(registry).registry;
  const args = ["ring", "retire", id, "--kid", String(kid || "").trim()];
  if (at) args.push("--at", String(at).trim());
  return pkm(args, registry, "ringRetire");
}

/** Regenerate the X25519 agent keypair (ed25519+x25519 registries only). */
export function agentKey(registry) {
  return pkm(["ring", "agent-key", pkmInfo(registry).registry], registry, "agentKey");
}

/** Choose which ring signs newly issued seats. */
export function setDefaultKid(registry, kid) {
  const id = pkmInfo(registry).registry;
  return pkm(["registry", "set-default", id, "--kid", String(kid || "").trim()], registry, "setDefault");
}

/* ── Seats ─────────────────────────────────────────────────────────────────── */

/**
 * Every seat with its status and days left, worst-first.
 * Uses `check-exp` rather than `list` on purpose. NOTE: `check-exp` archives
 * already-expired ledger records as a side effect (it never revokes anything);
 * the explicit "Archive expired" button is for the deliberate case. pkm has no
 * list command that skips that — a `--no-archive` flag there is the follow-up.
 *
 * @param {number} [days] - the "expiring" window; pkm defaults to 30
 */
export function listSeats(registry, days) {
  const id = pkmInfo(registry).registry;
  const won = Number(days) > 0 ? Number(days) : 30;
  return pkm(["check-exp", id, "--days", String(won)], registry, "seats");
}

/**
 * Look up one seat in the ledger (status, ring, expiry).
 *
 * Backs the Issue dialog's two guards. `pkm issue` checks neither: it will mint a
 * key for a seat the blocklist already rejects, and it overwrites
 * `issued/<sub>.key` (a fresh keypair) with no notice, orphaning anything already
 * encrypted under the old seat key.
 */
export async function seatInfo(registry, sub) {
  const seat = String(sub || "").trim();
  if (!seat) return fail("Seat id is required.");
  const res = await listSeats(registry);
  if (!res.ok) return res;
  const row = (res.data.rows || []).find((r) => String(r.sub) === seat) || null;
  return { ok: true, data: { found: Boolean(row), row } };
}

/**
 * Refuse to mint a licence for a seat the blocklist already rejects.
 *
 * `collectSeatRecords()` marks any record whose `sub` is in the blocklist
 * `revoked: true` — including one just re-issued — and the login path
 * (`scripts/frontdesk-license.mjs` → `loadRevokedSeats()`) answers
 * `revoked_seat`, which is checked *before* the signature. So the operator would
 * be handed a display-once key that can never log in. Unrevoke first.
 */
export async function guardIssuable(registry, sub) {
  const info = await seatInfo(registry, sub);
  // An unreadable ledger is not a reason to block: `issue` is already gated and
  // would report the same underlying problem in its own words.
  if (!info.ok) return { ok: true, data: { checked: false } };
  const row = info.data.row;
  if (row && (row.revoked === true || row.status === "revoked")) {
    return fail(
      `"${String(sub).trim()}" is on the revocation blocklist, so a new licence would be refused at login. Reinstate the seat first, or issue under a different seat id.`,
    );
  }
  return { ok: true, data: { checked: true, found: info.data.found, row } };
}

/**
 * Issue a seat licence. Returns `data.licenseKey` — display once, never log.
 *
 * `sub` in the registry's blocklist is rejected by the caller, not here: pkm
 * will happily mint a key for a revoked seat that the login path then refuses,
 * so `pkm:issue` runs guardIssuable() first.
 *
 * @param {string} [exp] - a date or "unlimited"
 * @param {{kid?: string, withEnc?: boolean}} [opts] - mirror the CLI's --kid / --with-enc
 */
export function issueSeat(registry, sub, exp, opts = {}) {
  const id = pkmInfo(registry).registry;
  const args = ["issue", id, String(sub), "--exp", String(exp)];
  if (opts.kid) args.push("--kid", String(opts.kid).trim());
  if (opts.withEnc) args.push("--with-enc");
  return pkm(args, registry, "issue");
}

/** Revoke a seat (tombstones the ledger record; live-enforced on next verify). */
export function revokeSeat(registry, sub, reason) {
  const id = pkmInfo(registry).registry;
  const args = ["revoke", id, String(sub)];
  if (reason) args.push("--reason", String(reason));
  return pkm(args, registry, "revoke");
}

/** Reinstate a previously revoked seat. */
export function unrevokeSeat(registry, sub) {
  return pkm(["unrevoke", pkmInfo(registry).registry, String(sub)], registry, "unrevoke");
}

/** Archive expired ledger records (explicit — Refresh only does this implicitly). */
export function archiveExpired(registry) {
  return pkm(["archive-expired", pkmInfo(registry).registry], registry, "archive");
}

/** Seat issue/revoke/expiry history. */
export function audit(registry) {
  return pkm(["audit", pkmInfo(registry).registry], registry, "audit");
}

/* ── Verify (read-only) ────────────────────────────────────────────────────── */

/** Validate a licence string against the live ring + revocation blocklist. */
export function validate(registry, licenseKey) {
  return pkm(["validate", pkmInfo(registry).registry, String(licenseKey)], registry, "validate");
}

/**
 * Simulate the client login handshake for a licence.
 *
 * Strictly stronger than `validate`: it proves the seat can complete the
 * challenge/response the webapp performs at login, which is the question an
 * operator actually has when handing a key over.
 */
export function challenge(registry, licenseKey) {
  return pkm(["challenge-test", pkmInfo(registry).registry, String(licenseKey)], registry, "challenge");
}

/**
 * ECDH → AES-256-GCM round trip for a licence (ed25519+x25519 registries only).
 * Catches a FRONTDESK_AGENT_PUBKEY mismatch, which otherwise only shows up as
 * "Reply decrypt failed" in a browser console.
 */
export function selfTest(registry, licenseKey) {
  return pkm(["crypto-self-test", pkmInfo(registry).registry, String(licenseKey)], registry, "selfTest");
}

/**
 * Reject test + verifier parity: does a revoked seat still get rejected, and do
 * the consumer apps that embed the blocklist match the authoritative file?
 */
export function checkRevocation(registry) {
  return pkm(["check-revocation", pkmInfo(registry).registry], registry, "revocation");
}

/** Report group/other-accessible key paths (read-only). */
export function permsReport() {
  return pkm(["perms"], undefined, "perms");
}

/** Tighten those permissions (`pkm perms --fix`). */
export function permsFix() {
  return pkm(["perms", "--fix"], undefined, "permsFix");
}

/** Re-sign the export bundle (`export/devmon.json` + its signature). */
export function exportBundle() {
  return pkm(["export"], undefined, "exportBundle");
}

/** Verify the export bundle against its detached signature (read-only). */
export function verifyBundle() {
  return pkm(["verify-bundle"], undefined, "bundle");
}

/* ── Sync into consumer apps ───────────────────────────────────────────────── */

/**
 * Rewrite the blocklist embedded in a registry's verifier source files.
 * Required for registries that embed their blocklist (e.g. `transcription-agent`
 * — electron/src/main/license.ts + python-backend/license.py); the consumer app
 * must then be rebuilt for an offline revoke to take effect.
 */
export function syncRevocation(registry) {
  return pkm(["sync-revocation", pkmInfo(registry).registry], registry, "syncRevocation");
}
