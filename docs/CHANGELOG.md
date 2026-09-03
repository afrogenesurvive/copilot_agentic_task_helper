# Changelog

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
