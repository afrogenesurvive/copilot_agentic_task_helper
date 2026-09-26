/**
 * Preload — exposes a minimal, safe IPC surface to the renderer via contextBridge.
 * The renderer has no Node access; everything goes through these invoke channels.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // The gate. While locked these three are the ONLY auth channels main will answer —
  // every other invoke rejects with "locked: …", which is what makes hiding the UI
  // cosmetic rather than the actual control. The secret is passed straight through and is
  // never logged, stored or echoed back (main's login() answers with email/role/deadline
  // only).
  //
  // authLogout ends the session, stops the app's services and returns the window to the
  // gate. It is here (rather than gated) because a session that lapses while the dashboard
  // is open does not re-lock the window, so refusing it would leave an operator with a Log
  // Out button that errors and no way to clear it. It never reveals anything: the reply is
  // a locked state, and the document that asked is destroyed by the gate swap.
  authState: () => ipcRenderer.invoke("auth:state"),
  authLogin: (email, secret) => ipcRenderer.invoke("auth:login", email, secret),
  authLogout: () => ipcRenderer.invoke("auth:logout"),
  // Services
  svcList: () => ipcRenderer.invoke("svc:list"),
  svcStart: (name) => ipcRenderer.invoke("svc:start", name),
  svcStop: (name) => ipcRenderer.invoke("svc:stop", name),
  svcRestart: (name) => ipcRenderer.invoke("svc:restart", name),
  // Bulk: an array of service names. Each one is started when down and restarted when up.
  svcBulkAction: (names) => ipcRenderer.invoke("svc:bulkAction", names),
  svcReregisterWebhooks: () => ipcRenderer.invoke("webhook:reregister"),
  svcLog: (name, lines) => ipcRenderer.invoke("svc:log", name, lines),
  health: () => ipcRenderer.invoke("health"),
  // Queues + logs
  queue: () => ipcRenderer.invoke("queue:get"),
  eventsClear: (id, queue) => ipcRenderer.invoke("events:clear", id, queue),
  eventsClearAll: (queue) => ipcRenderer.invoke("events:clearAll", queue),
  toolLog: (lines) => ipcRenderer.invoke("logs:tool", lines),
  logsQuery: (filters) => ipcRenderer.invoke("logs:get", filters),
  logsFiles: () => ipcRenderer.invoke("logs:files"),
  logsFile: (filePath, maxLines) => ipcRenderer.invoke("logs:file", filePath, maxLines),
  logsClear: () => ipcRenderer.invoke("logs:clear"),
  onLogEntry: (cb) => {
    const listener = (_e, entry) => cb(entry);
    ipcRenderer.on("logs:entry", listener);
    return () => ipcRenderer.removeListener("logs:entry", listener);
  },
  sessions: () => ipcRenderer.invoke("frontdesk:sessions"),
  // Notification centre (feed + read state live in main; see main/notifications.js)
  notificationsList: (opts) => ipcRenderer.invoke("notifications:list", opts),
  // Acknowledge: { source } clears one dot, { all: true } clears every dot
  notificationsRead: (target) => ipcRenderer.invoke("notifications:read", target),
  notificationsClear: () => ipcRenderer.invoke("notifications:clear"),
  onNotification: (cb) => {
    const listener = (_e, entry) => cb(entry);
    ipcRenderer.on("notifications:new", listener);
    return () => ipcRenderer.removeListener("notifications:new", listener);
  },
  // Key Manager — pkm-backed; all licensing logic/data lives in personal_key_manager.
  // `registry` selects which registry a command applies to (PKM_REGISTRY when omitted).
  //
  // Writes are gated in main (electron/src/main/key-manager.mjs): a call can be
  // refused before it spawns anything when the store cannot support it, so a
  // disabled control here is a hint, not the boundary.
  pkmCapabilities: (registry) => ipcRenderer.invoke("pkm:capabilities", registry),
  pkmStatus: (registry) => ipcRenderer.invoke("pkm:status", registry),
  pkmList: (registry, days) => ipcRenderer.invoke("pkm:list", registry, days),
  pkmSeatInfo: (registry, sub) => ipcRenderer.invoke("pkm:seatInfo", registry, sub),
  pkmIssue: (registry, sub, exp) => ipcRenderer.invoke("pkm:issue", registry, sub, exp),
  pkmRevoke: (registry, sub, reason) => ipcRenderer.invoke("pkm:revoke", registry, sub, reason),
  pkmUnrevoke: (registry, sub) => ipcRenderer.invoke("pkm:unrevoke", registry, sub),
  pkmArchive: (registry) => ipcRenderer.invoke("pkm:archive", registry),
  pkmAudit: (registry) => ipcRenderer.invoke("pkm:audit", registry),
  pkmValidate: (registry, key) => ipcRenderer.invoke("pkm:validate", registry, key),
  pkmChallenge: (registry, key) => ipcRenderer.invoke("pkm:challenge", registry, key),
  pkmSelfTest: (registry, key) => ipcRenderer.invoke("pkm:selfTest", registry, key),
  pkmCheckRevocation: (registry) => ipcRenderer.invoke("pkm:checkRevocation", registry),
  // Claims — identity bound to a key. `showVerifier` reveals the `pwdv` scrypt
  // verifier (display-once: it is offline-crackable, so never log it), and
  // `claimsSet` with `resign: true` returns a replacement licence under
  // `resigned.licenseKey` that must be handed to the seat owner.
  pkmClaimsShow: (registry, sub, showVerifier) => ipcRenderer.invoke("pkm:claimsShow", registry, sub, showVerifier),
  pkmClaimsSet: (registry, sub, patch) => ipcRenderer.invoke("pkm:claimsSet", registry, sub, patch),
  pkmClaimsResign: (registry, sub, force) => ipcRenderer.invoke("pkm:claimsResign", registry, sub, force),
  pkmClaimsBackfill: (registry, opts) => ipcRenderer.invoke("pkm:claimsBackfill", registry, opts),
  pkmClaimsVerify: (registry) => ipcRenderer.invoke("pkm:claimsVerify", registry),
  pkmCredsTest: (registry, key, email, password) => ipcRenderer.invoke("pkm:credsTest", registry, key, email, password),
  // Ring management + embedded-blocklist sync (consumer apps that embed it)
  pkmRings: (registry) => ipcRenderer.invoke("pkm:rings", registry),
  pkmRingCreate: (registry, kid) => ipcRenderer.invoke("pkm:ringCreate", registry, kid),
  pkmRingRetire: (registry, kid, at) => ipcRenderer.invoke("pkm:ringRetire", registry, kid, at),
  pkmAgentKey: (registry) => ipcRenderer.invoke("pkm:agentKey", registry),
  pkmSetDefaultKid: (registry, kid) => ipcRenderer.invoke("pkm:setDefaultKid", registry, kid),
  pkmSyncRevocation: (registry) => ipcRenderer.invoke("pkm:syncRevocation", registry),
  // Store hygiene + the signed export bundle dev_mon reads
  pkmPerms: () => ipcRenderer.invoke("pkm:perms"),
  pkmPermsFix: () => ipcRenderer.invoke("pkm:permsFix"),
  pkmExportBundle: () => ipcRenderer.invoke("pkm:exportBundle"),
  pkmVerifyBundle: () => ipcRenderer.invoke("pkm:verifyBundle"),
  // Config
  config: () => ipcRenderer.invoke("config:get"),
  configWithSources: () => ipcRenderer.invoke("config:getWithSources"),
  configSave: (values) => ipcRenderer.invoke("config:save", values),
  configExport: () => ipcRenderer.invoke("config:export"),
  configImport: (raw) => ipcRenderer.invoke("config:import", raw),
  // Usage (DS-mon LLM token usage + DeepSeek credit balance)
  usageAggregate: () => ipcRenderer.invoke("usage:aggregate"),
  usageCredits: () => ipcRenderer.invoke("usage:credits"),
  usageFlush: () => ipcRenderer.invoke("usage:flush"),
  googleStatus: () => ipcRenderer.invoke("google:status"),
  googleConnect: () => ipcRenderer.invoke("google:connect"),
  // Accounts & Keys (seat → Google/Trello bindings)
  accountsList: () => ipcRenderer.invoke("accounts:list"),
  accountsConnectGoogle: (sub) => ipcRenderer.invoke("accounts:connectGoogle", sub),
  accountsSetTrello: (sub, key, token) => ipcRenderer.invoke("accounts:setTrello", sub, key, token),
  accountsClear: (sub) => ipcRenderer.invoke("accounts:clear", sub),
  accountsSpawnForSeat: (sub) => ipcRenderer.invoke("accounts:spawnForSeat", sub),
  accountsStopForSeat: (sub) => ipcRenderer.invoke("accounts:stopForSeat", sub),
  // Tools
  toolsManifest: () => ipcRenderer.invoke("tools:manifest"),
  trello: (action, params) => ipcRenderer.invoke("tools:trello", action, params),
  gmail: (action, params) => ipcRenderer.invoke("tools:gmail", action, params),
  whatsapp: (action, params) => ipcRenderer.invoke("tools:whatsapp", action, params),
  netlify: (action, params) => ipcRenderer.invoke("tools:netlify", action, params),
  openExternal: (url) => ipcRenderer.invoke("open:external", url),
  // Scripts (scripts/user runner — manual run only)
  scriptsList: () => ipcRenderer.invoke("scripts:list"),
  // payload: legacy string (raw args) OR { values, extra } from a form-manifest card
  scriptsRun: (name, payload) => ipcRenderer.invoke("scripts:run", name, payload),
  scriptsStop: (target) => ipcRenderer.invoke("scripts:stop", target),
  scriptsRunning: () => ipcRenderer.invoke("scripts:running"),
  scriptsPick: (opts) => ipcRenderer.invoke("scripts:pick", opts), // { browseFor } -> { path }
  onScriptOutput: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on("scripts:output", listener);
    return () => ipcRenderer.removeListener("scripts:output", listener);
  },
  onScriptsUpdate: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on("scripts:update", listener);
    return () => ipcRenderer.removeListener("scripts:update", listener);
  },
  // About
  appVersion: () => ipcRenderer.invoke("app:version"),
  // Docs (About → Guide)
  docsList: () => ipcRenderer.invoke("docs:list"),
  docsGet: (file) => ipcRenderer.invoke("docs:get", file),
  // Chat
  chatList: () => ipcRenderer.invoke("chat:list"),
  chatNew: (title, origin) => ipcRenderer.invoke("chat:new", title, origin),  // origin: 'operator' | 'frontdesk' (default operator)
  chatHistory: (id) => ipcRenderer.invoke("chat:history", id),
  chatSend: (id, message) => ipcRenderer.invoke("chat:send", id, message),
  chatDecide: (token, approved, editedArgs) => ipcRenderer.invoke("chat:decide", token, approved, editedArgs), // approve/deny a proposed tool call
  chatStop: (id) => ipcRenderer.invoke("chat:stop", id), // stop the running agentic loop
  onChatStep: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on("chat:step", listener);
    return () => ipcRenderer.removeListener("chat:step", listener);
  },
  // Appearance
  getTheme: () => ipcRenderer.invoke("app:getTheme"),
  setTheme: (theme) => ipcRenderer.invoke("app:setTheme", theme),
  setAppearance: (patch) => ipcRenderer.invoke("app:setAppearance", patch),
  quit: () => ipcRenderer.invoke("app:quit"),
  // Menu-bar popover (electron/src/renderer/tray.js). Same document preload as the
  // dashboard, so these are the only two channels the panel adds.
  trayOpenDashboard: () => ipcRenderer.invoke("tray:openDashboard"),
  trayHide: () => ipcRenderer.invoke("tray:hidePopover"),
  // The corner grip: asks main to scale the panel (window size AND zoom factor) and
  // gets back the scale actually applied, which is lower when the display cannot fit it.
  // `persist` is false for the frames of a drag and true once, on release.
  trayZoom: (scale, persist) => ipcRenderer.invoke("tray:zoom", scale, persist),
  onTrayRefresh: (cb) => {
    // The payload carries the current scale: the grip needs it to turn a pointer delta
    // into a size, because the page itself is zoomed (a raw CSS-pixel delta would make
    // the handle drift away from the cursor).
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on("tray:refresh", listener);
    return () => ipcRenderer.removeListener("tray:refresh", listener);
  },
});
