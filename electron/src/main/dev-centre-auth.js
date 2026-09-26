/**
 * Dev Centre authentication — the gate.
 *
 * Design, in one paragraph: `.env` `DEV_CENTRE_ADMINS` lists the ADMINS as
 * `email:secret` pairs and they are always `tier_1` (everything). Everybody else
 * lives in the gitignored role registry (`safe/dev-centre-roles.json`, see
 * `dev-centre-roles.js`) at `tier_2` — everything except the Key Manager and
 * Accounts & Keys. A secret is either a plaintext string or a `scrypt$…`
 * verifier minted by `pkm claims set … --password-stdin`. A successful login
 * starts a WALL-CLOCK session (`DEV_CENTRE_SESSION_LIMIT` seconds, 12 h default)
 * whose deadline is appended to a gitignored session log; the deadline is
 * re-checked on every launch and the session is resumed when it is still valid.
 * The session is never interrupted while the app runs. Logging out is an explicit
 * operator action (`logout()`): it appends a terminal `logout` row to the session
 * log — which is what stops the next launch RESUMING the session — and drops the
 * in-memory session so the window can return to the gate for a different address.
 *
 * Everything here is pure filesystem + crypto: no `pkm` CLI, no child process, no
 * network. A broken or moved key store cannot lock the operator out of their own
 * desktop app, which is the whole reason the primary credentials live here rather
 * than in the seat ledger.
 *
 * A SEAT LICENCE is accepted as a SECOND way in (`licence-verifier.js`, a CJS port of
 * the frontdesk verifier). It is consulted only when the typed address is in neither
 * `.env` nor the role registry, so it is purely ADDITIVE — every existing credential
 * keeps the exact semantics it had, including a `TA1…` stored as a plaintext secret.
 * The cert's signed `email` claim then decides the role against the HIDDEN admin list
 * in `dev-centre-admin-emails.js`: listed ⇒ `tier_1`, anything else ⇒ `tier_2`. That
 * list is a source constant rather than a config key precisely so it reaches no config
 * surface — including the Config tab's Raw JSON view, which renders every key.
 *
 * FAIL CLOSED, with one deliberate exception: a missing/corrupt registry or `.env`
 * means "no credentials", never "no gate". Entry is a match against `.env` admins, a
 * registry user, or a verified seat licence. A missing KEY STORE closes the licence
 * path only — it cannot widen access, because it can only remove a way in that was
 * never a local credential to begin with.
 *
 * SECRETS ARE NEVER LOGGED OR RETURNED. The session log records the email, the role,
 * the deadline and a failure REASON (`unknown_email` | `bad_key` | …) — the typed
 * secret, the stored secret and the licence string never reach a log line, an IPC
 * payload or a thrown error message.
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const pwdv = require("./password-verifier");
const roles = require("./dev-centre-roles");
const adminEmails = require("./dev-centre-admin-emails");
const licences = require("./licence-verifier");

/** Session length when `DEV_CENTRE_SESSION_LIMIT` is absent or unusable. */
const DEFAULT_SESSION_LIMIT_SECONDS = 43200; // 12 h

/** `.env` key holding the admin list. Read from `.env` first (see `readSetting`). */
const ADMINS_KEY = "DEV_CENTRE_ADMINS";

/** `.env` key holding the session length in SECONDS. */
const SESSION_LIMIT_KEY = "DEV_CENTRE_SESSION_LIMIT";

/**
 * `source` prefix for a session opened with a seat licence, e.g. `licence:frontdesk-agent`.
 * The registry id is not a secret and it is what makes a session log readable after the
 * fact — the alternative, recording the licence, would put a private key in a log line.
 */
const LICENCE_SOURCE_PREFIX = "licence:";

/**
 * Operator-facing text for each `verifyLicenseKey()` failure. The raw code is appended
 * in parentheses, so the message stays useful to a human without losing the exact reason
 * for a bug report. Deliberately generic about WHO a licence belongs to: see the comment
 * in `resolveLicenceSignIn()` about not echoing a cert's email onto a locked screen.
 */
const LICENCE_REASON_TEXT = {
  malformed: "that is not a licence string",
  malformed_cert: "that licence's certificate cannot be read",
  app_mismatch: "that licence was issued for a different app, or a newer format than this build understands",
  unknown_kid: "that licence was signed by a key this device's key store does not know",
  retired_kid: "the master key that signed that licence has been retired",
  revoked_seat: "that seat has been revoked",
  bad_signature: "that licence's signature does not verify",
  bad_seat_key: "that licence's seat key cannot be read",
  key_mismatch: "that licence's seat key does not match its certificate",
  expired: "that licence has expired",
  no_enc_key: "that licence carries no encryption key",
};

/**
 * The session-log events that say something about the CURRENT session. `hydrate()`
 * reads the last one of these to decide whether to resume; everything else
 * (`app_start`, `denied`) is noise for that purpose.
 */
const SESSION_EVENTS = new Set(["login", "logout", "session_expired", "session_revoked"]);

/**
 * Channels that must work before anyone is signed in — the gate's own API.
 * Everything else is refused while locked, which is what makes the gate real:
 * the renderer hiding a tab is cosmetic, this is the enforcement.
 *
 * `app:version` and `app:getTheme` are here for the menu-bar panel, which has to be
 * able to say "locked, sign in" without rendering in the wrong palette. Both are
 * cosmetic — a version string and the current light/dark choice — and the mutating
 * `app:setTheme` / `app:setAppearance` are deliberately NOT.
 *
 * `app:quit` is here because the gate IS the window: its × used to hide the window and
 * leave a locked operator with no way out of the app except the tray's right-click menu
 * or Cmd+Q. Quitting reveals nothing, it is not accounts/keys, and a close of the window
 * itself while the gate is showing does the same thing (see main.js's `close` handler) —
 * so both routes agree instead of one of them quietly backgrounding the app.
 *
 * The panel's own window management is here for a harder reason: the panel is reachable
 * from the menu bar WITHOUT signing in, so while it is locked it still has to be able to
 * hide itself, zoom itself, and — `tray:openDashboard` — provide the only route from the
 * panel to the gate. Refusing those would leave a locked operator looking at a panel
 * that neither dismisses nor leads anywhere. None of the three touches the app's data.
 *
 * `auth:logout` is here for a specific reason: a session that LAPSES while the dashboard
 * is open does not re-lock the window (see `gateShowing` in main.js), so `authorize` would
 * refuse the operator's own Log Out with `locked` — an error they cannot clear from the
 * screen they are on. Ending a session is always permitted; the handler no-ops when there
 * is nothing to end.
 */
const ALWAYS_OPEN = new Set([
  "auth:state",
  "auth:login",
  "auth:logout",
  "app:version",
  "app:getTheme",
  "app:quit",
  "tray:hidePopover",
  "tray:zoom",
  "tray:openDashboard",
]);

/**
 * Channel groups only `tier_1` may use. `tier_2` is "everything except
 * accounts/keys and key manager", so these two prefixes are the whole difference.
 * The groups are refused for BOTH reads and writes — "cannot access the Key
 * Manager" has to include `pkm:status` and `pkm:list`, or the panel would render
 * seats and rings for a role that is not allowed to see them.
 */
const TIER_1_ONLY = [/^pkm:/, /^accounts:/];

/** In-memory session. `null` = locked. Hydrated from the log at startup. */
let session = null;

/** Configured repo root; `null` until `configure()` runs. */
let repoOverride = null;

/** Lazily resolved `shared/config-loader.cjs` (see `configModule`). */
let cachedConfig = null;

// ── Wiring ────────────────────────────────────────────────────────────────────

/**
 * Point the gate at a repo root. main.js calls this once with the same `REPO` it
 * resolved for everything else, so the packaged app reads `.env`, `safe/` and
 * `logs/` from `process.resourcesPath` rather than from inside the asar.
 */
function configure({ repo } = {}) {
  repoOverride = repo || null;
  session = null;
  return repoRoot();
}

/** The effective repo root. */
function repoRoot() {
  return roles.repoRoot(repoOverride);
}

/**
 * `shared/config-loader.cjs`, resolved against the configured repo root so the
 * packaged layout works. Falls back to the path relative to this file (the dev
 * tree) so a misconfigured root degrades instead of throwing at import time.
 */
function configModule() {
  if (cachedConfig) return cachedConfig;
  const candidates = [
    path.join(repoRoot(), "shared", "config-loader.cjs"),
    path.resolve(__dirname, "..", "..", "..", "shared", "config-loader.cjs"),
  ];
  for (const candidate of candidates) {
    try {
      cachedConfig = require(candidate);
      return cachedConfig;
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error("shared/config-loader.cjs not found — cannot read the admin list");
}

/**
 * Resolve one setting. Precedence is `.env` → `config.json` → `process.env` →
 * default, i.e. `.env` first because the operator asked for `.env` to be the
 * source of truth for the admin list, while still honouring a Config-tab-managed
 * `config.json` and a shell injection for one-off runs.
 *
 * NOTE: config-loader's own precedence is the opposite (config.json wins). The
 * inversion is deliberate and documented; `DEV_CENTRE_ADMINS` is never written by
 * the Config tab (it is redacted out of every config surface), so the two sources
 * cannot silently disagree in practice.
 */
function readSetting(key, fallback) {
  const cfg = configModule();
  const env = cfg.readEnv();
  if (typeof env[key] === "string" && env[key] !== "") return { value: env[key], source: ".env" };
  try {
    const file = cfg.readConfigFile() || {};
    if (typeof file[key] === "string" && file[key] !== "") return { value: file[key], source: "config.json" };
  } catch {
    /* corrupt config.json — fall through */
  }
  if (typeof process.env[key] === "string" && process.env[key] !== "") {
    return { value: process.env[key], source: "process.env" };
  }
  return { value: fallback, source: null };
}

// ── Admin list ────────────────────────────────────────────────────────────────

/**
 * Parse `email:secret[,email:secret…]`.
 *
 * Two `.env` realities this handles:
 *   - a QUOTED value keeps its literal quote characters (`config-loader`'s
 *     `parseEnv` skips `#`-comment stripping for a quoted value but does not
 *     unquote it), so one matching quote pair is stripped here;
 *   - the secret is taken VERBATIM after the first `:` — do not pad it with
 *     spaces, because a space becomes part of the secret. A `scrypt$…` verifier
 *     never contains whitespace, and the CLI round-trips plaintext exactly.
 *
 * @returns {{admins: Map<string,string>, problems: string[]}}
 */
function parseAdmins(raw) {
  const text = String(raw ?? "").trim();
  const unquoted = /^(["'])[\s\S]*\1$/.test(text) ? text.slice(1, -1) : text;
  const admins = new Map();
  const problems = [];

  for (const part of unquoted.split(",")) {
    const item = part.trim();
    if (!item) continue;
    const colon = item.indexOf(":");
    if (colon <= 0) {
      problems.push(`ignored "${item.slice(0, 12)}…" — expected email:secret`);
      continue;
    }
    const email = pwdv.tryNormalizeEmail(item.slice(0, colon));
    const secret = item.slice(colon + 1);
    if (!email) {
      problems.push(`ignored "${item.slice(0, colon)}" — not a valid email address`);
      continue;
    }
    if (!secret) {
      problems.push(`ignored ${email} — empty secret`);
      continue;
    }
    if (pwdv.looksLikeVerifier(secret) && !pwdv.isPasswordVerifier(secret)) {
      problems.push(`${email} — the stored scrypt verifier is malformed, so this admin can never sign in`);
    }
    if (admins.has(email) && admins.get(email) !== secret) problems.push(`${email} is listed twice`);
    admins.set(email, secret);
  }

  return { admins, problems };
}

/** The configured admins, plus any parse complaints. Never leaves this module verbatim. */
function adminState() {
  const raw = readSetting(ADMINS_KEY, "");
  const { admins, problems } = parseAdmins(raw.value);
  return { admins, problems, source: raw.source };
}

// ── Credentials ───────────────────────────────────────────────────────────────

/**
 * Compare a stored secret with a typed one.
 *
 * A `scrypt$…` stored value is verified with pkm's own algorithm (so a verifier
 * minted by `pkm claims set` works here). Anything else is a plaintext compare
 * done over SHA-256 digests, which keeps the comparison constant-time and
 * length-independent — a bare `===` leaks the length and the matching prefix.
 *
 * A verifier in the STORE never falls back to plaintext: a malformed verifier
 * fails, it does not become a literal password.
 */
function verifySecret(stored, typed) {
  const a = String(stored ?? "");
  const b = String(typed ?? "");
  if (!a || !b) return false;
  if (pwdv.looksLikeVerifier(a)) return pwdv.checkPasswordVerifier(a, b);
  const digestA = crypto.createHash("sha256").update(a, "utf8").digest();
  const digestB = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

/**
 * Where a given email's credential lives, and at what role. `.env` admins win
 * over the registry — a conflict is reported as a problem rather than resolved
 * silently in either direction.
 */
function credentialFor(email) {
  const wanted = pwdv.tryNormalizeEmail(email);
  if (!wanted) return null;

  const { admins } = adminState();
  if (admins.has(wanted)) {
    return { email: wanted, role: "tier_1", secret: admins.get(wanted), source: ".env DEV_CENTRE_ADMINS" };
  }

  const user = roles.getUser(wanted, repoRoot());
  if (user && user.key) {
    return { email: wanted, role: user.role, secret: user.key, source: "safe/dev-centre-roles.json" };
  }
  return null;
}

// ── Session ───────────────────────────────────────────────────────────────────

/** Session length in seconds (`DEV_CENTRE_SESSION_LIMIT`, default 12 h). */
function sessionLimitSeconds() {
  const { value } = readSetting(SESSION_LIMIT_KEY, String(DEFAULT_SESSION_LIMIT_SECONDS));
  const seconds = Number(String(value).trim());
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : DEFAULT_SESSION_LIMIT_SECONDS;
}

/** The append-only session log — gitignored via the repo's `logs/` rule. */
function sessionLogPath() {
  return path.join(repoRoot(), "logs", "dev-centre", "electron_session_log.jsonl");
}

/**
 * Append one audit record. Never throws and never records a secret: the email,
 * the role, the deadline and a reason only.
 */
function logEvent(event, extra = {}) {
  try {
    const file = sessionLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), event, ...extra })}\n`, "utf8");
  } catch {
    /* the audit trail must never break a login */
  }
}

/**
 * The most recent session-relevant record in the session log, or null.
 *
 * This deliberately returns the last record of ANY of `SESSION_EVENTS`, not just the last
 * `login`. `hydrate()` resumes a session from a single record, so a `logout` that this
 * function skipped would be invisible to it and the next launch would cheerfully resume
 * the session we just ended, while still inside the original deadline. Terminal events
 * have to be visible here for `logout` to mean anything across a restart.
 */
function lastSessionRecord() {
  let text;
  try {
    text = fs.readFileSync(sessionLogPath(), "utf8");
  } catch {
    return null;
  }
  let found = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // a torn final line must not discard the whole history
    }
    if (rec && SESSION_EVENTS.has(rec.event) && typeof rec.email === "string") {
      found = rec;
    }
  }
  return found;
}

/**
 * Resume (or refuse) a session that was opened with a SEAT LICENCE.
 *
 * `credentialFor()` CANNOT be used here, and this is the subtle half of the licence
 * feature: a licence sign-in happens precisely BECAUSE the address is in neither `.env`
 * nor the role registry, so resolving it the way a local credential is resolved returns
 * null and silently revokes EVERY licence session at the next launch. The session would
 * appear to work, then vanish on restart — the kind of bug that reads as a flaky app.
 *
 * What can still be re-checked is the half that belongs to this app: a `tier_1` session is
 * resumed only while the address is still in the hidden admin list, so deleting an entry
 * takes effect at the next launch exactly as removing a `.env` admin does.
 *
 * The licence itself is NOT re-checked, because it is never stored (it is a secret — a
 * private key). So revocation of a seat whose session is still live takes effect at the
 * next SIGN-IN, not the next launch. That latency is deliberate and is documented in
 * `docs/safe/licensing-and-login.md`; shortening it would mean either persisting a
 * private key or shortening `DEV_CENTRE_SESSION_LIMIT` for licence sessions.
 *
 * @param {object} record - the last `login` row from the session log
 * @returns {object} the state object (see `state()`)
 */
function hydrateLicenceSession(record) {
  const wanted = pwdv.tryNormalizeEmail(record.email);
  // Anything unrecognised is treated as the weaker role, never promoted: a hand-edited or
  // partially-written log line must not be able to mint a tier_1 session.
  const role = record.role === "tier_1" ? "tier_1" : "tier_2";
  const source = typeof record.source === "string" && record.source ? record.source : "licence";

  if (!wanted || (role === "tier_1" && !adminEmails.isTier1Email(wanted))) {
    session = null;
    logEvent("session_revoked", {
      email: typeof record.email === "string" ? record.email : "",
      role,
      reason: "not_in_admin_list",
      via: "licence",
    });
    return state();
  }

  if (record.expiresAt <= Date.now()) {
    session = null;
    logEvent("session_expired", { email: wanted, role, expiresAt: record.expiresAt, via: "licence" });
    return state();
  }

  session = { email: wanted, role, expiresAt: record.expiresAt, source, via: "licence" };
  return state();
}

/**
 * Load the persisted session at startup. The stored deadline decides, and the
 * email is re-resolved against the CURRENT credential sources — so removing an
 * admin from `.env`, deleting a registry user or retiering one takes effect on
 * the next launch rather than lasting until the deadline.
 *
 * Never interrupts a running app: this only runs at startup, by design.
 * @returns {object} the state object (see `state()`)
 */
function hydrate({ version } = {}) {
  logEvent("app_start", version ? { version } : {});

  const record = lastSessionRecord();
  if (!record) {
    session = null;
    return state();
  }

  // The last thing that happened was an operator logout (or an expiry/revocation another
  // launch recorded), so there is nothing to resume. Tested as `!== "login"` rather than
  // `=== "logout"` on purpose: ANY terminal record ends the session, so a future event
  // name cannot silently become resumable by being forgotten here.
  if (record.event !== "login" || typeof record.expiresAt !== "number") {
    session = null;
    return state();
  }

  // A licence session has no local credential to re-resolve against — it is resumed from
  // its own record, and the admin list is what can revoke its tier. See the function.
  if (record.via === "licence") return hydrateLicenceSession(record);

  const credential = credentialFor(record.email);
  if (!credential) {
    session = null;
    logEvent("session_revoked", { email: record.email, reason: "not_in_credential_sources" });
    return state();
  }

  if (record.expiresAt <= Date.now()) {
    session = null;
    logEvent("session_expired", { email: record.email, role: credential.role, expiresAt: record.expiresAt });
    return state();
  }

  session = {
    email: credential.email,
    role: credential.role,
    expiresAt: record.expiresAt,
    source: credential.source,
    via: "local",
  };
  return state();
}

/**
 * Resolve a sign-in from a SEAT LICENCE.
 *
 * The licence IS the credential. A full `TA1…` carries the seat's Ed25519 + X25519
 * private seeds, so `verifyLicenseKey()`'s possession check (the derived public key must
 * equal the one in the signed cert) is what proves the holder is the seat — no separate
 * secret is needed and none is stored. Verification is delegated to `licence-verifier.js`
 * so the gate reaches the *same* verdict the frontdesk webapp does for the same key.
 *
 * The role comes from the cert's signed `email` claim against the hidden admin list:
 * listed ⇒ `tier_1`, anything else that verifies ⇒ `tier_2`.
 *
 * Why a claim-less licence is refused rather than defaulted: `cert.email` is absent on
 * every seat issued before claims existed, and those keys still verify. Treating a
 * missing claim as "trust whatever was typed" would turn the untrusted `Email` field
 * into the identity, which is exactly what the claim exists to prevent.
 *
 * NEVER echoes the cert's email. `state()` deliberately hides identities while locked so
 * the login screen cannot be used to enumerate who has access; an error naming the
 * licence's real address would hand that back — and would let anyone holding a leaked
 * licence string read its owner's address without decoding it.
 *
 * @returns {{ok: true, credential: object} | {ok: false, reason: string, detail: string}}
 */
function resolveLicenceSignIn(wanted, typed) {
  const store = licences.pkmPaths();
  const verdict = licences.verifyLicenseKey(typed, Date.now(), store);

  if (!verdict.ok) {
    return {
      ok: false,
      reason: "bad_licence",
      detail: `${LICENCE_REASON_TEXT[verdict.reason] || "that licence could not be verified"} (${verdict.reason})`,
    };
  }

  const certEmail = verdict.claims.email;
  if (!certEmail) {
    return {
      ok: false,
      reason: "licence_no_email",
      detail:
        "that licence carries no email claim, so there is nothing to match against the admin list — " +
        "re-sign it with `pkm claims set <registry> <seat> --email <address> --resign` and use the NEW key",
    };
  }

  if (certEmail !== wanted) {
    return {
      ok: false,
      reason: "email_mismatch",
      detail: "the address on that licence is not the address you typed — sign in with the address the licence names",
    };
  }

  return {
    ok: true,
    credential: {
      email: certEmail,
      role: adminEmails.isTier1Email(certEmail) ? "tier_1" : "tier_2",
      source: `${LICENCE_SOURCE_PREFIX}${store.registry}`,
      via: "licence",
    },
  };
}

/**
 * Attempt a login. Returns `{ok:true, email, role, expiresAt, remainingMs}` or
 * `{ok:false, reason}` — the reason is safe to show the operator, because an
 * unknown email and a wrong secret deliberately produce DIFFERENT reasons here
 * (the login screen says "no such user" vs "wrong secret"). That is a usability
 * trade-off on a single-user desktop app, not a public endpoint: the session log
 * is the authoritative record of which it was.
 *
 * TWO CREDENTIAL PATHS, and the order is load-bearing:
 *
 *   1. `.env` / role registry — checked FIRST, so an entry keeps the exact semantics it
 *      has always had. A `TA1…` stored there as a plaintext secret therefore still works
 *      even when the key store cannot be read.
 *   2. a seat licence — consulted only when the address is in NEITHER source AND the
 *      typed secret is licence-shaped (`looksLikeLicenseKey()`, a cheap prefix test kept
 *      separate from verification).
 *
 * That ordering is what makes this change purely additive: nothing that signed in before
 * signs in differently now, and a malformed licence is never compared as a password.
 */
function login(email, secret) {
  const { admins, problems } = adminState();
  const registry = roles.listRoles(repoRoot());
  const typed = String(secret ?? "");
  const licenceShaped = licences.looksLikeLicenseKey(typed);

  if (admins.size === 0 && registry.count === 0 && !licenceShaped) {
    logEvent("denied", { email: String(email ?? "").slice(0, 254), reason: "no_admins_configured" });
    return {
      ok: false,
      reason: "no_admins_configured",
      detail:
        `nothing is configured in ${ADMINS_KEY} (.env), ${registry.path} has no users, ` +
        "and that does not look like a seat licence either",
    };
  }

  const wanted = pwdv.tryNormalizeEmail(email);
  if (!wanted) {
    logEvent("denied", { email: String(email ?? "").slice(0, 254), reason: "bad_email" });
    return { ok: false, reason: "bad_email", detail: "that is not a valid email address" };
  }

  const credential = credentialFor(wanted);

  // Unknown address AND not licence-shaped ⇒ nothing to try. Bail before the licence
  // branch so an unknown address still reports `unknown_email` rather than `bad_licence`.
  if (!credential && !licenceShaped) {
    logEvent("denied", { email: wanted, reason: "unknown_email" });
    return {
      ok: false,
      reason: "unknown_email",
      detail: `not in ${ADMINS_KEY} (.env) or ${registry.path}`,
    };
  }

  let resolved;
  if (credential) {
    if (!verifySecret(credential.secret, typed)) {
      logEvent("denied", { email: wanted, reason: "bad_key", role: credential.role, source: credential.source });
      return { ok: false, reason: "bad_key", detail: "wrong secret for that address" };
    }
    resolved = credential;
  } else {
    const licence = resolveLicenceSignIn(wanted, typed);
    if (!licence.ok) {
      logEvent("denied", { email: wanted, reason: licence.reason, via: "licence" });
      return { ok: false, reason: licence.reason, detail: licence.detail };
    }
    resolved = licence.credential;
  }

  const limitSeconds = sessionLimitSeconds();
  const expiresAt = Date.now() + limitSeconds * 1000;
  const via = resolved.via === "licence" ? "licence" : "local";
  session = { email: wanted, role: resolved.role, expiresAt, source: resolved.source, via };
  logEvent("login", {
    email: wanted,
    role: resolved.role,
    expiresAt,
    limitSeconds,
    source: resolved.source,
    via,
  });

  return {
    ok: true,
    email: wanted,
    role: resolved.role,
    expiresAt,
    remainingMs: expiresAt - Date.now(),
    limitSeconds,
    via,
    ...(problems.length ? { warnings: problems } : {}),
  };
}

/** Drop the in-memory session. Returns the locked state. */
function lock() {
  session = null;
  return state();
}

/**
 * End the session on purpose — the sidebar's Log Out.
 *
 * Two halves, and the first is the easy one to forget: the terminal record is what makes
 * the logout survive a restart. Without it the app resumes the session on the next launch,
 * because `hydrate()` reads the last session record and an unrecorded logout leaves it
 * looking at the `login` row from earlier in the day.
 *
 * Safe to call with no session: it then only clears what is already cleared and returns the
 * locked state. Nothing is appended in that case, because a lapsed session carries no
 * address to attribute — `state()` deliberately hides `email` while locked so the login
 * screen cannot be used to enumerate who has access.
 *
 * Stopping the app's services is main.js's job, not this module's: nothing here spawns or
 * owns a child process.
 *
 * @param {string} [reason] short machine-readable note for the audit trail
 * @returns {object} the state object (see `state()`)
 */
function logout(reason = "operator_logout") {
  if (session) {
    logEvent("logout", {
      email: session.email,
      role: session.role,
      expiresAt: session.expiresAt,
      source: session.source,
      reason,
    });
  }
  return lock();
}

/**
 * The gate's current state, safe to hand a locked renderer.
 *
 * Identities and the role roster are only disclosed once someone is signed in;
 * while locked this reports counts and diagnostics only, so the login screen
 * cannot be used to enumerate who has access.
 */
function state() {
  const now = Date.now();
  const remaining = session ? Math.max(0, session.expiresAt - now) : 0;
  const locked = !session || remaining <= 0;

  const admins = adminState();
  const registry = roles.listRoles(repoRoot());
  const licenceStore = licences.storeStatus();
  const problems = [
    ...admins.problems,
    ...adminEmails.adminListProblems(),
    ...licenceStore.problems,
    ...(registry.error ? [`role registry unreadable: ${registry.error}`] : []),
  ];

  // A user listed in both sources is a configuration conflict: `.env` wins (tier_1),
  // which is the opposite of what the registry entry would grant.
  const { admins: parsed } = admins;
  for (const user of registry.users) {
    if (parsed.has(user.email)) problems.push(`${user.email} is in both ${ADMINS_KEY} and the role registry — the .env admin entry wins (tier_1)`);
  }

  return {
    locked,
    email: locked ? null : session.email,
    role: locked ? null : session.role,
    expiresAt: locked ? null : session.expiresAt,
    remainingMs: locked ? 0 : remaining,
    limitSeconds: sessionLimitSeconds(),
    roles: roles.ROLES,
    adminsConfigured: parsed.size > 0,
    adminCount: parsed.size,
    registryCount: registry.count,
    registryPath: registry.path,
    envPath: configModule().ENV_PATH,
    sessionLog: sessionLogPath(),
    // The LICENCE path, reported as booleans and a registry id only. `licenceReady` says a
    // master ring is readable; `licenceAdminsConfigured` says the hidden list names at
    // least one address. Neither is the count or the contents — the whole point of the
    // list living in source is that a locked renderer learns nothing from it.
    licenceReady: licenceStore.ready,
    licenceAdminsConfigured: adminEmails.hasTier1Emails(),
    licenceRegistry: licenceStore.registry,
    problems,
    // A licence is a way in, so an install with no `.env` admins and no registry users is
    // NOT unconfigured while the key store is readable — otherwise the gate would disable
    // its own form and report "no credentials" to the one person holding a valid seat.
    needsSetup: parsed.size === 0 && registry.count === 0 && !licenceStore.ready,
  };
}

/**
 * Is this IPC channel allowed right now?
 *
 * main.js installs this as a single wrapper around `ipcMain.handle`, so it covers
 * every handler — including ones added later — instead of relying on each handler
 * to remember to check.
 *
 * @returns {{ok: true} | {ok: false, reason: "locked"|"forbidden", hint: string}}
 */
function authorize(channel) {
  if (ALWAYS_OPEN.has(channel)) return { ok: true };

  if (!session || session.expiresAt <= Date.now()) {
    session = null;
    return { ok: false, reason: "locked", hint: "Sign in to Dev Centre" };
  }

  if (session.role !== "tier_1" && TIER_1_ONLY.some((re) => re.test(channel))) {
    const group = channel.startsWith("accounts:") ? "Accounts & Keys" : "Key Manager";
    return { ok: false, reason: "forbidden", hint: `${group} requires tier_1 (you are ${session.role})` };
  }

  return { ok: true };
}

/** The current session (or null). For main-process callers that need the role. */
function currentSession() {
  return session && session.expiresAt > Date.now() ? { ...session } : null;
}

module.exports = {
  ADMINS_KEY,
  SESSION_LIMIT_KEY,
  DEFAULT_SESSION_LIMIT_SECONDS,
  LICENCE_SOURCE_PREFIX,
  ALWAYS_OPEN,
  TIER_1_ONLY,
  configure,
  repoRoot,
  readSetting,
  parseAdmins,
  verifySecret,
  credentialFor,
  resolveLicenceSignIn,
  hydrateLicenceSession,
  sessionLimitSeconds,
  sessionLogPath,
  lastSessionRecord,
  hydrate,
  login,
  lock,
  logout,
  state,
  authorize,
  currentSession,
  logEvent,
};
