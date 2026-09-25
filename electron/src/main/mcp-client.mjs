/**
 * In-process MCP client — Electron main process.
 *
 * Gives the operator chat (and the Tools-tab quick actions) access to every
 * configured MCP server WITHOUT duplicating their REST logic a third time: the
 * advertised tool list comes from `shared/tool-manifest.js` — the same arrays the
 * servers themselves import — and the first *call* to a server's tool lazily
 * spawns that server as a stdio child and speaks the Model Context Protocol to it.
 *
 * Why the manifest (not `tools/list`) drives the advertised list: answering "what
 * tools exist?" must not cost eight node processes. The manifest and each server
 * import the identical arrays, so the two cannot drift — and `verifyAgainstManifest()`
 * below warns loudly if a running server ever exposes something the manifest lacks.
 *
 * Why the client spawns its own children instead of reusing the Dashboard's services:
 * a server's stdio is a single pipe, and `startService()` already consumes it for the
 * log ring buffer (plus the servers only print to stderr — they never speak on
 * stdout). So an MCP conversation needs its own process. `MCP_NAMES` in main.js is
 * therefore NOT autostarted; those entries now exist for manual Start/Restart/Stop.
 *
 * Credentials: the transport is handed `{...process.env}` EXPLICITLY. Left to its
 * default the SDK spawns children with `getDefaultEnvironment()`, a filtered set
 * that drops GMAIL_* / TRELLO_* / NETLIFY_* / WHATSAPP_* — every server would then
 * fail as "not configured" while looking perfectly healthy.
 */
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  trelloTools,
  gmailTools,
  driveTools,
  calendarTools,
  sheetsTools,
  webSearchTools,
  whatsappTools,
  netlifyTools,
} from "../../../shared/tool-manifest.js";

/**
 * Servers this client may spawn, mapped to the manifest array that describes them.
 * Deliberately absent: `photos` (picker-only — it needs a human to open a URI and
 * `photos_picker_download` writes to a caller-chosen local dir) and the
 * `frontdesk_reply` tool (belongs to the frontdesk agent path, never the operator
 * console). Both are excluded here rather than in a filter, so they cannot be
 * reached by accident.
 */
const SERVER_TOOLS = {
  trello: trelloTools,
  gmail: gmailTools,
  drive: driveTools,
  calendar: calendarTools,
  sheets: sheetsTools,
  "web-search": webSearchTools,
  whatsapp: whatsappTools,
  netlify: netlifyTools,
};

export const MCP_SERVERS = Object.keys(SERVER_TOOLS);

/** tool name → owning MCP server, built once from the manifest. */
const TOOL_OWNER = new Map();
for (const [server, tools] of Object.entries(SERVER_TOOLS)) {
  for (const t of tools) TOOL_OWNER.set(t.name, server);
}

/** Every tool reachable through this client (manifest order, servers in MCP_SERVERS order). */
export function availableTools() {
  return MCP_SERVERS.flatMap((s) => SERVER_TOOLS[s]);
}

/** The MCP server that owns `toolName`, or null when nothing exposes it. */
export function ownerOf(toolName) {
  return TOOL_OWNER.get(toolName) || null;
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

const IDLE_MS = (() => {
  const n = parseInt(process.env.MCP_CLIENT_IDLE_MS ?? "", 10);
  if (Number.isFinite(n) && n >= 0) return n;
  return 10 * 60 * 1000; // children are idle REST wrappers; don't hold them forever
})();

let ctx = { repo: null, onLog: null, version: "0.0.0" };

/** @type {Map<string, {server:string, client?:object, transport?:object, pid?:number|null, connecting?:Promise<any>|null, tools?:Array|null, lastUsed?:number, idleTimer?:any, closing?:boolean}>} */
const conns = new Map();

/**
 * Wire the client to the host app. Call once, before the first tool call.
 * @param {{repo:string, version?:string, onLog?:function}} opts
 */
export function configure(opts = {}) {
  ctx = {
    repo: opts.repo || ctx.repo,
    onLog: typeof opts.onLog === "function" ? opts.onLog : ctx.onLog,
    version: opts.version || ctx.version,
  };
  return { idleMs: IDLE_MS, servers: MCP_SERVERS };
}

function log(message, level = "info") {
  if (ctx.onLog) ctx.onLog(message, level);
}

function touch(entry) {
  entry.lastUsed = Date.now();
  if (!IDLE_MS) return;
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    log(`idle ${Math.round(IDLE_MS / 1000)}s — closing ${entry.server}`, "muted");
    void closeEntry(entry);
  }, IDLE_MS);
  if (entry.idleTimer && typeof entry.idleTimer.unref === "function") entry.idleTimer.unref();
}

/** Forget a connection. The child is killed by the transport's own close(). */
function drop(entry) {
  if (!entry || !conns.has(entry.server) || conns.get(entry.server) !== entry) return;
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  conns.delete(entry.server);
}

async function closeEntry(entry) {
  if (!entry) return;
  entry.closing = true;
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  const client = entry.client;
  drop(entry);
  try {
    if (client) await client.close();
  } catch (err) {
    log(`${entry.server} close failed: ${err.message}`, "err");
  }
}

function pipeStderr(server, stream) {
  let buffered = "";
  stream.on("data", (chunk) => {
    buffered += chunk.toString();
    const lines = buffered.split("\n");
    buffered = lines.pop() || "";
    for (const line of lines) {
      const text = line.trim();
      if (text) log(`${server} | ${text}`, "muted");
    }
  });
  stream.on("error", () => {
    /* the child died; connect()/callTool() surface the real error */
  });
}

async function connect(server, entry) {
  const transport = new StdioClientTransport({
    command: process.env.MCP_NODE_BIN || "node",
    args: [path.join(ctx.repo, "mcp", server, "index.js")],
    cwd: ctx.repo,
    env: { ...process.env },
    stderr: "pipe",
  });
  // Attach before connect(): the transport returns the PassThrough immediately so
  // an import-time crash (bad credentials, missing module) is captured, not lost.
  if (transport.stderr) pipeStderr(server, transport.stderr);

  const client = new Client({ name: "dev-centre", version: ctx.version }, { capabilities: {} });
  await client.connect(transport);

  entry.client = client;
  entry.transport = transport;
  entry.pid = typeof transport.pid === "number" ? transport.pid : null;
  entry.tools = null;
  transport.onclose = () => {
    if (entry.closing) return;
    log(`${server} exited unexpectedly`, "warn");
    drop(entry);
  };
  transport.onerror = (err) => log(`${server} transport error: ${err.message}`, "err");
  touch(entry);
  log(`${server} connected (pid ${entry.pid})`, "ok");
  void verifyAgainstManifest(server, client);
  return entry;
}

/** Non-fatal drift check: warn when a server exposes a tool the manifest lacks. */
async function verifyAgainstManifest(server, client) {
  try {
    const listed = await client.listTools();
    const names = Array.isArray(listed?.tools) ? listed.tools.map((t) => t.name) : [];
    const known = new Set((SERVER_TOOLS[server] || []).map((t) => t.name));
    const extra = names.filter((n) => !known.has(n));
    if (extra.length) log(`${server} exposes tools missing from shared/tool-manifest.js: ${extra.join(", ")}`, "warn");
  } catch (err) {
    log(`${server} tools/list failed: ${err.message}`, "warn");
  }
}

/** Connect on first use and reuse thereafter; one in-flight connect per server. */
async function ensure(server) {
  if (!SERVER_TOOLS[server]) throw new Error(`unknown MCP server "${server}"`);
  if (!ctx.repo) throw new Error("mcp-client not configured (call configure({repo}) first)");

  const existing = conns.get(server);
  if (existing && existing.client) {
    touch(existing);
    return existing;
  }
  if (existing && existing.connecting) return existing.connecting;

  const entry = existing || { server };
  entry.connecting = connect(server, entry);
  conns.set(server, entry);
  try {
    return await entry.connecting;
  } catch (err) {
    // Leave no half-built entry behind, so the next call retries cleanly.
    if (conns.get(server) === entry) conns.delete(server);
    throw new Error(`MCP ${server} failed to start: ${err.message}`);
  } finally {
    if (entry.connecting) entry.connecting = null;
  }
}

// ── Calling ──────────────────────────────────────────────────────────────────

/** MCP content blocks → the `{ok, tool, result|error}` shape the chat loop expects. */
function normalize(tool, res) {
  const blocks = Array.isArray(res?.content) ? res.content : [];
  const text = blocks
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (res?.isError) return { ok: false, tool, error: text || "tool returned an error" };
  let result = text;
  try {
    result = JSON.parse(text);
  } catch {
    /* servers may return prose (e.g. "no such file") — keep it as text */
  }
  return { ok: true, tool, result };
}

/**
 * Run one tool through its MCP server.
 * Never throws: failures come back as `{ok:false, error}` so the chat loop can
 * hand the reason to the model instead of aborting the turn.
 */
export async function callTool(name, args) {
  const server = ownerOf(name);
  if (!server) return { ok: false, tool: name, error: `No MCP server exposes "${name}"` };
  let entry;
  try {
    entry = await ensure(server);
  } catch (err) {
    return { ok: false, tool: name, error: err.message };
  }
  try {
    const res = await entry.client.callTool({ name, arguments: args && typeof args === "object" ? args : {} });
    touch(entry);
    return normalize(name, res);
  } catch (err) {
    drop(entry); // a throw here usually means the child died — reconnect next time
    return { ok: false, tool: name, error: err.message };
  }
}

// ── Introspection / teardown ─────────────────────────────────────────────────

export function status() {
  return MCP_SERVERS.map((server) => {
    const c = conns.get(server);
    return {
      server,
      toolCount: (SERVER_TOOLS[server] || []).length,
      connected: !!(c && c.client),
      connecting: !!(c && c.connecting),
      pid: (c && c.pid) || null,
      lastUsed: (c && c.lastUsed) || null,
    };
  });
}

export async function close(server) {
  const c = conns.get(server);
  if (c) await closeEntry(c);
}

/** Kill every child. Called from shutdownEverything() so a quit leaves no strays. */
export async function closeAll() {
  await Promise.all([...conns.values()].map((c) => closeEntry(c)));
}
