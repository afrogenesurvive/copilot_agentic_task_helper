/**
 * Config redaction — the gate-owned keys that must never reach a config surface.
 *
 * ONE implementation, shared by:
 *   - the Electron main process (`electron/src/main.js`), which hides the keys from
 *     `config:get` / `config:getWithSources` / `config:export` and refuses them on
 *     `config:save` / `config:import`;
 *   - `scripts/config-from-env.mjs` (`npm run config:init`), which must not mirror them
 *     from `.env` into `config.json`.
 *
 * WHY a key is listed here at all: `readEffective()` / `readWithSources()` return EVERY
 * key they know, and the Config tab's Raw JSON view serialises all of them for any
 * signed-in operator — including `tier_2`. The Dev Centre gate reads its admin list with
 * its own precedence (`.env` → `config.json` → `process.env` → default), so a second copy
 * in `config.json` is both a credential disclosure (the value is `email:secret` pairs, not
 * just an address list) and a privilege escalation (a `tier_2` operator could write
 * themselves in as a `tier_1` admin). Hiding it is what makes `.env` "the only place it
 * can be set" true, and what makes the gate's inverted precedence safe.
 *
 * WHAT is deliberately NOT here: the tier_1 admin list in
 * `electron/src/main/dev-centre-admins.json` (validated by `dev-centre-admins.js`). That is
 * compiled into the app rather than being a config key — the point is that it reaches no
 * config surface at all — and adding an `ADMIN_EMAIL`-shaped key here would put it back on
 * the Config tab, which `scripts/check-licence-wiring.mjs` explicitly fails on.
 *
 * CJS on purpose: the Electron main process and the `.mjs` CLI scripts both consume it,
 * and `require()` is the one import shape they share.
 *
 * NOTE: this module guards SURFACES, not the loader's internals — `mergeConfig()`,
 * `saveConfig()`, `importConfig()` and `setKey()` in `shared/config-loader.cjs` remain
 * callable with any key by a script that asks for that directly. That is a deliberate
 * scope decision (see the plan's "Guard depth" decision), not an oversight.
 */
"use strict";

/**
 * Canonical list. Keep it a plain literal and keep `electron/src/main.js`'s
 * `REDACTED_CONFIG_KEYS = new Set([...])` literal identical — `check-licence-wiring.mjs`
 * asserts the two agree, because the main-process one is the object its regex anchors on
 * while THIS list is what CLI scripts import.
 *
 * A frozen ARRAY rather than a frozen Set: `Object.freeze()` does not stop `Set.add()`,
 * so a frozen Set would advertise an immutability it does not have.
 */
const REDACTED_CONFIG_KEYS = Object.freeze(["DEV_CENTRE_ADMINS"]);

/** The same list for O(1) lookups. */
const REDACTED_SET = new Set(REDACTED_CONFIG_KEYS);

/** Is `key` gate-owned (i.e. must never appear on a config surface)? */
function isRedactedKey(key, keys = REDACTED_SET) {
  return keys.has(key);
}

/**
 * Strip the gate-owned keys out of a flat key→value map, whatever its value shape.
 * Returns a NEW object, so callers can strip `{key: {value, source}}` maps and plain
 * `{key: "value"}` maps alike without mutating what they were given.
 *
 * `keys` defaults to this module's list. The Electron main process passes its own literal
 * set instead, so the surfaces it owns are governed by the same object
 * `check-licence-wiring.mjs` greps for — and that check asserts the two lists are
 * identical, so passing one is a wiring statement, never a way to disagree.
 */
function redactConfig(values, keys = REDACTED_SET) {
  const out = {};
  for (const [k, v] of Object.entries(values || {})) {
    if (!keys.has(k)) out[k] = v;
  }
  return out;
}

/**
 * The gate-owned keys present in `items` — an array of key names, or an object whose own
 * keys are the candidates. Empty array means "nothing to refuse". Used to REFUSE a write
 * loudly rather than dropping the key silently (a silent no-op looks like the save worked
 * and leaves the operator believing their credential changed).
 */
function blockedKeys(items, keys = REDACTED_SET) {
  const candidates = Array.isArray(items) ? items : Object.keys(items || {});
  return candidates.filter((k) => keys.has(k));
}

module.exports = {
  REDACTED_CONFIG_KEYS,
  isRedactedKey,
  redactConfig,
  blockedKeys,
};
