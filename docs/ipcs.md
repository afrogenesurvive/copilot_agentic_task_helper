# Electron IPC Channels

The Electron renderer has **no Node access** — all privileged work happens in the main
process ([`electron/src/main.js`](../electron/src/main.js#L1033)) via `ipcMain.handle`, exposed to the renderer through the
preload bridge ([`electron/src/preload.js`](../electron/src/preload.js#L7)) as `window.api`. The renderer calls these with
`await api.<name>(...)`.

## Channels

| `window.api` method | IPC channel | Returns |
| ------------------- | ----------- | ------- |
| `svcList()` | [`svc:list`](../electron/src/main.js#L1045) | Array of `{name,label,configured,running,managed,external,pid,health}` for every service (webhook, runner, tunnel, `mcp:*`). `external` = up but started outside the dashboard (Start/Restart/Stop disabled) |
| `svcStart(name)` | [`svc:start`](../electron/src/main.js#L1046) | `{ok, pid?, already?}` |
| `svcStop(name)` | [`svc:stop`](../electron/src/main.js#L1047) | `{ok}` |
| `svcRestart(name)` | [`svc:restart`](../electron/src/main.js#L1048) | `{ok}` — stop then start a service (waits ~700 ms for the old process to free its port) |
| `svcLog(name, lines?)` | [`svc:log`](../electron/src/main.js#L1049) | Tail of a service's stdout/stderr ring buffer |
| `svcReregisterWebhooks()` | [`webhook:reregister`](../electron/src/main.js#L1050) | Re-runs the Trello/Gmail/Calendar/Drive registration scripts; restarts the webhook service only when the dashboard manages it (an external server is left running — registration alone applies): `{ok, steps:[{label, ok, output}], webhookRestarted}` |
| `health()` | [`health`](../electron/src/main.js#L1079) | `{ok, json}` from `:3199/health` |
| `queue()` | [`queue:get`](../electron/src/main.js#L1087) | `/api/queue-status` result |
| `eventsClear(id, queue)` | [`events:clear`](../electron/src/main.js#L1094) | PATCH `/events/:id?queue=` |
| `eventsClearAll(queue)` | [`events:clearAll`](../electron/src/main.js#L1095) | DELETE `/events?queue=` — clears an entire queue |
| `logsQuery(filters)` | [`logs:get`](../electron/src/main.js#L1097) | Live-buffer entries matching `{source, subSource, level, search, limit, sinceTs}` |
| `logsFiles()` | [`logs:files`](../electron/src/main.js#L1098) | `{path,name,size,mtime,source}` for every file under `logs/` |
| `logsFile(path, maxLines?)` | [`logs:file`](../electron/src/main.js#L1099) | Lines of a file under `logs/` (guarded against path escape) |
| `logsClear()` | [`logs:clear`](../electron/src/main.js#L1105) | Clears the in-memory live buffer |
| `onLogEntry(cb)` | `logs:entry` (push) | Live entries pushed from main via `webContents.send`; see [`main/logger.js`](../electron/src/main/logger.js#L1) |
| `toolLog(lines?)` | [`logs:tool`](../electron/src/main.js#L1096) | `/tool-logs?lines=` result (legacy tool-call tail) |
| `sessions()` | [`frontdesk:sessions`](../electron/src/main.js#L1109) | Last 200 frontdesk session entries |
| `licenses()` | [`licenses:list`](../electron/src/main.js#L1111) | `{ok, seats:[{sub,status,exp,issuedAt,enc}]}` |
| `config()` | [`config:get`](../electron/src/main.js#L1112) | Config summary: `{present, source, configPath, values, webhookBaseUrl, …}` (config.json primary, `.env` fallback) |
| `configSave(values)` | [`config:save`](../electron/src/main.js#L1132) | Writes the flat object to `config.json` and applies it to `process.env` |
| `configExport()` | [`config:export`](../electron/src/main.js#L1149) | `{ok, present, source, json}` — effective config as pretty JSON |
| `configImport(raw)` | [`config:import`](../electron/src/main.js#L1155) | Parses JSON → saves `config.json` → applies to `process.env` |
| `configWithSources()` | [`config:getWithSources`](../electron/src/main.js#L1128) | Per-key config with source annotation — `{values: {key: {value, source}}}` where source ∈ `config.json` \| `.env` \| `default` |
| `googleStatus()` | [`google:status`](../electron/src/main.js#L1160) | `{connected, user, consentUrl}` |
| `toolsManifest()` | [`tools:manifest`](../electron/src/main.js#L1157) | Shared tool manifest ([`shared/tool-manifest.js`](../shared/tool-manifest.js#L1)) |
| `trello(action, params)` | [`tools:trello`](../electron/src/main.js#L1158) | Trello REST quick actions (list_boards/lists/cards, add_comment) |
| `gmail(action, params)` | [`tools:gmail`](../electron/src/main.js#L1159) | Gmail list/get via googleapis |
| `openExternal(url)` | [`open:external`](../electron/src/main.js#L1259) | Open a URL in the system browser |
| `getTheme()` | [`app:getTheme`](../electron/src/main.js#L1263) | `{theme: light\|dark\|system, effective: dark\|light}` |
| `setTheme(theme)` | [`app:setTheme`](../electron/src/main.js#L1264) | Persists `APPEARANCE_THEME` to `config.json` (or `.env` fallback), applies it, returns theme info |
| `quit()` | [`app:quit`](../electron/src/main.js#L1265) | Quit the app (main `before-quit` stops all services) |
| `accountsList()` | [`accounts:list`](../electron/src/main.js#L1162) | `{ok, rows:[{sub, googleConnected, googleUser, trelloConfigured}]}` |
| `accountsConnectGoogle(sub)` | [`accounts:connectGoogle`](../electron/src/main.js#L1177) | Runs loopback OAuth for the seat → binds Google account |
| `accountsSetTrello(sub, key, token)` | [`accounts:setTrello`](../electron/src/main.js#L1178) | Stores a seat's Trello credentials |
| `accountsClear(sub)` | [`accounts:clear`](../electron/src/main.js#L1187) | Removes a seat's bindings |
| `accountsSpawnForSeat(sub)` | [`accounts:spawnForSeat`](../electron/src/main.js#L1196) | Spawns dedicated `mcp:gmail:<sub>` / `mcp:trello:<sub>` with per-seat env |
| `accountsStopForSeat(sub)` | [`accounts:stopForSeat`](../electron/src/main.js#L1197) | Stops the per-seat MCP instances |
| `appVersion()` | [`app:version`](../electron/src/main.js#L1203) | `{ok, name, version}` — app name/version (About tab) |
| `scriptsList()` | [`scripts:list`](../electron/src/main.js#L1042) | `{ok, preflight, scripts, runs}` — runnable scripts under the operator scripts folder (safe subfolder included) |
| `scriptsRun(name, payload)` | [`scripts:run`](../electron/src/main.js#L1048) | Runs a script — raw args string, or `{values, extra}` from a `.params.json` form |
| `scriptsStop(target)` | [`scripts:stop`](../electron/src/main.js#L1049) | Stops a running script |
| `scriptsRunning()` | [`scripts:running`](../electron/src/main.js#L1050) | `{ok, runs}` |
| `scriptsPick(opts)` | [`scripts:pick`](../electron/src/main.js#L1052) | Native file/folder dialog for form fields → `{ok, path}` |
| `chatList()` | [`chat:list`](../electron/src/main.js#L1217) | `{ok, sessions}` — chats under `logs/electron_chat/` |
| `chatNew(title?, origin?)` | [`chat:new`](../electron/src/main.js#L1218) | Starts a new chat session (origin: operator default, or frontdesk) |
| `chatHistory(id)` | [`chat:history`](../electron/src/main.js#L1226) | `{ok, entries}` — full transcript (agentic tool turns included) |
| `chatSend(id, message)` | [`chat:send`](../electron/src/main.js#L1227) | Operator: runs the agentic tool loop (reads auto, mutating actions ask first), streaming steps via `chat:step`. Frontdesk/tool-less: plain LLM Q&A |
| `chatDecide(token, approved, editedArgs?)` | [`chat:decide`](../electron/src/main.js#L1229) | Approve/Deny a proposed tool call (optional edited JSON args) |
| `chatStop(id)` | [`chat:stop`](../electron/src/main.js#L1240) | Stop the running agent loop for a session |
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

[`accounts:connectGoogle(sub)`](../electron/src/main.js#L1177) runs the consent → redirect → token-exchange flow in the main
process (opens the system browser, listens on an ephemeral `127.0.0.1` port), then calls
[`setSeatGoogle(sub, …)`](../scripts/frontdesk-accounts.mjs#L60) from [`scripts/frontdesk-accounts.mjs`](../scripts/frontdesk-accounts.mjs#L1). Works without the tunnel.
