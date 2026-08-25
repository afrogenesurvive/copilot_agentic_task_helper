/**
 * app.js — Frontdesk v2
 *
 * License-key login + end-to-end-encrypted chat with the agent.
 *
 * Primary path (tunnel up):
 *   - POST /api/license/verify (license → session token)
 *   - POST /api/frontdesk/send  (AES-GCM envelope via WebCrypto ECDH)
 *   - GET  /api/frontdesk/poll  (pull encrypted agent replies, decrypt in-browser)
 *
 * Degraded path (tunnel down — Netlify copy stays up):
 *   - /health check fails → messages are posted as `[fd1] …` comments on the
 *     Trello frontdesk_input card (via the Netlify trello-proxy). Trello's
 *     webhook retry delivers them once the tunnel returns.
 *   - If Trello is ALSO unreachable, messages go to a localStorage outbox and
 *     are flushed on reconnect.
 *
 * Config is fetched from /api/config (works on both Netlify and the tunnel).
 */

/* ==================================================================
   CONFIG — filled at runtime from /api/config
   ================================================================== */
const CONFIG = {
  WEBHOOK_BASE_URL: "", // tunnel URL (the backend)
  FRONTDESK_AGENT_PUBKEY: "", // agent X25519 public key (encryption peer)
  LIST_ID_INPUT: "", // frontdesk_input (Trello degraded fallback)
  LIST_ID_OUTPUT: "", // frontdesk_output (Trello degraded fallback)
  SESSION_TTL: 7200, // seconds
  POLL_INTERVAL: 10000,
  HEALTH_TIMEOUT: 4000,
};

const ON_NETLIFY = location.hostname.endsWith(".netlify.app");
const SESSION_DURATION = 2 * 60 * 60 * 1000;

let state = { license: "", token: "", sub: "", sessionExpiresAt: 0 };
let pollTimer = null;
let sessionTimer = null;
let degraded = false;
let lastSince = null;
let pendingOutbox = [];

/* ==================================================================
   Utilities
   ================================================================== */

function apiBase() {
  const cfg = CONFIG.WEBHOOK_BASE_URL || "";
  const myOrigin = location.origin;
  // Served from the API host already (tunnel copy) → same origin.
  try {
    if (myOrigin === new URL(cfg).origin) return myOrigin;
  } catch {
    /* cfg not a URL */
  }
  // Localhost (dev / tunnel-less) → same origin.
  if (/^https?:\/\/localhost(:\d+)?$/.test(myOrigin)) return myOrigin;
  // Netlify (or any other host) → the tunnel backend.
  return (cfg || myOrigin).replace(/\/+$/, "");
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

async function loadConfig() {
  try {
    const r = await fetch("/api/config", { cache: "no-store" });
    const cfg = await r.json();
    CONFIG.WEBHOOK_BASE_URL = cfg.WEBHOOK_BASE_URL || CONFIG.WEBHOOK_BASE_URL;
    CONFIG.FRONTDESK_AGENT_PUBKEY = cfg.FRONTDESK_AGENT_PUBKEY || "";
    CONFIG.LIST_ID_INPUT = cfg.TRELLO_LIST_FRONTEDESK_INPUT || "";
    CONFIG.LIST_ID_OUTPUT = cfg.TRELLO_LIST_FRONTEDESK_OUTPUT || "";
    if (cfg.FRONTDESK_SESSION_TTL) CONFIG.SESSION_TTL = parseInt(cfg.FRONTDESK_SESSION_TTL, 10);
  } catch (e) {
    console.error("Config load failed:", e);
  }
}

/* ==================================================================
   Session persistence (sessionStorage)
   ================================================================== */

function persistSession() {
  sessionStorage.setItem("frontdesk_license", state.license);
  sessionStorage.setItem("frontdesk_token", state.token);
  sessionStorage.setItem("frontdesk_sub", state.sub);
  sessionStorage.setItem("frontdesk_expires", String(state.sessionExpiresAt));
}

function tryRestoreSession() {
  const license = sessionStorage.getItem("frontdesk_license");
  const token = sessionStorage.getItem("frontdesk_token");
  const sub = sessionStorage.getItem("frontdesk_sub");
  const exp = parseInt(sessionStorage.getItem("frontdesk_expires") || "0", 10);
  if (license && token && sub && exp > Date.now()) {
    state = { license, token, sub, sessionExpiresAt: exp };
    enterApp();
    return true;
  }
  return false;
}

function clearSession() {
  sessionStorage.removeItem("frontdesk_license");
  sessionStorage.removeItem("frontdesk_token");
  sessionStorage.removeItem("frontdesk_sub");
  sessionStorage.removeItem("frontdesk_expires");
}

/* ==================================================================
   Login / Logout
   ================================================================== */

document.getElementById("login-btn").addEventListener("click", doLogin);
document.getElementById("license").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    doLogin();
  }
});

async function doLogin() {
  const license = document.getElementById("license").value.trim();
  const errEl = document.getElementById("login-error");
  if (!license) {
    errEl.textContent = "Please paste your license key";
    errEl.classList.remove("hidden");
    return;
  }
  const btn = document.getElementById("login-btn");
  btn.disabled = true;
  btn.textContent = "Verifying…";
  try {
    const r = await fetch(`${apiBase()}/api/license/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ license }),
    });
    const out = await r.json();
    if (!out.ok) {
      errEl.textContent = "Invalid or expired license (" + (out.reason || "unknown") + ")";
      errEl.classList.remove("hidden");
      return;
    }
    state.license = license;
    state.token = out.token;
    state.sub = out.sub;
    state.sessionExpiresAt = Date.parse(out.sessionExpiresAt) || Date.now() + CONFIG.SESSION_TTL * 1000;
    persistSession();
    logSession("login");
    enterApp();
  } catch (e) {
    errEl.textContent = "Cannot reach the server. Connect when the tunnel is back, then retry.";
    errEl.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = "Log In";
  }
}

function enterApp() {
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("app-screen").classList.remove("hidden");
  document.getElementById("acct-sub").textContent = state.sub;
  document.getElementById("acct-expires").textContent = new Date(state.sessionExpiresAt).toLocaleString();
  document.getElementById("google-connect").href = `${apiBase()}/oauth/google/start?token=${encodeURIComponent(state.token)}`;
  startSessionTimer();
  startPolling();
  updateModeBadge();
  void loadAccountStatus();
  void checkHealth().then(updateModeBadge);
}

/** Show which Google/Trello accounts are bound to this seat. */
async function loadAccountStatus() {
  try {
    const r = await fetch(`${apiBase()}/api/frontdesk/account?token=${encodeURIComponent(state.token)}`, { cache: "no-store" });
    const out = await r.json();
    if (out.ok) {
      document.getElementById("google-status").textContent = out.google.connected
        ? `Connected as ${out.google.user || "your account"}`
        : "Not connected yet.";
      document.getElementById("acct-trello").textContent = out.trello.configured
        ? "Custom (seat-specific)"
        : "Default (agent .env)";
    }
  } catch {
    /* offline — leave defaults */
  }
}

function doLogout() {
  logSession("logout");
  clearSession();
  state = { license: "", token: "", sub: "", sessionExpiresAt: 0 };
  lastSince = null;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  if (sessionTimer) clearInterval(sessionTimer);
  sessionTimer = null;
  document.getElementById("app-screen").classList.add("hidden");
  document.getElementById("login-screen").classList.remove("hidden");
  document.getElementById("license").value = "";
  document.getElementById("messages-container").innerHTML = '<div class="empty-state">No messages yet. Start the conversation!</div>';
}

document.getElementById("logout-btn").addEventListener("click", doLogout);

/* ==================================================================
   Session timer
   ================================================================== */

function updateSessionTimer() {
  const el = document.getElementById("session-timer");
  const remaining = state.sessionExpiresAt - Date.now();
  if (remaining <= 0) {
    el.textContent = "Expired";
    el.className = "session-expired";
    return;
  }
  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);
  el.textContent = `${mins}:${secs.toString().padStart(2, "0")}`;
  el.className = mins < 5 ? "session-low" : "session-ok";
}

function startSessionTimer() {
  if (sessionTimer) clearInterval(sessionTimer);
  updateSessionTimer();
  sessionTimer = setInterval(updateSessionTimer, 1000);
}

/* ==================================================================
   Connection mode (direct vs degraded)
   ================================================================== */

async function checkHealth() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), CONFIG.HEALTH_TIMEOUT);
    const r = await fetch(`${apiBase()}/health`, { cache: "no-store", signal: ctl.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

function setDegraded(value) {
  degraded = value;
  updateModeBadge();
  document.getElementById("offline-banner").classList.toggle("hidden", !degraded);
}

function updateModeBadge() {
  const badge = document.getElementById("mode-badge");
  badge.textContent = degraded ? "● offline" : "● online";
  badge.className = degraded ? "mode-offline" : "mode-online";
  document.getElementById("acct-mode").textContent = degraded ? "degraded (Trello fallback)" : "direct (encrypted)";
}

/* ==================================================================
   Tabs
   ================================================================== */

document.getElementById("tab-chat").addEventListener("click", () => {
  document.getElementById("tab-chat").classList.add("active");
  document.getElementById("tab-account").classList.remove("active");
  document.getElementById("chat-view").classList.remove("hidden");
  document.getElementById("account-view").classList.add("hidden");
});
document.getElementById("tab-account").addEventListener("click", () => {
  document.getElementById("tab-account").classList.add("active");
  document.getElementById("tab-chat").classList.remove("active");
  document.getElementById("account-view").classList.remove("hidden");
  document.getElementById("chat-view").classList.add("hidden");
});

/* ==================================================================
   Chat UI
   ================================================================== */

function addBubble(text, sender, iso, pending) {
  const container = document.getElementById("messages-container");
  const empty = container.querySelector(".empty-state");
  if (empty) empty.remove();
  const bubble = document.createElement("div");
  bubble.className = `message ${sender === "You" ? "collaborator" : "agent"}${pending ? " pending" : ""}`;
  bubble.innerHTML = `
    <div class="text">${escapeHtml(text)}</div>
    <div class="meta">${sender} · ${fmtTime(iso)}${pending ? " · sending…" : ""}</div>
  `;
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
  return bubble;
}

document.getElementById("send-btn").addEventListener("click", sendMessage);
document.getElementById("message-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

async function sendMessage() {
  const input = document.getElementById("message-input");
  const text = input.value.trim();
  if (!text || !state.token) return;
  input.value = "";
  const bubble = addBubble(text, "You", new Date().toISOString(), true);
  try {
    await directSend(text);
    markSent(bubble);
  } catch (e) {
    console.warn("Direct send failed, trying degraded:", e.message);
    await degradedSend(text);
    markSent(bubble);
  }
}

function markSent(bubble) {
  if (!bubble) return;
  bubble.classList.remove("pending");
  const meta = bubble.querySelector(".meta");
  if (meta) meta.textContent = meta.textContent.replace(/· sending…$/, "").trim();
}

async function directSend(text) {
  const envelope = await FD.encrypt(state.license, CONFIG.FRONTDESK_AGENT_PUBKEY, { text, ts: new Date().toISOString() });
  const r = await fetch(`${apiBase()}/api/frontdesk/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: state.token, envelope }),
  });
  const out = await r.json();
  if (!out.ok) throw new Error(out.error || "send failed");
}

/* ── Degraded send: `[fd1]` comment on Trello, else localStorage outbox ── */

async function degradedSend(text) {
  setDegraded(true);
  const payload = await FD.degradedEnvelope(state.license, CONFIG.FRONTDESK_AGENT_PUBKEY, { text, ts: new Date().toISOString() });

  if (ON_NETLIFY && CONFIG.LIST_ID_INPUT) {
    try {
      const card = await findOrCreateDailyCard(CONFIG.LIST_ID_INPUT);
      await trelloProxy(`/cards/${card.id}/actions/comments`, "POST", { text: payload });
      return; // queued on Trello — will be delivered when the tunnel returns
    } catch (e) {
      console.error("Trello fallback failed:", e);
    }
  }
  // Belt-and-suspenders: stash locally, flush on reconnect.
  pendingOutbox.push({ text, ts: new Date().toISOString() });
  saveOutbox();
  addBubble("📡 Offline — queued locally, will send when connected.", "System", new Date().toISOString());
}

function loadOutbox() {
  try {
    pendingOutbox = JSON.parse(localStorage.getItem("frontdesk_outbox") || "[]");
  } catch {
    pendingOutbox = [];
  }
}
function saveOutbox() {
  localStorage.setItem("frontdesk_outbox", JSON.stringify(pendingOutbox));
}

async function flushOutbox() {
  if (!pendingOutbox.length) return;
  const remaining = [];
  for (const m of pendingOutbox) {
    try {
      await directSend(m.text);
    } catch {
      remaining.push(m);
    }
  }
  pendingOutbox = remaining;
  saveOutbox();
  if (remaining.length === 0) addBubble("📡 Back online — queued messages sent.", "System", new Date().toISOString());
}

/* ── Trello proxy (Netlify function — degraded mode only) ── */

async function trelloProxy(tpath, method, body) {
  const payload = { path: tpath, method: method || "GET", params: {} };
  if (body && method !== "GET") {
    payload.body = body;
    payload.params = { ...body };
  }
  const r = await fetch("/.netlify/functions/trello-proxy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Trello ${r.status}: ${data.error || ""}`);
  return data;
}

async function findOrCreateDailyCard(listId) {
  const today = new Date().toISOString().slice(0, 10);
  const cards = await trelloProxy(`/lists/${listId}/cards`, "GET");
  const existing = cards.find((c) => c.name === today);
  if (existing) return existing;
  return trelloProxy(`/lists/${listId}/cards`, "POST", { name: today, desc: `Messages for ${today}` });
}

/* ==================================================================
   Polling — health check + direct poll (+ outbox flush)
   ================================================================== */

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  loadOutbox();
  poll();
  pollTimer = setInterval(poll, CONFIG.POLL_INTERVAL);
}

async function poll() {
  const online = await checkHealth();
  setDegraded(!online);
  if (online) {
    await flushOutbox();
    await pollDirect();
  }
}

async function pollDirect() {
  try {
    const url = `${apiBase()}/api/frontdesk/poll?token=${encodeURIComponent(state.token)}${
      lastSince ? `&since=${encodeURIComponent(lastSince)}` : ""
    }`;
    const r = await fetch(url, { cache: "no-store" });
    const out = await r.json();
    if (!out.ok) return;
    lastSince = out.serverNow;
    for (const reply of out.replies || []) {
      try {
        const plain = await FD.decrypt(state.license, CONFIG.FRONTDESK_AGENT_PUBKEY, reply.envelope);
        let text = plain;
        try {
          const obj = JSON.parse(plain);
          if (obj && typeof obj.text === "string") text = obj.text;
        } catch {
          /* plain string */
        }
        addBubble(text, "Agent", reply.ts);
      } catch (e) {
        console.error("Reply decrypt failed:", e);
      }
    }
  } catch (e) {
    /* offline — keep lastSince, retry next tick */
  }
}

/* ==================================================================
   Session logging (best-effort)
   ================================================================== */

async function logSession(action) {
  try {
    await fetch(`${apiBase()}/api/session-log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: state.token,
        user: state.sub,
        action,
        userAgent: navigator.userAgent,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        language: navigator.language,
      }),
    });
  } catch {
    /* fire-and-forget */
  }
}

/* ==================================================================
   Init
   ================================================================== */

(async function init() {
  await loadConfig();
  if (!tryRestoreSession()) {
    // Fresh visit — show login.
    document.getElementById("login-screen").classList.remove("hidden");
  }
})();
