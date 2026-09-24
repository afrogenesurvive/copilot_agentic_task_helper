# Notification centre

An in-app feed of everything the operator should know about, with a red dot on the
sidebar item responsible for it. Opened from **Notifications** in the sidebar.

This is deliberately **in-app only**: no OS notifications, no tray badge. The menu-bar item reports the
priority queue instead — its left-click panel shows the pending count and the five most recent items
(`electron/src/renderer/tray.js`), and `checkPriority` in `electron/src/main.js` raises a native
notification when the queue grows. The transient in-renderer channel is the toast stack
(`renderer/styles/components/_notifications.css`).

## What raises a notification

| Source column | Raised by | Dot on |
| ------------- | --------- | ------ |
| `queue` | A new `frontdesk_message` lands on the **priority** queue (v2 `/api/frontdesk/send` and the legacy Trello mirror both) | Queue |
| `logs` | Any `error`-level entry in the unified live log that is *not* a frontdesk reply failure | Logs |
| `chat` | An agent reply finished (Chat tab), a chat turn failed, or the runner's `frontdesk_reply` failed | Chat |
| `dashboard` | A spawned service exited non-zero **without** the operator stopping it, or a service failed to start at all | Dashboard |
| `sessions` | A seat signed in (`POST /api/session-log` → `logSession`). Logouts are deliberately not news | Sessions |
| `scripts` | A user script finished, failed, or was stopped from the UI | Scripts |

Every producer funnels through `notify()` in `electron/src/main.js`, which applies
`NOTIFY_ENABLED` and pushes `notifications:new` to the renderer.

Five of the six are **derived from the live log**, not from new cross-process
plumbing: the webhook server and the agent runner already write `logs/live/*.jsonl`
and the app already tails it. That is why nothing in `mcp/` needed an IPC channel —
only `enqueueEvent` was enriched with `sub`/`text` so the queue notification has
something human to say.

> **Startup cutoff.** `liveLog.seedFromLive()` replays up to three days of history
> when the app starts. The producers ignore anything older than the app-start
> timestamp, so a launch never re-notifies the backlog. If you add a producer, keep
> that check.

## Storage

JSONL, like every other store in this repo — no migration, and the files sit with
the rest of the logs:

| Path | Contents |
| ---- | -------- |
| `logs/notifications/feed/YYYY-MM-DD.jsonl` | One entry per line: `{id, ts, source, level, title, body?, data?}` |
| `logs/notifications/feed-state.json` | Read marks: `{read: {global, queue, logs, chat, dashboard, sessions, scripts}}` |

`logs/` is gitignored, so neither file can be committed.

**Read state is per-source high-water marks, not a per-row flag.** A source is
unread up to `max(read.global, read[source])`, compared as **epoch milliseconds**.
That keeps marking read to one small write, and it is what makes the per-source dots
possible. The marks are written when you acknowledge, not when a row is rendered, so
a notification that arrives while you are looking at the panel is not swallowed.

## Acknowledging

- Opening a **source tab** (Queue, Logs, Chat, Dashboard, Sessions, Scripts) clears
  that source's dot. This is why the tab click handler calls `acknowledgeTab(tab)`.
- Opening the **Notifications panel** clears every dot (`{all: true}`).
- A notification arriving while the panel is open re-lights the dot — correct, since
  you have not seen it yet.

## Settings

| Key | Default | Effect |
| --- | ------- | ------ |
| `NOTIFY_ENABLED` | `true` | Master switch; `false` stops recording entirely |
| `NOTIFY_RETENTION_DAYS` | `30` | Feed files older than this are deleted at startup |

Both are read by the **Electron** process at startup (not the runner), so they are
not in `RESTART_KEYS` — restart the app to change them.

## Adding a source

1. Add the name to `SOURCES` in `electron/src/main/notifications.js`.
2. Add a producer in `startNotificationProducers()` (or call `notify()` from the
   code path that owns the event, as chat/services/scripts do).
3. Add the sidebar tab + section in `renderer/index.html` — the loaders map in
   `renderer/app.js` needs an entry, and the `data-tab` value must have a matching
   `<section id="tab-<value>">` or the tab click throws.
4. Add it to `NOTIF_TAB` in `renderer/app.js` so the dot and the tab acknowledge
   each other.
5. Run `node scripts/check-renderer-wiring.mjs` — every class you emit must be
   styled, and every glyph name must exist in `renderer/icons.js`.

## Where this is going (SQLite)

The store's exported surface — `configure`, `record`, `list`, `markRead`,
`unreadCounts`, `clearAll` — is the entire contract its callers use, so the storage
engine can be swapped without touching the producers or the renderer. The intended
move is `better-sqlite3` at `app.getPath("userData")/frontdesk.db`
(`~/Library/Application Support/Frontdesk Operator/`), WAL mode, with these tables
first: `notifications`, then `queue_events`, `script_runs` + `script_run_output`,
`log_entries`, `chat_entries` and `frontdesk_sessions`.

Two constraints to respect when that happens:

- **Electron 33 bundles Node 20.18**, so `node:sqlite` is unavailable — it needs
  `better-sqlite3` (electron-builder already pulls `@electron/rebuild`, and it
  auto-unpacks native modules).
- **One writer during the transition.** The webhook server and the agent runner are
  separate processes with their own JSONL. Keep Electron as the only process writing
  the database (it already sees everything via `logs/live` and the queue API), and
  leave `logs/webhook/raw/*.jsonl` — deliberately unsanitized — out of it entirely.
