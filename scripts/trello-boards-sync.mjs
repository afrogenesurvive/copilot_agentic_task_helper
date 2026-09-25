#!/usr/bin/env node
/**
 * Project `safe/trello-boards.json` into the places that used to hold hand-copied
 * copies of the same Trello board/list ids.
 *
 *   board/list ids ─┬─ config.json / .env   TRELLO_BOARD_ID, TRELLO_LIST_*,
 *   (this file)     │                       TRELLO_WEBHOOK_MODEL_IDS
 *                   └─ Netlify site env     TRELLO_BOARD_ID, TRELLO_LIST_FRONTEDESK_*
 *
 * Why: the same five values were maintained by hand in three places (the safe file,
 * the repo config, the Netlify UI). `shared/trello-boards.mjs` is now the single
 * reader, and this script pushes its values outward so they cannot drift.
 *
 * Usage:
 *   node scripts/trello-boards-sync.mjs                     # report only (default)
 *   node scripts/trello-boards-sync.mjs --apply             # write config.json
 *   node scripts/trello-boards-sync.mjs --push-netlify      # show what Netlify would get
 *   node scripts/trello-boards-sync.mjs --push-netlify --apply   # write + push
 *
 * Flags:
 *   --apply          actually write (default is a dry run — this touches remote config)
 *   --push-netlify   include the Netlify site env step (needs NETLIFY_AUTH_TOKEN +
 *                    NETLIFY_SITE_ID; set NETLIFY_SITE_ID in .env once)
 *   --strict         exit 1 when the board file is missing/unreadable or has drift
 *   --help
 *
 * Netlify notes: a variable holds ONE VALUE PER DEPLOY CONTEXT, so this reads each
 * key first and only rewrites the values — `is_secret`, `scopes` and every context
 * survive, and a variable that does not exist yet is created (POST wants a top-level
 * array, PUT wants a single object). A change needs a NEW DEPLOY to reach the
 * functions, so the run prints the deploy reminder.
 */
import fs from "node:fs";
import config from "../shared/config-loader.cjs";
import * as tb from "../shared/trello-boards.mjs";
import { setSiteEnvVar } from "../shared/netlify-env.mjs";

config.loadEnvInto(process.env);

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const APPLY = has("--apply");
const PUSH_NETLIFY = has("--push-netlify");
const STRICT = has("--strict");

if (has("--help") || has("-h")) {
  console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("*/")[0].replace(/^\/\*\*?/, "").trim());
  process.exit(0);
}

/** The subset the webapp's /api/config allowlist serves — the rest is server-side. */
const NETLIFY_KEYS = ["TRELLO_BOARD_ID", "TRELLO_BOARD_NAME", "TRELLO_LIST_FRONTEDESK_INPUT", "TRELLO_LIST_FRONTEDESK_OUTPUT"];

const label = (s) => String(s || "").padEnd(30);
let failures = 0;

/* ── 1. Read the source of truth ─────────────────────────────────────────── */

const snap = tb.snapshot(process.env);
console.log("\n📋 Board map");
console.log(`   ${label("file")}${snap.file}`);
console.log(`   ${label("present")}${snap.present ? "yes" : "NO (gitignored — absent on a fresh checkout)"}${snap.error ? ` — ${snap.error}` : ""}`);
if (!snap.present) {
  console.log("   Nothing to sync. Set TRELLO_BOARDS_FILE to point at a copy if it lives elsewhere.");
  if (STRICT) process.exit(1);
  process.exit(0);
}
const boardNames = Object.keys(snap.boards);
console.log(`   ${label("boards")}${boardNames.map((b) => `${b} (${snap.boards[b]})`).join(", ") || "none"}`);
const fd = snap.frontdesk;
console.log(`   ${label("frontdesk board")}${fd.board || "UNRESOLVED"}${fd.boardId ? ` (${fd.boardId})` : ""}`);
if (!fd.board) {
  console.log("   ⚠️  No board has a `frontdesk_input` list, so the frontdesk ids cannot be derived.");
  failures += 1;
}
if (fd.other.length) console.log(`   ${label("other lists")}${fd.other.join(", ")} (not part of the frontdesk flow)`);

/* ── 2. Compare with the local config ────────────────────────────────────── */

const effective = config.readEffective();
console.log(`\n🔧 Local config (${effective.present ? "config.json" : ".env"} wins)`);
if (!Object.keys(snap.projected).length) {
  console.log("   The board map yields no values — nothing to write.");
} else {
  for (const [key, value] of Object.entries(snap.projected)) {
    const current = String(process.env[key] || "");
    const state = current === value ? "ok" : current ? "DRIFT" : "unset";
    if (state === "ok") {
      console.log(`   ${label(key)}${value}  ✓`);
    } else {
      console.log(`   ${label(key)}${value}  ← ${state}: currently "${current || "(empty)"}"`);
    }
  }
}

if (APPLY && Object.keys(snap.projected).length) {
  const res = config.mergeConfig(snap.projected);
  if (!res.ok) {
    console.log(`   ❌ Failed to write ${res.path || "config.json"}: ${res.error || "unknown error"}`);
    failures += 1;
  } else {
    config.applyValues(snap.projected, process.env);
    console.log(`   ✅ Wrote ${res.count} key(s) to ${res.path} (${res.changed} changed). config.json takes precedence over .env — .env is left untouched.`);
    console.log("   Restart the webhook server and agent runner so the new ids are picked up.");
  }
} else if (!APPLY) {
  console.log("   (dry run — pass --apply to write)");
}

/* ── 3. Netlify site env ─────────────────────────────────────────────────── */

if (PUSH_NETLIFY) {
  const siteId = process.env.NETLIFY_SITE_ID || "";
  const token = process.env.NETLIFY_AUTH_TOKEN || "";
  console.log(`\n☁️  Netlify site env${siteId ? ` (${siteId})` : ""}`);
  if (!siteId) {
    console.log("   ❌ NETLIFY_SITE_ID is not set — add it to .env (the site name or id works).");
    failures += 1;
  } else if (!token) {
    console.log("   ❌ NETLIFY_AUTH_TOKEN is not set — create a PAT at app.netlify.com/user/applications#personal-access-tokens.");
    failures += 1;
  } else {
    for (const key of NETLIFY_KEYS) {
      const value = snap.projected[key];
      if (!value) {
        console.log(`   ${label(key)}skipped — not in the board map`);
        continue;
      }
      try {
        const res = await setSiteEnvVar({ siteId, key, value, dryRun: !APPLY });
        const verb = res.dryRun ? "would" : res.created ? "created" : "updated";
        console.log(`   ${label(key)}${verb} → ${value}  [${res.contexts.join(", ")}]`);
      } catch (err) {
        console.log(`   ${label(key)}❌ ${err.message}`);
        failures += 1;
      }
    }
    if (APPLY) console.log("   ⚠️  A Netlify env change needs a NEW DEPLOY before the functions see it.");
    else console.log("   (dry run — pass --apply to push)");
  }
} else {
  console.log("\n☁️  Netlify site env skipped (pass --push-netlify to compare/push).");
}

/* ── Summary ─────────────────────────────────────────────────────────────── */

const drift = Object.entries(snap.projected).filter(([k, v]) => String(process.env[k] || "") !== v);
console.log(
  `\n${failures ? "❌" : "✅"} ${failures} problem(s); ${drift.length} local key(s) out of sync with the board file.` +
    (drift.length && !APPLY ? " Re-run with --apply to fix." : ""),
);
if (STRICT && (failures || drift.length)) process.exit(1);
