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
- All 6 MCP servers (`node mcp/{trello,gmail,drive,calendar,sheets,web-search}/index.js`)
- Cloudflare tunnel (only if `CLOUDFLARE_TUNNEL_TOKEN`/`ID` set)

## UI (left sidebar)

| Item | Contents |
| ---- | -------- |
| 📊 Dashboard | Start/stop every service, live health + per-service log tails, config, Google status |
| 🔴 Queue | Priority + misc queues, per-item clear |
| 📄 Logs | Live unified log stream (filter by source/sub-source/level, fold JSON details) + Log file browser with pretty JSONL view |
| 👥 Sessions | Frontdesk login/logout sessions |
| 🔑 Licenses | Seat licenses (valid / expired / revoked) |
| 🔐 Accounts & Keys | Bind Google/Trello accounts per seat; ▶ Spawn MCP for a seat |
| 💬 Chat | Chat with the configured LLM (the agent) directly from the dashboard — each conversation is saved as its own log file |
| ⚙️ Config | Sectioned field editor with per-key source badges, secret show/hide, Save (edited keys only), Export / Import, Raw JSON toggle |
| 🧰 Tools | Shared tool manifest + Trello/Gmail quick actions |
| 🎨 Appearance | Light / Dark / System theme (`APPEARANCE_THEME` — native chrome + dashboard) |
| ℹ️ About | App name + version (About) + a Guide sub-tab |
| ⏻ Quit (bottom) | Quits the app — main `before-quit` stops all backend services |

## Source layout

```
electron/
  package.json          (electron ^33, electron-builder)
  src/main.js           main process: service manager, IPC, tray, notifications, tools
  src/main/oauth.js     loopback Google OAuth (bind account → seat)
  src/preload.js        contextBridge → window.api
  src/renderer/         index.html, style.css, app.js (vanilla, no build step)
  README.md
```

- [`electron/package.json`](../electron/package.json#L1) — scripts (`start`, `dev`, `dist:mac`) + Electron deps
- [`electron/src/main.js`](../electron/src/main.js#L1) — service manager, IPC, tray, notifications, tools
- [`electron/src/main/oauth.js`](../electron/src/main/oauth.js#L1) — loopback Google OAuth (bind account → seat)
- [`electron/src/preload.js`](../electron/src/preload.js#L7) — `contextBridge` → `window.api`
- [`electron/src/renderer/`](../electron/src/renderer/index.html#L1) — `index.html`, `style.css`, `app.js` (vanilla, no build step)

## Build (dmg/zip)

```bash
npm run electron:build   # = electron-builder --mac
```

[`npm run electron:build`](../package.json#L48) = [`electron-builder --mac`](../electron/package.json#L1) (the `dist:mac` script).

Packaged apps read the repo pieces (scripts, shared, mcp, webapp) from `extraResources`, but
`.env`/`config.json`/`safe`/`logs/` are read from the live repo — the primary flow is dev (`npm start`).

A repo-root `config.json` (plain JSON) is the primary config source; `.env` is used when it's absent.
Manage it from the **⚙️ Config** tab — a sectioned field editor with per-key source badges
(`config.json` / `.env` / default), secret show/hide, and Save that writes only the keys you change.
A **Raw JSON** toggle keeps the full-editor view.

## Notes

- Tray menu (Open, Start services, Quit) + native notification when the priority queue grows.
- Closing the window keeps the app running in the background; quit via the tray or the sidebar
  Quit button.
- If `electron --version` reports `Electron failed to install correctly`, reinstall:
  `cd electron && rm -rf node_modules/electron && npm install electron@33.4.11` (decline npx's
  offer to fetch a different version and use `./node_modules/.bin/electron`).
