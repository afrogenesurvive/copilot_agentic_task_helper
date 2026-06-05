/**
 * app.js — Remote Collaborator Chat
 *
 * Two-list Trello backend:
 *   frontdesk_input  — new messages from the webapp go here as cards
 *   frontdesk_output — agent replies land here; these cards are shown
 *                      as "agent" messages in the chat window
 *
 * Login credentials are SHA-256 hashed. Trello API calls go through a
 * Netlify function proxy — the API key never reaches the browser.
 *
 * ── Setup ──
 * 1. Get your Trello API key: https://trello.com/app-key
 * 2. Generate a token: https://trello.com/1/authorize?expiration=never&scope=read,write&name=CollaboratorChat&key=YOUR_KEY
 * 3. Create a board with two lists: "frontdesk_input" and "frontdesk_output"
 * 4. Find list IDs (append ".json" to board URL, or use the API)
 * 5. Set env vars on Netlify (see README)
 */

/* ==================================================================
   CONFIGURATION — Fill in your Trello list & board IDs
   ================================================================== */

const CONFIG = {
  // Trello list where new collaborator messages go as cards
  LIST_ID_INPUT: "__LIST_ID_INPUT__", // frontdesk_input list ID

  // Trello list where agent replies appear (shown in chat window)
  LIST_ID_OUTPUT: "__LIST_ID_OUTPUT__", // frontdesk_output list ID

  // Board ID for fetching report data
  BOARD_ID: "__BOARD_ID__",

  // How often to poll for new messages (milliseconds)
  POLL_INTERVAL: 15000, // 15 seconds

  // Max messages in the chat window (last N inputs + outputs combined)
  MAX_CHAT_MESSAGES: 15,
};

/* ==================================================================
   Users — SHA-256 hashes of "<username>:<password>"

   Generate a hash from your browser console:
     crypto.subtle.digest("SHA-256", new TextEncoder().encode("collaborator:mypass"))
       .then(b => Array.from(new Uint8Array(b)).map(v => v.toString(16).padStart(2,"0")).join(""))
       .then(console.log)

   Then paste the hex string below for the corresponding username key.
   ================================================================== */

const USERS = {
  admin: "__ADMIN_HASH__",
  collaborator: "__COLLABORATOR_HASH__",
};

/* ==================================================================
   Utilities
   ================================================================== */

/** Simple SHA-256 hash (Web Crypto API) */
async function sha256(str) {
  const enc = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Call Trello API through the Netlify proxy (keeps credentials server-side) */
async function apiTrello(path, method = "GET", bodyParams, urlParams = {}) {
  // For POST/PUT, data goes as URL params (Trello API style). For comment
  // actions, also include text body so the proxy can sign it with HMAC.
  const payload = { path, method, params: urlParams };
  if (bodyParams && method !== "GET") {
    // Include the text body for HMAC signing on comment actions
    if (path.includes("/actions/comments")) {
      payload.body = bodyParams;
    }
    // Merge body params into URL params for Trello's API
    payload.params = { ...urlParams, ...bodyParams };
  }
  const resp = await fetch("/.netlify/functions/trello-proxy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`API error ${resp.status}: ${data.error || JSON.stringify(data)}`);
  return data;
}

/** Log session event (login/logout) to the server */
async function logSession(user, action) {
  try {
    await fetch("/.netlify/functions/log-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user,
        action,
        userAgent: navigator.userAgent,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        language: navigator.language,
      }),
    });
  } catch {
    // Fire-and-forget — don't block login/logout on logging
  }
}

/** Format a timestamp for display */
function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Format date for section headers */
function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

/* ==================================================================
   Session — 2 hour auto-logout
   ================================================================== */

const SESSION_DURATION = 2 * 60 * 60 * 1000; // 2 hours in ms
let currentUser = null;
let sessionTimer = null;

/** Check if the current session has expired and auto-logout if so */
function checkSession() {
  const loginTime = sessionStorage.getItem("frontdesk_login_time");
  const user = sessionStorage.getItem("frontdesk_user");
  if (!loginTime || !user) {
    if (currentUser) doLogout();
    return false;
  }
  const elapsed = Date.now() - parseInt(loginTime, 10);
  if (elapsed >= SESSION_DURATION) {
    doLogout();
    alert("Your session has expired. Please log in again.");
    return false;
  }
  return true;
}

/** Update the session timer display in the header */
function updateSessionTimer() {
  const el = document.getElementById("session-timer");
  if (!el) return;
  const loginTime = sessionStorage.getItem("frontdesk_login_time");
  if (!loginTime) {
    el.textContent = "";
    return;
  }
  const remaining = SESSION_DURATION - (Date.now() - parseInt(loginTime, 10));
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

/** Start the session timer countdown (updates every second) */
function startSessionTimer() {
  if (sessionTimer) clearInterval(sessionTimer);
  updateSessionTimer();
  sessionTimer = setInterval(updateSessionTimer, 1000);
}

/** Try to restore a valid session on page load */
function tryRestoreSession() {
  const user = sessionStorage.getItem("frontdesk_user");
  const loginTime = sessionStorage.getItem("frontdesk_login_time");
  if (user && loginTime) {
    const elapsed = Date.now() - parseInt(loginTime, 10);
    if (elapsed < SESSION_DURATION) {
      currentUser = user;
      document.getElementById("login-screen").classList.add("hidden");
      document.getElementById("app-screen").classList.remove("hidden");
      startSessionTimer();
      initApp();
      return true;
    } else {
      // Expired — clear it
      sessionStorage.removeItem("frontdesk_user");
      sessionStorage.removeItem("frontdesk_login_time");
    }
  }
  return false;
}

/* ==================================================================
   Login
   ================================================================== */

document.getElementById("login-btn").addEventListener("click", async () => {
  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value;
  const errEl = document.getElementById("login-error");

  if (!username || !password) {
    errEl.textContent = "Please enter username and password";
    errEl.classList.remove("hidden");
    return;
  }

  const hash = await sha256(`${username}:${password}`);
  const storedHash = USERS[username];

  // Debug logging — check browser console
  console.log("🔍 [login] USERS (known accounts):", USERS);
  console.log("🔍 [login] Attempting user:", username);
  console.log("🔍 [login] Computed SHA-256:", hash);
  console.log("🔍 [login] Stored hash for '" + username + "':", storedHash || "(not found)");
  console.log("🔍 [login] Match:", storedHash === hash);

  if (storedHash && storedHash === hash) {
    currentUser = username;
    sessionStorage.setItem("frontdesk_user", username);
    sessionStorage.setItem("frontdesk_login_time", String(Date.now()));
    errEl.classList.add("hidden");
    document.getElementById("login-screen").classList.add("hidden");
    document.getElementById("app-screen").classList.remove("hidden");
    startSessionTimer();
    logSession(username, "login");
    initApp();
  } else {
    errEl.textContent = "Invalid credentials";
    errEl.classList.remove("hidden");
  }
});

// Allow Enter to submit login
document.getElementById("password").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("login-btn").click();
});

/* ==================================================================
   Logout
   ================================================================== */

function doLogout() {
  const user = currentUser;
  currentUser = null;
  if (user) logSession(user, "logout");
  if (sessionTimer) clearInterval(sessionTimer);
  sessionTimer = null;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  sessionStorage.removeItem("frontdesk_user");
  sessionStorage.removeItem("frontdesk_login_time");
  document.getElementById("app-screen").classList.add("hidden");
  document.getElementById("login-screen").classList.remove("hidden");
  document.getElementById("username").value = "";
  document.getElementById("password").value = "";
  document.getElementById("messages-container").innerHTML = '<div class="empty-state">No messages yet. Start the conversation!</div>';
}

document.getElementById("logout-btn").addEventListener("click", doLogout);

/* ==================================================================
   Tab Switching
   ================================================================== */

document.getElementById("tab-chat").addEventListener("click", () => {
  document.getElementById("tab-chat").classList.add("active");
  document.getElementById("tab-reports").classList.remove("active");
  document.getElementById("chat-view").classList.remove("hidden");
  document.getElementById("reports-view").classList.add("hidden");
});

document.getElementById("tab-reports").addEventListener("click", () => {
  document.getElementById("tab-reports").classList.add("active");
  document.getElementById("tab-chat").classList.remove("active");
  document.getElementById("reports-view").classList.remove("hidden");
  document.getElementById("chat-view").classList.add("hidden");
  loadReports();
});

/* ==================================================================
   Chat — Send Message
   ================================================================== */

document.getElementById("send-btn").addEventListener("click", sendMessage);
document.getElementById("message-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

/**
 * Find or create the daily card on a given list.
 * Cards are named by date (YYYY-MM-DD) — one card per day.
 */
async function findOrCreateDailyCard(listId) {
  const today = new Date().toISOString().slice(0, 10);
  const cards = await apiTrello(`/lists/${listId}/cards`, "GET", null, { fields: "name,id" });
  const existing = cards.find((c) => c.name === today);
  if (existing) return existing;

  // Create new daily card
  const newCard = await apiTrello(`/lists/${listId}/cards`, "POST", null, {
    name: today,
    desc: `Messages for ${today}`,
  });
  console.log(`📅 Created daily card "${today}" on list ${listId}`);
  return newCard;
}

async function sendMessage() {
  if (!checkSession()) return;

  const input = document.getElementById("message-input");
  const text = input.value.trim();
  if (!text) return;

  const btn = document.getElementById("send-btn");
  btn.disabled = true;

  try {
    // Find or create today's card on frontdesk_input
    const todayCard = await findOrCreateDailyCard(CONFIG.LIST_ID_INPUT);

    // Add the message as a comment with username prefix
    const commentText = `[${currentUser}] ${text}`;
    await apiTrello(`/cards/${todayCard.id}/actions/comments`, "POST", { text: commentText });

    input.value = "";
    await loadMessages(); // Refresh
  } catch (err) {
    console.error("Send error:", err);
    alert("Failed to send message. Check Trello API credentials.");
  } finally {
    btn.disabled = false;
    input.focus();
  }
}

/* ==================================================================
   Chat — Load Messages (last N from both lists)
   ================================================================== */

/**
 * Fetch today's comments from a Trello list's daily card.
 * Each day has one card named by date; comments on that card are the messages.
 */
async function fetchListMessages(listId, sender) {
  const today = new Date().toISOString().slice(0, 10);

  // Find today's card on the list
  const cards = await apiTrello(`/lists/${listId}/cards`, "GET", null, { fields: "name,id" });
  const todayCard = cards.find((c) => c.name === today);

  if (!todayCard) return [];

  // Get comments from today's card
  let actions;
  try {
    actions = await apiTrello(`/cards/${todayCard.id}/actions`, "GET", null, {
      filter: "commentCard",
      fields: "data,date",
    });
  } catch {
    return [];
  }

  return actions.map((action) => ({
    cardId: todayCard.id,
    text: action.data?.text || "",
    date: action.date,
    member: sender,
    sender: sender,
  }));
}

async function loadMessages() {
  if (!checkSession()) return;

  const container = document.getElementById("messages-container");

  try {
    // 1. Fetch cards from both lists in parallel
    const [inputCards, outputCards] = await Promise.all([
      fetchListMessages(CONFIG.LIST_ID_INPUT, "You"),
      fetchListMessages(CONFIG.LIST_ID_OUTPUT, "Agent"),
    ]);

    // 2. Combine, sort descending (newest first), take last N
    const all = [...inputCards, ...outputCards];
    all.sort((a, b) => new Date(b.date) - new Date(a.date));

    const recent = all.slice(0, CONFIG.MAX_CHAT_MESSAGES).reverse(); // ascending for display

    if (recent.length === 0) {
      container.innerHTML = '<div class="empty-state">No messages yet. Start the conversation!</div>';
      return;
    }

    // 3. Render as chat bubbles (strip passphrase blocks from display)
    container.innerHTML = "";
    recent.forEach((msg) => {
      const isCollaborator = msg.sender === "You";
      // Strip ---passphrase--- and [sig:...] from displayed text
      const displayText = msg.text.replace(/^---.+?---\s*/, "").replace(/\s*\[sig:[a-f0-9]{16}\]$/, "");
      const bubble = document.createElement("div");
      bubble.className = `message ${isCollaborator ? "collaborator" : "agent"}`;
      bubble.innerHTML = `
        <div class="text">${escapeHtml(displayText)}</div>
        <div class="meta">${msg.sender} · ${fmtTime(msg.date)}</div>
      `;
      container.appendChild(bubble);
    });

    // Scroll to bottom
    container.scrollTop = container.scrollHeight;
  } catch (err) {
    console.error("Load messages error:", err);
    container.innerHTML = '<div class="empty-state">Error loading messages. Check Trello credentials.</div>';
  }
}

/* ==================================================================
   Reports — Load Last 5 Days
   ================================================================== */

async function loadReports() {
  const container = document.getElementById("reports-container");
  container.innerHTML = '<div class="loading">Loading reports...</div>';

  try {
    // Fetch recent board actions (past 5 days)
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const actions = await apiTrello(`/boards/${CONFIG.BOARD_ID}/actions`, "GET", null, {
      filter: "createCard,updateCard,commentCard",
      fields: "data,date,type",
      since: fiveDaysAgo,
      limit: 100,
    });

    // Group by date
    const byDate = {};
    actions.forEach((a) => {
      const day = a.date.slice(0, 10);
      if (!byDate[day]) byDate[day] = [];
      byDate[day].push(a);
    });

    const days = Object.keys(byDate).sort().reverse();

    if (days.length === 0) {
      container.innerHTML = '<div class="empty-state">No activity in the past 5 days.</div>';
      return;
    }

    container.innerHTML = "";
    days.forEach((day) => {
      const dayEl = document.createElement("div");
      dayEl.className = "report-day";
      dayEl.innerHTML = `<h3>📅 ${fmtDate(day)}</h3><ul>${byDate[day]
        .map((a) => {
          const typeLabel =
            a.type === "createCard"
              ? "📝 Card Created"
              : a.type === "commentCard"
                ? "💬 Comment"
                : a.type === "updateCard"
                  ? "✏️ Card Updated"
                  : a.type;
          const cardName = a.data?.card?.name || "(unknown)";
          const listName = a.data?.list?.name ? ` → ${a.data.list.name}` : "";
          return `<li><span class="event-type">${typeLabel}</span> ${escapeHtml(cardName)}${escapeHtml(listName)} <span class="event-time">${fmtTime(a.date)}</span></li>`;
        })
        .join("")}</ul>`;
      container.appendChild(dayEl);
    });
  } catch (err) {
    console.error("Reports error:", err);
    container.innerHTML = '<div class="empty-state">Error loading reports.</div>';
  }
}

/* ==================================================================
   Helpers
   ================================================================== */

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

/* ==================================================================
   Init — Load config on page load, then chat polling after login
   ================================================================== */

let pollTimer = null;

// Try restoring a session on page load
tryRestoreSession();

function initApp() {
  validateConfig();
  loadMessages();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(loadMessages, CONFIG.POLL_INTERVAL);
}

/* ==================================================================
   Validate config
   ================================================================== */

function validateConfig() {
  if (!CONFIG.LIST_ID_INPUT || !CONFIG.LIST_ID_OUTPUT || !CONFIG.BOARD_ID) {
    console.warn("⚠️ Collaborator Chat: Trello list/board IDs not configured in CONFIG.");
  } else {
    console.log("✓ Collaborator Chat: Config validated — API calls proxied through Netlify function");
  }
}
