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
      if (tab === "tools") refreshTools();
      if (tab === "appearance") refreshAppearance();
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

  // ── Quit (stops backend services via main's before-quit) ──
  document.getElementById("quit-btn").addEventListener("click", () => {
    if (window.confirm("Quit Frontdesk Operator? Backend services will stop.")) api.quit();
  });

  // ── Init ──
  refreshDashboard();
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
  }, 15000);
})();
