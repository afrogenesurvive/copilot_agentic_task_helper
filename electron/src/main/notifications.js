/**
 * Notification centre store — append-only JSONL + in-memory ring.
 *
 * The operator app already sees every signal that matters: it tails the unified
 * `logs/live/*.jsonl` stream every 2s (see main.js), polls `/api/queue-status`,
 * owns the chat loop and spawns both the services and the user scripts. This
 * module turns those into one durable, user-facing feed with an unread state, so
 * the sidebar can show a dot without the renderer holding any history itself.
 *
 * Storage is deliberately JSONL, matching every other store in this repo
 * (`logs/live/`, `logs/electron_chat/`, `logs/pending-tool-calls/`): one file per
 * day under `logs/notifications/feed/`, so nothing needs a migration and the
 * files sit with the rest of the logs. `electron/docs/notifications.md` records
 * the intended move to SQLite (userData, via `better-sqlite3`) — the exported
 * `record/list/markRead/unreadCounts` surface is the whole contract callers use,
 * so that swap stays contained to this file.
 *
 * Read state is a per-source high-water mark, not a per-row flag: marking
 * "everything in the queue source as seen" is one small write to
 * `feed-state.json`, and the dots are per-source anyway.
 *
 * The menu-bar badge gets a second, separate counter in the same state file
 * (`uncleared` + `clearedAt`): recorded-since-last-clear, reset only by
 * `clearAll()`. Reading is not clearing, so opening the panel must not lower it.
 *
 * CommonJS: required by the Electron main process.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/** Feed sources — also the sidebar items that can carry an unread dot. */
const SOURCES = ["queue", "logs", "chat", "dashboard", "sessions", "scripts"];
const LEVELS = ["info", "warn", "error"];

/** Ring cap. The panel is a recent-activity view, not an archive; the files are. */
const MAX_ENTRIES = 2000;
const MAX_BODY = 500;

let cfg = {
  dir: path.resolve(__dirname, "..", "..", "..", "logs", "notifications", "feed"),
  retentionDays: 30,
};

/** In-memory ring, oldest first. */
let entries = [];
let read = { global: 0 };

/**
 * The menu-bar badge's counter: notifications recorded since the last clear.
 *
 * Deliberately NOT `unreadCounts().total`. Opening the dashboard's Notifications
 * tab marks everything read (main.js's acknowledgeTab), and the badge has to
 * survive that — only the operator's explicit Clear resets it. `clearedAt` is
 * stored beside the counter so a restart can tell "never cleared" from "cleared
 * a moment ago" without walking the ring.
 */
let clearedAt = 0;
let uncleared = 0;

const listeners = [];

/**
 * Point the store at a directory (main.js resolves the repo root, which differs
 * between dev and a packaged app) and load the recent feed.
 */
function configure(opts = {}) {
  if (opts.dir) cfg.dir = opts.dir;
  if (opts.retentionDays != null && Number.isFinite(opts.retentionDays)) {
    cfg.retentionDays = Math.max(0, Math.min(opts.retentionDays, 3650));
  }
  const state = readState();
  read = state.read;
  clearedAt = state.clearedAt;
  uncleared = state.uncleared;
  prune();
  seed();
  // First run after the badge existed: persist the migrated marks so the decision
  // above (existing history is not "uncleared") is not re-made every launch.
  if (state.migrated) writeState();
  return { dir: cfg.dir, retentionDays: cfg.retentionDays, loaded: entries.length };
}

const stateFile = () => path.join(cfg.dir, "..", "feed-state.json");
const dayFile = (day) => path.join(cfg.dir, `${day}.jsonl`);
const day = (ts) => String(ts || new Date().toISOString()).slice(0, 10);

function readState() {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
  } catch {
    /* no state file yet — the defaults below are the answer */
  }

  const marks = { global: 0 };
  for (const s of SOURCES) marks[s] = Number(raw?.read?.[s]) || 0;
  marks.global = Number(raw?.read?.global) || 0;

  // A state file written before the menu-bar badge existed carries no counter.
  // Treat the history already on disk as seen (clearedAt = now, uncleared = 0) so
  // upgrading does not light the badge with days of backfill.
  const hasCounter = raw != null && Object.prototype.hasOwnProperty.call(raw, "uncleared");
  return {
    read: marks,
    clearedAt: hasCounter ? Number(raw.clearedAt) || 0 : Date.now(),
    uncleared: hasCounter ? Number(raw.uncleared) || 0 : 0,
    migrated: !hasCounter,
  };
}

function writeState() {
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(
      stateFile(),
      JSON.stringify({ updatedAt: new Date().toISOString(), read, clearedAt, uncleared }, null, 2) + "\n",
      "utf8",
    );
  } catch (err) {
    console.error("[notifications] could not write state:", err.message);
  }
}

/** Parse one feed file, tolerating a partially-written last line. */
function readDay(file) {
  const out = [];
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && e.ts && e.source) out.push(e);
    } catch {
      /* torn line — ignore, the next append rewrites nothing */
    }
  }
  return out;
}

const feedFiles = () => {
  try {
    return fs
      .readdirSync(cfg.dir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort();
  } catch {
    return [];
  }
};

/** Load the last few days into the ring so the panel has history at startup. */
function seed(days = 3) {
  entries = [];
  for (const f of feedFiles().slice(-days)) entries.push(...readDay(path.join(cfg.dir, f)));
  entries.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
}

/** Drop feed files older than the retention window. */
function prune() {
  if (!cfg.retentionDays) return 0;
  const cutoff = new Date(Date.now() - cfg.retentionDays * 86400000).toISOString().slice(0, 10);
  let removed = 0;
  for (const f of feedFiles()) {
    if (f.replace(/\.jsonl$/, "") >= cutoff) continue;
    try {
      fs.unlinkSync(path.join(cfg.dir, f));
      removed++;
    } catch {
      /* leave it for next time */
    }
  }
  return removed;
}

/**
 * Record one notification: append it to today's file, push it into the ring and
 * tell subscribers (main.js forwards them to the renderer).
 *
 * @param {object} n — { source, title, body?, level?, data?, ts? }
 * @returns {object|null} the stored entry
 */
function record(n = {}) {
  const source = SOURCES.includes(n.source) ? n.source : null;
  if (!source || !n.title) return null;

  const entry = {
    id: crypto.randomBytes(6).toString("hex"),
    ts: n.ts || new Date().toISOString(),
    source,
    level: LEVELS.includes(n.level) ? n.level : "info",
    title: String(n.title).slice(0, 200),
    body: n.body ? String(n.body).slice(0, MAX_BODY) : undefined,
    data: n.data === undefined ? undefined : n.data,
  };

  try {
    fs.mkdirSync(cfg.dir, { recursive: true });
    fs.appendFileSync(dayFile(day(entry.ts)), JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    console.error("[notifications] append failed:", err.message);
  }

  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);

  // Written synchronously: `record()` already does a synchronous append, and the
  // counter is the menu-bar badge's only source of truth across a restart, so a
  // debounce here would buy nothing and lose counts on a hard exit.
  uncleared++;
  writeState();

  for (const cb of listeners) {
    try {
      cb(entry);
    } catch {
      /* a bad subscriber must not break the producer */
    }
  }
  return entry;
}

function onRecord(cb) {
  listeners.push(cb);
  return () => {
    const i = listeners.indexOf(cb);
    if (i >= 0) listeners.splice(i, 1);
  };
}

/**
 * Newest first, optionally filtered. Everything the panel needs is here rather
 * than in the renderer, so a future SQLite implementation can answer the same
 * questions with a query.
 */
function list({ source, level, search, unreadOnly, since, limit = 500 } = {}) {
  let items = entries.slice();
  if (source && SOURCES.includes(source)) items = items.filter((e) => e.source === source);
  if (level && LEVELS.includes(level)) items = items.filter((e) => e.level === level);
  if (since) {
    const from = Date.parse(since);
    if (Number.isFinite(from)) items = items.filter((e) => Date.parse(e.ts) > from);
  }
  if (unreadOnly) items = items.filter(isUnread);
  if (search) {
    const q = String(search).toLowerCase();
    items = items.filter((e) =>
      `${e.title} ${e.body || ""} ${e.source} ${e.level}`.toLowerCase().includes(q),
    );
  }
  items.reverse();
  return items.slice(0, Math.max(1, Math.min(limit, MAX_ENTRIES)));
}

/**
 * Read marks are epoch milliseconds, and the comparison is numeric.
 *
 * They started as ISO strings and `Math.max(0, "2026-09-24T…")` is `NaN`, which
 * made every entry compare false and every dot permanently lit — the store's first
 * bug, caught by exercising it rather than by reading it.
 */
const effectiveRead = (source) => Math.max(read.global || 0, read[source] || 0);

/** A source is read up to the newer of its own mark and the global one. */
const isUnread = (e) => Date.parse(e.ts) > effectiveRead(e.source);

/** Unread counts per source plus the total — what the sidebar dots render. */
function unreadCounts() {
  const bySource = {};
  for (const s of SOURCES) bySource[s] = 0;
  let total = 0;
  for (const e of entries) {
    if (!isUnread(e)) continue;
    bySource[e.source]++;
    total++;
  }
  // `clearedAt` rides along so a row can decide its own "new" edge with the very
  // rule the menu-bar badge counts, without a second round trip to ask.
  return { total, bySource, read, sources: SOURCES, uncleared, clearedAt };
}

/**
 * The menu-bar badge's number: everything recorded since the last clear, whether
 * or not it has been read.
 *
 * This exists so main.js can ask for the badge value on every `notify()` without
 * walking the ring to rebuild the whole per-source breakdown.
 */
function unclearedCount() {
  return uncleared;
}

/**
 * Mark read. `{ all: true }` clears every dot (the panel was opened); a `source`
 * clears just that one (its own tab was opened).
 *
 * The mark is `now` rather than the newest entry's timestamp, so a notification
 * that arrives between rendering and acknowledging is not swallowed.
 */
function markRead({ source, all, at } = {}) {
  const parsed = at ? Date.parse(at) : Date.now();
  const ts = Number.isFinite(parsed) ? parsed : Date.now();
  if (all) {
    read.global = ts;
    for (const s of SOURCES) read[s] = ts;
  } else if (source && SOURCES.includes(source)) {
    read[source] = ts;
  } else {
    return unreadCounts();
  }
  writeState();
  return unreadCounts();
}

/** Delete every feed file (operator "Clear" action) and reset the ring. */
function clearAll() {
  for (const f of feedFiles()) {
    try {
      fs.unlinkSync(path.join(cfg.dir, f));
    } catch {
      /* ignore */
    }
  }
  entries = [];
  // The one thing that resets the menu-bar badge. `read` marks are left alone on
  // purpose: they record "seen", not "dealt with".
  uncleared = 0;
  clearedAt = Date.now();
  writeState();
  return { ok: true, uncleared };
}

module.exports = {
  SOURCES,
  configure,
  record,
  onRecord,
  list,
  unreadCounts,
  unclearedCount,
  markRead,
  clearAll,
  prune,
  // exported for tests / diagnostics
  _stateFile: stateFile,
  _dir: () => cfg.dir,
};
