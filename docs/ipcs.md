# Electron IPC Channels

The Electron renderer has **no Node access** — all privileged work happens in the main
process ([`electron/src/main.js`](../electron/src/main.js#L364)) via `ipcMain.handle`, exposed to the renderer through the
preload bridge ([`electron/src/preload.js`](../electron/src/preload.js#L7)) as `window.api`. The renderer calls these with
`await api.<name>(...)`.

## Channels

| `window.api` method | IPC channel | Returns |
| ------------------- | ----------- | ------- |
| `svcList()` | [`svc:list`](../electron/src/main.js#L364) | Array of `{name,label,configured,running,pid,health}` for every service (webhook, runner, tunnel, `mcp:*`) |
| `svcStart(name)` | [`svc:start`](../electron/src/main.js#L365) | `{ok, pid?, already?}` |
| `svcStop(name)` | [`svc:stop`](../electron/src/main.js#L366) | `{ok}` |
| `svcLog(name, lines?)` | [`svc:log`](../electron/src/main.js#L367) | Tail of a service's stdout/stderr ring buffer |
| `health()` | [`health`](../electron/src/main.js#L369) | `{ok, json}` from `:3199/health` |
| `queue()` | [`queue:get`](../electron/src/main.js#L377) | `/api/queue-status` result |
| `eventsClear(id, queue)` | [`events:clear`](../electron/src/main.js#L384) | PATCH `/events/:id?queue=` |
| `logsQuery(filters)` | [`logs:get`](../electron/src/main.js#L386) | Live-buffer entries matching `{source, subSource, level, search, limit, sinceTs}` |
| `logsFiles()` | [`logs:files`](../electron/src/main.js#L387) | `{path,name,size,mtime,source}` for every file under `logs/` |
| `logsFile(path, maxLines?)` | [`logs:file`](../electron/src/main.js#L388) | Lines of a file under `logs/` (guarded against path escape) |
| `logsClear()` | [`logs:clear`](../electron/src/main.js#L394) | Clears the in-memory live buffer |
| `onLogEntry(cb)` | `logs:entry` (push) | Live entries pushed from main via `webContents.send`; see [`main/logger.js`](../electron/src/main/logger.js#L1) |
| `toolLog(lines?)` | [`logs:tool`](../electron/src/main.js#L385) | `/tool-logs?lines=` result (legacy tool-call tail) |
| `sessions()` | [`frontdesk:sessions`](../electron/src/main.js#L398) | Last 200 frontdesk session entries |
| `licenses()` | [`licenses:list`](../electron/src/main.js#L400) | `{ok, seats:[{sub,status,exp,issuedAt,enc}]}` |
| `config()` | [`config:get`](../electron/src/main.js#L401) | Config summary: `{present, source, configPath, values, webhookBaseUrl, …}` (config.json primary, `.env` fallback) |
| `configSave(values)` | [`config:save`](../electron/src/main.js#L409) | Writes the flat object to `config.json` and applies it to `process.env` |
| `configExport()` | [`config:export`](../electron/src/main.js#L414) | `{ok, present, source, json}` — effective config as pretty JSON |
| `configImport(raw)` | [`config:import`](../electron/src/main.js#L418) | Parses JSON → saves `config.json` → applies to `process.env` |
| `configWithSources()` | [`config:getWithSources`](../electron/src/main.js#L487) | Per-key config with source annotation — `{values: {key: {value, source}}}` where source ∈ `config.json` \| `.env` \| `default` |
| `googleStatus()` | [`google:status`](../electron/src/main.js#L413) | `{connected, user, consentUrl}` |
| `toolsManifest()` | [`tools:manifest`](../electron/src/main.js#L410) | Shared tool manifest ([`shared/tool-manifest.js`](../shared/tool-manifest.js#L1)) |
| `trello(action, params)` | [`tools:trello`](../electron/src/main.js#L411) | Trello REST quick actions (list_boards/lists/cards, add_comment) |
| `gmail(action, params)` | [`tools:gmail`](../electron/src/main.js#L412) | Gmail list/get via googleapis |
| `openExternal(url)` | [`open:external`](../electron/src/main.js#L456) | Open a URL in the system browser |
| `getTheme()` | [`app:getTheme`](../electron/src/main.js#L460) | `{theme: light\|dark\|system, effective: dark\|light}` |
| `setTheme(theme)` | [`app:setTheme`](../electron/src/main.js#L461) | Persists `APPEARANCE_THEME` to `config.json` (or `.env` fallback), applies it, returns theme info |
| `quit()` | [`app:quit`](../electron/src/main.js#L462) | Quit the app (main `before-quit` stops all services) |
| `accountsList()` | [`accounts:list`](../electron/src/main.js#L415) | `{ok, rows:[{sub, googleConnected, googleUser, trelloConfigured}]}` |
| `accountsConnectGoogle(sub)` | [`accounts:connectGoogle`](../electron/src/main.js#L430) | Runs loopback OAuth for the seat → binds Google account |
| `accountsSetTrello(sub, key, token)` | [`accounts:setTrello`](../electron/src/main.js#L431) | Stores a seat's Trello credentials |
| `accountsClear(sub)` | [`accounts:clear`](../electron/src/main.js#L440) | Removes a seat's bindings |
| `accountsSpawnForSeat(sub)` | [`accounts:spawnForSeat`](../electron/src/main.js#L449) | Spawns dedicated `mcp:gmail:<sub>` / `mcp:trello:<sub>` with per-seat env |
| `accountsStopForSeat(sub)` | [`accounts:stopForSeat`](../electron/src/main.js#L450) | Stops the per-seat MCP instances |
| `appVersion()` | [`app:version`](../electron/src/main.js#L550) | `{ok, name, version}` — app name/version (About tab) |
| `scriptsList()` | [`scripts:list`](../electron/src/main.js#L977) | `{ok, preflight, scripts, runs}` — runnable scripts under the operator scripts folder (safe subfolder included) |
| `scriptsRun(name, payload)` | [`scripts:run`](../electron/src/main.js#L983) | Runs a script — raw args string, or `{values, extra}` from a `.params.json` form |
| `scriptsStop(target)` | [`scripts:stop`](../electron/src/main.js#L984) | Stops a running script |
| `scriptsRunning()` | [`scripts:running`](../electron/src/main.js#L985) | `{ok, runs}` |
| `scriptsPick(opts)` | [`scripts:pick`](../electron/src/main.js#L987) | Native file/folder dialog for form fields → `{ok, path}` |
| `chatList()` | [`chat:list`](../electron/src/main.js#L1151) | `{ok, sessions}` — chats under `logs/electron_chat/` |
| `chatNew(title?, origin?)` | [`chat:new`](../electron/src/main.js#L1152) | Starts a new chat session (origin: operator default, or frontdesk) |
| `chatHistory(id)` | [`chat:history`](../electron/src/main.js#L1160) | `{ok, entries}` — full transcript (agentic tool turns included) |
| `chatSend(id, message)` | [`chat:send`](../electron/src/main.js#L1161) | Operator: runs the agentic tool loop (reads auto, mutating actions ask first), streaming steps via `chat:step`. Frontdesk/tool-less: plain LLM Q&A |
| `chatDecide(token, approved, editedArgs?)` | [`chat:decide`](../electron/src/main.js#L1163) | Approve/Deny a proposed tool call (optional edited JSON args) |
| `chatStop(id)` | [`chat:stop`](../electron/src/main.js#L1174) | Stop the running agent loop for a session |
| `onChatStep(cb)` | `chat:step` (push) | Live chat entries + approval requests (see [`preload.js`](../electron/src/preload.js#L1)) |

## Security notes

- `contextIsolation: true`, `nodeIntegration: false` — the renderer only sees the methods above.
- Service logs are kept in a per-service ring buffer (500 lines) in the main process; credentials
  are never sent to the renderer (only connected/configured booleans + user emails).
- Per-seat MCP spawns pass credentials as child-process env overrides — never over IPC.
- Chat LLM calls run in the main process; chat transcripts are written under `logs/electron_chat/`.
- Tools (read-only run automatically; mutating actions show an Approve/Deny prompt) are only enabled on
  the **operator** channel — frontdesk chats never get tools. External tool results are sanitized before
  being fed back to the model.

## Loopback OAuth ([`electron/src/main/oauth.js`](../electron/src/main/oauth.js#L1))

[`accounts:connectGoogle(sub)`](../electron/src/main.js#L430) runs the consent → redirect → token-exchange flow in the main
process (opens the system browser, listens on an ephemeral `127.0.0.1` port), then calls
[`setSeatGoogle(sub, …)`](../scripts/frontdesk-accounts.mjs#L60) from [`scripts/frontdesk-accounts.mjs`](../scripts/frontdesk-accounts.mjs#L1). Works without the tunnel.
