/**
 * app.js — Remote Collaborator Chat
 *
 * Two-list Trello backend:
 *   frontdesk_input  — new messages from the webapp go here as cards
 *   frontdesk_output — agent replies land here; these cards are shown
 *                      as "agent" messages in the chat window
 *
 * Login credentials are SHA-256 hashed. The Trello API key & token are
 * split into fragments (reconstructed at runtime) to deter casual
 * inspection. NOT cryptographically secure — for production, use a
 * Netlify serverless function reading env vars (see .env.example).
 *
 * ── Setup ──
 * 1. Get your Trello API key: https://trello.com/app-key
 * 2. Generate a token: https://trello.com/1/authorize?expiration=never&scope=read,write&name=CollaboratorChat&key=YOUR_KEY
 * 3. Create a board with two lists: "frontdesk_input" and "frontdesk_output"
 * 4. Find list IDs (append ".json" to board URL, or use the API)
 * 5. Fill in CONFIG below (or use Netlify env vars)
 */

/* ==================================================================
   CONFIGURATION — Replace these with your own values
   ================================================================== */

const CONFIG = {
  // Trello API — split into parts to deter casual viewing
  TRELLO_KEY_PART1: "",
  TRELLO_KEY_PART2: "",
  TRELLO_KEY_PART3: "",
  TRELLO_TOKEN_PART1: "",
  TRELLO_TOKEN_PART2: "",
  TRELLO_TOKEN_PART3: "",

  // Trello list where new collaborator messages go as cards
  LIST_ID_INPUT: "", // frontdesk_input list ID

  // Trello list where agent replies appear (shown in chat window)
  LIST_ID_OUTPUT: "", // frontdesk_output list ID

  // Board ID for fetching report data
  BOARD_ID: "",

  // How often to poll for new messages (milliseconds)
  POLL_INTERVAL: 15000, // 15 seconds

  // Max messages in the chat window (last N inputs + outputs combined)
  MAX_CHAT_MESSAGES: 15,
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

/** Build the Trello API base URL */
function trelloUrl(path, params = {}) {
  const key = CONFIG.TRELLO_KEY_PART1 + CONFIG.TRELLO_KEY_PART2 + CONFIG.TRELLO_KEY_PART3;
  const token = CONFIG.TRELLO_TOKEN_PART1 + CONFIG.TRELLO_TOKEN_PART2 + CONFIG.TRELLO_TOKEN_PART3;
  const qs = new URLSearchParams({ key, token, ...params });
  return `https://api.trello.com/1${path}?${qs}`;
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
   State
   ================================================================== */

let currentUser = null;

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

  if (USERS[username] && USERS[username] === hash) {
    currentUser = username;
    errEl.classList.add("hidden");
    document.getElementById("login-screen").classList.add("hidden");
    document.getElementById("app-screen").classList.remove("hidden");
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

document.getElementById("logout-btn").addEventListener("click", () => {
  currentUser = null;
  document.getElementById("app-screen").classList.add("hidden");
  document.getElementById("login-screen").classList.remove("hidden");
  document.getElementById("username").value = "";
  document.getElementById("password").value = "";
  document.getElementById("messages-container").innerHTML = '<div class="empty-state">No messages yet. Start the conversation!</div>';
});

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

async function sendMessage() {
  const input = document.getElementById("message-input");
  const text = input.value.trim();
  if (!text) return;

  const btn = document.getElementById("send-btn");
  btn.disabled = true;

  const now = new Date();
  const ts = now.toISOString();

  try {
    // Create a card on the frontdesk_input Trello list
    const resp = await fetch(
      trelloUrl(`/lists/${CONFIG.LIST_ID_INPUT}/cards`, {
        name: `[${currentUser}] ${text.slice(0, 80)}${text.length > 80 ? "..." : ""}`,
        desc: text + `\n\n---\nFrom: ${currentUser}\nSent: ${ts}`,
      }),
      { method: "POST" },
    );

    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);

    const card = await resp.json();

    // Add the text as the first comment
    await fetch(trelloUrl(`/cards/${card.id}/actions/comments`, { text }), { method: "POST" });

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
 * Fetch cards from a Trello list and return message objects.
 * Each card becomes one message using its desc (first 300 chars) + timestamp.
 */
async function fetchListMessages(listId, sender) {
  const resp = await fetch(
    trelloUrl(`/lists/${listId}/cards`, {
      fields: "name,desc,dateLastActivity,id",
    }),
  );
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const cards = await resp.json();

  return cards.map((card) => {
    // Extract the plain message text from desc (strip the --- metadata block)
    const desc = card.desc || "";
    const text = desc.split("\n---\n")[0] || desc;
    const date = card.dateLastActivity || new Date(0).toISOString();

    return {
      cardId: card.id,
      text: text,
      date: date,
      member: sender,
      sender: sender,
    };
  });
}

async function loadMessages() {
  const container = document.getElementById("messages-container");

  try {
    // 1. Fetch cards from both lists in parallel
    const [inputCards, outputCards] = await Promise.all([
      fetchListMessages(CONFIG.LIST_ID_INPUT, "You"),
      fetchListMessages(CONFIG.LIST_ID_OUTPUT, "Agent"),
    ]);

    // Mark input cards as "pending" (awaiting human approval before agent acts)
    const inputMsgs = inputCards.map((m) => ({ ...m, pending: true }));
    const outputMsgs = outputCards.map((m) => ({ ...m, pending: false }));

    // 2. Combine, sort descending (newest first), take last N
    const all = [...inputMsgs, ...outputMsgs];
    all.sort((a, b) => new Date(b.date) - new Date(a.date));

    const recent = all.slice(0, CONFIG.MAX_CHAT_MESSAGES).reverse(); // ascending for display

    if (recent.length === 0) {
      container.innerHTML = '<div class="empty-state">No messages yet. Start the conversation!</div>';
      return;
    }

    // 3. Render as chat bubbles
    container.innerHTML = "";
    recent.forEach((msg) => {
      const isCollaborator = msg.sender === "You";
      const bubble = document.createElement("div");
      bubble.className = `message ${isCollaborator ? "collaborator" : "agent"}${msg.pending ? " pending" : ""}`;
      bubble.innerHTML = `
        <div class="text">${escapeHtml(msg.text)}</div>
        <div class="meta">${msg.sender} · ${fmtTime(msg.date)}${msg.pending ? " · ⏳ Pending approval" : ""}</div>
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
    const actionsResp = await fetch(
      trelloUrl(`/boards/${CONFIG.BOARD_ID}/actions`, {
        filter: "createCard,updateCard,commentCard",
        fields: "data,date,type",
        since: fiveDaysAgo,
        limit: 100,
      }),
    );

    if (!actionsResp.ok) throw new Error(`HTTP ${actionsResp.status}`);

    const actions = await actionsResp.json();

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
   Init — Poll for new messages
   ================================================================== */

let pollTimer = null;

function initApp() {
  loadMessages();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(loadMessages, CONFIG.POLL_INTERVAL);
}

/* ==================================================================
   Validate config on load
   ================================================================== */

(function validateConfig() {
  const key = CONFIG.TRELLO_KEY_PART1 + CONFIG.TRELLO_KEY_PART2 + CONFIG.TRELLO_KEY_PART3;
  const token = CONFIG.TRELLO_TOKEN_PART1 + CONFIG.TRELLO_TOKEN_PART2 + CONFIG.TRELLO_TOKEN_PART3;
  if (!key || !token || !CONFIG.LIST_ID_INPUT || !CONFIG.LIST_ID_OUTPUT || !CONFIG.BOARD_ID) {
    console.warn("⚠️ Collaborator Chat: Trello credentials not configured.\n" + "Open webapp/public/app.js and fill in the CONFIG section.");
  }
})();
