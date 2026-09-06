#!/usr/bin/env node
/**
 * run-keymanage.mjs — local runner for the private keymanage.mjs tool.
 *
 * keymanage.mjs is private/local-only (never committed to the public repo) and
 * lives under scripts/user/safe/. To stay robust against it being in either
 * location, this resolver tries scripts/user AND scripts/user/safe, whichever
 * exists. Used by the "keys:*" npm scripts in package.json.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const candidates = ["scripts/user/keymanage.mjs", "scripts/user/safe/keymanage.mjs"];
const resolved = candidates.find((p) => existsSync(p));

if (!resolved) {
  console.error(
    "keymanage.mjs not found (private/local-only — expected under scripts/user/safe/). " +
      "Not present in public clones."
  );
  process.exit(1);
}

const res = spawnSync(process.execPath, [resolved, ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(res.status === null ? 1 : res.status);
