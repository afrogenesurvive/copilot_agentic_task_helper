# Electron IPC Channels

The Electron renderer has **no Node access** — all privileged work happens in the main
process ([`electron/src/main.js`](../electron/src/main.js#L1033)) via `ipcMain.handle`, exposed to the renderer through the
preload bridge ([`electron/src/preload.js`](../electron/src/preload.js#L7)) as `window.api`. The renderer calls these with
`await api.<name>(...)`.

## Channels

| `window.api` method | IPC channel | Returns |
| ------------------- | ----------- | ------- |
| `svcList()` | [`svc:list`](../electron/src/main.js#L1657) | Array of `{name,label,configured,running,managed,external,pid,health}` for every service (webhook, runner, tunnel, `mcp:*`). `external` = up but started outside the dashboard (Start/Restart/Stop disabled) — either a live `/health` probe on its port, or (for a service with a `pidFile`, i.e. the runner) the pid in that file still being alive |
| `svcStart(name)` | [`svc:start`](../electron/src/main.js#L1658) | `{ok, pid?, already?}` |
| `svcStop(name)` | [`svc:stop`](../electron/src/main.js#L1659) | `{ok}` |
| `svcRestart(name)` | [`svc:restart`](../electron/src/main.js#L1660) | `{ok}` — stop then start a service (waits ~700 ms for the old process to free its port) |
| `svcStartAllDown()` | [`svc:startAllDown`](../electron/src/main.js#L1661) | Dashboard **Restart all down**: starts every **core** service that is not running (webhook, runner, tunnel) and leaves everything else alone. `mcp:*` is never bulk-started (the chat's in-process MCP client owns its own copy of each server), a service that is up — including an external one — is reported `action:"up"` and not touched, and an unconfigured one is `"skipped"`. Returns `{ok, started, startedNames, failed, results:[{name,label,action:"started"\|"up"\|"skipped"\|"failed",pid?,error?,reason?}]}`; re-entrancy guarded, so a second call while the first runs returns `{ok:false, error:"already starting services"}` |
| `svcLog(name, lines?)` | [`svc:log`](../electron/src/main.js#L1662) | Tail of a service's stdout/stderr ring buffer |
| `svcReregisterWebhooks()` | [`webhook:reregister`](../electron/src/main.js#L1663) | Re-runs the Trello/Gmail/Calendar/Drive registration scripts; restarts the webhook service only when the dashboard manages it (an external server is left running — registration alone applies): `{ok, steps:[{label, ok, output}], webhookRestarted}` |
| `health()` | [`health`](../electron/src/main.js#L1719) | `{ok, json}` from `:3199/health` |
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
| `notificationsList(opts)` | [`notifications:list`](../electron/src/main.js#L1584) | `{ok, items, counts}` — feed entries newest-first, filtered by `{source, level, search, unreadOnly, limit}`, plus `counts` = `{total, bySource, read, sources, uncleared, clearedAt}`. `total` is the read-based unread count; `uncleared` is the menu-bar badge's counter (recorded since the last clear). The store owns the feed (`logs/notifications/feed/*.jsonl`); the renderer only renders and acknowledges |
| `notificationsRead(target)` | [`notifications:read`](../electron/src/main.js#L1589) | Acknowledge: `{source}` clears that source's dot, `{all: true}` clears every dot. Returns the new counts. Does **not** touch the menu-bar badge |
| `notificationsClear()` | [`notifications:clear`](../electron/src/main.js#L1592) | Deletes every stored notification, resets the in-memory ring, and repaints the menu-bar badge — this is the **only** thing that lowers it |
| `onNotification(cb)` | `notifications:new` (push) | Each new entry as it is recorded — `{id, ts, source, level, title, body}`, `source` ∈ queue \| logs \| chat \| dashboard \| sessions \| scripts |
| `pkmCapabilities(registry?)` | [`pkm:capabilities`](../electron/src/main.js#L1678) | `{ok, data:{state, writable, reason, cli, doctor, actions, files, paths}}` — re-probes the key store. `state` ∈ `ready` \| `read-only` \| `blocklist-unreadable` \| `blocklist-missing` \| `store-missing` \| `cli-missing` \| `cli-broken`; `actions` holds a per-command verdict. Every disabled control on the Key Manager tab is painted from this |
| `pkmStatus(registry?)` | [`pkm:status`](../electron/src/main.js#L1323) | `{ok, data:{present, pkmRepo, pkmBin, storeRoot, indexFile, registry, registries:[{id,name,app,engine,defaultKid,rings,seats,revoked,verifierTargets}], entry, loosePermissions, authorityPublicKey, timeoutMs, capabilities}}`. `registry` defaults to `PKM_REGISTRY` (config.json/.env) |
| `pkmList(registry?, days?)` | [`pkm:list`](../electron/src/main.js#L1325) | `{ok, data:{registry, days, counts, archived, rows:[{sub,kid,exp,expUtc,issuedAt,enc,status,daysLeft}]}}`. Note `check-exp` archives already-expired records as a side effect |
| `pkmSeatInfo(registry?, sub)` | [`pkm:seatInfo`](../electron/src/main.js#L1326) | `{ok, data:{found, row}}` — one seat, for the Issue dialog's guards |
| `pkmIssue(registry?, sub, exp)` | [`pkm:issue`](../electron/src/main.js#L1327) | `{ok, data:{registry,sub,kid,exp,issuedAt,licenseKey}}` — **displayed once, never logged**. Refuses a seat already on the revocation blocklist, whose licence would be minted and then rejected at login |
| `pkmRevoke(registry?, sub, reason?)` | [`pkm:revoke`](../electron/src/main.js#L1335) | `{ok, data:{registry, sub, blocklistSize, archived}}` |
| `pkmUnrevoke(registry?, sub)` | [`pkm:unrevoke`](../electron/src/main.js#L1336) | `{ok, data:{registry, sub, changed, blocklistSize}}` |
| `pkmArchive(registry?)` | [`pkm:archive`](../electron/src/main.js#L1337) | `{ok, data:{registry, archived}}` |
| `pkmAudit(registry?)` | [`pkm:audit`](../electron/src/main.js#L1338) | `{ok, data:{registry, entries:[{ts,action,sub,kid,exp,detail}]}}` |
| `pkmValidate(registry?, key)` | [`pkm:validate`](../electron/src/main.js#L1339) | `{ok, data:{ok, claims?, reason?}}` |
| `pkmChallenge(registry?, key)` | [`pkm:challenge`](../electron/src/main.js#L1342) | `{ok, data:{ok, challengeResponseVerified, claims}}` — simulates the webapp login handshake; stronger than `pkmValidate` |
| `pkmSelfTest(registry?, key)` | [`pkm:selfTest`](../electron/src/main.js#L1343) | `{ok, data:{ok, ecdhAesGcmRoundTrip, claims}}` — the ECDH → AES-GCM round trip (`ed25519+x25519` only) |
| `pkmCheckRevocation(registry?)` | [`pkm:checkRevocation`](../electron/src/main.js#L1698) | `{ok, data:{ok, reject, parity}}` — reject test + per-file verifier parity for embedded blocklists |
| `pkmClaimsShow(registry?, sub, showVerifier?)` | [`pkm:claimsShow`](../electron/src/main.js#L1706) | `{ok, data:{registry, sub, kind, state, ledger, cert, keyPath, …}}` — `pkm claims show`. `state` ∈ `in-sync` \| `ledger-only` \| `cert-only` \| `mismatch` \| `no-cert`. `pwdv` is returned **only** with `showVerifier: true` — display once, never log |
| `pkmClaimsSet(registry?, sub, patch)` | [`pkm:claimsSet`](../electron/src/main.js#L1709) | **A write.** `patch` = `{email?, password?, clear?, resign?, force?}` → `{ok, data:{changed, resigned:{changed, licenseKey?, reason?}, claims, keyPath}}`. With `resign: true`, `resigned.licenseKey` is the **replacement licence — display once, never log**. The password goes on stdin |
| `pkmClaimsResign(registry?, sub, force?)` | [`pkm:claimsResign`](../electron/src/main.js#L1710) | **A write.** Pushes stored ledger claims into the cert. `changed: false` + `resigned.reason` means there was nothing to do |
| `pkmClaimsBackfill(registry?, opts)` | [`pkm:claimsBackfill`](../electron/src/main.js#L1713) | **A write**, ledger-only. `opts` = `{emailFromSub = true, dryRun = false}` → `{ok, data:{dryRun, changed, skipped, rows:[{sub, kid, action}]}}`. Use `dryRun` to preview |
| `pkmClaimsVerify(registry?)` | [`pkm:claimsVerify`](../electron/src/main.js#L1719) | `{ok, data:{ok, pending, reports:[{registry, ok, rows:[{sub, state, cert, ledger}], drifted, inertDivergent}]}}` — the cert↔ledger drift canary |
| `pkmCredsTest(registry?, key, email, password)` | [`pkm:credsTest`](../electron/src/main.js#L1720) | `{ok, data:{ok, reason, emailMatch, passwordMatch, claims}}` — the login check run offline. `reason` ∈ `ok` \| `password_mismatch` \| `email_mismatch` \| `revoked_seat` \| `malformed`. The password is stdin-only |
| `pkmPerms()` | [`pkm:perms`](../electron/src/main.js#L1731) | `{ok, data:{loose, clean}}` — group/other-accessible paths under the store |
| `pkmPermsFix()` | [`pkm:permsFix`](../electron/src/main.js#L1354) | `{ok, data:{loose, fixed}}` — `pkm perms --fix` (chmod only; no key material is touched) |
| `pkmExportBundle()` | [`pkm:exportBundle`](../electron/src/main.js#L1355) | `{ok, data:{bundleFile, signatureFile, authorityPublicKey, authorityKid, totals}}` — re-signs `export/devmon.json` |
| `pkmVerifyBundle()` | [`pkm:verifyBundle`](../electron/src/main.js#L1356) | `{ok, data:{ok, reason, kid}}` — checks the export bundle against its signature; `reason:"absent"` means *unverifiable*, not invalid |
| `pkmRings(registry?)` | [`pkm:rings`](../electron/src/main.js#L1346) | `{ok, data:{registry, defaultKid, rings:[{kid,publicKey,notAfter,createdAt}]}}` |
| `pkmRingCreate(registry?, kid)` | [`pkm:ringCreate`](../electron/src/main.js#L1347) | `{ok, data:{registry, kid, dir, privateKeyPath, publicKey}}` — mints a new master keypair (private half stays 0600 on disk) |
| `pkmRingRetire(registry?, kid, at?)` | [`pkm:ringRetire`](../electron/src/main.js#L1348) | `{ok, data:{registry, kid, notAfter}}` — `at` is an ISO date or `now` |
| `pkmAgentKey(registry?)` | [`pkm:agentKey`](../electron/src/main.js#L1349) | `{ok, data:{registry, dir, publicKey, privateKeyPath}}` — regenerates the X25519 peer keypair (ed25519+x25519 only; refused for `ed25519`) |
| `pkmSetDefaultKid(registry?, kid)` | [`pkm:setDefaultKid`](../electron/src/main.js#L1350) | `{ok, data:{registry, defaultKid}}` — ring that signs new seats |
| `pkmSyncRevocation(registry?)` | [`pkm:syncRevocation`](../electron/src/main.js#L1351) | `{ok, data:{results:[{registry, seats, changes:[{label,path,changed}]}]}}` — rewrites an embedded blocklist; **rebuild the consumer app** afterwards |
| `authState()` | [`auth:state`](../electron/src/main.js#L1756) | `{ok, state}` — the gate's own state: `{locked, email, role, expiresAt, remainingMs, limitSeconds, roles, adminsConfigured, adminCount, registryCount, registryPath, envPath, sessionLog, problems, needsSetup}`. Identities are `null` while locked, so the gate cannot be used to enumerate who has access. **One of the few channels allowed while locked** |
| `authLogin(email, secret)` | [`auth:login`](../electron/src/main.js#L1757) | Attempts a sign-in → `{ok:true, email, role, expiresAt, remainingMs, limitSeconds}` or `{ok:false, reason, detail}` where `reason` ∈ `no_admins_configured` \| `bad_email` \| `unknown_email` \| `bad_key`. The secret is never logged, stored or echoed back, and a success is applied by **main**, which swaps the window to `index.html`. **Allowed while locked** |
| `config()` | [`config:get`](../electron/src/main.js#L1271) | Config summary: `{present, source, configPath, values, webhookBaseUrl, …}` (config.json primary, `.env` fallback) |
| `configSave(values)` | [`config:save`](../electron/src/main.js#L1291) | Merges the changed keys into `config.json` (other keys preserved) and applies them to `process.env`; provider/usage-tracking key changes restart the runner + webhook |
| `configExport()` | [`config:export`](../electron/src/main.js#L1316) | `{ok, present, source, json}` — effective config as pretty JSON |
| `configImport(raw)` | [`config:import`](../electron/src/main.js#L1322) | Parses JSON → saves `config.json` → applies to `process.env` |
| `usageAggregate()` | [`usage:aggregate`](../electron/src/main.js#L1365) | Aggregated LLM token usage from the local DS-mon buffer + push status `{enabled, pushUrl, totals, byProvider, bySource, byModel, dsmon}` — `dsmon` carries `paused` + `reason` |
| `usageCredits()` | [`usage:credits`](../electron/src/main.js#L1366) | Provider-aware credit balance (DeepSeek balance endpoint; OpenAI/Anthropic report no public endpoint, Ollama is local) |
| `usageFlush()` | [`usage:flush`](../electron/src/main.js#L1367) | Pushes buffered usage to DS-mon now and returns the real outcome `{ok, at, count, error, paused, reason, bufferCount}` — a `401`/`403` pauses tracking instead of reporting a false success |
| `configWithSources()` | [`config:getWithSources`](../electron/src/main.js#L1287) | Per-key config with source annotation — `{values: {key: {value, source}}}` where source ∈ `config.json` \| `.env` \| `default` |
| `googleStatus()` | [`google:status`](../electron/src/main.js#L1160) | `{connected, user, consentUrl}` |
| `googleConnect()` | [`google:connect`](../electron/src/main.js) | Runs the loopback Google consent flow and rewrites the **operator** refresh token to whichever config store wins (`config.json` over `.env`); then drops the MCP client's children and restarts the runner/webhook. Returns `{ok, user, store, backup, restarted, closedMcp}`. Requests the scope set in `shared/google-scopes.mjs` |
| `toolsManifest()` | [`tools:manifest`](../electron/src/main.js#L1157) | Shared tool manifest ([`shared/tool-manifest.js`](../shared/tool-manifest.js#L1)) |
| `trello(action, params)` | [`tools:trello`](../electron/src/main.js#L1158) | Trello REST quick actions (list_boards/lists/cards, add_comment) |
| `gmail(action, params)` | [`tools:gmail`](../electron/src/main.js#L1159) | Gmail list/get via googleapis |
| `whatsapp(action, params)` | [`tools:whatsapp`](../electron/src/preload.js#L1) | WhatsApp Cloud API quick actions (status / list numbers / read inbox / send text or template) |
| `netlify(action, params)` | [`tools:netlify`](../electron/src/preload.js#L1) | Netlify quick actions, executed through the in-process MCP client (`electron/src/main/mcp-client.mjs`) rather than a local REST client: `list_sites` / `get_site` / `list_env` / `get_env` / `list_deploys` |
| `openExternal(url)` | [`open:external`](../electron/src/main.js#L1259) | Open a URL in the system browser |
| `getTheme()` | [`app:getTheme`](../electron/src/main.js#L1263) | `{theme: light\|dark\|system, effective: dark\|light, accentColor: string, fontSize: small\|medium\|large\|x-large\|xx-large}` |
| `setTheme(theme)` | [`app:setTheme`](../electron/src/main.js#L1264) | Persists `APPEARANCE_THEME` to `config.json` (or `.env` fallback), applies it, returns appearance info |
| `setAppearance(patch)` | [`app:setAppearance`](../electron/src/main.js#L1264) | Applies + persists any subset of `{theme, accentColor, fontSize}` (`APPEARANCE_THEME` / `APPEARANCE_ACCENT_COLOR` / `APPEARANCE_FONT_SIZE`); blank accent clears the override. Returns appearance info |
| `quit()` | [`app:quit`](../electron/src/main.js#L1265) | Quit the app (main `before-quit` stops all services) |
| `trayOpenDashboard()` | [`tray:openDashboard`](../electron/src/main.js#L1928) | Show + focus the dashboard (rebuilding or un-minimising it as needed) and dismiss the menu-bar panel. Used by the panel's button and its health pill |
| `trayHide()` | [`tray:hidePopover`](../electron/src/main.js#L1932) | Dismiss the menu-bar popover (Escape in the panel) |
| `accountsList()` | [`accounts:list`](../electron/src/main.js#L1162) | `{ok, rows:[{sub, googleConnected, googleUser, trelloConfigured}]}` |
| `accountsConnectGoogle(sub)` | [`accounts:connectGoogle`](../electron/src/main.js#L1177) | Runs loopback OAuth for the seat → binds Google account |
| `accountsSetTrello(sub, key, token)` | [`accounts:setTrello`](../electron/src/main.js#L1178) | Stores a seat's Trello credentials |
| `accountsClear(sub)` | [`accounts:clear`](../electron/src/main.js#L1187) | Removes a seat's bindings |
| `accountsSpawnForSeat(sub)` | [`accounts:spawnForSeat`](../electron/src/main.js#L1196) | Spawns dedicated `mcp:gmail:<sub>` / `mcp:trello:<sub>` with per-seat env |
| `accountsStopForSeat(sub)` | [`accounts:stopForSeat`](../electron/src/main.js#L1197) | Stops the per-seat MCP instances |
| `appVersion()` | [`app:version`](../electron/src/main.js#L1203) | `{ok, name, version}` — app name/version (About tab) |
| `docsList()` | [`docs:list`](../electron/src/main.js#L1) | `{ok, files:[{file,title}]}` — the end-user guides under `electron/docs/` (About → Guide) |
| `docsGet(file)` | [`docs:get`](../electron/src/main.js#L1) | `{ok, content}` for one guide (path-guarded against escape) |
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
| `onTrayRefresh(cb)` | `tray:refresh` (push) | Sent by main every time the menu-bar popover is shown, so the panel re-reads its pills, lists and uncleared count instead of polling (see [`electron/src/renderer/tray.js`](../electron/src/renderer/tray.js#L1)) |

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
