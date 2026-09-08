/**
 * Local operator tools — Electron main process only.
 *
 * Gives the operator chat (channel: operator) safe, scoped access to the local
 * repo: file reads under an allowlist, today's daily task file, and the webhook
 * server's pending queues. All writes/clears are classified as MUTATING by the
 * caller (they require operator approval); reads run automatically.
 *
 * These tools deliberately live OUT of shared/tool-manifest.js — the MCP
 * servers and agent-runner must not advertise tools they can't execute.
 */
import fs from "node:fs";
import path from "node:path";

// Folders (and one file) the operator assistant may read. Secrets live in
// safe/, .env, config.json — intentionally excluded.
const DIR_ROOTS = ["scripts/user", "logs", "tasks", "docs"];
const FILE_ROOT = "notes.txt";

export const LOCAL_READ_NAMES = new Set([
  "fs_list_dir",
  "fs_read_file",
  "task_read_today",
  "queue_list_priority",
  "queue_list_misc",
]);

export const LOCAL_TOOLS = [
  {
    name: "fs_list_dir",
    description: "List entries in an allowed workspace folder (scripts/user, logs, tasks, docs). Read-only.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: 'Repo-relative folder, e.g. "tasks" or "logs/pending-tool-calls"' } },
      required: ["path"],
    },
  },
  {
    name: "fs_read_file",
    description: "Read a text file from an allowed folder (scripts/user, logs, tasks, docs) or notes.txt. Read-only.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: 'Repo-relative file, e.g. "tasks/2026-09-07.md"' } },
      required: ["path"],
    },
  },
  {
    name: "task_read_today",
    description: "Read today's daily task file (tasks/YYYY-MM-DD.md) with checkbox status. Read-only.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "task_check_item",
    description: "Mark a daily task item as done (needs approval). Matches by text within an unchecked '- [ ]' item.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "Text contained in the task line to check off" } },
      required: ["text"],
    },
  },
  {
    name: "queue_list_priority",
    description: "List unactioned items in the priority queue (webhook server). Read-only.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "queue_list_misc",
    description: "List unactioned items in the misc_notifications queue (webhook server). Read-only.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "queue_clear_item",
    description: "Mark a pending queue item as cleared (needs approval). Mirrors the agent's 'done' action.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Event id from a queue_list_* result" },
        queue: { type: "string", description: "priority or misc_notifications (default: priority)" },
      },
      required: ["id"],
    },
  },
];

function resolveAllowed(repo, rel) {
  const raw = String(rel || "").trim();
  if (!raw || raw.includes("..") || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
    throw new Error(`invalid path (must be repo-relative): ${raw}`);
  }
  const abs = path.resolve(repo, raw);
  const inDir = DIR_ROOTS.some((r) => {
    const root = path.join(repo, r);
    return abs === root || abs.startsWith(root + path.sep);
  });
  if (inDir) return abs;
  if (abs === path.join(repo, FILE_ROOT)) return abs;
  throw new Error(`path not allowed (must be under ${DIR_ROOTS.join(", ")} or ${FILE_ROOT}): ${raw}`);
}

function todayFile(repo) {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return path.join(repo, "tasks", `${d.getFullYear()}-${mm}-${dd}.md`);
}

function readTaskLines(file) {
  const src = fs.readFileSync(file, "utf8");
  const lines = src.split("\n");
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^-\s+\[( |x)\]\s+(.*)$/.exec(lines[i]);
    if (m) items.push({ line: i + 1, done: m[1] === "x", text: m[2].trim() });
  }
  return { lines, items };
}

async function webhookRequest(relPath, method, query) {
  const port = process.env.WEBHOOK_PORT || "3199";
  const token = process.env.WEBHOOK_API_TOKEN || "";
  const sep = relPath.includes("?") ? "&" : "?";
  const url = `http://localhost:${port}${relPath}${query ? sep + query : ""}`;
  const res = await fetch(url, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(8000),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) throw new Error(`webhook ${res.status}: ${(data && data.error) || res.statusText}`);
  return data;
}

function summarizeEvent(ev) {
  const d = (ev && ev.data) || {};
  const oe = (d.originalEvent && d.originalEvent.data) || {};
  return {
    id: ev.id,
    seqNo: ev.seqNo,
    source: ev.source,
    type: ev.type,
    ts: ev.queuedAt || ev.ts || null,
    rule: d.rule || null,
    text: d.text ? String(d.text).slice(0, 200) : null,
    card: (oe.card && oe.card.name) || null,
    list: (oe.list && oe.list.name) || null,
    subject: d.subject || null,
  };
}

/**
 * Run a local tool. Throws Error on invalid input; returns
 * { ok: true, tool, result } on success.
 */
export async function runLocalTool(repo, name, args) {
  const a = args || {};
  if (name === "fs_list_dir") {
    const abs = resolveAllowed(repo, a.path);
    if (!fs.statSync(abs).isDirectory()) throw new Error("not a directory");
    const entries = fs.readdirSync(abs).filter((n) => !n.startsWith("."));
    return { ok: true, tool: name, result: { path: a.path, entries } };
  }
  if (name === "fs_read_file") {
    const abs = resolveAllowed(repo, a.path);
    if (!fs.statSync(abs).isFile()) throw new Error("not a file");
    const raw = fs.readFileSync(abs, "utf8");
    const MAX = 6000;
    const truncated = raw.length > MAX;
    return {
      ok: true,
      tool: name,
      result: { path: a.path, length: raw.length, truncated, content: truncated ? raw.slice(0, MAX) + "\n…(truncated)" : raw },
    };
  }
  if (name === "task_read_today") {
    const file = todayFile(repo);
    if (!fs.existsSync(file)) {
      return { ok: true, tool: name, result: { path: path.relative(repo, file), exists: false, message: "No task file for today." } };
    }
    const { items } = readTaskLines(file);
    return { ok: true, tool: name, result: { path: path.relative(repo, file), exists: true, total: items.length, done: items.filter((i) => i.done).length, items } };
  }
  if (name === "task_check_item") {
    const file = todayFile(repo);
    if (!fs.existsSync(file)) throw new Error("No task file for today.");
    const needle = String(a.text || "").trim().toLowerCase();
    if (!needle) throw new Error("task_check_item requires a text match");
    const { lines, items } = readTaskLines(file);
    const target = items.find((i) => !i.done && i.text.toLowerCase().includes(needle));
    if (!target) throw new Error(`No unchecked task matching "${a.text}"`);
    lines[target.line - 1] = lines[target.line - 1].replace("- [ ]", "- [x]");
    fs.writeFileSync(file, lines.join("\n"), "utf8");
    return { ok: true, tool: name, result: { checked: true, line: target.line, text: target.text } };
  }
  if (name === "queue_list_priority" || name === "queue_list_misc") {
    const q = name === "queue_list_priority" ? "priority" : "misc_notifications";
    const data = await webhookRequest("/events", "GET", `queue=${q}&cleared=false`);
    const events = (data && data.events) || [];
    return { ok: true, tool: name, result: { queue: q, count: data.count ?? events.length, items: events.slice(0, 15).map(summarizeEvent) } };
  }
  if (name === "queue_clear_item") {
    const id = String(a.id || "").trim();
    if (!id) throw new Error("queue_clear_item requires an id");
    const q = a.queue === "misc_notifications" ? "misc_notifications" : "priority";
    const data = await webhookRequest(`/events/${encodeURIComponent(id)}`, "PATCH", `queue=${q}`);
    return { ok: true, tool: name, result: data };
  }
  throw new Error(`unknown local tool: ${name}`);
}
