# Changelog

## [0.3.2-2] — 2026-09-24

### A notification centre for the operator console

Everything worth knowing was either transient — a message that faded after four seconds — or invisible
unless you happened to be looking at the right panel. A service that stopped in the small hours, a script
that failed, a collaborator who signed in, an error in the background: none of them left a lasting trace.

There is now a **Notifications** item in the sidebar listing everything that has happened, newest first.
Columns sort on click, the list searches and filters by source and level, entries are grouped by day in
sections you can collapse, and clicking one shows the detail behind it.

A red dot appears on the sidebar item a notification belongs to — Queue for a new chat message, Logs for
an error, Chat for a reply or a reply that failed, Dashboard for a service that stopped unexpectedly,
Sessions for a sign-in, Scripts for a run that finished or failed. Opening a tab marks its own
notifications as seen; opening the notification list clears every dot.

Stopping a service or a script yourself is never reported as a failure, and sign-outs are not reported at
all — the feed is for things you would want to have been told about.

Notifications are stored in the log folder, one file per day with the "seen" marks beside them, so they
survive a restart. Old files are removed after 30 days by default. That, and a master on/off switch, are
both in the Config tab.

## [0.3.2-1] — 2026-09-24

### Frontdesk chat: answers that never arrived, and one that arrived four times

A single day of logs revealed four separate faults behind a chat that looked silent from the outside.

**Replies were addressed to a seat that does not exist.** The agent was asked for a reply "seat" it
had no way to know, guessed one, and the reply was refused — so the question was never answered. That
parameter no longer exists: the seat comes from the licence the message arrived with, and it is now the
only thing that can decide it.

**The same message could be answered repeatedly while newer ones waited.** Two parts of the system
kept their own copy of the message queue, and one of them rewrote the other's work — so events that had
already been handled came back to life, and because the queue is served oldest-first, new messages sat
behind them. The two now agree on what has been handled, and one wake-up drains the backlog instead of
handling a single item.

**A question that needed a lookup got no answer at all.** Asking for the latest email made the agent
read your inbox and then stop — the result was never passed back to it, so nothing was ever sent. The
agent now takes another turn with what it read and is expected to finish with an answer.

**Failures were silent.** A reply that failed was marked done and forgotten. Failures now get a second
attempt, the user gets a short apology rather than silence, and anything still failing is recorded for
the operator instead of disappearing.

New settings, both optional: `AGENT_RUNNER_MAX_ROUNDS` (default 5) bounds how many steps one chat
question may take, and `AGENT_MAX_ITEMS_PER_PASS` (default 10) bounds how much of a backlog one wake-up
drains.

If the operator console is open, restart the agent runner from the Dashboard — it is a long-lived
process and does not pick up code changes on its own.

## [0.3.1-2] — 2026-09-24

### The app was called "Electron" in the dock

In development the process runs out of Electron's own bundle, so the dock tooltip, the bold
application menu and the About panel all read "Electron", under Electron's icon. `productName` in
`package.json` is only honoured when packaging, and `app.setName()` does not affect the name the OS
uses, so neither half of the identity was actually applied.

Both are now set for dev *and* packaged builds, and the About panel reports the same name the OS
shows. The tray icon was a 1×1 transparent placeholder — the menu-bar item was invisible — and is now
a real macOS template image.

The icon is generated rather than drawn: it rasterises a glyph from the interface's own icon set onto
the standard macOS rounded plate, so the app icon cannot drift away from the icons inside the app.
Regenerate it with `npm --prefix electron run make:icon`.

### The accent-colour swatches were invisible, and two modals were unstyled

The renderer's Content-Security-Policy sets `style-src 'self'` with no `'unsafe-inline'`, which
silently drops inline `style="…"` attributes. Twenty-two of them were load-bearing: every accent
swatch drew its own colour that way, and both modal overlays got their fixed positioning that way.
The swatches rendered as identical blank circles and the modals rendered inline in the page flow.

Every inline style is gone. Swatch colours come from `data-*` attribute selectors, and theme tokens
are written through the CSSOM — which means the stricter policy is kept rather than relaxed to
`'unsafe-inline'` to accommodate them.

### The dashboard restyle

The single 1,876-line stylesheet is now a design system split across 21 files, with the palette, type
scale and radii as tokens. Dark is the default and light is a full second palette.

Also in this pass: sidebar navigation uses inline SVG icons instead of emoji; a status bar carries
health, service-count and queue-count pills; toasts stack, so a second message can no longer silently
replace one you have not read; the sidebar is resizable; and a failure in one startup step no longer
skips the steps after it.

### The collaborator webapp matches the operator console

It now uses the same token names and palette as the desktop app, so the two read as one product.
Roughly 29% of its stylesheet styled elements that do not exist anywhere in the markup; that is
deleted, and the placeholder colour values and hand-mixed translucent tints became tokens and
`color-mix()`. The page stays entirely self-contained — no webfont, no images, no third-party
request.

### The hosted web frontdesk could not reach its backend

The public copy of the collaborator webapp asks its own host for the runtime settings it needs in order
to find the backend. That request went to a path only the local backend serves, so on the hosted site it
returned a 404: the app kept an empty backend address and the login card reported "No backend
configured", even though the site's own settings were present and correct.

The hosted copy now obtains its settings the same way the local one does, and it falls back to the
function path if that route is ever missing — so the login card reports the backend as connected.

## [0.3.1-1] — 2026-09-23

### A frontdesk reply could be addressed to a seat that does not exist

The agent runner's reply tool took the recipient's seat from the model's own output — but the model
was never shown that id, so it had to invent one. It invented the name of the event's *source*
(`frontdesk`) rather than a real seat, the backend correctly refused it, and the reply was lost. The
failure surfaced as an API error, which made it look like a backend fault rather than a bad argument.

The seat now comes from the event itself, where the licence-verified identity already lives, and the
model is no longer asked for it at all. A model-supplied id can no longer choose which collaborator a
reply is encrypted for; when the two disagree the event wins, and the override is logged.

## [0.2.10-4] — 2026-09-23

### Config tab gains a GitHub backup section, and imported values stop being polluted

`config.json` and `.env` are separate files with a per-key precedence rule, and values imported
from `.env` had arrived with their trailing comments glued on — so the OpenAI and Anthropic API
keys were stored as `sk-… # for LLM_PROVIDER=…`, which cannot authenticate, and the log level read
`info           # debug|info|warn|error`. The `.env` parser now ends an unquoted value at a
whitespace-preceded `#`, the five affected values in `config.json` were cleaned, and the keys
missing from it (the GitHub backup trio) were added.

The ⚙️ Config tab also gains a **GitHub backup** section — token (masked, with the reveal toggle),
user/org, and repo allowlist — so the repository backup script can be configured from the UI
together with everything else, instead of only by hand-editing `.env`.

## [0.2.10-3] — 2026-09-23

### The web chat now explains itself

The frontdesk webapp explained exactly one thing — how to log in — so a collaborator had no in-app
answer to "what am I allowed to ask this for?". It now carries a third tab, **📖 How to use**, which
states in plain terms how to send and receive messages, that replies are not instant, what the agent
can look up versus what it will not change, what the Account tab's Google/Trello rows mean, and what
to do when a session ends or the connection drops. It is static markup and issues no requests, so it
cannot expose one seat's activity to another.

Tab switching was hard-wired for exactly two tabs, so a third could not be expressed at all; it is
now a table plus a single handler, and a fourth tab is a one-line change.

### Docs

- New `docs/safe/web-frontdesk-use.md` — the collaborator-facing guide the new tab mirrors: logging in,
  the session countdown, sending/receiving, what the agent can and cannot be asked to do, the Account
  tab, and a symptom → action troubleshooting table. It deliberately carries no file paths, environment
  variables, ports or internal names, so it can be handed to a seat as-is.
- `docs/safe/frontdesk-quickstart.md` and `docs/safe/frontdesk-v2-operator.md` link it, and the operator
  runbook's "no Status tab in the webapp" note now records that the new tab is static.

## [0.2.10-2] — 2026-09-23

### Frontdesk: two reachable routes closed, and a silent failure made loud

The web frontdesk chat is licence-authenticated with end-to-end encryption, but two of its routes
were trusting the wrong thing:

- **The internal reply route was publicly reachable.** `/api/frontdesk/reply` — where the agent posts
  an encrypted answer back to a seat — was covered by a broad public-path prefix, so its only guard
  was a check that was skipped entirely when `WEBHOOK_API_TOKEN` was unset. Anyone able to reach the
  hostname could then inject text into a seat's outbox. It now goes through the standard token guard,
  which fails closed (503) when no token is configured.
- **The session-log route accepted unauthenticated writes.** It took a bare `user` field as a
  fallback, so login/logout rows could be appended without a session. It now requires one, and the
  identity always comes from the session rather than the request body.
- **An expired session no longer hides.** Sessions live in memory, so a backend restart logs everyone
  out. The webapp used to keep reporting "online" while quietly diverting every message into the
  offline outbox, where a dead token meant it could never be delivered. It now explains the expiry and
  returns the user to the login screen.
- `GET /health` reports whether the prompt-injection sanitizer is actually active, so a deployment
  missing its private sanitizer file is visible instead of silently unfiltered.

### Web search: one implementation instead of two

The Electron chat's `web_search`/`web_fetch` and the web-search MCP server now share a single
implementation, so they cannot disagree: snippets decode HTML entities properly (`&#x27;` used to
appear literally), a change in the search page's markup can no longer silently return zero results,
and both paths refuse loopback/private hosts so a model-chosen URL cannot read the local backend.

### Netlify env tooling fixed, and the chat now reports its connection status

- **The Netlify MCP's environment-variable tools were broken** — they called `/sites/{id}/env`, which
  does not exist, so listing or setting a site variable failed with a 404. They now use the real
  contract (account-scoped path with `site_id`, one value per deploy context), discover the account
  from the site so only `NETLIFY_SITE_ID` is needed, and read a variable before writing it so
  `is_secret`, the scopes and any context you did not name are preserved.
- **The web chat now shows whether it can actually reach the backend.** The login card carries a live
  status line naming the host it will call, and it tells "backend unreachable" apart from "no backend
  configured on this host" — the misconfiguration that previously surfaced only as a generic "Cannot
  reach the server". After login the same probe drives the online/offline badge, the backend host in
  the header, and a Backend row on the Account tab; it also warns when the injection sanitizer is off.

### Sanitization hardening

Prompt-injection filtering now happens at the *sources* as well as the callers: tool results are
sanitized where they are produced, prompt construction flattens and sanitizes each value it
interpolates, and the log sinks sanitize on the way to disk (the live log is rendered by the desktop
app, and one of its fields was built from request data). The deliberately-raw webhook forensic dumps
are unchanged and now documented as never-replay.

### Docs

- New `docs/safe/frontdesk-quickstart.md` — issue a seat, run the backend, host the webapp, and verify
  the encrypted round trip end to end.
- Frontdesk documentation brought up to date with the licence + E2E flow; the older HMAC and passphrase
  flow is now labelled as the legacy Trello mirror it is.

### Every user script now has a UI form, plus Trello/GitHub backup and disk cleanup

The 📜 Scripts tab is the app's manual script runner. Every script under `scripts/user/` now has a
generated form, and three tools that previously lived only in other repos were brought in.

- **New cards.** `trello-backup.mjs` — a complete JSON snapshot of every board (one file per board
  plus a manifest index), using the Trello credentials already configured. `github_backup.py` —
  mirrors each repo, exports a readable code snapshot and writes issues/pulls/releases metadata;
  Python standard library only. Plus the eight disk-cleanup scripts behind `master_cleanup.sh`,
  each with its own card.
- **Forms for the last two hold-outs.** `gmail-clear-labelled-updates.mjs` exposes its dry-run,
  label, account, rollback-manifest and restore options; `convert-xlsx-to-sheet.mjs` gained `--name`
  and `--dry-run` so it can target a file without editing the source. The daily rollover card gained
  the board-id / list-id overrides.
- **Bug fix.** `convert-xlsx-to-sheet.mjs` crashed on launch with
  `ENOENT … scripts/user/.env` — it read a hard-coded `../.env` that had been wrong since the script
  moved into `scripts/user/safe/`. It now loads configuration the same way every other script does.
- **Safety.** Every destructive card ships with `--dry-run` pre-checked, so a real delete is two
  deliberate actions. The cleanup master no longer skips a subscript just because a copy lost its
  executable bit — it falls back to `bash <script>`.
- **Docs.** `electron/docs/scripts.md` now covers the two scanned folders (flat, no subfolders), the
  dry-run defaults, the no-stdin caveat, and the rollover script's output contract.

The new scripts live in `scripts/user/safe/`, which is gitignored — the same folder as the existing
personal tools — so nothing here adds third-party or credentialed code to the repo.

## [0.2.10-1] — 2026-09-22

### Gmail setup can now manage filters, and credential backups can't be committed

- **Gmail filter support.** The Google consent scope was widened so the account can create and manage
  Gmail filters — the auto-label rules that file mail and skip the inbox — on top of the existing read
  and send access.
- **Re-running the Google setup is now safe.** It forces a fresh consent screen and refuses to save an
  empty credential, so an interrupted or failed setup can no longer overwrite working credentials. The
  refreshed credential is saved automatically with the previous one backed up first, instead of being
  printed out for manual copy-paste.
- **Credential backups are ignored by git.** The ignore rule previously matched only the exact
  environment file, so the automatic timestamped backups could have been committed. Those backups
  contain live credentials.

## [0.2.9-1] — 2026-09-19

### DS-mon: a bad push token now pauses tracking instead of retrying forever

DS-mon's sync server was hardened: it now requires the bearer token on **every** route and fails closed
without one. That turned a `401` from a transient blip into a **permanent** condition, while the tracker
still treated every non-2xx as retryable:

- **`401`/`403` is now classified as permanent** (`shared/usage-tracker.mjs`). Tracking pauses after a
  single rejection: the 60 s fast retry is not re-armed, no new records are buffered, and every buffered
  record is retained untouched. A corrected `DSMON_PUSH_TOKEN` clears the pause and replays the backlog
  on the next timer tick — the periodic timer deliberately stays armed for that reason.
- This removes the misleading `Buffer exceeds … dropping record (host unreachable?)` death spiral, which
  is exactly how an auth misconfiguration used to look like a network outage while silently discarding
  usage data.
- `getDsmonStatus()` reports `paused` + `reason`, so the 📈 Usage tab renders a distinct
  `⏸️ paused: unauthorized` tag instead of the transient "push failed" one, and **Flush now** reports the
  real outcome (200 / token problem / network) rather than a blanket success.
- Tracking now refuses to start when `USAGE_TRACKING_ENABLED=true` and a push URL is set but
  `DSMON_PUSH_TOKEN` is empty — the same fail-closed posture DS-mon takes itself.

### 🔒 Webhook server: auth now fails closed

`requireAuth` called `next()` when `WEBHOOK_API_TOKEN` was unset, which left the entire queue-admin
surface open to anyone who could reach the port — reading the event queues, clearing them (including a
whole-queue wipe), and reading the task list and tool-dispatch rules. The Cloudflare tunnel publishes
that port to the internet, so this was reachable, not hypothetical.

Those routes now answer **503** when no token is configured, and the reason is logged once at startup
instead of being retried per request. The intentionally-public paths (health check, webhook callbacks,
the frontdesk/licence/session/OAuth endpoints and the static webapp) are unchanged.
`WEBHOOK_API_TOKEN` is now documented as required wherever the webhook environment is described.

### Docs

- `electron/docs/usage.md` — the push token is required; a `401` is a configuration error, not an
  outage; added the paused state and its troubleshooting entries.
- `electron/docs/config.md`, `docs/electron.md` — the push contract and the token requirement.

## [0.2.8-4] — 2026-09-11

### Key Manager — every registry and every ring (Electron)

- The tab is no longer hardwired to one registry. A **registry picker** at the top of the 🔑 Key Manager
tab scopes every call, so every registry in the key store is managed from the same UI. The line beside it
summarises the selected registry's app id, signing engine, ring/seat/revocation counts, and whether it
reads its revocation blocklist **live** or **embeds** it in its own source files.
- **Ring management added** (previously CLI-only): the rings table lists every master key with its
  default/retired state, and **＋ New ring**, **Retire**, **Make default** and **🔑 Agent key**
  (X25519 peer keypair, `ed25519+x25519` registries only) are now buttons.
- **🔄 Sync blocklist** rewrites the blocklist embedded in a registry's consumer-app source files
  (e.g. `transcription-agent` → `electron/src/main/license.ts`, `python-backend/license.py`) and
  tells you to rebuild. A revoke for an embedding registry now also warns in the UI that the sync +
  rebuild is still outstanding.
- The picker line states how each registry reaches its blocklist — *read live* vs *embedded*.

### Key Manager — loading fixed (it could hang forever)

The tab could sit on `checking…` / `loading…` indefinitely with no error. Four compounding causes,
all fixed:

- **Wrong spawn target.** `key-manager.mjs` ran `spawn(process.execPath, …)` — inside Electron that
  is the **Electron binary**, not node, so `pkm.mjs` was opened as a desktop app that never exited.
  It now runs the CLI as Node (`ELECTRON_RUN_AS_NODE=1`), with `PKM_NODE` as an override.
- **No timeout.** A hung CLI deadlocked the serialised command queue forever. Every `pkm` run is now
  hard-bounded by `PKM_TIMEOUT_MS` (default 20s) and killed (SIGTERM → SIGKILL), reporting
  `pkm <cmd> timed out after Ns and was killed`.
- **No error path in the renderer.** `refreshLicenses()` awaited IPC with no `try/catch`, so a
  rejection left the initial placeholder text on screen. Loaders are now guarded and paint a
  Retry-able error box; a global `unhandledrejection` handler rescues any panel still showing
  `loading…`/`checking…` and drops the overlay.

### Paths are config, not code

- Key-store locations are now **config-driven** (`PKM_REPO`, `PKM_ROOT`, `PKM_REGISTRY`, `PKM_BIN`,
  and the command timeout) instead of being hardcoded, and the Key Manager picks up a change without a
  restart. A single shared resolver reads the store's own registry index, so a registry whose directory
  differs from its id resolves correctly.

### Loading overlays everywhere (Electron UI)

Ported the `ai_transcription_agent` pattern:

- **Blocking overlay** (`#loading-overlay`) with a spinner, a contextual message, an optional
  progress bar, a slow-operation hint after 8s, and an optional Cancel — wired into service
  start/stop/**restart**, webhook re-register, every `pkm` mutation, licence validation, config
  save/export/import, seat account connect/set/spawn/stop, usage flush, and the Trello/Gmail/
  WhatsApp quick actions.
- **Inline skeletons** (`.loading-block`) and **Retry-able error boxes** (`.panel-error`) for panel
  and tab fetches, plus a focused transient notice (`#toast`) for results that used to be `alert()`.

### Docs

- `docs/ipcs.md` — the 15 registry-aware `pkm:*` channels and their payloads.
- `electron/README.md`, `electron/docs/keys.md` — registry picker, rings, sync blocklist, corrected
  Refresh semantics, and where every path comes from.

## [0.2.8-3] — 2026-09-11

### Licensing — management moved out of this repo

- Key **management** (rings, seat ledger, revocation blocklist, audit) now lives in a separate local
  key-store repo driven by its `pkm` CLI — one source of truth, shared with the other app that issues
  licences. This repo keeps only a **read-only verifier**.
- **🔑 Licenses became 🔑 Key Manager** — issue / revoke / unrevoke / validate / archive-expired / audit,
  driven entirely through the CLI. Issued licences are **display-once** (a modal with Copy that clears on
  close); the app never stores or logs them.
- The in-repo key store and its management scripts were **removed**, along with the matching npm scripts;
  where the store lives is now configured in ⚙️ Config instead of being hardcoded.
- `electron/docs/licenses.md` → [`electron/docs/keys.md`](electron/docs/keys.md).

## [0.2.8-2] — 2026-09-10

### Operator chat — DeepSeek 400 fixed

- Continued operator conversations no longer abort with a DeepSeek `400`: *the `reasoning_content`
  in the thinking mode must be passed back to the API*. Once a tool-using conversation continues,
  DeepSeek needs the reasoning trail replayed on every assistant turn — including turns where the
  model produced no chain-of-thought, and history written by earlier builds. Both are now handled,
  so affected chats recover on their own instead of wedging (no need to clear the session).

## [0.2.8-1] — 2026-09-10

### Electron UI — layout

- **Chat tab** — the panel, session list, transcript and composer now fill the full tab height
  (the fixed `52vh`/`48vh`/`42vh` caps are gone).
- **Logs tab** — the panel plus the **Live** log box and the **Files** list/viewer fill the tab;
  the log box and file preview grow with the window instead of stopping at `55vh`/`50vh`.
- **Dashboard** — service tabs moved into a **collapsible sidebar** with per-service status dots
  (collapse state remembered per machine), the operator-only note now sits **above** the detail
  panel, and the sidebar + detail + log tail fill the tab.

### Electron UI — Appearance (accent + font size)

- New **accent color** control: nine presets (including *Theme default*) plus a custom color picker;
  drives `--accent` (buttons, active tabs, chat bubbles, highlights).
- New **font size** control: five presets (Small → XX-L) that scale the whole UI via a `--fs-scale`
  root font size.
- New config keys `APPEARANCE_ACCENT_COLOR` (blank = theme default) and `APPEARANCE_FONT_SIZE`,
  both also editable in ⚙️ Config → Appearance. New IPC `app:setAppearance`.

### Operator chat — tool-step budget

- `OPERATOR_CHAT_MAX_ROUNDS` (default **24**, clamped 1–100) replaces the hard-coded 8-step cap;
  editable in ⚙️ Config → Chat next to `OPERATOR_CHAT_TOOLS`.
- Hitting the cap no longer dead-ends: the agent gets one final **tool-free wrap-up** call and
  answers with what it has (stating what's unfinished). If that fails, the sentinel reply is used
  and the Chat tab shows a **▶ Continue** button — history is persisted, so continuing resumes with
  full context. `chat:send` also returns `maxSteps: true` in that case.

### Docs

- Updated `electron/docs/appearance.md`, `chat.md`, `dashboard.md`, `logs.md` and the guide index;
  refreshed `docs/electron.md` (UI table + operator chat) and `docs/ipcs.md` (`app:setAppearance`).

## [0.2.7-1] — 2026-09-09

### Config: config.json + merge-on-save

- **`config.json` created from `.env`** — `npm run config:init` (`scripts/config-from-env.mjs`)
  mirrors every `.env` key into a repo-root `config.json` (merge-safe; `.env` is left in place as
  the fallback). A `config.json` is now present, so the ⚙️ Config tab shows `✅ config.json present`.
- **Saving merges instead of overwriting** — `config:save` now merges the changed keys into
  `config.json` (new `config-loader.mergeConfig()`), so editing one field no longer wipes the rest
  of the file. Empty fields are dropped (revert to `.env`/default), mirroring `ai_transcription_agent`.
- **Usage-tracking keys restart the spawned services** — saving any `USAGE_TRACKING_*` / `DSMON_*`
  key now restarts the runner + webhook children so `shared/usage-tracker.mjs` picks up the change.

### Usage tracking (DS-mon) in config + UI

- New **Usage tracking** section in the ⚙️ Config tab: enable toggle, DS-mon push URL / token /
  interval / instance ID, optional AES-256 encryption key (+ key ID), and credit poll interval.
- New **📈 Usage** sidebar tab: DS-mon push status (enabled, buffer size, last push, instance ID),
  a provider-aware DeepSeek credit-balance card, and per-LLM-call token totals broken down by
  provider, source (flow) and model — read from `logs/dsmon_buffer.jsonl`. Includes a **Flush now**
  action and a persisted poll-interval selector.
- New IPC: `usage:aggregate`, `usage:credits`, `usage:flush`. New config key `CREDIT_POLL_INTERVAL`
  (default 60000).

### Docs

- New `electron/docs/usage.md`; `electron/docs/config.md` and the guide index updated.

## [0.2.6-1] — 2026-09-09

### WhatsApp (Meta Cloud API) MCP integration

- New `mcp/whatsapp/` MCP server (stdio) exposing `whatsapp_status`, `whatsapp_list_numbers`,
  `whatsapp_list_messages`, `whatsapp_send_text`, `whatsapp_send_template`, `whatsapp_mark_read`.
- Tool schemas added to `shared/tool-manifest.js` (`whatsappTools` appended to `allTools`).
- The shared tool executor now runs the WhatsApp tools; the Electron operator chat advertises
  them (reads auto-run, sends ask for operator approval).
- Electron UI: new WhatsApp Config section, a Tools manifest group with Status/Numbers quick
  actions, an MCP dashboard service card showing the active number/connection, and a new in-app
  WhatsApp guide covering both number setups (free Meta test number and real burner number).
- Inbound webhook route receives and sanitizes incoming WhatsApp messages, logs them, and adds
  them to the notification queue for agent processing.
- Version 0.2.6.

## [0.2.5-2] — 2026-09-09

### Electron dashboard

- Services started outside the dashboard (for example the webhook server run as a background
  daemon) are now correctly shown as **running (external)** instead of appearing stopped.
- External services can't be controlled from the dashboard, so their **Start / Restart / Stop**
  buttons are disabled; the webhook card switches to a **Re-register webhooks** action that updates
  the registration scripts without trying to restart a server the dashboard doesn't own.

### Seats & accounts vs the operator dashboard (clarity)

- Made explicit that the dashboard is **operator-only**: it lists every seat license and per-seat
  Google/Trello account binding at once. Seat licenses and bindings belong to the **public chat
  webapp** (collaborator login + which accounts the agent uses for that seat).
- Collaborators (seats) never see this app — each only uses their own webapp chat. This is now
  stated on the 📊 Dashboard, 🔑 Licenses, 👥 Sessions, 🔐 Accounts & Keys and ℹ️ About views and in
  the matching in-app guide pages.

## [0.2.5-1] — 2026-09-08

### Webhook server reliability

- The webhook server no longer drops offline when webhooks fire. Background auto-restart can no
  longer trigger on its own, and a single failing Trello/Gmail/Drive push can no longer crash the
  whole server — errors are logged and it keeps running.
- Calendar + Drive push handling fixed so stale sync tokens / an invalid field selection no
  longer make pushes silently report “0 files”.
- Logs always go to the repo `logs/` folder no matter where the server is started from.

### Electron dashboard

- **Dashboard**: every service card has a **Restart** button; the webhook service also has
  **Restart & re-register webhooks** (re-runs the Trello/Gmail/Calendar/Drive registration
  scripts and restarts the server, with per-step ✅/❌ results).
- **Logs tab**: browse a specific day’s logs, or switch back to live.
- **Queues**: clear an entire queue in one click.
- **Chat**: longer conversations now stay correct with DeepSeek’s “thinking” replies
  (reasoning is threaded through continued turns).

### Version

- App version bumped to 0.2.5.

## [0.2.4-3] — 2026-09-07

### Added

- **Scripts tab forms** — put a `<script>.params.json` next to a script and its card becomes a typed
  form (text, number, checkbox, dropdown, file picker with a Browse button). Scripts without one keep
  the plain raw-args box.
- **Agentic operator Chat** — operator chats can now chain tools to actually get things done. Read-only
  calls (Trello/Gmail reads, web search, plus local reads like today's task list and the pending
  queues) run automatically; anything that changes state shows an **Approve / Deny** card (with
  editable parameters) before it runs, and you can **Stop** at any time. Results from outside sources
  are sanitized before the model sees them.
- Chat stays read-only Q&A on the **frontdesk** channel and stays plain Q&A entirely if you set
  `OPERATOR_CHAT_TOOLS=false`.

## [0.2.4-2] — 2026-09-06

### Internal

- Private operator helper scripts were removed from the public repository. Local tooling — the
  `keys:*` npm commands and the Electron Scripts tab — now finds them in their private location
  automatically.

## [0.2.4-1] — 2026-09-03

### Added

- **Google Photos Picker MCP server** — pick a few photos straight from your library in your browser
  and save them locally via the new `photos_picker_*` tools (start / poll / list / download / delete).
  Picker-only by design: Google no longer lets third-party apps read a whole photo library, only what
  you explicitly select.

### Version

- Root + `electron/package.json` bumped `0.2.3` → `0.2.4`.

## [0.2.3-1] — 2026-09-03

### Added

- **Netlify MCP server** — manage the frontdesk Netlify site (sites, environment variables, deploys)
  via `netlify_*` tools, available to the operator in VS Code.
- **Electron Guide tab** — browse the included end-user documentation right inside the app (About →
  Guide).
- **Live LLM provider switching** — provider/model are read live from settings, so ⚙️ Config changes
  apply to the Chat tab and the agent stack immediately; saving a provider key restarts the
  runner/webhook automatically.

### Docs

- Refreshed `README.md` and `electron.md` (LLM providers, Netlify MCP server).

## [0.2.2-1] — 2026-08-29

### Added

- **Chat tab** in the Electron dashboard — chat directly with the configured LLM from the app; each
  conversation is saved to its own log file under `logs/electron_chat/`.
- **About tab** — app name/version plus a Guide sub-tab (placeholder for now).
- **Config editor upgrade** — the Config tab now shows config fields grouped by section with source badges
  (`config.json` / `.env` / default), secret show/hide, and saves only the keys you change. A **Raw JSON**
  toggle keeps the full-editor view.

### Fixed

- The Config tab could previously fail to load (a renderer/preload API name mismatch); it now renders
  correctly.

### Docs

- Refreshed `electron.md` and `ipcs.md`.

## [0.2.1-1] — 2026-08-27

### Added

- **Multi-provider LLM support** for the agent runner — switch between DeepSeek (default), OpenAI,
  Anthropic, or a local Ollama server via a single `LLM_PROVIDER` setting.
- **Config system** — a plain-JSON `config.json` at the repo root now takes precedence over `.env`.
  The Electron dashboard gains a **⚙️ Config** tab to view, edit, save, export, and import it.

### Changed

- All backend services (webhook server, agent runner, MCP servers) now load configuration from
  `config.json` first, falling back to `.env`.

### Docs

- Refreshed `ipcs.md` and `electron.md`.

## [0.2.0-2] — 2026-08-27

### Removed

- **Legacy Netlify build/edge/session-log helpers** — the site is now build-less; only the runtime-config and Trello-proxy functions remain. Session logs are written by the backend instead.

## [0.2.0-1] — 2026-08-24

### Fixed

- **Electron dashboard live-log crash**: the log tailer could crash when a new day's log file first appeared (invalid buffer size). The tailer now guards the start offset, and the tail loop is hardened so a bad tick logs an error instead of taking down the app.

## [0.2.0] — 2026-08-24

### Added

- **License-key login** for frontdesk seats — per-seat keys replace username/password.
- **End-to-end encrypted chat** between the frontdesk webapp and the agent (AES-256-GCM, key derived from a per-seat ECDH exchange).
- **Direct-to-tunnel chat** by default; Trello becomes an optional mirror with a degraded store-and-forward mode when the tunnel is down.
- **Per-seat Google/Trello account binding** via an in-app "Connect Google" flow; the agent runner uses a seat's own credentials when acting for it.
- **macOS Electron operator dashboard** — start/stop the whole backend stack, live log stream, queue, sessions, licenses, accounts & keys, tools, tray + priority notifications.
- **Named Cloudflare tunnel scripts** for a stable public endpoint.

### Changed

- **Unified logging**: all MCP servers and webhook handlers now route tool-call/webhook logging through a shared logger that emits a unified live stream while preserving the existing on-disk layouts.
- **Webapp rewrite** for license login, E2E encryption, Connect Google, and degraded mode; the Netlify config no longer serves secrets.

### Docs

- Added `docs/electron.md` (operator dashboard) and `docs/ipcs.md` (Electron IPC channels); refreshed `docs/push-notifications.md`.

## [main-3] — 2026-08-18

### Changed

- **Prompt-injection sanitization plumbing**: The sanitizer now loads via a tracked stub module backed by a local (untracked) implementation. All MCP servers and webhook handlers were updated to use the new module — no functional change.
- **Repository history**: Removed the original `scripts/sanitize.mjs` module from all commit history (history rewritten and force-pushed to `main`).

## [main-2] — 2026-07-26

### Added

- **Repo master list**: Created a comprehensive inventory of all 46 repos for account `afrogenesurvive` with license and visibility info.

### Changed

- **40 repo licenses updated** via GitHub API — 22 repos set to MIT, 17 to Apache-2.0, 1 changed from MIT→Apache-2.0, 1 changed from Apache-2.0→MIT.
- **Repo master list**: Updated to reflect current license states after all changes applied.

## [main-1] — 2026-07-24

### Added

- **Gmail multi-account support** (`mcp/gmail/index.js`): Added `userId` parameter to all Gmail tools (`gmail_list_messages`, `gmail_get_message`, `gmail_send_message`), supporting both the default account and `entclinicmobay@gmail.com` via `GMAIL_REFRESH_TOKEN_2`/`GMAIL_USER_2` env vars.
- **Sheets MCP Server** (`mcp/sheets/`): New MCP server with 5 tools — `sheets_get_metadata`, `sheets_get_values`, `sheets_update_values`, `sheets_insert_rows`, `sheets_copy_paste_format`. Provides per-cell Google Sheets editing for the Bills Check Master spreadsheet.
- **xlsx-to-Sheet conversion script** (`scripts/convert-xlsx-to-sheet.mjs`): One-time utility to convert the existing xlsx to a native Google Sheet.
- **`mcp:sheets` npm script** in `package.json` for running the Sheets MCP server directly.
- **`sheetsTools` export** in `shared/tool-manifest.js` — tool definitions shared with the agent runner and MCP servers.

### Changed

- **`shared/tool-manifest.js`**: All Gmail tool descriptions updated to document multi-account `userId` support. Added `sheetsTools` array with 5 Sheet tool definitions. `allTools` now includes `sheetsTools`.
- **Local config** (gitignored): VS Code MCP config updated with Sheets MCP server entry; the local extraction-agent doc updated with the Sheets API workflow replacing the xlsx download/upload pattern.
