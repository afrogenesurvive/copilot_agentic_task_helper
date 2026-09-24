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

let state = { license: "", token: "", sub: "", sessionExpiresAt: 0 };
let pollTimer = null;
let sessionTimer = null;
let degraded = false;

/**
 * Last connection probe — whether the backend (tunnel + webhook server) answered,
 * which base URL we asked, and what it reported. Rendered by renderConnStatus() in
 * both the login card and the logged-in views.
 */
let conn = { checkedAt: 0, ok: null, backend: "", error: null, sanitizer: null, configured: true };
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

/** Thrown when the backend rejects our session token (as opposed to being offline). */
class SessionExpiredError extends Error {
  constructor(message) {
    super(message || "invalid_session");
    this.name = "SessionExpiredError";
  }
}

/**
 * The backend rejected our session token. Sessions are held in memory on the
 * webhook server with no refresh path, so a backend restart (or the TTL
 * elapsing) invalidates them — send the user back to the login screen. Without
 * this the app kept reporting "online" and quietly diverted every message into
 * the offline outbox, where it could never be delivered.
 */
function forceRelogin(reason) {
  if (!state.token) return; // already logged out — don't stack messages
  const sub = state.sub;
  doLogout();
  const errEl = document.getElementById("login-error");
  errEl.textContent =
    `Session ended${sub ? ` for ${sub}` : ""} — ${reason || "the backend restarted"}. ` +
    "Paste your license key to log in again.";
  errEl.classList.remove("hidden");
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
    // Re-probe so the status line reflects reality, then explain the failure
    // precisely: an unconfigured host is a deployment problem, not an outage.
    const probeOk = await checkHealth();
    errEl.textContent = !backendIsConfigured(probeOk)
      ? "This deployment has no backend configured — WEBHOOK_BASE_URL is empty on this host."
      : "Cannot reach the server. Connect when the tunnel is back, then retry.";
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
  void checkHealth(); // show the live tunnel status again on the login card
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
  const res = await probeBackend();
  conn = { ...res, checkedAt: Date.now(), configured: backendIsConfigured(res.ok) };
  renderConnStatus();
  return res.ok;
}

/**
 * Ask the backend for /health — the single probe behind both the badge and the
 * status line. Success means the TUNNEL and the webhook server are both reachable
 * from this browser, not merely that the page loaded.
 */
async function probeBackend() {
  const backend = apiBase();
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), CONFIG.HEALTH_TIMEOUT);
    const r = await fetch(`${backend}/health`, { cache: "no-store", signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return { ok: false, backend, error: `HTTP ${r.status}`, sanitizer: null };
    let body = null;
    try {
      body = await r.json();
    } catch {
      /* older server: no JSON body */
    }
    return { ok: true, backend, error: null, sanitizer: (body && body.sanitizer) || null };
  } catch (e) {
    return { ok: false, backend, error: e && e.name === "AbortError" ? "timed out" : "unreachable", sanitizer: null };
  }
}

/**
 * Is a backend actually configured for THIS host?
 *
 * The Netlify copy does not run the backend, so the browser must be told where the
 * tunnel is via WEBHOOK_BASE_URL. If that is empty the app falls back to same-origin
 * and every API call 404s — which used to appear only as a generic "Cannot reach the
 * server". No URL is fine when this host IS the backend (local dev, or the webapp
 * served straight from the tunnel), and the probe is what tells those two apart.
 */
function backendIsConfigured(probeOk) {
  try {
    const cfg = new URL(CONFIG.WEBHOOK_BASE_URL);
    if (cfg.protocol === "http:" || cfg.protocol === "https:") return true;
  } catch {
    /* empty or unparseable — fall through to the same-origin check */
  }
  return probeOk === true;
}

/** Render the connection/tunnel status for the login card and the logged-in views. */
function renderConnStatus() {
  let host = conn.backend || "?";
  try {
    host = new URL(conn.backend).host;
  } catch {
    /* keep the raw value */
  }

  const box = document.getElementById("conn-status");
  const text = document.getElementById("conn-text");
  const detail = document.getElementById("conn-detail");
  const acctBackend = document.getElementById("acct-backend");
  const badge = document.getElementById("mode-badge");

  let cls = "conn-status";
  let msg;
  if (!conn.checkedAt) {
    cls += " checking";
    msg = "Checking connection…";
  } else if (!conn.configured) {
    cls += " bad";
    msg = `No backend configured for ${location.host} — WEBHOOK_BASE_URL is empty, so requests go to this host and fail.`;
  } else if (!conn.ok) {
    cls += " bad";
    msg = `Backend unreachable (${conn.error}) — the tunnel or the webhook server is down.`;
  } else {
    cls += " ok";
    msg = `Connected — backend ${host} is up.`;
    if (conn.sanitizer && conn.sanitizer.active === false) msg += " ⚠️ Injection sanitizer is OFF.";
  }

  if (box) box.className = cls;
  if (text) text.textContent = msg;
  if (detail) {
    detail.textContent = conn.checkedAt ? `${host} · checked ${fmtTime(new Date(conn.checkedAt).toISOString())}` : "";
  }
  if (badge) badge.title = conn.checkedAt ? `${msg} (${host})` : "";
  if (acctBackend) {
    acctBackend.textContent = conn.checkedAt ? `${host} · ${conn.ok ? "reachable" : `unreachable (${conn.error})`}` : "—";
  }
}

/** While the login card is showing, keep the status line live. */
let loginProbeTimer = null;
function startLoginProbe() {
  if (loginProbeTimer) clearInterval(loginProbeTimer);
  void checkHealth();
  loginProbeTimer = setInterval(() => {
    if (!state.token) void checkHealth();
  }, CONFIG.POLL_INTERVAL);
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

// One entry per tab — a new tab only needs a row here (plus its markup).
const TABS = [
  { tab: "tab-chat", view: "chat-view" },
  { tab: "tab-account", view: "account-view" },
  { tab: "tab-help", view: "help-view" },
];
for (const entry of TABS) {
  document.getElementById(entry.tab).addEventListener("click", () => {
    for (const t of TABS) {
      document.getElementById(t.tab).classList.toggle("active", t.tab === entry.tab);
      document.getElementById(t.view).classList.toggle("hidden", t.view !== entry.view);
    }
  });
}

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
    // A rejected session is not an outage — re-login instead of queueing.
    if (e instanceof SessionExpiredError) {
      bubble.remove();
      forceRelogin("the backend rejected this session");
      return;
    }
    console.warn("Direct send failed, falling back:", e.message);
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
  let r;
  try {
    r = await fetch(`${apiBase()}/api/frontdesk/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: state.token, envelope }),
    });
  } catch (e) {
    throw new Error(`network: ${e.message}`);
  }
  // 401 = our token is gone (backend restart / TTL). Distinct from "offline".
  if (r.status === 401) throw new SessionExpiredError("invalid_session");
  const out = await r.json();
  if (!out.ok) throw new Error(out.error || "send failed");
}

/* ── Fallback send: `[fd1]` comment on Trello, else localStorage outbox ── */

async function degradedSend(text) {
  // Only claim "degraded" when the backend is genuinely unreachable — a rejected
  // request must not masquerade as a network outage.
  const online = await checkHealth();
  setDegraded(!online);
  const payload = await FD.degradedEnvelope(state.license, CONFIG.FRONTDESK_AGENT_PUBKEY, { text, ts: new Date().toISOString() });

  // The Trello relay is a Netlify-only path (the proxy function lives there).
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
  addBubble(
    online
      ? "⚠️ Couldn't send — queued locally and will retry automatically."
      : "📡 Offline — queued locally, will send when connected.",
    "System",
    new Date().toISOString(),
  );
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
    } catch (e) {
      // A dead session would otherwise keep every message in the outbox forever.
      if (e instanceof SessionExpiredError) {
        forceRelogin("the backend rejected this session while flushing queued messages");
        return;
      }
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
    // 401 = the session is gone; tell the user rather than polling silently.
    if (r.status === 401) {
      forceRelogin("the backend rejected this session while polling for replies");
      return;
    }
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
    // Fresh visit — show login, with a live backend/tunnel status line.
    document.getElementById("login-screen").classList.remove("hidden");
    startLoginProbe();
  }
})();
