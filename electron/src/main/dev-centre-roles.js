/**
 * Dev Centre role registry — WHO may use this desktop app, and at what tier.
 *
 * This is the app-side counterpart to the frontdesk seat registry: the web
 * frontdesk gates collaborators, this gates the operator console. It lives in
 * the gitignored `safe/` tree because it holds credentials.
 *
 *   <repo>/safe/dev-centre-roles.json
 *   {
 *     "updatedAt": "2026-09-24T21:40:00.000Z",
 *     "users": {
 *       "someone@example.com": { "key": "<plaintext | scrypt$…>", "role": "tier_2", "addedAt": "…" }
 *     }
 *   }
 *
 * Two credential sources exist, and this is the second of them:
 *   - `.env` `DEV_CENTRE_ADMINS` — the ADMINS. Always `tier_1` (everything).
 *   - this registry — everybody else. `tier_2` = everything except the Key
 *     Manager and Accounts & Keys.
 *
 * A `key` may be EITHER a plaintext secret OR a `scrypt$…` verifier minted by
 * `pkm claims set <seat> --password-stdin` (see `password-verifier.js`).
 * Verification is identical either way, so an operator can harden the file
 * without re-enrolling anyone.
 *
 * Read fresh on every call — deliberately, mirroring `scripts/frontdesk-accounts.mjs`
 * — so adding/removing/retiering a user takes effect on the next login or the
 * next launch, with no app restart. A missing or corrupt file is treated as
 * "no users" rather than an error, so it can never lock the app open: the
 * `.env` admins remain the bootstrap path either way.
 *
 * Manage it with the CLI rather than by hand:
 *   node scripts/dev-centre-roles.mjs list
 *   node scripts/dev-centre-roles.mjs add   someone@example.com '<secret>' tier_2
 *   node scripts/dev-centre-roles.mjs role  someone@example.com tier_1
 *   node scripts/dev-centre-roles.mjs remove someone@example.com
 */
"use strict";

const fs = require("fs");
const path = require("path");

const { tryNormalizeEmail, looksLikeVerifier } = require("./password-verifier");

/** Roles this app understands. Order is weakest → strongest. */
const ROLES = ["tier_2", "tier_1"];

/** Role for a registry entry that does not name one. Least privilege. */
const DEFAULT_ROLE = "tier_2";

/** Relative to the repo root, under the gitignored `safe/` tree. */
const ROLES_FILE_REL = path.join("safe", "dev-centre-roles.json");

/**
 * The repo root — `electron/src/main/` → up three.
 *
 * Callers that already resolved it (the packaged app's `REPO`) pass it in;
 * everything else gets the dev-tree answer, which is also what the CLI wants.
 */
function repoRoot(explicit) {
  return explicit || path.resolve(__dirname, "..", "..", "..");
}

/** Absolute path to the role registry for a given repo root. */
function rolesPath(root) {
  return path.join(repoRoot(root), ROLES_FILE_REL);
}

/** Reject a role this build does not know, instead of silently granting nothing. */
function assertRole(role) {
  const value = String(role ?? DEFAULT_ROLE).trim();
  if (!ROLES.includes(value)) {
    throw new Error(`unknown role "${role}" — supported: ${ROLES.join(", ")}`);
  }
  return value;
}

/** Normalise an email key, throwing with a useful message when it is not one. */
function assertEmail(email) {
  const value = tryNormalizeEmail(email);
  if (!value) throw new Error(`"${email}" is not a valid email address`);
  return value;
}

/**
 * Load the registry. Never throws: absent, unreadable or corrupt all mean
 * "no registry users", which is safe because the `.env` admins still exist.
 * @returns {{updatedAt: string|null, users: object, path: string, error?: string}}
 */
function loadRoles(root) {
  const file = rolesPath(root);
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const users = raw && typeof raw.users === "object" && raw.users !== null && !Array.isArray(raw.users) ? raw.users : {};
    return { updatedAt: typeof raw?.updatedAt === "string" ? raw.updatedAt : null, users, path: file };
  } catch (err) {
    const missing = err && err.code === "ENOENT";
    return {
      updatedAt: null,
      users: {},
      path: file,
      ...(missing ? {} : { error: err.message || String(err) }),
    };
  }
}

/** Write the registry atomically (tmp + rename), stamping `updatedAt`. */
function saveRoles(users, root) {
  const file = rolesPath(root);
  const payload = {
    updatedAt: new Date().toISOString(),
    users: users && typeof users === "object" ? users : {},
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
  return { ok: true, path: file, count: Object.keys(payload.users).length, updatedAt: payload.updatedAt };
}

/**
 * One user by email, or null. The returned `key` IS the stored secret — callers
 * that render must use `listRoles()`/`describeSecret()` instead of echoing it.
 */
function getUser(email, root) {
  const wanted = tryNormalizeEmail(email);
  if (!wanted) return null;
  const { users, path: file } = loadRoles(root);
  const entry = users[wanted];
  if (!entry || typeof entry !== "object") return null;
  return {
    email: wanted,
    key: typeof entry.key === "string" ? entry.key : "",
    role: ROLES.includes(entry.role) ? entry.role : DEFAULT_ROLE,
    addedAt: typeof entry.addedAt === "string" ? entry.addedAt : null,
    source: file,
  };
}

/**
 * Add or update a user. `patch.key` is required on create; omit it to change
 * only the role of an existing user (the stored secret is preserved, so a
 * retier never requires re-typing a secret).
 */
function setUser(email, patch = {}, root) {
  const wanted = assertEmail(email);
  const role = assertRole(patch.role);
  const { users } = loadRoles(root);
  const existing = users[wanted] && typeof users[wanted] === "object" ? users[wanted] : null;

  const key = patch.key === undefined || patch.key === null ? existing?.key : String(patch.key);
  if (!key || String(key).trim() === "") {
    throw new Error(`a secret is required for "${wanted}" (or the user must already exist)`);
  }

  users[wanted] = {
    key: String(key),
    role,
    addedAt: existing?.addedAt || new Date().toISOString(),
  };
  const res = saveRoles(users, root);
  return { ...res, email: wanted, role, verifier: looksLikeVerifier(users[wanted].key) };
}

/** Remove a user. Returns `{ok, removed}` — removing an absent user is not an error. */
function removeUser(email, root) {
  const wanted = assertEmail(email);
  const { users } = loadRoles(root);
  const removed = Object.prototype.hasOwnProperty.call(users, wanted);
  if (removed) {
    delete users[wanted];
    saveRoles(users, root);
  }
  return { ok: true, email: wanted, removed, path: rolesPath(root) };
}

/**
 * Every user, WITHOUT the stored secret — safe to render in a UI, print in a
 * log or return over IPC.
 */
function listRoles(root) {
  const { users, path: file, updatedAt, error } = loadRoles(root);
  const rows = Object.keys(users)
    .sort()
    .map((email) => ({
      email,
      role: ROLES.includes(users[email]?.role) ? users[email].role : DEFAULT_ROLE,
      addedAt: typeof users[email]?.addedAt === "string" ? users[email].addedAt : null,
      verifier: looksLikeVerifier(users[email]?.key),
      hasSecret: typeof users[email]?.key === "string" && users[email].key.length > 0,
    }));
  return { path: file, updatedAt: updatedAt || null, count: rows.length, users: rows, ...(error ? { error } : {}) };
}

/** "verifier" (a `scrypt$…` string) or "plaintext" — never the value itself. */
function describeSecret(stored) {
  if (!stored) return "missing";
  return looksLikeVerifier(stored) ? "verifier" : "plaintext";
}

module.exports = {
  ROLES,
  DEFAULT_ROLE,
  ROLES_FILE_REL,
  repoRoot,
  rolesPath,
  loadRoles,
  saveRoles,
  getUser,
  setUser,
  removeUser,
  listRoles,
  describeSecret,
  assertEmail,
  assertRole,
};
