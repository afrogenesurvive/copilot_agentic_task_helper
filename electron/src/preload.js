/**
 * Preload — exposes a minimal, safe IPC surface to the renderer via contextBridge.
 * The renderer has no Node access; everything goes through these invoke channels.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // Services
  svcList: () => ipcRenderer.invoke("svc:list"),
  svcStart: (name) => ipcRenderer.invoke("svc:start", name),
  svcStop: (name) => ipcRenderer.invoke("svc:stop", name),
  svcRestart: (name) => ipcRenderer.invoke("svc:restart", name),
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
  // Key Manager — pkm-backed; all licensing logic/data lives in personal_key_manager.
  // `registry` selects which registry a command applies to (PKM_REGISTRY when omitted).
  pkmStatus: (registry) => ipcRenderer.invoke("pkm:status", registry),
  pkmRegistries: () => ipcRenderer.invoke("pkm:registries"),
  pkmList: (registry, days) => ipcRenderer.invoke("pkm:list", registry, days),
  pkmIssue: (registry, sub, exp) => ipcRenderer.invoke("pkm:issue", registry, sub, exp),
  pkmRevoke: (registry, sub, reason) => ipcRenderer.invoke("pkm:revoke", registry, sub, reason),
  pkmUnrevoke: (registry, sub) => ipcRenderer.invoke("pkm:unrevoke", registry, sub),
  pkmArchive: (registry) => ipcRenderer.invoke("pkm:archive", registry),
  pkmAudit: (registry) => ipcRenderer.invoke("pkm:audit", registry),
  pkmValidate: (registry, key) => ipcRenderer.invoke("pkm:validate", registry, key),
  // Ring management + embedded-blocklist sync (consumer apps that embed it)
  pkmRings: (registry) => ipcRenderer.invoke("pkm:rings", registry),
  pkmRingCreate: (registry, kid) => ipcRenderer.invoke("pkm:ringCreate", registry, kid),
  pkmRingRetire: (registry, kid, at) => ipcRenderer.invoke("pkm:ringRetire", registry, kid, at),
  pkmAgentKey: (registry) => ipcRenderer.invoke("pkm:agentKey", registry),
  pkmSetDefaultKid: (registry, kid) => ipcRenderer.invoke("pkm:setDefaultKid", registry, kid),
  pkmSyncRevocation: (registry) => ipcRenderer.invoke("pkm:syncRevocation", registry),
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
});
