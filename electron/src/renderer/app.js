/**
 * Frontdesk Operator — renderer.
 * Vanilla JS driving the dashboard via the preload `window.api` bridge.
 */
(function () {
  "use strict";
  const api = window.api;
  const $ = (id) => document.getElementById(id);

  const esc = (s) => {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  };
  const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : "");
  const pad = (n) => String(n).padStart(2, "0");

  // ── Tabs ──
  document.querySelectorAll(".sidebar-nav button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".sidebar-nav button").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.dataset.tab;
      $(`tab-${tab}`).classList.add("active");
      if (tab === "dashboard") refreshDashboard();
      if (tab === "queue") refreshQueue();
      if (tab === "logs") refreshLogs();
      if (tab === "sessions") refreshSessions();
      if (tab === "licenses") refreshLicenses();
      if (tab === "accounts") refreshAccounts();
      if (tab === "config") refreshConfig();
      if (tab === "tools") refreshTools();
      if (tab === "appearance") refreshAppearance();
      if (tab === "about") refreshAbout();
      if (tab === "chat") refreshChatSessions();
    });
  });

  // ── Dashboard ──
  async function refreshDashboard() {
    const grid = $("service-grid");
    const health = await api.health();
    const badge = $("health-badge");
    if (health.ok) {
      badge.textContent = `webhook ${health.json.port} ok`;
      badge.className = "badge ok";
    } else {
      badge.textContent = "webhook down";
      badge.className = "badge down";
    }

    const svcs = await api.svcList();
    grid.innerHTML = "";
    for (const s of svcs) {
      const card = document.createElement("div");
      card.className = "svc-card";
      const statusClass = s.running ? "running" : s.configured ? "stopped" : "error";
      const statusText = s.running ? `● running${s.pid ? ` (pid ${s.pid})` : ""}` : s.configured ? "○ stopped" : "not configured";
      card.innerHTML = `
        <h4>${esc(s.label)}</h4>
        <div class="svc-status ${statusClass}">${statusText}</div>
        <div class="svc-health">${s.health ? "health: " + esc(JSON.stringify(s.health)) : "—"}</div>
        <div class="svc-actions">
          <button data-start="${s.name}" ${s.running ? "disabled" : ""}>Start</button>
          <button data-stop="${s.name}" ${!s.running ? "disabled" : ""}>Stop</button>
        </div>
        <pre class="svc-log" id="svc-log-${s.name}">${esc((await api.svcLog(s.name, 30)).join("\n") || "")}</pre>
      `;
      grid.appendChild(card);
    }
    grid.querySelectorAll("[data-start]").forEach((b) =>
      b.addEventListener("click", async () => {
        await api.svcStart(b.dataset.start);
        refreshDashboard();
      }),
    );
    grid.querySelectorAll("[data-stop]").forEach((b) =>
      b.addEventListener("click", async () => {
        await api.svcStop(b.dataset.stop);
        refreshDashboard();
      }),
    );

    const cfg = await api.config();
    const gs = await api.googleStatus();
    $("config-box").textContent = JSON.stringify(
      { ...cfg, googleConnected: gs.connected, googleUser: gs.user || null },
      null,
      2,
    );
  }

  // ── Queue ──
  function renderQueue(list, el, queue) {
    el.innerHTML = "";
    if (!list || list.length === 0) {
      el.innerHTML = '<div class="empty">✅ Empty</div>';
      return;
    }
    for (const item of list.slice(0, 60)) {
      const div = document.createElement("div");
      div.className = "qitem" + (item.cleared ? " cleared" : "");
      const label = item.data?.rule || `${item.source}/${item.type}`;
      const desc = item.data?.text ? `"${item.data.text.slice(0, 70)}"` : item.data?.originalEvent?.data?.card?.name || "";
      div.innerHTML = `
        <span class="qn">#${item.seqNo ?? "?"}</span>
        <span class="qdesc">${esc(label)} ${esc(desc)}</span>
        <span class="qmeta">${fmt(item.queuedAt)}</span>
        <button data-clear="${item.id}" data-q="${queue}" ${item.cleared ? "disabled" : ""}>clear</button>
      `;
      el.appendChild(div);
    }
    el.querySelectorAll("[data-clear]").forEach((b) =>
      b.addEventListener("click", async () => {
        await api.eventsClear(b.dataset.clear, b.dataset.q);
        refreshQueue();
      }),
    );
  }

  async function refreshQueue() {
    const res = await api.queue();
    if (res.status === 0) {
      $("queue-priority").innerHTML = '<div class="empty">Webhook server not reachable.</div>';
      $("queue-misc").innerHTML = "";
      return;
    }
    renderQueue(res.json?.priority?.items || [], $("queue-priority"), "priority");
    renderQueue(res.json?.misc?.items || [], $("queue-misc"), "misc_notifications");
  }

  // ── Logs (Live + Files) ──
  const logState = { entries: [], paused: false, filters: { source: "", subSource: "", level: "", search: "" } };
  let logRenderTimer = null;

  function logMatchesFilters(e) {
    const f = logState.filters;
    if (f.source && e.source !== f.source) return false;
    if (f.subSource && e.subSource !== f.subSource) return false;
    if (f.level && e.level !== f.level) return false;
    if (f.search) {
      const q = f.search.toLowerCase();
      const hay = String(e.message || "") + " " + JSON.stringify(e.data || "");
      if (!hay.toLowerCase().includes(q)) return false;
    }
    return true;
  }

  function pretty(v) {
    try {
      const parsed = typeof v === "string" ? JSON.parse(v) : v;
      return JSON.stringify(parsed, null, 2);
    } catch {
      return String(v);
    }
  }

  function logRowHTML(e, idx) {
    const time = new Date(e.ts).toLocaleTimeString();
    const src = `${esc(e.source || "?")}${e.subSource ? "/" + esc(e.subSource) : ""}`;
    const hasData = e.data !== undefined;
    return `<div class="log-row level-${esc(e.level || "info")}" data-idx="${idx}">
      <span class="log-time">${time}</span>
      <span class="log-level">${esc(e.level || "info")}</span>
      <span class="log-src">${src}</span>
      <span class="log-msg">${esc(e.message || "")}</span>
      ${hasData ? `<button class="log-fold" data-idx="${idx}">▸</button>` : ""}
    </div>${hasData ? `<div class="log-detail" data-idx="${idx}" hidden><pre>${esc(pretty(e.data))}</pre></div>` : ""}`;
  }

  function renderLogEntries() {
    const box = $("log-box");
    const list = logState.entries.filter(logMatchesFilters);
    const shown = list.slice(-500);
    box.innerHTML = shown.map((e, i) => logRowHTML(e, i)).join("") || '<div class="empty">No matching log entries.</div>';
    box.querySelectorAll(".log-fold").forEach((btn) =>
      btn.addEventListener("click", () => {
        const detail = box.querySelector(`.log-detail[data-idx="${btn.dataset.idx}"]`);
        if (detail) {
          detail.hidden = !detail.hidden;
          btn.textContent = detail.hidden ? "▸" : "▾";
        }
      }),
    );
    if ($("log-f-autoscroll").checked) box.scrollTop = box.scrollHeight;
  }

  function scheduleLogRender() {
    if (logRenderTimer) return;
    logRenderTimer = setTimeout(() => {
      logRenderTimer = null;
      renderLogEntries();
    }, 300);
  }

  async function refreshLogs() {
    const res = await api.logsQuery({ ...logState.filters, limit: 500 });
    if (Array.isArray(res)) logState.entries = res;
    else if (res && Array.isArray(res.entries)) logState.entries = res.entries;
    renderLogEntries();
  }

  function bindLogFilters() {
    ["source", "subSource", "level"].forEach((k) =>
      $(`log-f-${k}`).addEventListener("change", (e) => {
        logState.filters[k] = e.target.value;
        refreshLogs();
      }),
    );
    $("log-f-search").addEventListener("input", (e) => {
      logState.filters.search = e.target.value;
      scheduleLogRender();
    });
    $("log-pause").addEventListener("click", () => {
      logState.paused = !logState.paused;
      $("log-pause").textContent = logState.paused ? "▶ Resume" : "⏸ Pause";
    });
    $("log-clear").addEventListener("click", async () => {
      await api.logsClear();
      logState.entries = [];
      renderLogEntries();
    });
    $("logs-sub-live").addEventListener("click", () => {
      $("logs-sub-live").classList.add("active");
      $("logs-sub-files").classList.remove("active");
      $("logs-live").style.display = "block";
      $("logs-files").style.display = "none";
    });
    $("logs-sub-files").addEventListener("click", () => {
      $("logs-sub-files").classList.add("active");
      $("logs-sub-live").classList.remove("active");
      $("logs-live").style.display = "none";
      $("logs-files").style.display = "block";
      refreshLogFiles();
    });
  }

  function bindLogStream() {
    api.onLogEntry((entry) => {
      if (logState.paused) return;
      logState.entries.push(entry);
      if (logState.entries.length > 2000) logState.entries.splice(0, logState.entries.length - 2000);
      scheduleLogRender();
    });
  }

  async function refreshLogFiles() {
    const res = await api.logsFiles();
    const list = $("log-file-list");
    if (!Array.isArray(res) || res.length === 0) {
      list.innerHTML = '<div class="empty">No log files yet.</div>';
      return;
    }
    const grouped = {};
    for (const f of res) (grouped[f.source] = grouped[f.source] || []).push(f);
    list.innerHTML = Object.keys(grouped).sort().map((src) => {
      const rows = grouped[src]
        .map((f) => {
          const size = f.size > 1024 ? (f.size / 1024).toFixed(1) + " KB" : f.size + " B";
          return `<div class="logfile-row" data-path="${esc(f.path)}" data-name="${esc(f.name)}"><span class="lf-name">${esc(f.name)}</span><span class="lf-meta">${size} · ${fmt(f.mtime)}</span></div>`;
        })
        .join("");
      return `<div class="logfile-group"><div class="logfile-src">${esc(src)}</div>${rows}</div>`;
    }).join("");
    list.querySelectorAll(".logfile-row").forEach((r) =>
      r.addEventListener("click", () => openLogFile(r.dataset.path, r.dataset.name, 500)),
    );
  }

  function renderLogFileLines(lines) {
    const q = ($("log-file-search").value || "").toLowerCase();
    const filtered = q ? lines.filter((l) => l.toLowerCase().includes(q)) : lines;
    const prettyLines = filtered.map((l) => {
      const t = l.trim();
      if (t.startsWith("{")) {
        try {
          return "  " + JSON.stringify(JSON.parse(t), null, 2);
        } catch {
          /* keep raw */
        }
      }
      return l;
    });
    $("log-file-box").textContent = prettyLines.map((l, i) => String(i + 1).padStart(4, " ") + "  " + l).join("\n") || "(empty)";
  }

  async function openLogFile(filePath, name, maxLines) {
    const res = await api.logsFile(filePath, maxLines);
    $("log-file-title").textContent = name || filePath;
    $("log-file-view").style.display = "block";
    const lines = (res && res.ok && res.lines) || [];
    window._curLog = { path: filePath, name: name || filePath, lines };
    renderLogFileLines(lines);
  }

  function bindLogFiles() {
    $("log-file-refresh").addEventListener("click", refreshLogFiles);
    $("log-file-tail").addEventListener("click", () => window._curLog && openLogFile(window._curLog.path, window._curLog.name, 500));
    $("log-file-full").addEventListener("click", () => window._curLog && openLogFile(window._curLog.path, window._curLog.name, 0));
    $("log-file-search-toggle").addEventListener("click", () => {
      const inp = $("log-file-search");
      inp.style.display = inp.style.display === "none" ? "block" : "none";
    });
    $("log-file-search").addEventListener("input", () => {
      if (window._curLog) renderLogFileLines(window._curLog.lines);
    });
  }

  // ── Sessions ──
  async function refreshSessions() {
    const res = await api.sessions();
    const entries = (res.ok && res.entries) || [];
    if (!entries.length) {
      $("sessions-box").innerHTML = '<div class="empty">No frontdesk sessions yet.</div>';
      return;
    }
    const rows = entries
      .slice(-50)
      .map((e) => `<tr><td>${fmt(e.ts)}</td><td>${esc(e.user || "")}</td><td>${esc(e.action || "")}</td><td>${esc(e.ip || "")}</td></tr>`)
      .join("");
    $("sessions-box").innerHTML = `<table><thead><tr><th>Time</th><th>User</th><th>Action</th><th>IP</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  // ── Licenses ──
  async function refreshLicenses() {
    const res = await api.licenses();
    if (!res.ok) {
      $("licenses-box").innerHTML = `<div class="empty">${esc(res.error)}</div>`;
      return;
    }
    const seats = res.seats || [];
    if (!seats.length) {
      $("licenses-box").innerHTML = '<div class="empty">No seats issued yet.</div>';
      return;
    }
    const rows = seats
      .map((s) => `<tr><td>${esc(s.sub)}</td><td><span class="tag ${s.status}">${s.status}</span></td><td>${esc(s.exp)}</td><td>${s.enc ? "yes" : "no"}</td></tr>`)
      .join("");
    $("licenses-box").innerHTML = `<table><thead><tr><th>Seat</th><th>Status</th><th>Expires</th><th>Enc</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
  $("licenses-refresh").addEventListener("click", refreshLicenses);

  // ── Accounts & Keys ──
  async function refreshAccounts() {
    const res = await api.accountsList();
    const box = $("accounts-box");
    if (!res.ok) {
      box.innerHTML = `<div class="empty">${esc(res.error)}</div>`;
      return;
    }
    const rows = res.rows || [];
    if (!rows.length) {
      box.innerHTML = '<div class="empty">No seats or account bindings yet. Issue a license first.</div>';
      return;
    }
    box.innerHTML = rows
      .map(
        (r) => `
      <div class="qitem">
        <span class="qn">${esc(r.sub)}</span>
        <span class="qdesc">google: <b>${r.googleConnected ? esc(r.googleUser || "connected") : "—"}</b> · trello: <b>${r.trelloConfigured ? "configured" : "default (.env)"}</b></span>
        <span class="qmeta">
          <button data-gconnect="${esc(r.sub)}">Connect Google</button>
          <button data-tset="${esc(r.sub)}">Set Trello</button>
          <button data-tclear="${esc(r.sub)}">Clear</button>
          <button data-spawn="${esc(r.sub)}">▶ Spawn MCP</button>
          <button data-stopspawn="${esc(r.sub)}">■ Stop MCP</button>
        </span>
      </div>`,
      )
      .join("");
    box.querySelectorAll("[data-gconnect]").forEach((b) =>
      b.addEventListener("click", async () => {
        const r = await api.accountsConnectGoogle(b.dataset.gconnect);
        alert(r.ok ? `Connected ${r.user || ""} to ${b.dataset.gconnect}` : `Failed: ${r.error}`);
        refreshAccounts();
      }),
    );
    box.querySelectorAll("[data-tset]").forEach((b) =>
      b.addEventListener("click", async () => {
        const key = prompt(`Trello key for ${b.dataset.tset}:`) || "";
        const token = prompt("Trello token:") || "";
        if (key && token) {
          await api.accountsSetTrello(b.dataset.tset, key, token);
          refreshAccounts();
        }
      }),
    );
    box.querySelectorAll("[data-tclear]").forEach((b) =>
      b.addEventListener("click", async () => {
        await api.accountsClear(b.dataset.tclear);
        refreshAccounts();
      }),
    );
    box.querySelectorAll("[data-spawn]").forEach((b) =>
      b.addEventListener("click", async () => {
        const r = await api.accountsSpawnForSeat(b.dataset.spawn);
        alert(r.ok ? `Spawned ${r.spawned.length} MCP instance(s)` : `Failed: ${r.error}`);
        refreshDashboard();
      }),
    );
    box.querySelectorAll("[data-stopspawn]").forEach((b) =>
      b.addEventListener("click", async () => {
        await api.accountsStopForSeat(b.dataset.stopspawn);
        refreshDashboard();
      }),
    );
  }
  $("accounts-refresh").addEventListener("click", refreshAccounts);

  // ── Tools ──
  async function refreshTools() {
    const res = await api.toolsManifest();
    if (!res.ok) {
      $("manifest-box").innerHTML = `<div class="empty">${esc(res.error)}</div>`;
      return;
    }
    $("manifest-box").innerHTML = (res.tools || [])
      .map((t) => {
        const props = Object.keys(t.inputSchema?.properties || {});
        return `<div class="manifest-tool"><span class="tname">${esc(t.name)}</span><div class="tdesc">${esc(t.description || "")}</div><div class="tdesc">params: ${esc(props.join(", ") || "none")}</div></div>`;
      })
      .join("");
  }

  async function runTrello(action, params) {
    const res = await api.trello(action, params);
    const box = $("trello-result");
    if (!res.ok) {
      box.innerHTML = `<div class="empty">Error: ${esc(res.error)}</div>`;
      return;
    }
    const data = Array.isArray(res.result) ? res.result : [res.result];
    box.innerHTML = data
      .slice(0, 20)
      .map((r) => `• ${esc(r.name || r.id || JSON.stringify(r).slice(0, 80))}${r.url ? ` — ${esc(r.url)}` : ""}`)
      .join("<br/>") || "(empty)";
  }

  document.querySelector('[data-act="boards"]').addEventListener("click", () => runTrello("list_boards"));
  document
    .querySelector('[data-act="lists"]')
    .addEventListener("click", () => runTrello("list_lists", { boardId: prompt("Board ID:") || "" }));
  document
    .querySelector('[data-act="cards"]')
    .addEventListener("click", () => runTrello("list_cards", { listId: prompt("List ID:") || "" }));

  document.querySelector('[data-act="gmail-list"]').addEventListener("click", async () => {
    const res = await api.gmail("list_messages", { maxResults: 10 });
    const box = $("gmail-result");
    box.innerHTML = res.ok
      ? (res.result || []).map((m) => `• ${esc(m.id)}`).join("<br/>") || "(empty)"
      : `<div class="empty">Error: ${esc(res.error)}</div>`;
  });

  // ── Config (config.json) — sectioned field editor with source annotations ──
  const escAttr = (s) => esc(s).replace(/"/g, "&quot;");
  const CONFIG_FIELDS = [
    // LLM Provider
    { key: "LLM_PROVIDER", label: "LLM Provider", section: "LLM Provider", secret: false, options: ["deepseek", "openai", "anthropic", "ollama"] },
    { key: "DEEPSEEK_API_KEY", label: "DeepSeek API Key", section: "LLM Provider", secret: true },
    { key: "DEEPSEEK_MODEL", label: "DeepSeek Model", section: "LLM Provider", secret: false },
    { key: "OPENAI_API_KEY", label: "OpenAI API Key", section: "LLM Provider", secret: true },
    { key: "OPENAI_MODEL", label: "OpenAI Model", section: "LLM Provider", secret: false },
    { key: "OPENAI_BASE_URL", label: "OpenAI Base URL", section: "LLM Provider", secret: false },
    { key: "ANTHROPIC_API_KEY", label: "Anthropic API Key", section: "LLM Provider", secret: true },
    { key: "ANTHROPIC_MODEL", label: "Anthropic Model", section: "LLM Provider", secret: false },
    { key: "ANTHROPIC_BASE_URL", label: "Anthropic Base URL", section: "LLM Provider", secret: false },
    { key: "ANTHROPIC_MAX_TOKENS", label: "Anthropic Max Tokens", section: "LLM Provider", secret: false },
    { key: "OLLAMA_BASE_URL", label: "Ollama Base URL", section: "LLM Provider", secret: false },
    { key: "OLLAMA_MODEL", label: "Ollama Model", section: "LLM Provider", secret: false },
    { key: "OLLAMA_NUM_CTX", label: "Ollama Context Window", section: "LLM Provider", secret: false },
    { key: "LLM_TEMPERATURE", label: "LLM Temperature", section: "LLM Provider", secret: false },
    // Webhook / Operator
    { key: "WEBHOOK_PORT", label: "Webhook Port", section: "Webhook", secret: false },
    { key: "WEBHOOK_BASE_URL", label: "Webhook Base URL", section: "Webhook", secret: false },
    { key: "WEBHOOK_API_TOKEN", label: "Webhook API Token", section: "Webhook", secret: true },
    { key: "CORS_ORIGINS", label: "CORS Origins", section: "Webhook", secret: false },
    { key: "TRUST_PROXY", label: "Trust Proxy", section: "Webhook", secret: false },
    { key: "OPERATOR_AUTOSTART", label: "Operator Autostart", section: "Webhook", secret: false, options: ["true", "false"] },
    { key: "PRIORITY_REMINDER_INTERVAL", label: "Priority Reminder Interval (ms)", section: "Webhook", secret: false },
    // Trello
    { key: "TRELLO_KEY", label: "Trello API Key", section: "Trello", secret: true },
    { key: "TRELLO_TOKEN", label: "Trello Token", section: "Trello", secret: true },
    { key: "TRELLO_BOARD_ID", label: "Board ID", section: "Trello", secret: false },
    { key: "TRELLO_LIST_FRONTEDESK_INPUT", label: "Frontdesk Input List ID", section: "Trello", secret: false },
    { key: "TRELLO_LIST_FRONTEDESK_OUTPUT", label: "Frontdesk Output List ID", section: "Trello", secret: false },
    { key: "TRELLO_LIST_SESSION_LOGS", label: "Session Logs List ID", section: "Trello", secret: false },
    { key: "TRELLO_WEBHOOK_MODEL_IDS", label: "Webhook Model IDs", section: "Trello", secret: false },
    { key: "TRELLO_WEBHOOK_ACTIONS", label: "Webhook Actions", section: "Trello", secret: false },
    // Gmail / Google
    { key: "GMAIL_CLIENT_ID", label: "Gmail Client ID", section: "Gmail / Google", secret: true },
    { key: "GMAIL_CLIENT_SECRET", label: "Gmail Client Secret", section: "Gmail / Google", secret: true },
    { key: "GMAIL_REFRESH_TOKEN", label: "Gmail Refresh Token", section: "Gmail / Google", secret: true },
    { key: "GMAIL_USER", label: "Gmail User", section: "Gmail / Google", secret: false },
    { key: "GMAIL_TOPIC_NAME", label: "Gmail Pub/Sub Topic", section: "Gmail / Google", secret: false },
    { key: "GMAIL_PUBSUB_SUBSCRIPTION", label: "Gmail Pub/Sub Subscription", section: "Gmail / Google", secret: false },
    { key: "GOOGLE_APPLICATION_CREDENTIALS", label: "Google App Credentials Path", section: "Gmail / Google", secret: false },
    // Frontdesk
    { key: "FRONTDESK_USE_TRELLO", label: "Use Trello for Frontdesk", section: "Frontdesk", secret: false, options: ["true", "false"] },
    { key: "FRONTDESK_LOG_TO_TRELLO", label: "Log Frontdesk to Trello", section: "Frontdesk", secret: false, options: ["true", "false"] },
    { key: "FRONTDESK_AGENT_PUBKEY", label: "Agent Public Key", section: "Frontdesk", secret: false },
    { key: "FRONTDESK_SESSION_TTL", label: "Session TTL (s)", section: "Frontdesk", secret: false },
    { key: "FRONTEND_HMAC_SECRET", label: "HMAC Secret", section: "Frontdesk", secret: true },
    { key: "FRONTEND_AUTH_PASSPHRASE", label: "Auth Passphrase", section: "Frontdesk", secret: true },
    // Tunnel
    { key: "CLOUDFLARE_TUNNEL_TOKEN", label: "Cloudflare Tunnel Token", section: "Tunnel", secret: true },
    { key: "CLOUDFLARE_TUNNEL_ID", label: "Cloudflare Tunnel ID", section: "Tunnel", secret: false },
    { key: "CLOUDFLARE_TUNNEL_DOMAIN", label: "Cloudflare Tunnel Domain", section: "Tunnel", secret: false },
    // Agent runner
    { key: "AGENT_RUNNER_ENABLED", label: "Agent Runner Enabled", section: "Agent runner", secret: false, options: ["true", "false"] },
    { key: "AGENT_TASK_INTERVAL", label: "Task Check Interval (ms)", section: "Agent runner", secret: false },
    { key: "AGENT_RUNNER_VERBOSE", label: "Verbose Prompt Logging", section: "Agent runner", secret: false, options: ["true", "false"] },
    // Logging
    { key: "LOG_LEVEL", label: "Log Level", section: "Logging", secret: false, options: ["debug", "info", "warn", "error"] },
    { key: "LOG_DIR", label: "Log Directory", section: "Logging", secret: false },
    { key: "LOG_CONSOLE", label: "Echo to Console", section: "Logging", secret: false, options: ["0", "1", "true", "false"] },
    // Appearance
    { key: "APPEARANCE_THEME", label: "Appearance Theme", section: "Appearance", secret: false, options: ["light", "dark", "system"] },
  ];

  const configState = { values: {}, sources: {}, dirty: new Set(), raw: false };

  function configMsg(text, isErr) {
    const el = $("config-msg");
    el.textContent = text;
    el.className = isErr ? "config-msg err" : "config-msg ok";
  }

  function configFieldHTML(f) {
    const v = configState.values[f.key];
    const val = v ? v.value : "";
    const src = v ? v.source : "default";
    const srcClass = src === "config.json" ? "valid" : src === ".env" ? "env" : "default";
    const srcLabel = src === "config.json" ? "config.json" : src === ".env" ? ".env" : "default";
    const inputType = f.secret ? "password" : "text";
    const input = f.options
      ? `<select data-cfield="${escAttr(f.key)}">${f.options.map((o) => `<option value="${escAttr(o)}" ${String(val) === o ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`
      : `<input type="${inputType}" data-cfield="${escAttr(f.key)}" value="${escAttr(val)}" spellcheck="false" />`;
    const toggle = f.secret ? `<button type="button" class="cfg-secret-toggle" data-secret-toggle="${escAttr(f.key)}" title="show/hide">👁</button>` : "";
    return `
      <div class="config-field">
        <label class="cfg-label" title="${escAttr(f.key)}">${esc(f.label)}</label>
        <div class="cfg-input-row">${input}${toggle}</div>
        <span class="cfg-source tag ${srcClass}">${srcLabel}</span>
      </div>`;
  }

  function renderConfigForm() {
    const wrap = $("config-fields");
    const raw = $("config-editor");
    if (configState.raw) {
      wrap.classList.add("hidden");
      raw.classList.remove("hidden");
      const flat = {};
      for (const k of Object.keys(configState.values)) flat[k] = configState.values[k].value;
      raw.value = JSON.stringify(flat, null, 2);
      return;
    }
    wrap.classList.remove("hidden");
    raw.classList.add("hidden");
    const sections = [];
    for (const f of CONFIG_FIELDS) {
      let sec = sections.find((s) => s.name === f.section);
      if (!sec) {
        sec = { name: f.section, fields: [] };
        sections.push(sec);
      }
      sec.fields.push(f);
    }
    wrap.innerHTML = sections
      .map((s) => `<div class="config-section"><h4>${esc(s.name)}</h4>${s.fields.map(configFieldHTML).join("")}</div>`)
      .join("");
    wrap.querySelectorAll("[data-cfield]").forEach((el) =>
      el.addEventListener("input", (e) => {
        const k = e.currentTarget.dataset.cfield;
        if (!configState.values[k]) configState.values[k] = { value: "", source: "default" };
        configState.values[k].value = e.currentTarget.value;
        configState.dirty.add(k);
        configMsg("");
      }),
    );
    wrap.querySelectorAll("[data-secret-toggle]").forEach((b) =>
      b.addEventListener("click", () => {
        const input = wrap.querySelector(`[data-cfield="${b.dataset.secretToggle}"]`);
        if (!input) return;
        const show = input.type === "password";
        input.type = show ? "text" : "password";
        b.textContent = show ? "🙈" : "👁";
      }),
    );
  }

  async function refreshConfig() {
    const c = await api.configWithSources();
    const status = $("config-status");
    configState.values = {};
    configState.dirty = new Set();
    if (c && c.ok !== false && c.present !== undefined) {
      if (c.present) {
        status.innerHTML = `<span class="tag valid">✅ config.json present</span><span class="config-src">using <code>${esc(c.configPath)}</code> — overrides <code>.env</code></span>`;
      } else {
        status.innerHTML = `<span class="tag expired">⚠️ no config.json</span><span class="config-src">falling back to <code>.env</code> — press <b>Save</b> to create config.json from edited values</span>`;
      }
      configState.values = c.values || {};
    } else {
      status.innerHTML = `<span class="tag expired">⚠️ config unavailable</span>`;
    }
    renderConfigForm();
    configMsg("");
  }

  $("config-refresh").addEventListener("click", refreshConfig);
  $("config-raw").addEventListener("click", () => {
    configState.raw = !configState.raw;
    $("config-raw").textContent = configState.raw ? "Form view" : "Raw JSON";
    renderConfigForm();
  });
  $("config-save").addEventListener("click", async () => {
    let payload;
    if (configState.raw) {
      try {
        payload = JSON.parse($("config-editor").value);
      } catch (err) {
        return configMsg(`Invalid JSON: ${err.message}`, true);
      }
    } else {
      payload = {};
      for (const k of configState.dirty) {
        if (configState.values[k]) payload[k] = configState.values[k].value;
      }
    }
    if (Object.keys(payload).length === 0) return configMsg("No changes to save.", true);
    const res = await api.configSave(payload);
    if (res.ok) {
      configMsg(`Saved ${res.count} key(s) to config.json. Restart services (Dashboard → Stop / Start) to apply.`);
      refreshConfig();
    } else {
      configMsg(res.error || "Save failed", true);
    }
  });
  $("config-export").addEventListener("click", async () => {
    const res = await api.configExport();
    const blob = new Blob([res.json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "config.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    configMsg(`Exported ${res.present ? "config.json" : ".env → JSON"} (${res.json.length} bytes).`);
  });
  $("config-import").addEventListener("click", () => $("config-import-input").click());
  $("config-import-input").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const text = await file.text();
    const res = await api.configImport(text);
    if (res.ok) {
      configMsg(`Imported ${res.count} key(s) → config.json. Restart services to apply.`);
      refreshConfig();
    } else {
      configMsg(res.error || "Import failed", true);
    }
    e.target.value = "";
  });

  // ── Appearance (light/dark/system) ──
  let sysMedia = null;
  let sysHandler = null;
  function applyTheme(info) {
    const effective = info.effective || "dark";
    document.documentElement.dataset.theme = effective;
    document.querySelectorAll(".theme-option").forEach((b) => b.classList.toggle("active", b.dataset.theme === info.theme));
  }
  async function refreshAppearance() {
    const t = await api.getTheme();
    if (!t || !t.theme) return;
    applyTheme(t);
    if (sysMedia && sysHandler) sysMedia.removeEventListener("change", sysHandler);
    sysMedia = null;
    sysHandler = null;
    if (t.theme === "system") {
      sysMedia = window.matchMedia("(prefers-color-scheme: dark)");
      sysHandler = () => applyTheme({ theme: "system", effective: sysMedia.matches ? "dark" : "light" });
      sysMedia.addEventListener("change", sysHandler);
    }
  }
  document.querySelectorAll(".theme-option").forEach((b) =>
    b.addEventListener("click", async () => {
      const t = await api.setTheme(b.dataset.theme);
      if (t) applyTheme(t);
    }),
  );

  // ── About (About / Guide tabs, Guide left empty for now) ──
  async function refreshAbout() {
    const r = await api.appVersion();
    const el = $("about-version");
    el.textContent = r && r.ok ? `${r.name} — v${r.version}` : "Frontdesk Operator";
  }
  function setAboutTab(sub) {
    const info = $("about-sub-info");
    const guide = $("about-sub-guide");
    const active = sub === "guide" ? guide : info;
    const other = sub === "guide" ? info : guide;
    active.classList.add("active");
    other.classList.remove("active");
    $("about-info").classList.toggle("hidden", sub === "guide");
    $("about-guide").classList.toggle("hidden", sub !== "guide");
  }
  $("about-sub-info").addEventListener("click", () => setAboutTab("info"));
  $("about-sub-guide").addEventListener("click", () => setAboutTab("guide"));

  // ── Chat (prompt the configured LLM; each chat persists to its own log file) ──
  const chatState = { sessions: [], current: null, entries: [], sending: false };
  async function refreshChatSessions() {
    const res = await api.chatList();
    chatState.sessions = (res.ok && res.sessions) || [];
    const list = $("chat-session-list");
    list.innerHTML = chatState.sessions.length
      ? chatState.sessions
          .map(
            (s) => `
        <div class="chat-session ${s.id === chatState.current ? "active" : ""}" data-session="${escAttr(s.id)}">
          <span class="cs-name">${esc(s.id)}</span>
          <span class="cs-meta">${s.count} msgs · ${fmt(s.lastTs) || "—"}</span>
        </div>`,
          )
          .join("")
      : '<div class="empty">No chats yet.</div>';
    list.querySelectorAll("[data-session]").forEach((el) => el.addEventListener("click", () => openChat(el.dataset.session)));
  }
  async function openChat(id) {
    chatState.current = id;
    const res = await api.chatHistory(id);
    chatState.entries = (res.ok && res.entries) || [];
    renderChat();
    refreshChatSessions();
  }
  function renderChat() {
    const box = $("chat-box");
    if (!chatState.current) {
      box.innerHTML = '<div class="empty">Start a new chat or pick a session.</div>';
      return;
    }
    box.innerHTML =
      chatState.entries
        .map((e) => {
          const role = e.role === "user" ? "user" : e.role === "system" ? "system" : "assistant";
          const who = role === "user" ? "You" : role === "system" ? "System" : "Agent";
          const meta = e.model ? ` · <span class="chat-model">${esc(e.model)}</span>` : "";
          return `<div class="chat-msg ${role}"><div class="chat-role">${who}${meta}</div><div class="chat-body">${esc(e.content || "")}</div></div>`;
        })
        .join("") || '<div class="empty">No messages.</div>';
    box.scrollTop = box.scrollHeight;
  }
  function chatMsg(text, isErr) {
    const el = $("chat-status");
    el.textContent = text;
    el.className = "config-msg " + (isErr ? "err" : "ok");
  }
  async function sendChat() {
    const input = $("chat-input");
    const text = input.value.trim();
    if (!text || chatState.sending) return;
    if (!chatState.current) {
      const created = await api.chatNew();
      if (!created.ok) return chatMsg(created.error || "Failed to start chat", true);
      chatState.current = created.id;
    }
    chatState.sending = true;
    $("chat-send").disabled = true;
    input.value = "";
    chatMsg("…");
    chatState.entries.push({ role: "user", content: text });
    renderChat();
    const res = await api.chatSend(chatState.current, text);
    chatState.sending = false;
    $("chat-send").disabled = false;
    if (res.ok) {
      chatState.entries.push({ role: "assistant", content: res.reply, model: res.model });
      chatMsg("sent");
    } else {
      chatState.entries.push({ role: "assistant", content: `⚠️ ${res.error || "send failed"}`, error: true });
      chatMsg(res.error || "send failed", true);
    }
    renderChat();
    refreshChatSessions();
  }
  $("chat-send").addEventListener("click", sendChat);
  $("chat-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });
  $("chat-new").addEventListener("click", async () => {
    const created = await api.chatNew();
    if (!created.ok) return chatMsg(created.error || "Failed to start chat", true);
    chatState.current = created.id;
    chatState.entries = [];
    renderChat();
    refreshChatSessions();
  });
  $("chat-refresh").addEventListener("click", () => {
    if (chatState.current) openChat(chatState.current);
    else refreshChatSessions();
  });

  // ── Quit (stops backend services via main's before-quit) ──
  document.getElementById("quit-btn").addEventListener("click", () => {
    if (window.confirm("Quit Frontdesk Operator? Backend services will stop.")) api.quit();
  });

  // ── Init ──
  refreshDashboard();
  refreshConfig();
  refreshAppearance();
  bindLogFilters();
  bindLogStream();
  bindLogFiles();
  setInterval(() => {
    // Light background refresh of health + dashboard while visible
    if (document.querySelector("#tab-dashboard").classList.contains("active")) refreshDashboard();
    if (document.querySelector("#tab-queue").classList.contains("active")) refreshQueue();
    if (document.querySelector("#tab-logs").classList.contains("active")) refreshLogs();
    if (document.querySelector("#tab-accounts").classList.contains("active")) refreshAccounts();
    if (document.querySelector("#tab-config").classList.contains("active")) refreshConfig();
    if (document.querySelector("#tab-about").classList.contains("active")) refreshAbout();
    if (document.querySelector("#tab-chat").classList.contains("active")) refreshChatSessions();
  }, 15000);
})();
