/**
 * app.js — Remote Collaborator Chat
 *
 * Connects to Trello as the "backend" for storing chat messages
 * and reading agent replies. All configuration is in CONFIG below.
 *
 * ── Setup ──
 * Replace the values in the CONFIG object with your own Trello details.
 * 1. Get your Trello API key: https://trello.com/app-key
 * 2. Generate a token: https://trello.com/1/authorize?expiration=never&scope=read,write&name=CollaboratorChat&key=YOUR_KEY
 * 3. Create a board and a "Pending Approval" list
 * 4. Find the list ID (add ".json" to the board URL, or use the API)
 *
 * ── Credential Security (Basic) ──
 * Login credentials are stored as SHA-256 hashes so viewing the source
 * doesn't reveal the plaintext passwords. The Trello API key+token are
 * split into fragments and reconstructed at runtime to deter casual
 * inspection. This is NOT cryptographically secure — a determined attacker
 * with debugger access can extract them. For stronger security, use a
 * serverless proxy (see notes.txt).
 */

/* ==================================================================
   CONFIGURATION — Replace these with your own values
   ================================================================== */

const CONFIG = {
  // Trello API — split into parts to deter casual viewing
  // Reassemble: part1 + part2 + part3
  TRELLO_KEY_PART1: "", // First ~1/3 of your Trello API key
  TRELLO_KEY_PART2: "", // Middle ~1/3
  TRELLO_KEY_PART3: "", // Last ~1/3
  TRELLO_TOKEN_PART1: "", // First ~1/3 of your Trello token
  TRELLO_TOKEN_PART2: "", // Middle ~1/3
  TRELLO_TOKEN_PART3: "", // Last ~1/3

  // Trello list where new collaborator messages go as cards
  LIST_ID: "", // e.g. "65a1b2c3d4e5f6a7b8c9d0e1"

  // Board ID for fetching report data
  BOARD_ID: "", // e.g. "65a1b2c3d4e5f6a7b8c9d0e1"

  // How often to poll for new replies (milliseconds)
  POLL_INTERVAL: 15000, // 15 seconds
};

/* ==================================================================
   Login Credentials (SHA-256 hashed)
   Run this in Node to generate: echo -n "user:pass" | shasum -a 256
   ================================================================== */

const USERS = {
  /* Default users — replace hashes with your own:
     Generate: echo -n "alice:secret123" | shasum -a 256
     Result:   "abc123def456..." (64 hex chars)
  */
  collaborator: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  admin: "a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a",
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

  try {
    // Create a card on the "Pending Approval" Trello list
    const resp = await fetch(
      trelloUrl(`/lists/${CONFIG.LIST_ID}/cards`, {
        name: `[${currentUser}] ${text.slice(0, 80)}${text.length > 80 ? "..." : ""}`,
        desc: text + `\n\n---\nFrom: ${currentUser}\nSent: ${new Date().toISOString()}`,
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
   Chat — Load Messages
   ================================================================== */

async function loadMessages() {
  const container = document.getElementById("messages-container");

  try {
    // Get cards from the "Pending Approval" list
    const cardsResp = await fetch(
      trelloUrl(`/lists/${CONFIG.LIST_ID}/cards`, {
        fields: "name,desc,dateLastActivity",
      }),
    );
    if (!cardsResp.ok) throw new Error(`HTTP ${cardsResp.status}`);

    const cards = await cardsResp.json();
    if (cards.length === 0) {
      container.innerHTML = '<div class="empty-state">No messages yet. Start the conversation!</div>';
      return;
    }

    // For each card, get comments (the conversation)
    const cardPromises = cards.map(async (card) => {
      const actionsResp = await fetch(
        trelloUrl(`/cards/${card.id}/actions`, {
          filter: "commentCard",
          fields: "data,date,memberCreator",
        }),
      );
      if (!actionsResp.ok) return [];
      const actions = await actionsResp.json();
      return actions.map((a) => ({
        cardId: card.id,
        cardName: card.name,
        text: a.data.text,
        date: a.date,
        member: a.memberCreator ? a.memberCreator.fullName : "Unknown",
      }));
    });

    const allComments = (await Promise.all(cardPromises)).flat();

    // Sort by date ascending
    allComments.sort((a, b) => new Date(a.date) - new Date(b.date));

    // Render as chat bubbles
    container.innerHTML = "";
    allComments.forEach((msg) => {
      const isCollaborator = !msg.member.toLowerCase().includes("agent") && !msg.member.toLowerCase().includes("admin");
      const bubble = document.createElement("div");
      bubble.className = `message ${isCollaborator ? "collaborator" : "agent"}`;
      bubble.innerHTML = `
        <div class="text">${escapeHtml(msg.text)}</div>
        <div class="meta">${msg.member} · ${fmtTime(msg.date)}</div>
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
  if (!key || !token || !CONFIG.LIST_ID || !CONFIG.BOARD_ID) {
    console.warn("⚠️ Collaborative Chat: Trello credentials not configured.\n" + "Open webapp/public/app.js and fill in the CONFIG section.");
  }
})();
