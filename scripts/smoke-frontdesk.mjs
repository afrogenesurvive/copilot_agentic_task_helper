#!/usr/bin/env node
/**
 * Frontdesk v2 smoke test — exercises the full encrypted round-trip against a
 * running webhook server:
 *
 *   1. License login            → POST /api/license/verify      → session token
 *   2. Client encrypt + send    → POST /api/frontdesk/send      → priority queue
 *   3. Agent reply (internal)   → POST /api/frontdesk/reply     → encrypted store
 *   4. Poll + client decrypt    → GET  /api/frontdesk/poll      → envelope → plaintext
 *   5. Config + session-log     → GET  /api/config, POST /api/session-log
 *
 * Uses the SAME code paths the webapp and agent runner use (deriveAesKeyClient /
 * deriveAesKeyServer / encryptAes / decryptAes) so a green run means the real
 * flow works.
 *
 * Usage:
 *   node scripts/smoke-frontdesk.mjs [seatSub]
 *   # seatSub defaults to "test@example.com" (dev seat).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { deriveAesKeyClient, encryptAes, decryptAes } from "./frontdesk-license.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BASE = process.env.WEBHOOK_SMOKE_URL || "http://localhost:3199";
const SUB = process.argv[2] || "test@example.com";

// Read the license key + API token from disk/env (same as production).
function readSeatKey(sub) {
  const issued = path.join(ROOT, "safe", "frontdesk-keys", "mk-2026-08", "issued", `${sub}.key`);
  if (fs.existsSync(issued)) return fs.readFileSync(issued, "utf8").trim();
  // Fall back to a revoked/expired dir (still valid to attempt verify).
  for (const dirName of ["revoked", "expired"]) {
    const p = path.join(ROOT, "safe", "frontdesk-keys", "mk-2026-08", dirName, `${sub}.key`);
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
  }
  return null;
}

function readEnv(key) {
  try {
    const env = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
    const m = env.match(new RegExp(`^${key}=(.+)$`, "m"));
    return m ? m[1].trim() : "";
  } catch {
    return "";
  }
}

async function api(method, url, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

function check(label, cond, detail) {
  if (cond) {
    results.passed++;
    console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    results.failed++;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
  return cond;
}

const agentPub = readEnv("FRONTDESK_AGENT_PUBKEY") || process.env.FRONTDESK_AGENT_PUBKEY;
const apiToken = readEnv("WEBHOOK_API_TOKEN");

const results = { passed: 0, failed: 0 };

async function main() {
  console.log(`Frontdesk v2 smoke test → ${BASE} (seat: ${SUB})\n`);

  // 0. Preconditions
  const license = readSeatKey(SUB);
  check("seat license key found", !!license);
  check("agent pubkey configured", !!agentPub, agentPub);
  check("webhook api token configured", !!apiToken);
  if (!license || !agentPub) {
    console.log("\nAborting: missing license/agent key. Run keymanage create-agent-key + issue first.");
    process.exit(1);
  }

  // 1. Login
  const login = await api("POST", "/api/license/verify", { license });
  const token = login.json?.ok ? login.json.token : null;
  check("login returns session token", !!token, login.json?.reason || login.json?.sub);
  if (!token) {
    console.log(`\nLogin failed: ${JSON.stringify(login.json)}`);
    process.exit(1);
  }

  // 2. Client encrypt + send
  const clientKey = deriveAesKeyClient(license, agentPub);
  const msg = `smoke test message ${new Date().toISOString()}`;
  const envelope = encryptAes(JSON.stringify({ text: msg, ts: new Date().toISOString() }), clientKey);
  const sent = await api("POST", "/api/frontdesk/send", { token, envelope });
  check("send accepted", sent.json?.ok === true, sent.json?.id);

  // 3. Agent reply (internal endpoint, static token)
  const replyText = `auto-reply from smoke test ${new Date().toISOString()}`;
  const replied = await api("POST", "/api/frontdesk/reply", { sub: SUB, text: replyText }, apiToken);
  check("reply posted (internal)", replied.json?.ok === true, replied.json?.id);

  // 4. Poll + decrypt
  const polled = await api("GET", `/api/frontdesk/poll?token=${token}&since=${new Date(Date.now() - 60000).toISOString()}`);
  const got = (polled.json?.replies || []).some((r) => {
    try {
      return decryptAes(r.envelope, clientKey) === replyText;
    } catch {
      return false;
    }
  });
  check("poll returns decryptable reply", got === true, `${(polled.json?.replies || []).length} reply(ies)`);

  // 5. Config + session-log
  const cfg = await api("GET", "/api/config");
  check("config served", cfg.json?.FRONTDESK_AGENT_PUBKEY === agentPub, "agent pubkey matches");
  const slog = await api("POST", "/api/session-log", { token, user: SUB, action: "login", userAgent: "smoke-test" });
  check("session-log accepted", slog.json?.ok === true);

  // 6. Health
  const health = await api("GET", "/health");
  check("health ok", health.json?.status === "ok");

  console.log(`\n${results.passed} passed, ${results.failed} failed`);
  process.exit(results.failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`Smoke test crashed: ${err.message}`);
  process.exit(1);
});
