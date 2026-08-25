/**
 * Electron main-process logger — ring buffer + subscriber + per-source tagging.
 *
 * Mirrors the approach in ai_transcription_agent/electron/src/main/logger.ts:
 *  - in-memory ring buffer for the live log view
 *  - subscriber pattern to push new entries to the renderer in real time
 *  - captures child process output, tagged by service source/subSource
 *  - tails the unified structured stream (logs/live/*.jsonl) written by
 *    shared/logger.mjs so the live view reflects every component's logs
 *
 * Sources: webhook | runner | mcp | tunnel | frontdesk | notifications | electron
 * The live buffer is fed by:
 *   (a) the unified logs/live stream (all structured entries from every component)
 *   (b) raw child output for services that don't emit structured logs (tunnel,
 *       plus runner's human-readable console so "agent logs" are visible)
 *   (c) electron-main lifecycle events (service start/stop/exit)
 * Webhook/MCP raw console is intentionally NOT mirrored here — it is already
 * captured per-service on the Dashboard, and the Log Files view lists those files.
 */
"use strict";
const path = require("path");
const fs = require("fs");

const MAX_ENTRIES = 20000;
const buffer = [];
let subscribers = [];

function makeEntry({ source, subSource, level = "info", message = "", data }) {
  const e = { ts: new Date().toISOString(), source, subSource, level, message };
  if (data !== undefined) e.data = data;
  return e;
}

function addLog(entry) {
  const e = typeof entry.ts === "string" ? entry : makeEntry(entry);
  buffer.push(e);
  if (buffer.length > MAX_ENTRIES) buffer.shift();
  for (const cb of subscribers) {
    try {
      cb(e);
    } catch {
      /* subscriber errors are non-fatal */
    }
  }
  return e;
}

function subscribe(cb) {
  subscribers.push(cb);
  return () => {
    subscribers = subscribers.filter((s) => s !== cb);
  };
}

function clear() {
  buffer.length = 0;
}

/** Query the ring buffer with filters. */
function query({ source, subSource, level, search, limit = 200, sinceTs } = {}) {
  let items = buffer;
  if (source) items = items.filter((e) => e.source === source);
  if (subSource) items = items.filter((e) => e.subSource === subSource);
  if (level) items = items.filter((e) => e.level === level);
  if (sinceTs) items = items.filter((e) => new Date(e.ts).getTime() > sinceTs);
  if (search) {
    const q = String(search).toLowerCase();
    items = items.filter((e) => {
      try {
        return String(e.message || "").toLowerCase().includes(q) || JSON.stringify(e.data || "").toLowerCase().includes(q);
      } catch {
        return false;
      }
    });
  }
  return items.slice(-limit);
}

/** Map a service name to {source, subSource}. */
function sourceForService(name) {
  if (name === "webhook") return { source: "webhook", subSource: undefined };
  if (name === "runner") return { source: "runner", subSource: undefined };
  if (name === "tunnel") return { source: "tunnel", subSource: "cloudflared" };
  const mcp = /^mcp:(.+)$/.exec(name);
  if (mcp) return { source: "mcp", subSource: mcp[1] };
  return { source: "electron", subSource: name };
}

/** Services whose raw child output should also land in the live buffer. */
const RAW_CAPTURE_SOURCES = new Set(["tunnel", "runner"]);

function inferLevel(line) {
  const l = line.toLowerCase();
  if (/\b(error|fatal|exception|traceback)\b/.test(l) || l.includes("❌")) return "error";
  if (/\b(warn|warning)\b/.test(l) || l.includes("⚠️")) return "warn";
  return "info";
}

/** Capture a child process's stdout/stderr into the live buffer, tagged by service. */
function captureService(name, child) {
  const { source, subSource } = sourceForService(name);
  const push = (chunk) => {
    const lines = chunk.toString().split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines) {
      const trimmed = line.trim();
      let entry = null;
      if (trimmed.startsWith("{")) {
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === "object" && (parsed.ts || parsed.source)) {
            entry = {
              ts: parsed.ts || new Date().toISOString(),
              source: parsed.source || source,
              subSource: parsed.subSource || subSource,
              level: parsed.level || "info",
              message: parsed.message || trimmed,
              ...(parsed.data !== undefined ? { data: parsed.data } : {}),
            };
          }
        } catch {
          /* not JSON */
        }
      }
      addLog(entry || makeEntry({ source, subSource, level: inferLevel(line), message: line }));
    }
  };
  if (child && child.stdout) child.stdout.on("data", push);
  if (child && child.stderr) child.stderr.on("data", push);
}

/** List log files under a base dir (for the Log Files view). */
function listLogFiles(baseDir) {
  const out = [];
  const EXCLUDE = new Set([".DS_Store"]);
  const walk = (dir, rel) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (EXCLUDE.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full, rel ? `${rel}/${ent.name}` : ent.name);
      else if (/\.(log|jsonl)$/.test(ent.name)) {
        try {
          const stat = fs.statSync(full);
          out.push({
            path: full,
            name: rel ? `${rel}/${ent.name}` : ent.name,
            size: stat.size,
            mtime: stat.mtime.toISOString(),
            source: (rel || "").split("/")[0] || "root",
          });
        } catch {
          /* skip unreadable */
        }
      }
    }
  };
  walk(baseDir, "");
  out.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return out;
}

/** Read the last N lines of a log file (0 = all). */
function readLogFile(filePath, maxLines = 0) {
  try {
    const lines = fs.readFileSync(filePath, "utf8").split("\n").filter((l) => l.length > 0);
    return maxLines > 0 ? lines.slice(-maxLines) : lines;
  } catch {
    return [];
  }
}

// ── Unified live stream tail (logs/live/*.jsonl) ──
let lastOffsets = {}; // filePath -> byte offset already read

function tailLive(logsDir) {
  const fsNow = fs;
  const days = [new Date().toISOString().slice(0, 10)];
  if (days[0] !== new Date(Date.now() - 86400000).toISOString().slice(0, 10)) {
    days.unshift(new Date(Date.now() - 86400000).toISOString().slice(0, 10));
  }
  for (const d of days) {
    const p = path.join(logsDir, "live", `${d}.jsonl`);
    let fh = null;
    try {
      fh = fsNow.openSync(p, "r");
    } catch {
      continue; // file not created yet
    }
    try {
      const stat = fsNow.fstatSync(fh);
      const offset = lastOffsets[p] || 0;
      if (stat.size < offset) {
        lastOffsets[p] = 0; // file rotated/truncated
      }
      const from = lastOffsets[p] || 0; // safe start offset (never undefined/NaN)
      if (stat.size > from) {
        const buf = Buffer.alloc(stat.size - from);
        fsNow.readSync(fh, buf, 0, buf.length, from);
        lastOffsets[p] = stat.size;
        const lines = buf.toString("utf8").split("\n").filter((l) => l.trim().length > 0);
        for (const line of lines) {
          try {
            const e = JSON.parse(line);
            addLog({
              ts: e.ts,
              source: e.source || "app",
              subSource: e.subSource,
              level: e.level || "info",
              message: e.message || "",
              ...(e.data !== undefined ? { data: e.data } : {}),
            });
          } catch {
            /* skip malformed */
          }
        }
      }
    } finally {
      fsNow.closeSync(fh);
    }
  }
}

/** Seed the ring buffer from the tail of recent unified live files (history). */
function seedFromLive(logsDir, perFile = 2000) {
  const days = [];
  for (let i = 0; i < 3; i++) days.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
  for (const d of days) {
    const p = path.join(logsDir, "live", `${d}.jsonl`);
    if (!fs.existsSync(p)) continue;
    const lines = readLogFile(p, perFile);
    // Record end-of-file offset so tailLive won't re-read the seeded portion.
    lastOffsets[p] = fs.statSync(p).size;
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        addLog({
          ts: e.ts,
          source: e.source || "app",
          subSource: e.subSource,
          level: e.level || "info",
          message: e.message || "",
          ...(e.data !== undefined ? { data: e.data } : {}),
        });
      } catch {
        /* skip malformed */
      }
    }
  }
}

module.exports = {
  makeEntry,
  addLog,
  subscribe,
  clear,
  query,
  sourceForService,
  captureService,
  listLogFiles,
  readLogFile,
  tailLive,
  seedFromLive,
  RAW_CAPTURE_SOURCES,
};
