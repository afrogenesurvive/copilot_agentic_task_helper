# Changelog

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
