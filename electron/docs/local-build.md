# 🛠️ Local build (macOS `.app`)

How to build and run a **local** copy of Dev Centre — an `.app` for this machine, working against
**this checkout**. Not a distribution guide: the app resolves its repo at launch, so whoever runs it
needs the repo (and its `node_modules`) on disk. A shippable build is a different piece of work.

## Prerequisites

- The repo is installed and working in dev: `npm run electron:install` has been run, and
  `npm start` opens the dashboard.
- `config.json` or `.env` exists at the repo root — the built app reads its config from the repo, so
  it has none without one.
- Node is installed (the app's services are `node` processes; see *Which node* below).

## Build

```bash
npm --prefix electron run make:icon    # only if electron/assets/icon.icns is missing
npm run trust:bake                     # only matters for seat-licence sign-in; see below
npm run electron:build                 # preflight → electron-builder --mac
```

`electron:build` runs `scripts/check-build-preflight.mjs` first and refuses to build when something
would produce an app that starts blank — a missing icon, an uninstalled `electron/node_modules`, or
no `config.json`/`.env`. It warns (without failing) when the baked licence trust is stale or when the
build would have no usable local password.

`dist:mac` also clears `electron/dist` before packing. A build over a previous run's output fails in
electron-builder's update-info step (`TypeError: Cannot read properties of null (reading 'provider')`),
which looks alarming but is only stale state — the clean build is the fix, so it is automatic.

Output: `electron/dist/mac-arm64/Dev Centre.app`, plus a `.dmg` and a `.zip`.

### Signing, and what it means locally

electron-builder signs the app with whatever identity it finds in your keychain. If that is not an
Apple **Developer ID** — a machine with only a self-signed certificate will not have one — the app is
signed with that instead (`TeamIdentifier=not set`) and notarization is skipped, so `spctl -a -t exec`
**rejects** it:

```
Dev Centre.app: rejected
origin=<your certificate's common name>
```

That does not stop you running it: Gatekeeper only enforces that verdict on a **quarantined** download,
and a locally built app carries no quarantine attribute. It does mean the signature is worthless
anywhere else — a self-signed identity proves nothing to another Mac — and that a build on a machine
with a different keychain is signed differently. Expect it, do not chase it.

### `trust:bake` — the one licensing step

`electron/src/main/dev-centre-trust.json` is the trust a build falls back to when the
`personal_key_manager` store is not readable: the master **ring** and the seat **blocklist**. It is a
baked snapshot, so a stale one refuses a licence signed by a newer ring key (`unknown_kid`) — and, the
other way round, a seat revoked since the last bake would still sign in. `npm run trust:bake` refreshes
it from the store; the preflight warns when it is older than the store's own `ring.json` /
`revoked-seats.json`.

If you sign in with a password (`DEV_CENTRE_ADMINS` in `.env`) rather than a seat licence, you can skip
this — but the preflight's warning is then the only thing standing between you and a confusing
`revoked_seat` refusal later.

### Which node

The app resolves its interpreter at launch (`electron/src/main/runtime.js`): `NODE_BIN`, else a real
`node` found on PATH (with `~/.nvm/versions/node/*/bin`, `/opt/homebrew/bin` and `/usr/local/bin`
prepended, because a Finder launch does not inherit your shell's PATH), else the Electron binary
running as Node (`ELECTRON_RUN_AS_NODE=1`). That last fallback is why double-clicking works on a Mac
with no Node installed at all; set `NODE_BIN=/path/to/node` if you need a specific one.

## Running it

1. Copy `Dev Centre.app` to `/Applications` (or anywhere — the path does not matter).
2. Launch it. **The first launch asks for the repo folder**: pick
   `…/Documents/GitHub/copilot_agentic_task_helper`. That answer is remembered, and the app
   relaunches against it.
3. Sign in. Admins come from `DEV_CENTRE_ADMINS` in the repo's `.env`; a seat licence also works.

## Where things live

The app runs against the repo, so nearly everything is where the CLI tools expect it:

| Thing | Location |
| --- | --- |
| `config.json`, `.env` | repo root (shared with every `npm run …` script) |
| `safe/`, `logs/`, `tasks/` | repo root |
| `node_modules` (app + each `mcp/*`) | repo |
| Repo pointer | `~/Library/Application Support/Dev Centre/repo.json` |
| Panel zoom, sidebar width, collapsed sections | `~/Library/Application Support/Dev Centre/` |

The pointer is the **only** new state in Application Support: delete `repo.json` to be asked for the
folder again.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| The folder dialog appears on every launch | The picker could not write `repo.json` (check permissions on `~/Library/Application Support/Dev Centre`), or the chosen folder no longer passes validation — it must contain `package.json` with `"name": "copilot_agentic_task_helper"`, plus `shared/config-loader.cjs` and `mcp/webhook-server/index.js`. |
| "That is not the Dev Centre repo" | You picked a parent folder (`GitHub`) or a copy without `node_modules`/markers. Pick the folder itself. |
| Repo moved or renamed | The pointer fails validation on launch and the app asks again. Nothing else to do. |
| A service immediately exits with `ENOENT` | The interpreter could not be spawned. Set `NODE_BIN` to a real node, then relaunch. |
| A service exits with `ERR_MODULE_NOT_FOUND` | `npm install` has not been run in the repo (or in that `mcp/*` folder). The built app uses the repo's `node_modules`, it does not carry its own. |
| Sign-in refuses a licence with `revoked_seat` / `unknown_kid` | The baked trust is stale: `npm run trust:bake`, then rebuild. |
| Dashboard is empty, Config says "no config.json" | The app resolved a different folder than you expect: check `repo.json` (above), or `DEV_CENTRE_REPO` if you launched from a terminal. |
| Gatekeeper refuses to open it | Only affects a *copied/downloaded* copy — a locally built app has no quarantine attribute, so double-click works even though `spctl` rejects the self-signed bundle (see above). If you zipped and moved it: right-click → **Open**, or `xattr -dr com.apple.quarantine "/Applications/Dev Centre.app"`. |
| A rebuild fails with `Cannot read properties of null (reading 'provider')` | Stale `electron/dist`. `npm run electron:build` clears it automatically; a bare `electron-builder --mac` does not. |

## Notes

- **Local only.** macOS-only, arm64-only (built for this Mac), signed with a keychain identity but not
  notarized. Handing the `.app` to someone else does not work: they have no checkout for it to resolve,
  so the app can only ask for a folder it will not find. A shippable build is a separate piece of work —
  it needs the app to bring its own config store, Node runtime and service dependencies.
- **Rebuilds keep your settings**: config lives in the repo, never in the bundle, so replacing the
  `.app` changes nothing about your configuration or credentials.
- **Quit properly** (menu-bar menu or Cmd+Q) so `before-quit` stops the services it started;
  a force-quit can leave `node` processes behind (`pgrep -fl "mcp/"`).
