# Electron Operator Dashboard

A lightweight macOS control plane for the frontdesk v2 stack. No operator license required.

## Run

```bash
npm run electron:install   # one-time: installs Electron + electron-builder
npm run electron:dev       # launch dashboard + autostart the whole backend
```

[`npm run electron:dev`](../package.json#L47) → `cd electron && npm start` ([`electron/package.json`](../electron/package.json#L1)) → `electron .`. The main process
([`electron/src/main.js`](../electron/src/main.js#L1)) autostarts on launch (set `OPERATOR_AUTOSTART=false` to disable):

- Webhook server (`node mcp/webhook-server/index.js`, `:3199`)
- Agent runner (`node mcp/agent-runner/index.js`)
- Cloudflare tunnel (only if `CLOUDFLARE_TUNNEL_TOKEN`/`ID` set)

The 9 MCP servers (`node mcp/{trello,gmail,drive,calendar,photos,sheets,web-search,whatsapp,netlify}/index.js`)
are **not** autostarted. They are startable from the Dashboard rail, and the operator chat's MCP
client ([`electron/src/main/mcp-client.mjs`](../electron/src/main/mcp-client.mjs)) spawns its own
child per server the first time one of that server's tools is called — so autostarting them too
would leave two processes for every server the chat touches. `OPERATOR_AUTOSTART_MCP=true` restores
the old behaviour.

## UI (left sidebar)

| Item | Contents |
| ---- | -------- |
| 📊 Dashboard | Start/stop every service, live health + per-service log tails, config, Google status |
| 🔔 Notifications | Unread feed for the app: new frontdesk messages, error logs, chat turns, unexpected service exits, seat logins and script runs. Sortable and searchable, grouped by day into collapsible sections, with a red unread dot on each source's sidebar item. The menu-bar icon carries a red count of **uncleared** notifications — that one is reset only by the **Clear** button here, never by opening the panel |
| 🔴 Queue | Priority + misc queues, per-item clear |
| 📄 Logs | Live unified log stream (filter by source/sub-source/level, fold JSON details) + Log file browser with pretty JSONL view |
| 👥 Sessions | Frontdesk login/logout sessions |
| 📈 Usage | LLM token usage + DS-mon push status + provider credit balance |
| 🔑 Key Manager | Every registry in the key store (picker): seat licences (issue / revoke / unrevoke / archive expired / validate / per-seat detail), master **rings** (new / retire / make default / agent key), the audit log, blocklist sync for registries that embed it, and a store action row (Archive expired / Export bundle). A **Verify** row runs the checks that matter when issuing — Challenge (does the licence complete a login), Crypto self-test, Revocation check, Permissions, Verify bundle — and stays available even when the store is read-only. When the store cannot support an action, its control is disabled with the reason instead of failing on click. A **Claims** panel binds an identity to a key — an `email` claim and/or a scrypt password *verifier* (the password itself is never stored) — and shows the signed certificate beside the ledger record, because only the certificate is enforced: **Apply + resign** re-signs and returns a replacement licence to hand over, and **Reveal verifier** is display-once. **Backfill emails** retro-fits claims from seat ids, a **Claims drift** canary finds a certificate that no longer matches its ledger, and **Test credentials…** answers “will this email + password actually work for this key?” offline, before the key is handed out |
| 🔐 Accounts & Keys | Bind Google/Trello accounts per seat; ▶ Spawn MCP for a seat |
| 💬 Chat | Chat with the configured LLM (the agent) directly from the dashboard — each conversation is saved as its own log file |
| ⚙️ Config | Sectioned field editor with per-key source badges, secret show/hide, Save (edited keys only), Export / Import, Raw JSON toggle |
| 🧰 Tools | Shared tool manifest (grouped per server, incl. Netlify) + Trello/Gmail/WhatsApp/Netlify quick actions |
| 📜 Scripts | Run vetted helper scripts under `scripts/user/` (and the gitignored `scripts/user/safe/`), with generated forms from a `<script>.params.json` sidecar |
| 🎨 Appearance | Light / Dark / System theme, accent color (ten presets + custom), font-size preset and sidebar width (`APPEARANCE_THEME`, `APPEARANCE_ACCENT_COLOR`, `APPEARANCE_FONT_SIZE` — native chrome + dashboard; width is a local preference) |
| ℹ️ About | App name + version (About) + a Guide sub-tab |
| ⏻ Quit (bottom) | Quits the app — main `before-quit` stops all backend services |

## Source layout

```
electron/
  package.json          (electron ^33, electron-builder)
  assets/               app icon + tray template (generated — see make:icon)
  src/main.js           main process: service manager, IPC, tray + menu-bar panel, notifications, tools
  src/main/oauth.js     loopback Google OAuth (operator remint + bind account → seat)
  src/main/mcp-client.mjs  in-process MCP client (lazy stdio child per server)
  src/main/mcp-policy.mjs  operator-chat tool policy (read / approve / never)
  src/preload.js        contextBridge → window.api
  src/renderer/         index.html + tray.html, tokens.js, icons.js, app.js/tray.js (vanilla, no build step)
  src/renderer/styles/  the design system — 22 stylesheets, linked in cascade order (+ `tray.css` for the panel)
  README.md
```

- [`electron/package.json`](../electron/package.json#L1) — scripts (`start`, `dev`, `make:icon`, `dist:mac`) + Electron deps
- [`electron/src/main.js`](../electron/src/main.js#L1) — service manager, IPC, tray, notifications, tools
- [`electron/src/main/oauth.js`](../electron/src/main/oauth.js#L1) — loopback Google OAuth (bind account → seat)
- [`electron/src/main/chat-agent.mjs`](../electron/src/main/chat-agent.mjs#L1) — operator chat agentic loop (tools + approvals)
- [`electron/src/main/local-tools.mjs`](../electron/src/main/local-tools.mjs#L1) — operator local tools (fs/tasks/queues)
- [`electron/src/preload.js`](../electron/src/preload.js#L7) — `contextBridge` → `window.api`
- [`electron/src/renderer/`](../electron/src/renderer/index.html#L1) — `index.html`, `app.js` (vanilla, no build step), plus `tokens.js` (theme tokens) and `icons.js` (inline SVG set); the menu-bar panel is its own document, [`tray.html`](../electron/src/renderer/tray.html#L1) + `tray.js`
- [`scripts/make-icon.mjs`](../scripts/make-icon.mjs#L1) — generates the dock/tray icons from a glyph in `icons.js`
- [`scripts/check-renderer-wiring.mjs`](../scripts/check-renderer-wiring.mjs#L1) — dev check: every id, glyph, asset and class the renderer (and the webapp) references must actually exist
- [`scripts/check-pkm-wiring.mjs`](../scripts/check-pkm-wiring.mjs#L1) — dev check: preload ↔ `ipcMain.handle` parity for every `pkm:*` channel, each channel documented in the IPCs docs, every `data-pkm-write` naming a real gated command, and no preload method the renderer never calls. `npm run check:wiring` runs this plus the renderer check

## Build (dmg/zip)

```bash
npm run electron:build   # = electron-builder --mac
```

[`npm run electron:build`](../package.json#L48) = [`electron-builder --mac`](../electron/package.json#L1) (the `dist:mac` script).

Packaged apps read the repo pieces (scripts, shared, mcp, webapp) from `extraResources`, but
`.env`/`config.json`/`safe`/`logs/` are read from the live repo — the primary flow is dev (`npm start`).

## App identity (dock icon + name)

The dock icon and the name in the application menu come from the app **bundle**, not from JS:
`app.setName()` only changes the name Electron uses internally and does not affect what macOS shows.
So there are two halves:

- **Packaged** — `build.productName` / `build.appId` in [`electron/package.json`](../electron/package.json#L1),
  plus `mac.icon` pointing at [`electron/assets/icon.icns`](../electron/assets/icon.icns).
- **Dev (`npm start`)** — the process runs out of `electron/node_modules/electron/dist/Electron.app`,
  so [`scripts/patch-electron-app-name.mjs`](../scripts/patch-electron-app-name.mjs#L1) rewrites that
  bundle's `Info.plist`. It is wired to `postinstall`, so it survives a reinstall, and it is idempotent.
  (Safe because the npm Electron bundle is ad-hoc, linker-signed with `Info.plist=not bound` — editing
  the plist does not invalidate it. The script re-signs ad-hoc if a future version *is* sealed.)

The icons are generated, not drawn. [`scripts/make-icon.mjs`](../scripts/make-icon.mjs#L1) rasterises the
`console` glyph from [`electron/src/renderer/icons.js`](../electron/src/renderer/icons.js#L1) onto a
macOS squircle plate, so the app icon can never drift from the UI's own icon set:

```bash
npm --prefix electron run make:icon     # -> electron/assets/{icon.png,icon.icns,trayTemplate*.png}
```

Icons live in `electron/assets/`, **not** `electron/build/` — the repo `.gitignore` has an unanchored
`build/` rule that would silently swallow them. `assets/**/*` is in `build.files` because the main
process loads the dock and tray images at runtime.

A repo-root `config.json` (plain JSON) is the primary config source; `.env` is used when it's absent.
Manage it from the **⚙️ Config** tab — a sectioned field editor with per-key source badges
(`config.json` / `.env` / default), secret show/hide, and Save that **merges** just the keys you change
(other keys are preserved; clearing a field reverts it to `.env`/default). A **Raw JSON** toggle keeps the
full editor. `npm run config:init` seeds `config.json` from `.env`.

## LLM providers

The **Chat** tab and the agent stack (runner + webhook server) support multiple LLM providers —
DeepSeek (default), OpenAI, Anthropic, and a local Ollama server — via `LLM_PROVIDER` in the
⚙️ Config tab. Single source of truth: [`shared/model-provider.mjs`](../shared/model-provider.mjs#L1).

- The **LLM Provider** section shows only the active provider's fields (API key, model with default
  placeholder, optional base URL / max tokens) plus the shared `LLM_TEMPERATURE`.
- Provider and model are resolved **live from config on every call**, so saving a change applies to
  the Chat tab immediately (no app restart).
- Saving any provider key **auto-restarts** the agent runner and webhook server (if running) so they
  pick up the new provider too; MCP servers and the tunnel are untouched.
- The Chat header shows the active `provider · model` chip.

## Usage tracking

Per-LLM-call token usage is buffered locally and pushed to DS-mon when enabled. The **📈 Usage** tab
shows the push status, a provider-aware credit-balance card, and token totals broken down by provider /
source / model, with a **Flush now** action. Enable and configure it from **⚙️ Config → Usage tracking**.

`DSMON_PUSH_TOKEN` is **required whenever `DSMON_PUSH_URL` is set** — DS-mon requires the bearer token
and fails closed without it. A `401`/`403` is therefore treated as a **permanent configuration error,
not an outage**: tracking pauses (no retries, no new records, buffer retained), and resumes once the
token is corrected. See `electron/docs/usage.md`.

## Operator Chat (agentic)

Operator chats mirror the VS Code agent experience — the model can **chain tools** to actually complete
requests, with tool activity shown inline as chips and result bubbles:

- **Read-only tools run automatically** — Trello/Gmail/Drive/Calendar/Sheets/WhatsApp/Netlify reads,
  web search/fetch, and scoped local reads (files under operator folders, today's daily task file, the
  pending-queue lists).
- **State-changing actions ask first** — a card shows the tool and its parameters with **Approve / Deny**
  (args editable before you approve); **Stop** aborts the loop. The read/approve split is fail-closed and
  lives in [`electron/src/main/mcp-policy.mjs`](../electron/src/main/mcp-policy.mjs).
- **Tool calls run through an in-process MCP client** ([`electron/src/main/mcp-client.mjs`](../electron/src/main/mcp-client.mjs)) —
  each MCP server is spawned as a stdio child the first time one of its tools is called and reused
  afterwards, so the chat needs no REST re-implementation of its own. Photos is excluded by design
  (picker-only), as is `frontdesk_reply` (frontdesk channel).
- Local file access is allowlisted to operator folders; secrets and private folders are never exposed to
  the model, and external tool results are sanitized before being fed back.
- Tool access is **operator-channel only** — frontdesk chats stay read-only Q&A by design. Disable tools
  entirely with `OPERATOR_CHAT_TOOLS=false`. See [`electron/docs/chat.md`](../electron/docs/chat.md).
- Each message gets `OPERATOR_CHAT_MAX_ROUNDS` tool steps (default **24**). On exhaustion the agent makes a
  final tool-free **wrap-up** call so you still get an answer; otherwise it stops with a sentinel message
  and the Chat tab offers **▶ Continue** (history is persisted, so continuing resumes with full context).

## Scripts tab

- Runs executables under the operator scripts folder (bash/node/python3) — manual only.
- A `<script>.params.json` sidecar generates a typed form (text / number / checkbox / dropdown / file
  picker); scripts without one keep the raw args box. See [`electron/docs/scripts.md`](../electron/docs/scripts.md).

## Loading & errors

Long-running actions (service start/stop/restart, licence operations, config save/import, per-seat account
setup, tool calls) show a **blocking overlay** with the action's context, a “still working” hint if they
take unusually long, and an optional Cancel. Panel and tab loads use an inline spinner instead, so the
surrounding UI stays readable.

Every load that can fail renders the error **in place with a Retry button**, and a background safety net
turns any leftover loading placeholder into the same error box — a failed call can never leave the UI
spinning forever. Streamed output (live logs, script output, chat steps) is never covered by the overlay.

## Licensing

Seat licences gate the **public chat webapp**, not this operator app. Management lives in a separate local
key store driven by its `pkm` CLI — this repo only verifies licences — so the Key Manager tab is a front
end: it spawns the CLI and renders the result, and never stores or logs a licence. Store locations are
configured in ⚙️ Config rather than hardcoded. See [`electron/docs/keys.md`](../electron/docs/keys.md).

## Notes

- The menu-bar item: **left**-click opens the panel; **right**-click opens the menu (Open dashboard,
  Start services, Quit). The panel is a second renderer document (`src/renderer/tray.html` + `tray.js` +
  `styles/tray.css`), not a mode of the dashboard. Four status pills (webhook health, services running,
  queue depth, key store) stay above three tabs — **Services**, **Queues** (Priority / Misc sub-tabs) and
  **Notifications** — with an **Open dashboard** button below. It opens at 340×440 and is **resizable**;
  the size is remembered in
  `~/Library/Application Support/Frontdesk Operator/popover-size.json`.
- The menu-bar icon carries a red **uncleared count** (capped at `9+`) beside the glyph, drawn at runtime
  by `src/main/tray-badge.mjs`. It counts notifications recorded since the last **Clear** in the
  Notifications tab — deliberately *not* the read/unread dots, which clear as soon as the panel is
  opened.
- The panel's data can also be read over HTTP: `GET /api/menubar` returns the webhook/runner/tunnel state,
  queue counts and a sanitized one-line preview per item (queue items are **summaries**, never message
  bodies — the route is operator-token-gated), and `node scripts/pkm-status.mjs --json` prints the
  key-store status. That is what a non-Electron client would consume.
- A native notification is raised when the priority queue grows.
- Closing the window **hides** it — the app keeps running in the background, and the menu-bar item, the
  dock icon and a notification click all restore and focus it. Quit via the menu-bar menu or the sidebar
  Quit button.
- If `electron --version` reports `Electron failed to install correctly`, reinstall:
  `cd electron && rm -rf node_modules/electron && npm install electron@33.4.11` (decline npx's
  offer to fetch a different version and use `./node_modules/.bin/electron`).
