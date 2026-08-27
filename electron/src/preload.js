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
  svcLog: (name, lines) => ipcRenderer.invoke("svc:log", name, lines),
  health: () => ipcRenderer.invoke("health"),
  // Queues + logs
  queue: () => ipcRenderer.invoke("queue:get"),
  eventsClear: (id, queue) => ipcRenderer.invoke("events:clear", id, queue),
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
  // Licenses + config
  licenses: () => ipcRenderer.invoke("licenses:list"),
  config: () => ipcRenderer.invoke("config:get"),
  configSave: (values) => ipcRenderer.invoke("config:save", values),
  configExport: () => ipcRenderer.invoke("config:export"),
  configImport: (raw) => ipcRenderer.invoke("config:import", raw),
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
  openExternal: (url) => ipcRenderer.invoke("open:external", url),
  // Appearance
  getTheme: () => ipcRenderer.invoke("app:getTheme"),
  setTheme: (theme) => ipcRenderer.invoke("app:setTheme", theme),
  quit: () => ipcRenderer.invoke("app:quit"),
});
