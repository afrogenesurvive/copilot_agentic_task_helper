/**
 * Dev Centre — renderer.
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

  // ── Icons ──
  // Static markup carries `<span data-icon="name">`; the SVG itself comes from
  // icons.js, so the glyph set has exactly one source of truth. Idempotent, so it
  // is safe to call again after a panel renders.
  function hydrateIcons(root) {
    (root || document).querySelectorAll("[data-icon]").forEach((el) => {
      if (el.dataset.iconDone === "1") return;
      el.innerHTML = window.Icons.svg(el.dataset.icon, Number(el.dataset.iconSize) || 18);
      el.dataset.iconDone = "1";
    });
  }

  // Static markup only, so hydrate it before anything else runs: a later throw must
  // never be able to leave the sidebar iconless.
  hydrateIcons();

  /**
   * Subscribe to a main-process push channel.
   *
   * Guarded on purpose. A single missing bridge method used to throw out of this
   * IIFE and silently kill every binding declared after it — which is exactly how
   * the icons went missing the first time round.
   */
  function subscribe(method, handler) {
    if (!api || typeof api[method] !== "function") {
      console.warn(`[subscribe] api.${method} is unavailable — skipping`);
      return;
    }
    try {
      api[method](handler);
    } catch (err) {
      console.warn(`[subscribe] api.${method} failed:`, err && err.message);
    }
  }

  /**
   * Icon + label for a button whose text changes at runtime.
   *
   * The label is wrapped in a `<span>` on purpose: `button` is `display:inline-flex`,
   * and a bare text node is not a flex item, so the icon/label gap would not apply.
   */
  function iconLabel(name, size, text) {
    return `${window.Icons.svg(name, size || 13)}<span>${esc(text)}</span>`;
  }

  // ── Tabs ──
  const NAV_SELECTOR = "#sidebar-nav .sidebar-btn";
  document.querySelectorAll(NAV_SELECTOR).forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(NAV_SELECTOR).forEach((b) => b.classList.remove("sidebar-btn--active"));
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      btn.classList.add("sidebar-btn--active");
      const tab = btn.dataset.tab;
      $(`tab-${tab}`).classList.add("active");
      // Each loader is guarded: a rejected IPC renders an error + Retry in the
      // panel instead of leaving its "loading…" placeholder up forever.
      const loaders = {
        dashboard: refreshDashboard,
        queue: refreshQueue,
        logs: refreshLogs,
        sessions: refreshSessions,
        notifications: refreshNotifications,
        licenses: refreshLicenses,
        usage: refreshUsage,
        accounts: refreshAccounts,
        config: refreshConfig,
        tools: refreshTools,
        scripts: refreshScripts,
        appearance: refreshAppearance,
        about: refreshAbout,
        chat: refreshChatSessions,
      };
      if (loaders[tab]) guarded(`tab:${tab}`, loaders[tab]);
      // Opening a tab acknowledges its notifications: a source tab clears its own
      // dot, the notification panel clears every dot.
      acknowledgeTab(tab);
      hydrateIcons();
    });
  });

  // ── Text prompt (replaces window.prompt) ──
  // Electron's renderer does NOT implement window.prompt() — it throws
  // "prompt() is not supported" — so all single-value prompts use this modal.
  // Resolves with the entered string, or null if cancelled.
  let promptResolve = null;

  function askText({ title = "Input", label = "Value", desc = "", value = "", placeholder = "" } = {}) {
    $("prompt-title").textContent = title;
    $("prompt-label").textContent = label;
    $("prompt-desc").textContent = desc;
    $("prompt-desc").style.display = desc ? "" : "none";
    const input = $("prompt-input");
    input.value = value;
    input.placeholder = placeholder;
    $("prompt-modal").classList.remove("hidden");
    input.focus();
    input.select();
    return new Promise((resolve) => {
      promptResolve = resolve;
    });
  }

  function closePrompt(result) {
    $("prompt-modal").classList.add("hidden");
    $("prompt-input").value = "";
    const resolve = promptResolve;
    promptResolve = null;
    if (resolve) resolve(result);
  }

  $("prompt-ok").addEventListener("click", () => closePrompt($("prompt-input").value));
  $("prompt-cancel").addEventListener("click", () => closePrompt(null));
  $("prompt-modal").addEventListener("click", (e) => {
    if (e.target === $("prompt-modal")) closePrompt(null);
  });
  $("prompt-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      closePrompt($("prompt-input").value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closePrompt(null);
    }
  });

  // ── Loading + error feedback ────────────────────────────────────────────────
  // Mirrors the ai_transcription_agent pattern:
  //   • #loading-overlay — ONE blocking overlay for one-shot actions (service
  //     start/stop/restart, pkm CLI calls, config save/import, MCP spawn).
  //   • .loading-block   — inline skeleton for panel/tab fetches.
  //   • .panel-error     — Retry-able error box, so a rejected IPC can never
  //     leave a bare "loading…" placeholder on screen forever.
  const LOADING_TEXT = /^(loading…?|checking…?)$/i;
  let loadingDepth = 0;
  let loadingSlowTimer = null;
  let loadingCancelFn = null;

  function showLoading(message, opts = {}) {
    const ov = $("loading-overlay");
    if (!ov) return;
    loadingDepth++;
    $("loading-msg").textContent = message || "Working…";
    const hint = $("loading-hint");
    hint.textContent = opts.hint || "";
    hint.classList.toggle("hidden", !opts.hint);
    const progress = $("loading-progress");
    if (typeof opts.progress === "number") {
      progress.classList.remove("hidden");
      $("loading-bar").style.width = `${Math.max(0, Math.min(100, opts.progress))}%`;
    } else {
      progress.classList.add("hidden");
    }
    const cancelBtn = $("loading-cancel");
    loadingCancelFn = typeof opts.cancel === "function" ? opts.cancel : null;
    cancelBtn.classList.toggle("hidden", !loadingCancelFn);
    cancelBtn.textContent = opts.cancelLabel || "Cancel";
    ov.classList.remove("hidden");
    // Long CLI calls say something rather than spinning silently for 20s.
    clearTimeout(loadingSlowTimer);
    loadingSlowTimer = setTimeout(
      () => {
        const h = $("loading-hint");
        if (h && !opts.hint) {
          h.textContent = opts.slowHint || "Taking longer than expected — still working…";
          h.classList.remove("hidden");
        }
      },
      opts.slowAfterMs || 8000,
    );
  }

  function hideLoading() {
    loadingDepth = Math.max(0, loadingDepth - 1);
    if (loadingDepth > 0) return;
    clearTimeout(loadingSlowTimer);
    loadingSlowTimer = null;
    loadingCancelFn = null;
    $("loading-overlay")?.classList.add("hidden");
    $("loading-hint")?.classList.add("hidden");
    $("loading-cancel")?.classList.add("hidden");
  }

  /** Run `fn` behind the blocking overlay; a failure surfaces as a toast, never a freeze. */
  async function withLoading(message, fn, opts = {}) {
    showLoading(message, opts);
    try {
      return await fn();
    } catch (err) {
      reportError(err, opts.context);
      return undefined;
    } finally {
      hideLoading();
    }
  }

  const loadingHTML = (label) =>
    `<div class="loading-block"><span class="spin"></span><span>${esc(label || "Loading…")}</span></div>`;

  function panelLoading(id, label) {
    const el = $(id);
    if (el) el.innerHTML = loadingHTML(label);
  }

  /** Replace a panel with a Retry-able error box (never leave "loading…" up). */
  function panelError(id, err, retry) {
    const el = $(id);
    if (!el) return;
    const msg = typeof err === "string" ? err : (err && err.message) || "Something went wrong";
    el.innerHTML =
      `<div class="panel-error"><span class="pe-msg">⚠️ ${esc(msg)}</span>` +
      (typeof retry === "function" ? `<button data-retry>Retry</button>` : "") +
      `</div>`;
    el.querySelector("[data-retry]")?.addEventListener("click", () => {
      panelLoading(id, "Retrying…");
      Promise.resolve()
        .then(retry)
        .catch((e) => panelError(id, e, retry));
    });
  }

  // Toasts STACK rather than replacing each other. A second message arriving while
  // the first was still on screen used to silently overwrite it, which is how a
  // failure could disappear before it was read.
  const TOAST_ICON = { ok: "check", error: "warning", warn: "warning", info: "info" };

  function dismissToast(el) {
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function toast(msg, kind) {
    const stack = $("toast-stack");
    if (!stack) return;
    const level = kind === "err" ? "error" : kind === "ok" ? "ok" : kind === "warn" ? "warn" : "info";
    const el = document.createElement("div");
    el.className = `toast toast--${level}`;
    el.innerHTML =
      `<span class="toast__icon">${window.Icons.svg(TOAST_ICON[level] || "info", 14)}</span>` +
      `<span>${esc(msg)}</span>` +
      `<button type="button" class="toast__close" aria-label="Dismiss">${window.Icons.svg("close", 12)}</button>`;
    el.querySelector(".toast__close").addEventListener("click", () => dismissToast(el));
    stack.appendChild(el);
    // Cap the stack so a burst of failures cannot bury the window.
    while (stack.children.length > 4) dismissToast(stack.firstElementChild);
    setTimeout(() => dismissToast(el), level === "error" ? 9000 : 4000);
  }

  function reportError(err, context) {
    const msg = (err && err.message) || String(err || "unknown error");
    console.error(context ? `[${context}] ${msg}` : msg, err);
    toast(msg, "err");
  }

  /**
   * Safety net: anything still showing a bare placeholder after a failure gets
   * an error + Retry instead of spinning forever (the 01.png Key Manager bug).
   */
  function rescueStuckPanels(err, retry) {
    hideLoading();
    document.querySelectorAll('[id$="-box"], [id$="-host"], [id$="-list"]').forEach((el) => {
      if (!LOADING_TEXT.test((el.textContent || "").trim())) return;
      panelError(el.id, err, retry);
    });
    const badge = $("pkm-badge");
    if (badge && LOADING_TEXT.test((badge.textContent || "").trim())) {
      badge.className = "badge down";
      badge.textContent = "error";
    }
  }

  /** Wrap a tab loader so a rejected IPC is reported instead of silently stalling. */
  function guarded(name, fn) {
    return Promise.resolve()
      .then(() => fn())
      .catch((err) => {
        reportError(err, name);
        rescueStuckPanels(err, fn);
      });
  }

  // Last-resort net: an unhandled rejection can never leave the UI spinning.
  window.addEventListener("unhandledrejection", (e) => {
    const err = e.reason || new Error("unknown error");
    reportError(err, "unhandled");
    rescueStuckPanels(err);
  });

  $("loading-cancel")?.addEventListener("click", () => {
    const fn = loadingCancelFn;
    hideLoading();
    if (fn) fn();
  });

  // ── Status bar ──
  // The health badge that used to live in the app header is now a pill in the
  // bottom status bar. These three helpers are the only writers of that area, so
  // a pill's colour can never drift from the state it reports.
  function setHealthPill(ok, text) {
    const el = $("health-badge");
    if (!el) return;
    el.className = `status-pill ${ok ? "status-pill--ok" : "status-pill--bad"}`;
    const label = $("health-text");
    if (label) label.textContent = text;
    el.title = text;
  }

  function setStatusText(id, text, kind) {
    const el = $(id);
    if (!el) return;
    el.className = `status-pill ${kind ? `status-pill--${kind}` : "status-pill--plain"}`;
    el.textContent = text;
  }

  // ── Dashboard (collapsible service sidebar + large detail view) ──
  const SVC_COLLAPSE_KEY = "frontdesk.svcSidebarCollapsed";
  const dash = {
    selected: null,
    // Bulk start/restart picker. This has to be state rather than DOM state:
    // refreshDashboard() re-runs the whole rail's innerHTML on the 15s background
    // refresh, which would otherwise wipe a tick the operator had just made.
    selecting: false,
    picked: new Set(),
    // Sidebar collapse state is a per-machine UI preference → localStorage.
    collapsed: (() => {
      try {
        return localStorage.getItem(SVC_COLLAPSE_KEY) === "1";
      } catch {
        return false;
      }
    })(),
  };

  function svcState(s) {
    return s.running ? "running" : s.configured ? "stopped" : "error";
  }

  /**
   * Icon per local service (see the services group in icons.js).
   *
   * The rail collapses to icons, so every service needs a glyph that survives its
   * label disappearing; an unmapped one falls back to `tools` rather than rendering
   * an empty square, because Icons.svg() returns a blank <svg> for an unknown name.
   */
  const SVC_ICONS = {
    webhook: "webhook",
    runner: "agent",
    tunnel: "cloud",
    "mcp:trello": "board",
    "mcp:gmail": "mail",
    "mcp:drive": "folder",
    "mcp:calendar": "calendar",
    "mcp:sheets": "table",
    "mcp:photos": "image",
    "mcp:web-search": "search",
    "mcp:whatsapp": "chat",
    "mcp:netlify": "upload",
  };
  const svcIcon = (name) => SVC_ICONS[name] || "tools";

  function svcStateTitle(s) {
    return s.running ? (s.external ? "running (external — started outside the dashboard)" : "running") : s.configured ? "stopped" : "not configured";
  }

  async function refreshDashboard() {
    const health = await api.health();
    setHealthPill(health.ok, health.ok ? `webhook :${health.json.port}` : "webhook down");

    const svcs = await api.svcList();
    const names = svcs.map((s) => s.name);
    const running = svcs.filter((s) => s.running).length;
    setStatusText(
      "status-services",
      `services ${running}/${svcs.length}`,
      svcs.length === 0 ? "" : running === svcs.length ? "ok" : running > 0 ? "warn" : "bad",
    );
    // The rail's bulk action is a picker now, so nothing here narrows to "core services"
    // any more: whatever is ticked is started when down and restarted when up.
    if (!dash.selected || !names.includes(dash.selected)) dash.selected = names[0] || null;

    const strip = $("svc-tabs");
    strip.classList.toggle("collapsed", dash.collapsed);

    const selecting = dash.selecting;
    const pickedCount = svcs.filter((s) => dash.picked.has(s.name)).length;
    const rowHTML = (s) => {
      const state = svcState(s);
      const icon = `<span class="svc-icon">${window.Icons.svg(svcIcon(s.name), 16)}</span>`;
      const dot = `<span class="svc-dot ${state}"></span>`;
      const label = `<span class="svc-tab-label">${esc(s.label)}</span>`;
      if (!selecting) {
        const cls = ["svc-tab", state, s.name === dash.selected ? "active" : ""].join(" ");
        return `<button class="${cls}" data-svc="${esc(s.name)}" title="${esc(s.label)} — ${svcStateTitle(s)}">${icon}${dot}${label}</button>`;
      }
      // A <label> row, deliberately NOT a button wrapping an <input>: a control inside a
      // control is invalid and fires both handlers. Picking must also never re-point the
      // detail pane, which is why these rows are excluded from the click binding below.
      const cls = ["svc-tab", "svc-pick", state].join(" ");
      const box = `<input type="checkbox" class="svc-pick-box" data-svc="${esc(s.name)}"${dash.picked.has(s.name) ? " checked" : ""}${s.configured ? "" : " disabled"} />`;
      const title = s.configured ? `Include ${s.label} — ${svcStateTitle(s)}` : `${s.label} is not configured — nothing to start`;
      return `<label class="${cls}" title="${esc(title)}">${box}${icon}${dot}${label}</label>`;
    };

    strip.innerHTML =
      `<div class="svc-tabs-head">` +
      `<span class="svc-tabs-title">Services</span>` +
      `<button id="svc-collapse" class="svc-collapse" title="${dash.collapsed ? "Expand the service list" : "Collapse the service list"}">${window.Icons.svg(dash.collapsed ? "chevron-right" : "chevron-left", 14)}</button>` +
      `</div>` +
      // The bulk buttons sit between the heading and the rows: the action belongs beside
      // the things it acts on, and the rail is where the tick-boxes appear.
      `<div class="svc-bulk">` +
      (selecting
        ? `<button id="svc-bulk-toggle" class="svc-bulk-btn" title="Leave selection mode and clear every tick">${window.Icons.svg("close", 12)}<span>Cancel</span></button>` +
          `<button id="svc-bulk-go" class="svc-bulk-btn primary"${pickedCount ? "" : " disabled"} title="${pickedCount ? "Start the ticked services that are down and restart the ones already up" : "Tick at least one service first"}">${window.Icons.svg("power", 12)}<span id="svc-bulk-go-label">Start / restart (${pickedCount})</span></button>`
        : `<button id="svc-bulk-toggle" class="svc-bulk-btn" title="Pick services to start (if down) or restart (if up)">${window.Icons.svg("power", 12)}<span>Start / restart…</span></button>`) +
      `</div>` +
      svcs.map(rowHTML).join("");

    strip.querySelector("#svc-collapse").addEventListener("click", () => {
      dash.collapsed = !dash.collapsed;
      try {
        localStorage.setItem(SVC_COLLAPSE_KEY, dash.collapsed ? "1" : "0");
      } catch {
        /* ignore (storage unavailable) */
      }
      refreshDashboard();
    });

    if (selecting) {
      strip.querySelectorAll(".svc-pick-box").forEach((box) =>
        box.addEventListener("change", () => {
          if (box.checked) dash.picked.add(box.dataset.svc);
          else dash.picked.delete(box.dataset.svc);
          // Touch only the commit button's own label and disabled state: re-rendering the
          // rail here would rebuild (and un-focus) the row that was just clicked.
          const go = strip.querySelector("#svc-bulk-go");
          const goLabel = strip.querySelector("#svc-bulk-go-label");
          if (go) go.disabled = dash.picked.size === 0;
          if (goLabel) goLabel.textContent = `Start / restart (${dash.picked.size})`;
        }),
      );
      strip.querySelector("#svc-bulk-toggle").addEventListener("click", cancelBulkSelection);
      strip.querySelector("#svc-bulk-go")?.addEventListener("click", () => runBulkSelection(svcs));
    } else {
      // `button.svc-tab`, not `.svc-tab`: the picker's rows share that class and must not
      // answer this handler — a <label> has no `data-svc`, so it would clear the selection
      // and blank the detail pane.
      strip.querySelectorAll("button.svc-tab").forEach((b) =>
        b.addEventListener("click", async () => {
          dash.selected = b.dataset.svc;
          strip.querySelectorAll("button.svc-tab").forEach((x) => x.classList.toggle("active", x === b));
          await renderSvcDetail(b.dataset.svc);
        }),
      );
      strip.querySelector("#svc-bulk-toggle").addEventListener("click", () => {
        dash.selecting = true;
        // Pre-tick the core services — the set the old "Restart all down" covered — so the
        // common "bring the backend back up" case stays one action. MCP servers are a
        // deliberate, occasional choice, so they start unticked.
        dash.picked = new Set(svcs.filter((s) => s.configured && !s.name.startsWith("mcp:")).map((s) => s.name));
        refreshDashboard();
      });
    }

    await renderSvcDetail(dash.selected, svcs);
  }

  /**
   * Leave the picker and forget every tick.
   *
   * Used by Cancel and again at the end of a bulk action, so both paths land in exactly the
   * same state: the rail reverts to its normal rows with nothing left ticked.
   */
  function cancelBulkSelection() {
    dash.selecting = false;
    dash.picked = new Set();
    const st = $("svc-bulk-status");
    if (st) st.textContent = "";
    refreshDashboard();
  }

  /**
   * Bulk start/restart over the ticked services.
   *
   * The start-or-restart decision is made in main (`bulkServiceAction`): that side owns
   * `serviceHealth()`, so it is the one that can tell "down" from "up but external" — the
   * latter comes back as skipped rather than being silently ignored.
   */
  async function runBulkSelection(svcs) {
    const names = svcs.filter((s) => dash.picked.has(s.name)).map((s) => s.name);
    if (!names.length) return;
    const st = $("svc-bulk-status");
    const go = $("svc-bulk-go");
    if (go) go.disabled = true;
    const res = await withLoading(`Starting or restarting ${names.length} service${names.length === 1 ? "" : "s"}…`, () => api.svcBulkAction(names), {
      context: "svc bulk action",
      slowHint: "A restart waits for each old process to release its port before the replacement binds…",
    });
    if (st) {
      if (!res) {
        st.textContent = "No result — check the service list.";
      } else if (res.ok === false) {
        st.textContent = `⚠️ ${res.error}`;
      } else {
        const rows = res.results || [];
        const byAction = (action) => rows.filter((r) => r.action === action);
        st.textContent =
          [
            byAction("started").length ? `✅ started ${byAction("started").map((r) => r.label).join(", ")}` : "",
            byAction("restarted").length ? `🔁 restarted ${byAction("restarted").map((r) => r.label).join(", ")}` : "",
            byAction("failed").length ? `❌ ${byAction("failed").map((r) => `${r.label} (${r.error})`).join(", ")}` : "",
            byAction("skipped").length ? `skipped ${byAction("skipped").map((r) => `${r.label} (${r.reason})`).join(", ")}` : "",
          ]
            .filter(Boolean)
            .join(" · ") || "Nothing to do.";
      }
    }
    // The action ends the picker: the ticks and the second button go away with this
    // re-render. The report above is deliberately left in place — refreshDashboard() does
    // not touch #svc-bulk-status — so it can still be read afterwards.
    dash.selecting = false;
    dash.picked = new Set();
    refreshDashboard();
  }

  // WhatsApp MCP server dashboard details — configured token/WABA, which number
  // is active (test vs live) and its connection status, plus a list-numbers helper.
  async function waSvcDetailHTML() {
    const res = await api.whatsapp("status");
    if (!res.ok || !res.result) {
      return `<div class="svc-wa">💬 <b>WhatsApp (Meta Cloud API):</b> not configured — set the WHATSAPP_* keys in ⚙️ Config, then start this service.</div>`;
    }
    const c = res.result.configured || {};
    const n = res.result.activeNumber;
    const numLine =
      n && typeof n === "object"
        ? `${n.displayPhoneNumber || n.phoneNumberId || "?"} — ${n.status || "?"}${n.qualityRating ? ` (${n.qualityRating})` : ""}`
        : c.activePhoneId || "no active number set";
    return `<div class="svc-wa">💬 <b>WhatsApp (Meta Cloud API):</b> token ${c.accessToken ? "✅" : "❌"} · WABA ${c.wabaId ? "✅" : "❌"} · active ${esc(numLine)}${res.result.connected ? " · connected ✅" : " · not connected"}
      <button type="button" id="wa-list-numbers" title="Copy phone-number IDs into Config">List numbers</button> <span id="wa-dash-nums"></span></div>`;
  }

  async function renderSvcDetail(name, svcs) {
    const detail = $("svc-detail");
    if (!name) {
      detail.innerHTML = '<div class="empty">No services configured.</div>';
      return;
    }
    const s = (svcs || (await api.svcList())).find((x) => x.name === name);
    if (!s) return;
    const canControl = s.running && !s.external;
    const statusClass = s.running ? "running" : s.configured ? "stopped" : "error";
    // No bullet character in the text: the dot is a `.status-dot` element that
    // inherits the status colour, so it tracks the theme and the font preset.
    const statusText = s.running
      ? `running${s.external ? " (external — started outside the dashboard)" : s.pid ? ` (pid ${s.pid})` : ""}`
      : s.configured
        ? "stopped"
        : "not configured";
    detail.innerHTML = `
      <div class="svc-head">
        <div>
          <h3>${esc(s.label)}</h3>
          <div class="svc-status ${statusClass}"><span class="status-dot"></span>${esc(statusText)}</div>
        </div>
        <div class="svc-actions">
          <button data-start="${esc(s.name)}" ${s.running ? "disabled" : ""} title="${s.external ? "Already running outside the dashboard" : "Start this service"}">${window.Icons.svg("play", 13)} Start</button>
          <button data-restart="${esc(s.name)}" ${!canControl ? "disabled" : ""} title="Restart this service (stop + start)">${window.Icons.svg("refresh", 13)} Restart</button>
          <button data-stop="${esc(s.name)}" ${!canControl ? "disabled" : ""}>${window.Icons.svg("stop", 13)} Stop</button>
          <button id="svc-refresh">Refresh</button>
        </div>
      </div>
      ${s.name === "webhook" ? `<div class="svc-actions svc-reregister">
        <button id="svc-reregister" title="${s.external ? "Re-run Trello/Gmail/Calendar/Drive registration scripts — the running server is not managed by the dashboard, so it won't be restarted" : "Restart the webhook server and re-run the Trello/Gmail/Calendar/Drive registration scripts"}">🔁 ${s.external ? "Re-register webhooks" : "Restart &amp; re-register webhooks"}</button>
        <span class="svc-rereg-status" id="svc-rereg-status"></span>
      </div>` : ""}
      <div class="svc-health">${s.health ? "health: " + esc(JSON.stringify(s.health)) : s.running ? "—" : "not running"}</div>
      ${s.name === "mcp:whatsapp" ? await waSvcDetailHTML() : ""}
      <pre class="svc-detail-log" id="svc-detail-log">${esc((await api.svcLog(s.name, 500)).join("\n") || "")}</pre>
    `;
    detail.querySelector("[data-start]")?.addEventListener("click", async () => {
      await withLoading(`Starting ${s.label}…`, () => api.svcStart(s.name), {
        context: "svc start",
        slowHint: "Waiting for the service to come up…",
      });
      refreshDashboard();
    });
    detail.querySelector("[data-stop]")?.addEventListener("click", async () => {
      await withLoading(`Stopping ${s.label}…`, () => api.svcStop(s.name), { context: "svc stop" });
      refreshDashboard();
    });
    detail.querySelector("[data-restart]")?.addEventListener("click", async () => {
      const r = await withLoading(`Restarting ${s.label}…`, () => api.svcRestart(s.name), {
        context: "svc restart",
        slowHint: "Waiting for the old process to release its port…",
      });
      // restartService waits ~700ms for the old process to free its port.
      setTimeout(refreshDashboard, r === false ? 0 : 900);
    });
    detail.querySelector("#svc-refresh")?.addEventListener("click", () => renderSvcDetail(s.name));
    detail.querySelector("#wa-list-numbers")?.addEventListener("click", async () => {
      const r = await withLoading("Reading phone numbers from the WhatsApp Cloud API…", () => api.whatsapp("list_numbers"), {
        context: "whatsapp list_numbers",
      });
      const out = detail.querySelector("#wa-dash-nums");
      if (!out) return;
      if (!r) return;
      out.innerHTML = r.ok && Array.isArray(r.result)
        ? r.result.map((x) => `<code>${esc(x.id)} — ${esc(x.display || "")}</code>`).join(" · ")
        : `<span class="err">${esc((r && r.error) || "unknown error")}</span>`;
    });
    detail.querySelector("#svc-reregister")?.addEventListener("click", async () => {
      const btn = detail.querySelector("#svc-reregister");
      const st = detail.querySelector("#svc-rereg-status");
      if (btn) {
        btn.disabled = true;
        btn.textContent = "⏳ Re-registering…";
      }
      if (st)
        st.textContent = s.external
          ? "Re-running Trello → Gmail → Calendar → Drive registration scripts (server already running outside the dashboard — not restarted)…"
          : "Running Trello → Gmail → Calendar → Drive setup, then restarting the webhook server (≈20–60s)…";
      const res = await withLoading(
        "Re-registering webhooks (Trello → Gmail → Calendar → Drive) and restarting the webhook server…",
        () => api.svcReregisterWebhooks(),
        { context: "webhook re-register", slowHint: "This takes 20–60s while the server restarts." },
      );
      if (st && res) {
        const parts = (res.steps || []).map((x) => {
          if (x.ok) return `✅ ${x.label}`;
          const tail = (x.output || x.error || "").split("\n").filter(Boolean).slice(-2).join(" · ");
          return `❌ ${x.label} — ${tail}`;
        });
        st.textContent = `Webhook restarted: ${res.webhookRestarted ? "yes" : "no"}. ${parts.join(" | ")}`;
      }
      if (btn) {
        btn.disabled = false;
        btn.textContent = s.external ? "🔁 Re-register webhooks" : "🔁 Restart & re-register webhooks";
      }
      // No immediate re-render: the dashboard's 15s poll updates the running
      // state, keeping this ✅/❌ summary visible until then.
    });
    const box = $("svc-detail-log");
    if (box) box.scrollTop = box.scrollHeight;
  }

  // ── Queue ──
  // Each panel is an independent view over its own queue file. Collapse state is a
  // per-machine UI preference (localStorage, like the service rail); filter and sort
  // state live in memory. Filters never re-fetch: the items are cached, so typing in
  // the search box cannot hammer the webhook server.
  const QUEUE_COLLAPSE_KEY = "frontdesk.queueCollapsed";
  const QUEUE_ROW_LIMIT = 400;
  /** Per-queue DOM ids. The misc queue's key is `misc_notifications`; its ids say `misc`. */
  const QUEUE_IDS = {
    priority: {
      toggle: "queue-toggle-priority",
      type: "queue-type-priority",
      search: "queue-search-priority",
      sort: "queue-sort-priority",
      count: "queue-count-priority",
      body: "queue-priority",
    },
    misc_notifications: {
      toggle: "queue-toggle-misc",
      type: "queue-type-misc",
      search: "queue-search-misc",
      sort: "queue-sort-misc",
      count: "queue-count-misc",
      body: "queue-misc",
    },
  };
  const queueState = {
    priority: { collapsed: false, type: "", search: "", sort: "newest" },
    misc_notifications: { collapsed: false, type: "", search: "", sort: "newest" },
  };
  let queueCache = { priority: [], misc_notifications: [] };

  (function restoreQueueCollapse() {
    try {
      const saved = JSON.parse(localStorage.getItem(QUEUE_COLLAPSE_KEY) || "{}");
      for (const q of Object.keys(queueState)) {
        if (typeof saved[q] === "boolean") queueState[q].collapsed = saved[q];
      }
    } catch {
      /* storage unavailable — both panels start expanded */
    }
  })();

  /** The event source an item belongs to — this is the filter facet. */
  const queueSource = (item) => item.source || "unknown";

  /** Short tag for the row: `tool_dispatch` is the dispatch engine, not a source. */
  const queueTypeLabel = (item) => (item.source === "tool_dispatch" ? "dispatch" : queueSource(item));

  /** Everything a free-text search should match for one item. */
  function queueHaystack(item) {
    return [
      item.source,
      item.type,
      item.id,
      item.data?.rule,
      item.data?.text,
      item.data?.message,
      item.data?.sub,
      item.data?.originalEvent?.data?.card?.name,
      item.data?.originalEvent?.data?.subject,
      item.data?.originalEvent?.data?.from,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }

  /** Apply this panel's type filter, text search and sort. */
  function queueView(list, q) {
    const st = queueState[q];
    const needle = st.search.trim().toLowerCase();
    const out = (list || []).filter((item) => {
      if (st.type && queueSource(item) !== st.type) return false;
      if (needle && !queueHaystack(item).includes(needle)) return false;
      return true;
    });
    const seq = (i) => Number(i.seqNo) || 0;
    const at = (i) => Date.parse(i.queuedAt || i.timestamp || "") || 0;
    if (st.sort === "oldest") out.sort((a, b) => at(a) - at(b) || seq(a) - seq(b));
    else if (st.sort === "type") out.sort((a, b) => queueTypeLabel(a).localeCompare(queueTypeLabel(b)) || at(b) - at(a));
    else if (st.sort === "uncleared") out.sort((a, b) => Number(a.cleared || 0) - Number(b.cleared || 0) || at(b) - at(a));
    else out.sort((a, b) => at(b) - at(a) || seq(b) - seq(a)); // newest first
    return out;
  }

  /**
   * Rebuild a panel's type options from the items actually present.
   * A source that has since disappeared would otherwise leave a stale filter hiding
   * every row with no visible cause.
   */
  function queueTypeOptions(el, list, q) {
    if (!el) return;
    const st = queueState[q];
    const sources = [...new Set((list || []).map(queueSource))].sort();
    el.innerHTML =
      '<option value="">all types</option>' +
      sources.map((s) => `<option value="${esc(s)}"${s === st.type ? " selected" : ""}>${esc(s)}</option>`).join("");
    if (st.type && !sources.includes(st.type)) {
      st.type = "";
      el.value = "";
    }
  }

  /** Paint a panel's collapse state (caret, aria, body visibility). */
  function applyQueuePanel(q) {
    const ids = QUEUE_IDS[q];
    const st = queueState[q];
    const body = $(ids.body);
    if (body) body.classList.toggle("hidden", st.collapsed);
    const toggle = $(ids.toggle);
    if (toggle) {
      toggle.setAttribute("aria-expanded", st.collapsed ? "false" : "true");
      const caret = toggle.querySelector(".q-caret");
      if (caret) caret.textContent = st.collapsed ? "▸" : "▾";
      toggle.title = st.collapsed ? "Expand this section" : "Collapse this section";
    }
  }

  function renderQueue(list, el, queue) {
    const ids = QUEUE_IDS[queue];
    const all = list || [];
    const view = queueView(all, queue);

    const countEl = $(ids.count);
    if (countEl) countEl.textContent = view.length === all.length ? String(all.length) : `${view.length} of ${all.length}`;
    queueTypeOptions($(ids.type), all, queue);

    el.innerHTML = "";
    if (!view.length) {
      el.innerHTML = `<div class="empty">${all.length ? "No items match the filter." : "✅ Empty"}</div>`;
      return;
    }
    for (const item of view.slice(0, QUEUE_ROW_LIMIT)) {
      const div = document.createElement("div");
      div.className = "qitem" + (item.cleared ? " cleared" : "");
      const label = item.data?.rule || `${item.source}/${item.type}`;
      const desc = item.data?.text
        ? `"${item.data.text.slice(0, 70)}"`
        : item.data?.originalEvent?.data?.card?.name || item.data?.originalEvent?.data?.subject || "";
      div.innerHTML = `
        <span class="qn">#${item.seqNo ?? "?"}</span>
        <span class="qtype">${esc(queueTypeLabel(item))}</span>
        <span class="qdesc">${esc(label)} ${esc(desc)}</span>
        <span class="qmeta">${fmt(item.queuedAt)}</span>
        <button data-clear="${item.id}" data-q="${queue}" ${item.cleared ? "disabled" : ""}>clear</button>
      `;
      el.appendChild(div);
    }
    if (view.length > QUEUE_ROW_LIMIT) {
      // Say so rather than cutting the list off — the old version sliced at 60 and
      // gave no hint that anything was missing.
      const more = document.createElement("div");
      more.className = "empty";
      more.textContent = `${view.length - QUEUE_ROW_LIMIT} more item(s) not shown — narrow the filter to see them.`;
      el.appendChild(more);
    }
    el.querySelectorAll("[data-clear]").forEach((b) =>
      b.addEventListener("click", async () => {
        await api.eventsClear(b.dataset.clear, b.dataset.q);
        refreshQueue();
      }),
    );
  }

  /** Re-render one panel from the cache — what every filter/sort control calls. */
  function paintQueue(q) {
    applyQueuePanel(q);
    const body = $(QUEUE_IDS[q].body);
    if (body) renderQueue(queueCache[q], body, q);
  }

  async function refreshQueue() {
    const res = await api.queue();
    if (res.status === 0) {
      const body = $("queue-priority");
      if (body) body.innerHTML = '<div class="empty">Webhook server not reachable.</div>';
      const misc = $("queue-misc");
      if (misc) misc.innerHTML = "";
      return;
    }
    queueCache.priority = res.json?.priority?.items || [];
    queueCache.misc_notifications = res.json?.misc?.items || [];
    paintQueue("priority");
    paintQueue("misc_notifications");
  }

  // ── Logs (Live + Files) ──
  const logState = { entries: [], dayEntries: [], day: null, dayPath: null, dayMap: {}, paused: false, filters: { source: "", subSource: "", level: "", search: "" } };
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
    // Live mode filters the streaming buffer; day mode filters that day's snapshot.
    const pool = logState.day ? logState.dayEntries : logState.entries;
    const list = pool.filter(logMatchesFilters);
    const shown = logState.day ? list.slice(-3000) : list.slice(-500);
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
    if (logState.day) {
      await loadLogDay(logState.day);
      return;
    }
    const res = await api.logsQuery({ ...logState.filters, limit: 500 });
    if (Array.isArray(res)) logState.entries = res;
    else if (res && Array.isArray(res.entries)) logState.entries = res.entries;
    renderLogEntries();
  }

  // ── Live log: browse a specific day (snapshot of logs/live/YYYY-MM-DD.jsonl) ──
  async function logDayPaths() {
    const res = await api.logsFiles();
    const files = Array.isArray(res) ? res : [];
    const days = [];
    for (const f of files) {
      const m = /(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f.name || "");
      if (m && f.source === "live") days.push({ date: m[1], path: f.path });
    }
    days.sort((a, b) => (a.date < b.date ? 1 : -1));
    return days;
  }

  async function populateLogDaySelect() {
    const sel = $("log-day");
    if (!sel) return;
    try {
      const days = await logDayPaths();
      logState.dayMap = {};
      for (const d of days) logState.dayMap[d.date] = d.path;
      sel.innerHTML =
        '<option value="__live__">🔴 Live (auto)</option>' +
        days.map((d) => `<option value="${escAttr(d.date)}">📅 ${d.date}</option>`).join("");
      sel.value = logState.day || "__live__";
    } catch {
      /* leave dropdown at defaults on failure */
    }
  }

  async function loadLogDay(date) {
    const status = $("log-day-status");
    if (!Object.keys(logState.dayMap).length) await populateLogDaySelect();
    const filePath = logState.dayMap[date];
    if (!filePath) {
      if (status) status.textContent = `⚠️ No unified live log file for ${date}.`;
      logState.dayEntries = [];
      renderLogEntries();
      return;
    }
    const res = await api.logsFile(filePath, 10000);
    const lines = (res && res.ok && res.lines) || [];
    const entries = [];
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        entries.push({
          ts: e.ts,
          source: e.source || "app",
          subSource: e.subSource,
          level: e.level || "info",
          message: e.message || "",
          ...(e.data !== undefined ? { data: e.data } : {}),
        });
      } catch {
        /* skip malformed lines */
      }
    }
    logState.dayPath = filePath;
    logState.dayEntries = entries;
    if (status) status.textContent = `📅 ${date} — ${entries.length} entries (snapshot from logs/live). Filters apply; select 🔴 Live to resume streaming.`;
    renderLogEntries();
  }

  function setLogDay(date) {
    const sel = $("log-day");
    const status = $("log-day-status");
    if (!date || date === "__live__") {
      logState.day = null;
      logState.dayPath = null;
      logState.dayEntries = [];
      if (sel) sel.value = "__live__";
      if (status) status.textContent = "";
      refreshLogs();
      return;
    }
    logState.day = date;
    if (sel) sel.value = date;
    loadLogDay(date);
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
      $("log-pause").innerHTML = logState.paused
        ? iconLabel("play", 13, "Resume")
        : iconLabel("stop", 13, "Pause");
    });
    $("log-clear").addEventListener("click", async () => {
      await api.logsClear();
      logState.entries = [];
      renderLogEntries();
    });
    // Browse a specific day's unified log + refresh the current view.
    $("log-day")?.addEventListener("change", (e) => setLogDay(e.target.value));
    $("log-refresh")?.addEventListener("click", async () => {
      await populateLogDaySelect();
      if (logState.day) await loadLogDay(logState.day);
      else await refreshLogs();
    });
    populateLogDaySelect().catch(() => {}); // fill the date dropdown (best-effort)
    $("logs-sub-live").addEventListener("click", () => {
      $("logs-sub-live").classList.add("active");
      $("logs-sub-files").classList.remove("active");
      $("logs-live").classList.remove("hidden");
      $("logs-files").classList.add("hidden");
    });
    $("logs-sub-files").addEventListener("click", () => {
      $("logs-sub-files").classList.add("active");
      $("logs-sub-live").classList.remove("active");
      $("logs-live").classList.add("hidden");
      $("logs-files").classList.remove("hidden");
      refreshLogFiles();
    });
  }

  function bindLogStream() {
    subscribe("onLogEntry", (entry) => {
      if (logState.paused || logState.day) return; // pause streaming while browsing a day snapshot
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
    $("log-file-view").classList.remove("hidden");
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
  // Webapp visit history, read straight from logs/frontdesk/sessions/*.jsonl. No pkm
  // involvement, so this view keeps working in exactly the states where the Key
  // Manager's writes are refused.
  const SESSIONS_COLS = [
    { key: "ts", label: "Time" },
    { key: "user", label: "User" },
    { key: "action", label: "Action" },
    { key: "ip", label: "IP" },
    { key: "timezone", label: "TZ" },
  ];
  const sessionsState = { rows: [], sort: "ts", dir: -1, query: "" };

  /** Every field a search should match, including the ones not shown as columns. */
  function sessionHaystack(e) {
    return [e.user, e.action, e.ip, e.timezone, e.language, e.userAgent]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }

  function renderSessions() {
    const box = $("sessions-box");
    if (!box) return;
    const needle = sessionsState.query.trim().toLowerCase();
    const rows = sessionsState.rows.filter((e) => !needle || sessionHaystack(e).includes(needle));

    const k = sessionsState.sort;
    const val = (e) => (k === "ts" ? Date.parse(e.ts || "") || 0 : String(e[k] ?? "").toLowerCase());
    const sorted = rows.slice().sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (av === bv) return 0;
      return av < bv ? -sessionsState.dir : sessionsState.dir;
    });

    const count = $("sessions-count");
    if (count) count.textContent = rows.length === sessionsState.rows.length ? String(rows.length) : `${rows.length} of ${sessionsState.rows.length}`;

    if (!sessionsState.rows.length) {
      box.innerHTML = '<div class="empty">No frontdesk sessions yet.</div>';
      return;
    }

    const head = SESSIONS_COLS.map((c) => {
      const active = sessionsState.sort === c.key;
      const arrow = active ? (sessionsState.dir === 1 ? " ▲" : " ▼") : "";
      return `<th><button class="s-sort${active ? " is-active" : ""}" data-ssort="${esc(c.key)}" title="Sort by ${esc(c.label)}">${esc(c.label)}${arrow}</button></th>`;
    }).join("");
    const body = sorted
      .map(
        (e) =>
          `<tr><td>${fmt(e.ts)}</td><td>${esc(e.user || "")}</td><td>${esc(e.action || "")}</td><td>${esc(e.ip || "")}</td><td>${esc(e.timezone || "")}</td></tr>`,
      )
      .join("");
    box.innerHTML =
      `<table><thead><tr>${head}</tr></thead><tbody>${
        body || `<tr><td colspan="${SESSIONS_COLS.length}">No session matches the search.</td></tr>`
      }</tbody></table>`;

    box.querySelectorAll("[data-ssort]").forEach((b) =>
      b.addEventListener("click", () => {
        const key = b.dataset.ssort;
        if (sessionsState.sort === key) sessionsState.dir *= -1;
        else {
          sessionsState.sort = key;
          // Newest-first is the useful default for a time column; A→Z for the rest.
          sessionsState.dir = key === "ts" ? -1 : 1;
        }
        renderSessions();
      }),
    );
  }

  async function refreshSessions() {
    const res = await api.sessions();
    sessionsState.rows = (res.ok && res.entries) || [];
    renderSessions();
  }

  function bindSessions() {
    $("sessions-search")?.addEventListener("input", (e) => {
      sessionsState.query = e.target.value;
      renderSessions();
    });
    $("sessions-refresh")?.addEventListener("click", () => guarded("sessions", refreshSessions));
  }

  // ── Key Manager ──
  // All licensing logic + data live in the sibling personal_key_manager repo; this
  // tab only shells out to `pkm` (via the main process) and renders the result.
  // The store holds an INDEPENDENT ring + seat ledger per consumer app, so every
  // call is scoped to the registry chosen in the toolbar (frontdesk-agent,
  // transcription-agent, …) — the tab is not hardwired to a single one.
  const pkmState = {
    registry: null,
    registries: [],
    entry: null,
    lastError: null,
    // Last capability report from main (key-manager.mjs → capabilities()). Drives
    // every disabled control on this tab: state, reason, and a per-command verdict.
    caps: { state: "unknown", writable: false, reason: null, actions: {}, files: null, paths: null, checkedAt: 0 },
  };
  const expLabel = (r) => (r.exp === 0 ? "unlimited" : r.expUtc ? String(r.expUtc).slice(0, 10) : "—");
  const daysLabel = (r) =>
    r.daysLeft == null ? "—" : r.daysLeft < 0 ? `${r.daysLeft} (past)` : String(r.daysLeft);
  const shortKey = (k) => (k ? (k.length > 18 ? `${k.slice(0, 18)}…` : k) : "—");

  /** Registry id passed to every pkm call (undefined → PKM_REGISTRY in config). */
  const pkmReg = () => pkmState.registry || undefined;
  const pkmLabel = () => pkmState.registry || "the configured registry";

  // ── Capability gate ──
  // personal_key_manager owns every licence, ring and revocation record; this app
  // is only a client of its CLI. `caps` is that store's verdict on what may run,
  // painted in three places: the status-bar pill, the banner at the head of this
  // tab, and the disabled state of every control tagged data-pkm-write.
  //
  // Disabling here is a HINT, not the boundary: main refuses a write BEFORE it
  // spawns anything (COMMANDS + gateFor in electron/src/main/key-manager.mjs), so a
  // bug in this file cannot mint, revoke, retire or re-sign anything the store
  // disallows. Writes live there because that is where the pkm CLI lives — this
  // repo deliberately contains no licence logic.

  /** Pill text + colour per state. `kind` maps to status-pill--<kind>. */
  const GATE_PILL = {
    ready: { text: "keys ✓", kind: "ok" },
    "read-only": { text: "keys read-only", kind: "warn" },
    "blocklist-unreadable": { text: "keys ⚠ revocation off", kind: "bad" },
    "blocklist-missing": { text: "keys ⚠ revocation off", kind: "bad" },
    "store-missing": { text: "keys no store", kind: "bad" },
    "cli-missing": { text: "keys no pkm", kind: "bad" },
    "cli-broken": { text: "keys pkm error", kind: "bad" },
    unknown: { text: "keys …", kind: "" },
  };
  /** Banner headline per state — the pill has room for a few words, this does not. */
  const GATE_TITLE = {
    "read-only": "Key store is read-only",
    "blocklist-unreadable": "Revocation blocklist unreadable",
    "blocklist-missing": "Revocation blocklist missing",
    "store-missing": "Key store not found",
    "cli-missing": "personal_key_manager not found",
    "cli-broken": "pkm is not answering",
  };

  /** Adopt a capabilities payload (from the probe, or from pkm:status). */
  function setCaps(d) {
    if (!d || !d.state) return;
    Object.assign(pkmState.caps, d);
    renderGate();
  }

  /** Paint the pill, the banner, and every tagged write control. */
  function renderGate() {
    const c = pkmState.caps;
    const pill = GATE_PILL[c.state] || GATE_PILL.unknown;
    setStatusText("status-keys", pill.text, pill.kind);
    const pillEl = $("status-keys");
    if (pillEl) pillEl.title = c.reason || `Key store: ${c.state}`;

    const banner = $("pkm-gate");
    if (banner) {
      if (c.state === "ready" || c.state === "unknown") {
        banner.className = "gate-banner hidden";
        banner.innerHTML = "";
      } else {
        const warn = c.state === "read-only";
        banner.className = `gate-banner gate-banner--${warn ? "warn" : "bad"}`;
        // No extra sentence: `reason` already explains this state and what to do
        // about it, and in the read-only state most writes are still available.
        banner.innerHTML =
          `<span class="gate-banner__icon">${window.Icons.svg("warning", 14)}</span>` +
          `<span><b>${esc(GATE_TITLE[c.state] || "Key store unavailable")}</b> — ${esc(c.reason || "")}</span>`;
      }
    }

    // Static buttons (tagged in index.html) and per-row buttons (tagged as the
    // tables re-render) take the same path, so a capability verdict can never
    // disagree between them.
    document.querySelectorAll("[data-pkm-write]").forEach((btn) => {
      const action = btn.dataset.pkmWrite;
      if (btn.dataset.gateTitle === undefined) btn.dataset.gateTitle = btn.title || "";
      const verdict = (c.actions || {})[action];
      const ok = c.writable && (!verdict || verdict.ok);
      btn.disabled = !ok;
      btn.classList.toggle("is-gated", !ok);
      const why = !c.writable ? c.reason : verdict && !verdict.ok ? verdict.reason : "";
      btn.title = ok ? btn.dataset.gateTitle : why || "Unavailable";
    });
  }

  /**
   * Probe the store.
   *
   * `fresh` bypasses main's cached CLI liveness check — used by Re-check and after
   * a PKM_* config change, both of which expect a real answer rather than a verdict
   * up to a minute old.
   */
  async function loadCaps({ fresh = false } = {}) {
    try {
      const res = fresh ? await api.pkmCapabilities(pkmReg()) : await api.pkmStatus(pkmReg());
      setCaps(res && res.data && res.data.capabilities);
    } catch (err) {
      reportError(err, "key store probe");
    }
    return pkmState.caps;
  }

  /**
   * Guard a mutation against the gate before calling it.
   *
   * Belt and braces over main's refusal: this turns an unavailable action into a
   * sentence in the UI instead of an error string from a refused spawn.
   * @returns {boolean} true when the caller should stop.
   */
  function gatedWrite(action) {
    const c = pkmState.caps;
    const verdict = (c.actions || {})[action];
    if (verdict && !verdict.ok) {
      toast(`⚠️ ${verdict.reason}`, "err");
      return true;
    }
    if (!c.writable) {
      toast(`⚠️ Key store is read-only — ${c.reason || "unavailable"}`, "err");
      return true;
    }
    return false;
  }

  /** Populate the registry picker from the store, keeping the current selection. */
  function renderPkmRegistryPicker(d) {
    const sel = $("pkm-registry");
    const rows = d.registries || [];
    pkmState.registries = rows;
    const ids = rows.map((r) => r.id);
    const prev = pkmState.registry;
    const chosen = [prev, d.registry].find((x) => x && ids.includes(x)) || ids[0] || null;
    pkmState.registry = chosen;
    pkmState.entry = rows.find((r) => r.id === chosen) || null;
    if (sel) {
      sel.innerHTML = ids.length
        ? rows
            .map(
              (r) =>
                `<option value="${escAttr(r.id)}"${r.id === chosen ? " selected" : ""}>${esc(r.id)} — ${r.seats ?? 0} seat(s), ${r.rings ?? 0} ring(s)</option>`,
            )
            .join("")
        : `<option value="">(no registries in store)</option>`;
      sel.disabled = ids.length === 0;
    }
    const meta = $("pkm-registry-meta");
    const e = pkmState.entry;
    if (meta) {
      const targets = Object.keys(e?.verifierTargets || {});
      // Where the blocklist comes from is the wrong thing to advertise when it is
      // unreadable — that is the state this whole tab is warning about.
      const bl = (pkmState.caps.files || {}).blocklist;
      const blNote =
        bl === "unreadable"
          ? ' · <b class="gate-inline">⚠ blocklist UNREADABLE</b>'
          : bl === "missing"
            ? ' · <b class="gate-inline">⚠ blocklist MISSING</b>'
            : targets.length
              ? ` · <b>blocklist embedded</b> (${esc(targets.join(", "))})`
              : " · blocklist read live";
      meta.innerHTML = e
        ? `app <b>${esc(e.app)}</b> · engine ${esc(e.engine)} · ${e.rings} ring(s) · ${e.seats} seat(s) · ${e.revoked} revoked` + blNote
        : "";
    }
  }

  /** Explain what the ring buttons do for THIS registry (engine/verifier dependent). */
  function renderPkmRingsHint() {
    const el = $("pkm-rings-hint");
    if (!el) return;
    const e = pkmState.entry || {};
    const hasAgent = e.engine === "ed25519+x25519";
    const targets = Object.keys(e.verifierTargets || {});
    el.innerHTML =
      (hasAgent
        ? "This registry is <b>ed25519+x25519</b> — its seats carry an X25519 key for E2E chat, so 🔑 Agent key regenerates that peer keypair (then update <code>FRONTDESK_AGENT_PUBKEY</code>). "
        : "This registry is <b>ed25519</b> — it has no agent (peer) keypair, so 🔑 Agent key does not apply. ") +
      (targets.length
        ? `It <b>embeds its blocklist</b> in ${esc(targets.join(", "))} — after revoking a seat, run 🔄 Sync blocklist and rebuild that app.`
        : "It reads its blocklist <b>live</b> on every verify, so a revoke needs no sync step.");
  }

  async function refreshPkmStatus(retry) {
    const badge = $("pkm-badge");
    const host = $("pkm-host");
    pkmState.lastError = null;
    // A rejected invoke must be handled exactly like a returned {ok:false} —
    // otherwise the header keeps stale numbers from the previous load.
    let res;
    try {
      res = await api.pkmStatus(pkmReg());
    } catch (err) {
      res = { ok: false, error: (err && err.message) || "pkm status failed" };
    }
    // The gate verdict rides on this payload (main probes once and reports it), so
    // the status line and the controls below can never disagree with each other.
    setCaps(res.data && res.data.capabilities);
    if (!res.ok) {
      pkmState.lastError = res.error;
      badge.className = "badge down";
      badge.textContent = "error";
      host.innerHTML = "";
      panelError("pkm-host", res.error, retry);
      return false;
    }
    const d = res.data || {};
    if (!d.present) {
      pkmState.lastError = `pkm not found at ${d.pkmBin} — set PKM_REPO in ⚙️ Config.`;
      badge.className = "badge down";
      badge.textContent = "pkm missing";
      host.innerHTML =
        `<div class="empty">pkm not found at <code>${esc(d.pkmBin)}</code>.<br/>` +
        `Locate the <b>personal_key_manager</b> repo, or set <code>PKM_REPO</code> in ⚙️ Config.</div>`;
      return false;
    }
    renderPkmRegistryPicker(d);
    const e = pkmState.entry;
    const c = pkmState.caps;
    // The header badge is the gate's headline when the store is not ready: "42 seats"
    // is misleading while revocation is not being enforced.
    if (c.state !== "ready" && c.state !== "unknown") {
      badge.className = c.state === "read-only" ? "badge" : "badge down";
      badge.textContent = (GATE_PILL[c.state] || GATE_PILL.unknown).text.replace("keys ", "");
    } else {
      badge.className = e ? "badge ok" : "badge down";
      badge.textContent = e ? `${e.seats} seats · ${e.defaultKid || "no ring"}` : "no registry";
    }
    host.innerHTML =
      `<div class="svc-note">📦 <code>${esc(d.storeRoot)}</code> — registry <b>${esc(pkmLabel())}</b>` +
      (e ? ` · engine ${esc(e.engine)} · ${e.rings} ring(s) · ${e.revoked} revoked` : "") +
      (d.loosePermissions
        ? ` · <b>⚠ ${d.loosePermissions} loose key path(s)</b> <button id="pkm-perms-fix" data-pkm-write="permsFix" title="Tighten group/other-accessible files under the key store (pkm perms --fix)">Fix</button>`
        : "") +
      (d.authorityPublicKey ? ` · bundle signer <code>${esc(shortKey(d.authorityPublicKey))}</code>` : "") +
      ` · timeout ${Math.round((d.timeoutMs || 20000) / 1000)}s` +
      `</div>`;
    $("pkm-perms-fix")?.addEventListener("click", fixPerms);
    renderGate();
    return true;
  }

  async function refreshPkmRings(retry) {
    panelLoading("pkm-rings-box", "Loading rings…");
    const res = await api.pkmRings(pkmReg());
    if (!res.ok) {
      panelError("pkm-rings-box", res.error, retry);
      return false;
    }
    const d = res.data || {};
    const rings = d.rings || [];
    renderPkmRingsHint();
    const box = $("pkm-rings-box");
    if (!rings.length) {
      box.innerHTML = '<div class="empty">No rings in this registry yet — create one with ＋ New ring.</div>';
      return true;
    }
    const body = rings
      .map((r) => {
        const retired = r.notAfter && Date.now() >= r.notAfter * 1000;
        const na = r.notAfter ? new Date(r.notAfter * 1000).toISOString().slice(0, 10) : "—";
        const isDefault = r.kid === d.defaultKid;
        return (
          `<tr><td>${esc(r.kid)}</td>` +
          `<td>${isDefault ? '<span class="tag valid">default</span>' : `<button data-ringdefault="${escAttr(r.kid)}" data-pkm-write="setDefault">Make default</button>`}</td>` +
          `<td><code title="${escAttr(r.publicKey || "")}">${esc(shortKey(r.publicKey))}</code></td>` +
          `<td>${esc(na)}${retired ? ' <span class="tag revoked">retired</span>' : ""}</td>` +
          `<td>${retired ? "" : `<button data-ringretire="${escAttr(r.kid)}" data-pkm-write="ringRetire">Retire</button>`}</td></tr>`
        );
      })
      .join("");
    box.innerHTML =
      `<table><thead><tr><th>kid</th><th>Default</th><th>Public key</th><th>Retires</th><th></th></tr></thead><tbody>${body}</tbody></table>`;
    box.querySelectorAll("[data-ringretire]").forEach((b) =>
      b.addEventListener("click", () => retireRing(b.dataset.ringretire)),
    );
    box.querySelectorAll("[data-ringdefault]").forEach((b) =>
      b.addEventListener("click", () => makeRingDefault(b.dataset.ringdefault)),
    );
    renderGate();
    return true;
  }

  async function refreshPkmSeats(retry) {
    panelLoading("pkm-seats-box", "Loading seats…");
    const res = await api.pkmList(pkmReg());
    const box = $("pkm-seats-box");
    if (!res.ok) {
      panelError("pkm-seats-box", res.error, retry);
      return false;
    }
    const rows = (res.data.rows || []).slice().sort((a, b) => String(a.sub).localeCompare(String(b.sub)));
    if (!rows.length) {
      box.innerHTML = '<div class="empty">No seats issued yet in this registry.</div>';
      return true;
    }
    const counts = res.data.counts || {};
    const body = rows
      .map((r) => {
        const action =
          r.status === "revoked"
            ? `<button data-unrevoke="${escAttr(r.sub)}" data-pkm-write="unrevoke">Unrevoke</button>`
            : `<button data-revoke="${escAttr(r.sub)}" data-pkm-write="revoke">Revoke</button>`;
        return `<tr><td>${esc(r.sub)}</td><td><span class="tag ${escAttr(r.status)}">${esc(r.status)}</span></td><td>${esc(r.kid || "—")}</td><td>${esc(expLabel(r))}</td><td>${esc(daysLabel(r))}</td><td>${r.enc ? "yes" : "no"}</td><td>${esc(String(r.issuedAt || "").slice(0, 10))}</td><td>${action}</td></tr>`;
      })
      .join("");
    box.innerHTML =
      `<table><thead><tr><th>Seat</th><th>Status</th><th>kid</th><th>Expires</th><th>Days</th><th>Enc</th><th>Issued</th><th></th></tr></thead><tbody>${body}</tbody></table>` +
      `<p class="hint">${rows.length} seat(s): ${counts.valid || 0} valid, ${counts.expiring || 0} expiring, ${counts.expired || 0} expired, ${counts.revoked || 0} revoked` +
      (res.data.archived ? ` · ${res.data.archived} expired record(s) archived by this refresh` : "") +
      `</p>`;
    box.querySelectorAll("[data-revoke]").forEach((b) => b.addEventListener("click", () => revokeSeat(b.dataset.revoke)));
    box.querySelectorAll("[data-unrevoke]").forEach((b) => b.addEventListener("click", () => unrevokeSeat(b.dataset.unrevoke)));
    renderGate();
    return true;
  }

  // ── Claims (identity bound to a key) ────────────────────────────────────────
  //
  // A claim lives in TWO places on purpose: the SIGNED cert (what a consumer app
  // enforces) and the ledger record (what the next re-sign reads). They can
  // diverge silently, and only the cert is enforced — which is why every render
  // here shows both copies side by side and marks the rows they disagree on.
  //
  // Only a resign touches the cert, and a resign CHANGES THE LICENCE STRING: pkm
  // hands back the replacement as `resigned.licenseKey`, so it goes straight into
  // the display-once modal and must be passed to the seat owner.
  //
  // A `pwdv` is a scrypt VERIFIER, not a password. Revealing one is a deliberate,
  // display-once action: unlike a password it is offline-crackable by whoever
  // holds it, so it is never rendered into the panel itself.
  let claimsSub = null;

  /** One "label: value" row; `diff` marks a claim the two copies disagree on. */
  function claimsRow(label, value, diff) {
    const empty = value === null || value === undefined || value === "";
    return `<div class="pkm-claims__row${diff ? " pkm-claims__row--diff" : ""}"><b>${esc(label)}:</b> ${empty ? "—" : esc(String(value))}</div>`;
  }

  function setClaimsMsg(text, kind) {
    const el = $("pkm-claims-msg");
    if (!el) return;
    el.className = kind ? `config-msg ${kind}` : "pkm-meta";
    el.textContent = text || "";
  }

  function claimsSeat() {
    return ($("pkm-claims-seat")?.value || "").trim();
  }

  /** The drift state → the badge class that already means it. */
  const CLAIM_STATE_TAG = {
    "in-sync": "valid",
    "ledger-only": "expired",
    "cert-only": "expired",
    mismatch: "revoked",
    "no-cert": "expired",
  };

  function renderClaimsBox(d) {
    const box = $("pkm-claims-box");
    if (!box) return;
    const cert = d.cert || {};
    const ledger = d.ledger || {};
    const diffEmail = (cert.email || null) !== (ledger.email || null);
    const diffPassword = Boolean(cert.hasPassword) !== Boolean(ledger.hasPassword);
    const tag = CLAIM_STATE_TAG[d.state] || "expired";

    box.innerHTML = `
      <div class="pkm-claims">
        <div class="pkm-claims__head">
          <span class="pkm-claims__title">${esc(d.sub || "")}</span>
          <span class="tag ${tag}">${esc(d.state || "unknown")}</span>
          <span class="pkm-claims__meta">ring ${esc(d.kid || "—")} · record ${esc(d.kind || "—")} · resigns ${Number(d.resignCount) || 0}</span>
        </div>
        <div class="pkm-claims__grid">
          <div class="pkm-claims__col">
            <div class="pkm-claims__col-label">Signed cert — what an app enforces</div>
            ${claimsRow("email", cert.email, diffEmail)}
            ${claimsRow("password", cert.hasPassword ? "verifier set" : "", diffPassword)}
          </div>
          <div class="pkm-claims__col">
            <div class="pkm-claims__col-label">Ledger record — what the next resign reads</div>
            ${claimsRow("email", ledger.email, diffEmail)}
            ${claimsRow("password", ledger.hasPassword ? "verifier set" : "", diffPassword)}
          </div>
        </div>
        <div class="pkm-claims__form">
          <div class="pkm-claims__field">
            <label class="cfg-label" for="pkm-claims-email">Email to set</label>
            <input id="pkm-claims-email" type="text" placeholder="blank = leave unchanged" spellcheck="false" />
          </div>
          <div class="pkm-claims__field">
            <label class="cfg-label" for="pkm-claims-password">Password to set</label>
            <input id="pkm-claims-password" type="password" placeholder="blank = leave unchanged" spellcheck="false" />
          </div>
          <div class="pkm-claims__actions">
            <button data-claimset="ledger" data-pkm-write="claimsSet" title="Write these claims to the LEDGER only — the cert keeps what it has until a resign">Apply to ledger</button>
            <button data-claimset="resign" class="primary" data-pkm-write="claimsSet" title="Write the claims AND re-sign the cert. This changes the licence string, so the seat owner must be handed the replacement">Apply + resign</button>
            <button data-claimclear="email" data-pkm-write="claimsSet" title="Remove the email claim (ledger only, like any set)">Clear email</button>
            <button data-claimclear="password" data-pkm-write="claimsSet" title="Remove the password verifier (ledger only)">Clear password</button>
            <button data-claimresign data-pkm-write="claimsResign" title="Push the claims already in the ledger into the cert, without changing them">Push ledger → cert</button>
            <button data-claimreveal title="Show the scrypt VERIFIER pkm stores — the string Dev Centre's admin list accepts in place of a plaintext secret. Display-once: a verifier is offline-crackable">Reveal verifier</button>
          </div>
        </div>
        <p class="pkm-claims__meta">licence file: ${esc(d.keyPath || "—")}</p>
      </div>`;

    box.querySelectorAll("[data-claimset]").forEach((btn) =>
      btn.addEventListener("click", () => guarded("claims", () => applyClaims({ resign: btn.dataset.claimset === "resign" }))),
    );
    box.querySelectorAll("[data-claimclear]").forEach((btn) =>
      btn.addEventListener("click", () => guarded("claims", () => applyClaims({ clear: btn.dataset.claimclear }))),
    );
    box.querySelector("[data-claimresign]")?.addEventListener("click", () => guarded("claims", pushClaimsToCert));
    box.querySelector("[data-claimreveal]")?.addEventListener("click", () => guarded("claims", revealVerifier));

    // The per-seat buttons were just created, so the gate has to re-paint them.
    renderGate();
  }

  async function showClaims(seat) {
    const sub = (seat || claimsSeat()).trim();
    if (!sub) {
      setClaimsMsg("Enter a seat id (the sub — usually its email).", "err");
      return;
    }
    claimsSub = sub;
    panelLoading("pkm-claims-box", "Loading claims…");
    const res = await api.pkmClaimsShow(pkmReg(), sub);
    if (!res || !res.ok) {
      setClaimsMsg("", null);
      panelError("pkm-claims-box", (res && res.error) || "Could not read this seat's claims", () => showClaims(sub));
      return;
    }
    setClaimsMsg("", null);
    renderClaimsBox(res.data || {});
  }

  /**
   * Write the two form fields. A blank field means "leave this claim alone",
   * mirroring pkm's own flags, and a filled one always overwrites.
   */
  async function applyClaims({ resign = false, clear = "" } = {}) {
    const sub = claimsSub || claimsSeat();
    if (!sub) {
      toast("Pick a seat first.", "err");
      return;
    }
    if (gatedWrite("claimsSet")) return;

    const email = ($("pkm-claims-email")?.value || "").trim();
    const password = $("pkm-claims-password")?.value || "";
    if (!clear && !email && !password) {
      setClaimsMsg("Enter an email or a password, or use a Clear button.", "err");
      return;
    }

    const patch = clear
      ? { clear }
      : { ...(email ? { email } : {}), ...(password ? { password } : {}), ...(resign ? { resign: true } : {}) };

    setClaimsMsg("Working…", null);
    const res = await api.pkmClaimsSet(pkmReg(), sub, patch);
    // Never leave a typed password sitting in the DOM.
    const pw = $("pkm-claims-password");
    if (pw) pw.value = "";

    if (!res || !res.ok) {
      setClaimsMsg((res && res.error) || "pkm refused the change", "err");
      toast(`⚠️ ${(res && res.error) || "claims set failed"}`, "err");
      return;
    }

    const d = res.data || {};
    const replacement = d.resigned && d.resigned.licenseKey;
    if (replacement) showLicenseModal(replacement, sub, "Re-signed");
    setClaimsMsg(
      d.changed
        ? replacement
          ? "Claims set and the cert re-signed — hand the seat owner the new licence."
          : "Claims written to the ledger. Resign to push them into the cert."
        : `Nothing changed${d.resigned && d.resigned.reason ? ` — ${d.resigned.reason}` : ""}.`,
      d.changed ? "ok" : null,
    );
    guarded("claims", () => showClaims(sub));
  }

  async function pushClaimsToCert() {
    const sub = claimsSub || claimsSeat();
    if (!sub) return;
    if (gatedWrite("claimsResign")) return;

    setClaimsMsg("Re-signing…", null);
    const res = await api.pkmClaimsResign(pkmReg(), sub);
    if (!res || !res.ok) {
      setClaimsMsg((res && res.error) || "pkm refused the resign", "err");
      return;
    }
    const d = res.data || {};
    const replacement = d.resigned && d.resigned.licenseKey;
    if (replacement) showLicenseModal(replacement, sub, "Re-signed");
    setClaimsMsg(
      d.changed
        ? "Cert re-signed — hand the seat owner the new licence."
        : `Nothing to do${d.resigned && d.resigned.reason ? ` — ${d.resigned.reason}` : ""}.`,
      d.changed ? "ok" : null,
    );
    guarded("claims", () => showClaims(sub));
  }

  /**
   * Reveal the stored `pwdv`. NOT gated: reading a claim cannot corrupt the store,
   * which is the same rule the Verify row follows.
   */
  async function revealVerifier() {
    const sub = claimsSub || claimsSeat();
    if (!sub) return;
    const res = await api.pkmClaimsShow(pkmReg(), sub, true);
    if (!res || !res.ok) {
      setClaimsMsg((res && res.error) || "Could not read the verifier", "err");
      return;
    }
    const pwdv = (res.data?.cert || {}).pwdv || (res.data?.ledger || {}).pwdv;
    if (!pwdv) {
      setClaimsMsg("This seat stores no password verifier, so it has no password.", "err");
      return;
    }
    showLicenseModal(pwdv, sub, "Password verifier");
  }

  /** Retro-fit email claims from seat ids. Ledger-only, so nothing is re-signed. */
  async function backfillClaims(dryRun) {
    if (gatedWrite("claimsBackfill")) return;
    setClaimsMsg("Working…", null);
    const res = await api.pkmClaimsBackfill(pkmReg(), { emailFromSub: true, dryRun });
    if (!res || !res.ok) {
      setClaimsMsg((res && res.error) || "pkm refused the backfill", "err");
      return;
    }
    const d = res.data || {};
    const changed = Number(d.changed) || 0;
    setClaimsMsg(
      `${dryRun ? "Dry run — " : ""}${changed} to change, ${Number(d.skipped) || 0} skipped${changed ? "" : " (every seat already has an email)"}.`,
      changed && !dryRun ? "ok" : null,
    );
    if (!dryRun) {
      toast("Ledger claims backfilled.", "ok");
      if (claimsSub) guarded("claims", () => showClaims(claimsSub));
    }
  }

  /** The cert↔ledger drift canary, reported into the shared Verify output line. */
  async function checkClaimsDrift() {
    const out = $("pkm-checks-out");
    out.className = "pkm-checks__out";
    out.textContent = "Checking claims…";
    const res = await api.pkmClaimsVerify(pkmReg());
    if (!res || !res.ok) {
      out.className = "pkm-checks__out pkm-checks__out--warn";
      out.textContent = (res && res.error) || "claims verify failed";
      return;
    }
    const reports = (res.data && res.data.reports) || [];
    const rows = reports.flatMap((r) => r.rows || []);
    const drifted = reports.reduce((n, r) => n + (Number(r.drifted) || 0), 0);
    const out2 = rows.filter((r) => r.state && r.state !== "in-sync" && r.state !== "no-cert");
    if (out2.length || drifted) {
      out.className = "pkm-checks__out pkm-checks__out--warn";
      out.textContent = `${out2.length} seat(s) with a cert that differs from the ledger — ${out2
        .slice(0, 3)
        .map((r) => `${r.sub} (${r.state})`)
        .join(", ")}${out2.length > 3 ? "…" : ""}. Resign each seat to push the ledger claims into its cert.`;
      return;
    }
    out.className = "pkm-checks__out pkm-checks__out--ok";
    out.textContent = `Claims in sync for ${rows.length} seat(s) — every cert matches its ledger record.`;
  }

  /** The login check, offline: does this email + password actually work for this key? */
  async function testCreds() {
    const key = ($("pkm-creds-key")?.value || "").trim();
    const email = ($("pkm-creds-email")?.value || "").trim();
    const password = $("pkm-creds-password")?.value || "";
    const msg = $("pkm-creds-msg");

    if (!key || !password) {
      msg.className = "config-msg err";
      msg.textContent = "A licence key and a password are both required.";
      return;
    }
    msg.className = "config-msg";
    msg.textContent = "Testing…";

    const res = await api.pkmCredsTest(pkmReg(), key, email, password);
    const pw = $("pkm-creds-password");
    if (pw) pw.value = "";

    if (!res || !res.ok) {
      msg.className = "config-msg err";
      msg.textContent = (res && res.error) || "pkm refused the test";
      return;
    }
    const d = res.data || {};
    const REASONS = {
      ok: "Credentials work — this key logs in with that email and password.",
      password_mismatch: "The password does not match the verifier on this key.",
      email_mismatch: "The email does not match this key's `email` claim (a key with no claim always reports this).",
      revoked_seat: "That seat is REVOKED — the key is refused before the signature is even examined.",
      malformed: "That is not a well-formed TA1 licence key.",
    };
    msg.className = d.ok ? "config-msg ok" : "config-msg err";
    msg.textContent = REASONS[d.reason] || `pkm reported: ${d.reason}`;
  }

  /**
   * Load the whole tab. Every failure path paints a Retry-able error box, so the
   * panels can never be left showing their initial "loading…" placeholder.
   */
  async function refreshLicenses(retry) {
    const again = typeof retry === "function" ? retry : () => refreshLicenses();
    panelLoading("pkm-seats-box", "Loading seats…");
    panelLoading("pkm-rings-box", "Loading rings…");
    try {
      const ok = await refreshPkmStatus(again);
      if (!ok) {
        const msg = pkmState.lastError || "Key store unavailable";
        panelError("pkm-seats-box", msg, again);
        panelError("pkm-rings-box", msg, again);
        return;
      }
      await refreshPkmRings(again);
      await refreshPkmSeats(again);
    } catch (err) {
      reportError(err, "Key Manager");
      const badge = $("pkm-badge");
      if (badge) {
        badge.className = "badge down";
        badge.textContent = "error";
      }
      panelError("pkm-host", err, again);
      panelError("pkm-seats-box", err, again);
      panelError("pkm-rings-box", err, again);
      rescueStuckPanels(err, again);
    }
  }

  // ── Copy-once secret modal ──
  // pkm returns these exactly once and each one embeds secret material: an issued
  // licence (the seat's private seeds), a `resigned.licenseKey` replacement, or a
  // `pwdv` scrypt verifier (never the password, but offline-crackable). It lives
  // only in this textarea and is cleared the moment the modal closes.
  function showLicenseModal(licenseKey, sub, label = "Issued") {
    $("pkm-modal-key").value = licenseKey;
    const msg = $("pkm-modal-msg");
    msg.className = "config-msg ok";
    msg.textContent = `${label} for ${sub}.`;
    $("pkm-modal").classList.remove("hidden");
    const ta = $("pkm-modal-key");
    ta.focus();
    ta.select();
  }

  function hideLicenseModal() {
    $("pkm-modal-key").value = "";
    $("pkm-modal-msg").textContent = "";
    $("pkm-modal").classList.add("hidden");
  }

  async function copyLicense() {
    const ta = $("pkm-modal-key");
    const msg = $("pkm-modal-msg");
    ta.focus();
    ta.select();
    let done = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(ta.value);
        done = true;
      }
    } catch {
      /* fall through to execCommand */
    }
    if (!done) {
      try {
        done = document.execCommand("copy");
      } catch {
        done = false;
      }
    }
    msg.className = done ? "config-msg ok" : "config-msg err";
    msg.textContent = done ? "Copied to clipboard." : "Press ⌘C to copy the selected text.";
  }

  // ── Issue / revoke / unrevoke ──
  // Every pkm mutation runs behind the blocking overlay: the CLI spawns a
  // process, rewrites export/*.json, and can legitimately take a few seconds.
  async function issueSeat() {
    const msg = $("pkm-issue-msg");
    const sub = $("pkm-issue-sub").value.trim();
    const exp = $("pkm-issue-exp").value.trim();
    if (!sub) {
      msg.className = "config-msg err";
      msg.textContent = "Seat id is required.";
      return;
    }
    if (!exp) {
      msg.className = "config-msg err";
      msg.textContent = 'Expiry is required — a date like 2027-12-31, or "unlimited".';
      return;
    }
    if (gatedWrite("issue")) return;

    // ── The two guards pkm itself does not apply ──
    // 1. A seat already on the blocklist: `issue` would happily sign a licence that
    //    `loadRevokedSeats()` then refuses (`revoked_seat`), so the operator would get
    //    a display-once key that can never log in. Main refuses this too.
    // 2. An existing seat: re-issuing mints a NEW keypair and overwrites the stored
    //    licence file, orphaning anything already encrypted under the old one. The
    //    revoke dialog says so; the issue dialog used to say nothing.
    const info = await api.pkmSeatInfo(pkmReg(), sub);
    const row = info && info.ok && info.data ? info.data.row : null;
    if (row && (row.revoked === true || row.status === "revoked")) {
      msg.className = "config-msg err";
      msg.textContent = `"${sub}" is on the revocation blocklist, so a new licence would be refused at login. Reinstate it first (Unrevoke).`;
      return;
    }
    if (row) {
      const exp0 = row.exp === 0 ? "unlimited" : String(row.expUtc || "").slice(0, 10);
      if (
        !window.confirm(
          `"${sub}" already has a licence (${row.status}, expires ${exp0}).\n\n` +
            "Re-issuing mints a new keypair and overwrites the stored licence file, so the old key stops " +
            "working and anything encrypted under it becomes unreadable. Continue?",
        )
      )
        return;
    }

    msg.className = "config-msg";
    msg.textContent = "Issuing…";
    const res = await withLoading(`Issuing a licence for ${sub} in ${pkmLabel()}…`, () => api.pkmIssue(pkmReg(), sub, exp), {
      context: "pkm issue",
      slowHint: "pkm is signing the seat certificate…",
    });
    if (!res || !res.ok) {
      msg.className = "config-msg err";
      msg.textContent = (res && res.error) || "Issue failed";
      return;
    }
    const key = (res.data && res.data.licenseKey) || "";
    $("pkm-issue-sub").value = "";
    $("pkm-issue-exp").value = "";
    $("pkm-issue-form").classList.add("hidden");
    msg.textContent = "";
    if (key) showLicenseModal(key, res.data.sub);
    refreshLicenses();
  }

  async function revokeSeat(sub) {
    if (gatedWrite("revoke")) return;
    const reason = await askText({
      title: `Revoke "${sub}"?`,
      label: "Reason (optional)",
      desc: `Blocks the seat in ${pkmLabel()} immediately — live, no restart. Any config stored under its key becomes unreadable. Cancel aborts.`,
      placeholder: "e.g. offboarded / refunded",
    });
    if (reason === null) return;
    const res = await withLoading(`Revoking ${sub}…`, () => api.pkmRevoke(pkmReg(), sub, reason), { context: "pkm revoke" });
    if (!res) return;
    if (!res.ok) {
      toast(`⚠️ Revoke failed: ${res.error}`, "err");
      return;
    }
    toast((res.data && res.data.message) || `Revoked ${sub}.`, "ok");
    // Registries that embed their blocklist need a sync + rebuild for the revoke
    // to apply offline — say so rather than letting it look finished.
    if (Object.keys(pkmState.entry?.verifierTargets || {}).length) {
      toast(`Revoked ${sub} — this registry embeds its blocklist: run 🔄 Sync blocklist, then rebuild the app.`, "err");
    }
    refreshLicenses();
  }

  async function unrevokeSeat(sub) {
    if (gatedWrite("unrevoke")) return;
    if (!window.confirm(`Reinstate "${sub}" in ${pkmLabel()}?`)) return;
    const res = await withLoading(`Reinstating ${sub}…`, () => api.pkmUnrevoke(pkmReg(), sub), { context: "pkm unrevoke" });
    if (!res) return;
    if (!res.ok) {
      toast(`⚠️ Unrevoke failed: ${res.error}`, "err");
      return;
    }
    toast((res.data && res.data.message) || `Reinstated ${sub}.`, "ok");
    refreshLicenses();
  }

  async function archiveExpiredSeats() {
    if (gatedWrite("archive")) return;
    if (
      !window.confirm(
        `Move already-expired seat records in ${pkmLabel()} into its expired/ ledger?\n\nThis archives records whose expiry has already passed — it never revokes anything.`,
      )
    )
      return;
    const res = await withLoading("Archiving expired seat records…", () => api.pkmArchive(pkmReg()), {
      context: "pkm archive",
    });
    if (!res) return;
    if (!res.ok) {
      toast(`⚠️ Archive failed: ${res.error}`, "err");
      return;
    }
    toast(`Archived ${(res.data && res.data.archived) || 0} record(s).`, "ok");
    refreshLicenses();
  }

  // Check an arbitrary licence string against the live ring + blocklist. Useful for
  // confirming a key before handing it out, or diagnosing a rejected login.
  async function validateLicense() {
    const entered = await askText({
      title: "Validate a licence",
      label: "Licence key",
      desc: `Checked against the live ring and revocation blocklist of ${pkmLabel()}. The key is not stored or logged.`,
      placeholder: "TA1…",
    });
    if (entered === null || !entered.trim()) return;
    const res = await withLoading("Validating the licence…", () => api.pkmValidate(pkmReg(), entered.trim()), {
      context: "pkm validate",
    });
    if (!res) return;
    if (!res.ok) {
      toast(`⚠️ Validation failed: ${res.error}`, "err");
      return;
    }
    const d = res.data || {};
    if (d.ok) {
      const c = d.claims || {};
      const exp = c.exp ? new Date(c.exp * 1000).toISOString().slice(0, 10) : "unlimited";
      window.alert(`✅ Valid licence\n\nseat   ${c.sub}\nkid    ${c.kid}\nexp    ${exp}\nenc    ${c.enc ? "ready" : "missing"}`);
    } else {
      window.alert(
        `❌ Rejected: ${d.reason || "unknown reason"}\n\nRevocation is checked before the signature, so "revoked_seat" always means blocked.`,
      );
    }
  }

  async function loadAudit() {
    const box = $("pkm-audit-box");
    const again = () => loadAudit();
    panelLoading("pkm-audit-box", `Loading ${pkmLabel()} audit log…`);
    const res = await api.pkmAudit(pkmReg());
    if (!res.ok) {
      panelError("pkm-audit-box", res.error, again);
      return;
    }
    const entries = (res.data.entries || []).slice().reverse();
    if (!entries.length) {
      box.innerHTML = '<div class="empty">No audit entries yet.</div>';
      return;
    }
    box.innerHTML =
      `<table><thead><tr><th>When</th><th>Action</th><th>Seat</th><th>kid</th><th>Detail</th></tr></thead><tbody>${entries
        .map((e) => `<tr><td>${esc(fmt(e.ts))}</td><td>${esc(e.action || "")}</td><td>${esc(e.sub || "")}</td><td>${esc(e.kid || "")}</td><td>${esc(e.detail || "")}</td></tr>`)
        .join("")}</tbody></table>`;
  }

  // ── Rings (master keys) ──
  async function createRing() {
    if (gatedWrite("ringCreate")) return;
    const kid = await askText({
      title: `New master ring in ${pkmLabel()}`,
      label: "kid (ring id)",
      desc: "Generates a new Ed25519 master keypair. Its private half is written 0600 in the key store and never leaves this machine. New seats are signed by the registry's default ring.",
      placeholder: "mk-2026-09",
    });
    if (kid === null || !kid.trim()) return;
    const res = await withLoading(`Creating ring ${kid.trim()}…`, () => api.pkmRingCreate(pkmReg(), kid.trim()), {
      context: "pkm ring create",
      slowHint: "Generating the master keypair…",
    });
    if (!res) return;
    if (!res.ok) {
      toast(`⚠️ Ring create failed: ${res.error}`, "err");
      return;
    }
    toast((res.data && res.data.message) || `Ring ${kid.trim()} created.`, "ok");
    refreshLicenses();
  }

  async function retireRing(kid) {
    if (gatedWrite("ringRetire")) return;
    const at = await askText({
      title: `Retire ring "${kid}"?`,
      label: "Retire at (a date, or “now”)",
      desc: "Verifiers start rejecting licences signed by this ring from that moment. Seats signed by another ring are unaffected. Cancel aborts.",
      value: "now",
      placeholder: "now — or 2027-01-01",
    });
    if (at === null) return;
    const res = await withLoading(`Retiring ring ${kid}…`, () => api.pkmRingRetire(pkmReg(), kid, at.trim() || "now"), {
      context: "pkm ring retire",
    });
    if (!res) return;
    if (!res.ok) {
      toast(`⚠️ Retire failed: ${res.error}`, "err");
      return;
    }
    toast((res.data && res.data.message) || `Ring ${kid} retired.`, "err");
    refreshLicenses();
  }

  async function makeRingDefault(kid) {
    if (gatedWrite("setDefault")) return;
    if (!window.confirm(`Sign all NEW seats in ${pkmLabel()} with ring "${kid}"?\n\nExisting seats keep the ring that signed them.`)) return;
    const res = await withLoading(`Switching the default ring to ${kid}…`, () => api.pkmSetDefaultKid(pkmReg(), kid), {
      context: "pkm set-default",
    });
    if (!res) return;
    if (!res.ok) {
      toast(`⚠️ Could not set the default ring: ${res.error}`, "err");
      return;
    }
    toast((res.data && res.data.message) || `Default ring is now ${kid}.`, "ok");
    refreshLicenses();
  }

  async function rotateAgentKey() {
    if (gatedWrite("agentKey")) return;
    if (
      !window.confirm(
        `Regenerate the X25519 agent keypair for ${pkmLabel()}?\n\n` +
          "This is the peer key the webapp encrypts to. Existing webapp sessions stop decrypting until you copy the new public key into FRONTDESK_AGENT_PUBKEY (⚙️ Config) and restart the webhook server.",
      )
    )
      return;
    const res = await withLoading("Generating a new agent keypair…", () => api.pkmAgentKey(pkmReg()), {
      context: "pkm ring agent-key",
    });
    if (!res) return;
    if (!res.ok) {
      toast(`⚠️ Agent key failed: ${res.error}`, "err");
      return;
    }
    const d = res.data || {};
    window.alert(
      `🔑 New agent public key:\n\n${d.publicKey || "(see output)"}\n\n` +
        `Private key: ${d.privateKeyPath || "agent/agent-private.key"}\n\n` +
        `Now set FRONTDESK_AGENT_PUBKEY in ⚙️ Config to the value above and restart the webhook server.`,
    );
    refreshLicenses();
  }

  async function syncBlocklist() {
    if (gatedWrite("syncRevocation")) return;
    const e = pkmState.entry || {};
    const targets = Object.keys(e.verifierTargets || {});
    if (!targets.length) {
      window.alert(
        `${pkmLabel()} reads its blocklist live on every verify — there is nothing to sync.\n\n(Sync is only needed by registries that embed the blocklist in their own source, e.g. transcription-agent.)`,
      );
      return;
    }
    if (!window.confirm(`Rewrite the embedded blocklist in ${targets.join(", ")}?\n\nThe consumer app must be rebuilt afterwards.`)) return;
    const res = await withLoading("Syncing the embedded blocklist…", () => api.pkmSyncRevocation(pkmReg()), {
      context: "pkm sync-revocation",
    });
    if (!res) return;
    if (!res.ok) {
      toast(`⚠️ Sync failed: ${res.error}`, "err");
      return;
    }
    const lines = ((res.data && res.data.results) || [])
      .map((r) => `[${r.registry}] ${r.seats.length} revoked seat(s):\n${(r.changes || []).map((c) => `  ${c.changed ? "updated  " : "unchanged"} ${c.label} ${c.path}`).join("\n")}`)
      .join("\n\n");
    window.alert(`${lines || "Nothing to sync."}\n\nRebuild the consumer app for the change to take effect.`);
  }

  // ── Read-only checks ──
  // These answer the questions an operator actually has about a licence, and they
  // keep working in every state where the CLI answers at all — including the states
  // where writes are refused, which is precisely when something is wrong. All three
  // are strictly stronger than Validate: challenge proves the login handshake,
  // self-test proves the E2E envelope round-trips, and check-revocation proves the
  // blocklist is both enforced and in sync with the consumer apps.

  /** Write a one-line result under the Verify row. */
  function checksOut(text, kind) {
    const el = $("pkm-checks-out");
    if (!el) return;
    el.className = `pkm-checks__out${kind ? ` pkm-checks__out--${kind}` : ""}`;
    el.textContent = text || "";
  }

  const claimsLine = (claims) => {
    if (!claims) return "";
    const exp = claims.exp ? new Date(claims.exp * 1000).toISOString().slice(0, 10) : "unlimited";
    return `${esc(claims.sub)} · kid ${esc(claims.kid)} · exp ${esc(exp)}`;
  };

  /** Shared shape for the two "check this licence" flows. */
  async function runLicenseCheck({ title, desc, action, context, okText, failText }) {
    const entered = await askText({ title, label: "Licence key", desc, placeholder: "TA1…" });
    if (entered === null || !entered.trim()) return;
    const res = await withLoading(`${title}…`, () => api[action](pkmReg(), entered.trim()), { context });
    if (!res) return;
    if (!res.ok) return checksOut(`${title}: ${res.error}`, "err");
    const d = res.data || {};
    checksOut(d.ok ? okText(d) : `${failText} — ${d.reason || "rejected"}`, d.ok ? "ok" : "err");
  }

  function checkChallenge() {
    return runLicenseCheck({
      title: "Challenge",
      desc: `Simulates the webapp login handshake for a licence in ${pkmLabel()}: the seat signs a fresh nonce, so a pass means the key can actually log in. Validate only checks the signature and expiry.`,
      action: "pkmChallenge",
      context: "pkm challenge-test",
      okText: (d) => `Challenge ✅ — the handshake succeeds. ${claimsLine(d.claims)}`,
      failText: "Challenge ❌",
    });
  }

  function checkSelfTest() {
    return runLicenseCheck({
      title: "Crypto self-test",
      desc: `ECDH → AES-256-GCM round trip between the seat and the agent keypair in ${pkmLabel()}. A pass means replies will decrypt; a fail usually means FRONTDESK_AGENT_PUBKEY (.env and Netlify) does not match this registry's agent key.`,
      action: "pkmSelfTest",
      context: "pkm crypto-self-test",
      okText: (d) => `Crypto ✅ — the envelope round-trips. ${claimsLine(d.claims)}`,
      failText: "Crypto ❌",
    });
  }

  async function checkRevocationState() {
    const res = await withLoading("Running the revocation check…", () => api.pkmCheckRevocation(pkmReg()), {
      context: "pkm check-revocation",
    });
    if (!res) return;
    if (!res.ok) return checksOut(`Revocation check: ${res.error}`, "err");
    const d = res.data || {};
    const parts = [];
    for (const r of d.reject?.results || []) parts.push(`[${r.registry}] ${r.message}`);
    for (const p of d.parity || []) {
      for (const t of p.targets || []) {
        const state = !t.exists
          ? "MISSING"
          : !t.markerFound
            ? "NO MARKER"
            : t.matches
              ? "in sync"
              : "OUT OF SYNC";
        parts.push(`[${p.registry}] ${t.lang} ${state} ${t.path}`);
      }
    }
    checksOut(
      `Revocation ${d.ok ? "✅" : "❌"} — ${parts.join(" · ") || "no revoked seats and no embedded blocklists to check"}`,
      d.ok ? "ok" : "err",
    );
  }

  async function checkPerms() {
    const res = await withLoading("Reading key-store permissions…", () => api.pkmPerms(), { context: "pkm perms" });
    if (!res) return;
    if (!res.ok) return checksOut(`Permissions: ${res.error}`, "err");
    const d = res.data || {};
    const loose = d.loose || [];
    checksOut(
      d.clean ? "Permissions ✅ — every key path is tight." : `Permissions ⚠️ — ${loose.length} group/other-accessible path(s): ${loose.slice(0, 3).join(", ")}${loose.length > 3 ? " …" : ""}`,
      d.clean ? "ok" : "warn",
    );
  }

  async function checkBundle() {
    const res = await withLoading("Verifying the export bundle…", () => api.pkmVerifyBundle(), {
      context: "pkm verify-bundle",
    });
    if (!res) return;
    if (!res.ok) return checksOut(`Bundle: ${res.error}`, "err");
    const d = res.data || {};
    if (d.ok) return checksOut(`Bundle ✅ — the signature matches${d.kid ? ` (kid ${d.kid})` : ""}.`, "ok");
    checksOut(
      d.reason === "absent"
        ? "Bundle ⚠️ — no export/devmon.json.sig, so the bundle is unverifiable (not invalid)."
        : "Bundle ❌ — export/devmon.json does NOT match its signature. Do not ship it.",
      d.reason === "absent" ? "warn" : "err",
    );
  }

  /**
   * Tighten loose key paths (`pkm perms --fix`).
   *
   * A write, so it is gated — but key-file hygiene rather than key management: it
   * chmods directories and private keys, and never touches key material.
   */
  async function fixPerms() {
    if (gatedWrite("permsFix")) return;
    if (
      !window.confirm(
        "Tighten group/other-accessible files under the key store?\n\n" +
          "Directories become 700 and private keys 600. No key material is changed.",
      )
    )
      return;
    const res = await withLoading("Tightening key-store permissions…", () => api.pkmPermsFix(), {
      context: "pkm perms --fix",
    });
    if (!res) return;
    if (!res.ok) return toast(`⚠️ Permission fix failed: ${res.error}`, "err");
    const n = ((res.data && res.data.fixed) || []).length;
    toast(n ? `Tightened ${n} path(s).` : "Nothing to fix.", "ok");
    refreshLicenses();
  }

  /**
   * Rebuild and re-sign the public export bundle (`pkm export`).
   *
   * The counterpart to the read-only **Verify bundle** check: that one proves an
   * existing bundle matches its signature, this one writes a fresh pair
   * (`export/devmon.json` + `.sig`). It is metadata only — registries, rings, seat
   * status and counts, never a licence or key material — so it is safe to hand to a
   * consumer app, which is exactly what dev_mon does.
   *
   * A write, so it is gated like every other mutation. There is deliberately no
   * separate "authority key" action: the CLI's `signBundle()` calls
   * `ensureAuthority()` itself, so the signing keypair is created on demand.
   */
  async function exportBundle() {
    if (gatedWrite("exportBundle")) return;
    const res = await withLoading("Exporting the bundle…", () => api.pkmExportBundle(), { context: "pkm export" });
    if (!res) return;
    if (!res.ok) return toast(`⚠️ Export failed: ${res.error}`, "err");
    const d = res.data || {};
    const t = d.totals || {};
    const counts = typeof t.registries === "number" ? ` — ${t.registries} registry(ies), ${t.seats ?? 0} seat(s)` : "";
    toast(
      `Bundle exported${counts} — ${d.bundleFile || "export/devmon.json"} re-signed${d.authorityKid ? ` (kid ${d.authorityKid})` : ""}.`,
      "ok",
    );
    // The export can also have created the authority keypair on the way through, so
    // re-read the store to keep the status header honest.
    refreshLicenses();
  }

  /** Re-probe the store on demand (bypasses main's cached CLI liveness check). */
  async function recheckStore() {
    const c = await loadCaps({ fresh: true });
    toast(
      c.state === "ready" ? "Key store ready — all actions available." : `Key store: ${c.state} — ${c.reason || ""}`,
      c.state === "ready" ? "ok" : "err",
    );
    guarded("licenses", refreshLicenses);
  }

  $("pkm-recheck").addEventListener("click", recheckStore);
  $("pkm-challenge").addEventListener("click", checkChallenge);
  $("pkm-selftest").addEventListener("click", checkSelfTest);
  $("pkm-revocation-check").addEventListener("click", checkRevocationState);
  $("pkm-perms").addEventListener("click", checkPerms);
  $("pkm-bundle-check").addEventListener("click", checkBundle);
  // Claims — the read-only drift canary sits with the other Verify checks; the
  // seat-scoped actions live in the Claims panel, next to the two copies they act on.
  $("pkm-claims-verify").addEventListener("click", () => guarded("claims", checkClaimsDrift));
  $("pkm-claims-show").addEventListener("click", () => guarded("claims", () => showClaims()));
  $("pkm-claims-seat").addEventListener("keydown", (e) => {
    if (e.key === "Enter") guarded("claims", () => showClaims());
  });
  $("pkm-claims-backfill").addEventListener("click", () => guarded("claims", () => backfillClaims(true)));
  $("pkm-claims-backfill-go").addEventListener("click", () => guarded("claims", () => backfillClaims(false)));
  $("pkm-creds-open").addEventListener("click", () => {
    $("pkm-creds-form").classList.remove("hidden");
    $("pkm-creds-msg").textContent = "";
    $("pkm-creds-key").focus();
  });
  $("pkm-creds-cancel").addEventListener("click", () => {
    $("pkm-creds-form").classList.add("hidden");
    $("pkm-creds-msg").textContent = "";
    // Never leave a typed password in a hidden form.
    $("pkm-creds-password").value = "";
  });
  $("pkm-creds-go").addEventListener("click", testCreds);
  $("pkm-refresh").addEventListener("click", () => guarded("licenses", refreshLicenses));
  $("pkm-archive").addEventListener("click", archiveExpiredSeats);
  $("pkm-export").addEventListener("click", exportBundle);
  $("pkm-validate-open").addEventListener("click", validateLicense);
  $("pkm-audit-load").addEventListener("click", () => guarded("audit", loadAudit));
  // Registry switch — every panel below is scoped to the selected registry, so
  // reset the per-registry views rather than leaving the previous app's data up.
  $("pkm-registry").addEventListener("change", (e) => {
    pkmState.registry = e.target.value || null;
    pkmState.entry = pkmState.registries.find((r) => r.id === pkmState.registry) || null;
    $("pkm-audit-box").innerHTML = "";
    // Claims are per-registry too, so drop the shown seat rather than leaving the
    // previous registry's identity on screen where it could be edited blindly.
    claimsSub = null;
    $("pkm-claims-seat").value = "";
    $("pkm-claims-box").innerHTML = '<div class="empty">Pick a seat to see the identity bound to its key.</div>';
    setClaimsMsg("", null);
    renderPkmRingsHint();
    guarded("licenses", refreshLicenses);
  });
  // Ring management
  $("pkm-ring-create").addEventListener("click", createRing);
  $("pkm-agent-key").addEventListener("click", rotateAgentKey);
  $("pkm-sync-revocation").addEventListener("click", syncBlocklist);
  $("pkm-issue-open").addEventListener("click", () => {
    $("pkm-issue-form").classList.remove("hidden");
    $("pkm-issue-msg").textContent = "";
    $("pkm-issue-sub").value = "";
    $("pkm-issue-exp").value = "";
    $("pkm-issue-sub").focus();
  });
  $("pkm-issue-cancel").addEventListener("click", () => $("pkm-issue-form").classList.add("hidden"));
  $("pkm-issue-go").addEventListener("click", issueSeat);
  $("pkm-modal-copy").addEventListener("click", copyLicense);
  $("pkm-modal-close").addEventListener("click", hideLicenseModal);

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
          <button data-spawn="${esc(r.sub)}">${iconLabel("play", 12, "Spawn MCP")}</button>
          <button data-stopspawn="${esc(r.sub)}">${iconLabel("stop", 12, "Stop MCP")}</button>
        </span>
      </div>`,
      )
      .join("");
    box.querySelectorAll("[data-gconnect]").forEach((b) =>
      b.addEventListener("click", async () => {
        const sub = b.dataset.gconnect;
        const r = await withLoading(`Connecting a Google account for ${sub}…`, () => api.accountsConnectGoogle(sub), {
          context: "accounts connectGoogle",
          slowHint: "A browser window opens for the OAuth consent screen…",
        });
        if (r) toast(r.ok ? `Connected ${r.user || ""} to ${sub}` : `⚠️ ${r.error}`, r.ok ? "ok" : "err");
        refreshAccounts();
      }),
    );
    box.querySelectorAll("[data-tset]").forEach((b) =>
      b.addEventListener("click", async () => {
        const sub = b.dataset.tset;
        const key = await askText({ title: `Trello credentials for ${sub}`, label: "API key" });
        if (key === null) return;
        const token = await askText({ title: `Trello credentials for ${sub}`, label: "API token" });
        if (token === null) return;
        if (key.trim() && token.trim()) {
          await withLoading(`Saving Trello credentials for ${sub}…`, () => api.accountsSetTrello(sub, key.trim(), token.trim()), {
            context: "accounts setTrello",
          });
          refreshAccounts();
        }
      }),
    );
    box.querySelectorAll("[data-tclear]").forEach((b) =>
      b.addEventListener("click", async () => {
        const sub = b.dataset.tclear;
        await withLoading(`Clearing the account binding for ${sub}…`, () => api.accountsClear(sub), {
          context: "accounts clear",
        });
        refreshAccounts();
      }),
    );
    box.querySelectorAll("[data-spawn]").forEach((b) =>
      b.addEventListener("click", async () => {
        const sub = b.dataset.spawn;
        const r = await withLoading(`Spawning MCP instance(s) for ${sub}…`, () => api.accountsSpawnForSeat(sub), {
          context: "accounts spawn",
          slowHint: "Launching per-seat MCP servers…",
        });
        if (r) toast(r.ok ? `Spawned ${r.spawned.length} MCP instance(s)` : `⚠️ ${r.error}`, r.ok ? "ok" : "err");
        refreshDashboard();
      }),
    );
    box.querySelectorAll("[data-stopspawn]").forEach((b) =>
      b.addEventListener("click", async () => {
        const sub = b.dataset.stopspawn;
        await withLoading(`Stopping the MCP instance(s) for ${sub}…`, () => api.accountsStopForSeat(sub), {
          context: "accounts stop-spawn",
        });
        refreshDashboard();
      }),
    );
  }
  $("accounts-refresh").addEventListener("click", refreshAccounts);

  // ── Tools ──
  // The shared manifest is grouped by server (name prefix) into collapsible
  // accordion sections. Expansion state persists across re-renders; all start collapsed.
  const toolsState = { open: new Set() };
  const MANIFEST_GROUPS = [
    { prefix: "trello_", label: "Trello" },
    { prefix: "gmail_", label: "Gmail" },
    { prefix: "drive_", label: "Drive" },
    { prefix: "calendar_", label: "Calendar" },
    { prefix: "photos_", label: "Photos" },
    { prefix: "web_", label: "Web Search" },
    { prefix: "sheets_", label: "Sheets" },
    { prefix: "frontdesk_", label: "Frontdesk" },
    { prefix: "whatsapp_", label: "WhatsApp" },
    { prefix: "netlify_", label: "Netlify" },
  ];

  async function refreshTools() {
    const res = await api.toolsManifest();
    if (!res.ok) {
      $("manifest-box").innerHTML = `<div class="empty">${esc(res.error)}</div>`;
      return;
    }
    const tools = res.tools || [];
    const groups = MANIFEST_GROUPS.map((g) => ({ label: g.label, items: [] }));
    const other = { label: "Other", items: [] };
    for (const t of tools) {
      const g = groups.find((x) => t.name && t.name.startsWith(x.prefix));
      (g || other).items.push(t);
    }
    const all = [...groups.filter((g) => g.items.length), ...(other.items.length ? [other] : [])];
    $("manifest-box").innerHTML = all
      .map((g) => {
        const open = toolsState.open.has(g.label);
        const rows = g.items
          .map((t) => {
            const props = Object.keys(t.inputSchema?.properties || {});
            return `<div class="manifest-tool"><span class="tname">${esc(t.name)}</span><div class="tdesc">${esc(t.description || "")}</div><div class="tdesc">params: ${esc(props.join(", ") || "none")}</div></div>`;
          })
          .join("");
        return `<div class="manifest-group${open ? "" : " collapsed"}">
          <div class="manifest-head" data-manifest-sec="${escAttr(g.label)}" title="click to expand/collapse"><span class="caret">${open ? "▾" : "▸"}</span>${esc(g.label)} <span class="count">${g.items.length}</span></div>
          <div class="manifest-body">${rows}</div>
        </div>`;
      })
      .join("");
    $("manifest-box").querySelectorAll("[data-manifest-sec]").forEach((h) =>
      h.addEventListener("click", () => {
        const root = h.closest(".manifest-group");
        if (!root) return;
        const label = h.dataset.manifestSec;
        const caret = h.querySelector(".caret");
        if (toolsState.open.has(label)) {
          toolsState.open.delete(label);
          root.classList.add("collapsed");
          if (caret) caret.textContent = "▸";
        } else {
          toolsState.open.add(label);
          root.classList.remove("collapsed");
          if (caret) caret.textContent = "▾";
        }
      }),
    );
  }

  async function runTrello(action, params) {
    const res = await withLoading("Calling the Trello API…", () => api.trello(action, params), {
      context: `trello ${action}`,
    });
    const box = $("trello-result");
    if (!res) return;
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
  document.querySelector('[data-act="lists"]').addEventListener("click", async () => {
    const boardId = await askText({ title: "Trello lists", label: "Board ID" });
    if (boardId && boardId.trim()) runTrello("list_lists", { boardId: boardId.trim() });
  });
  document.querySelector('[data-act="cards"]').addEventListener("click", async () => {
    const listId = await askText({ title: "Trello cards", label: "List ID" });
    if (listId && listId.trim()) runTrello("list_cards", { listId: listId.trim() });
  });

  document.querySelector('[data-act="gmail-list"]').addEventListener("click", async () => {
    const res = await withLoading("Reading recent Gmail messages…", () => api.gmail("list_messages", { maxResults: 10 }), {
      context: "gmail list_messages",
    });
    const box = $("gmail-result");
    if (!res) return;
    box.innerHTML = res.ok
      ? (res.result || []).map((m) => `• ${esc(m.id)}`).join("<br/>") || "(empty)"
      : `<div class="empty">Error: ${esc(res.error)}</div>`;
  });

  // WhatsApp quick actions — status + list_numbers let you discover & copy the
  // test/live phone-number IDs into the WhatsApp Config section (number picker).
  async function runWhatsapp(action, params) {
    const res = await withLoading("Calling the WhatsApp Cloud API…", () => api.whatsapp(action, params), {
      context: `whatsapp ${action}`,
    });
    const box = $("whatsapp-result");
    if (!res) return;
    if (!res.ok) {
      box.innerHTML = `<div class="empty">Error: ${esc(res.error)}</div>`;
      return;
    }
    const data = Array.isArray(res.result) ? res.result : [res.result];
    box.innerHTML =
      data
        .slice(0, 20)
        .map((r) => {
          const line = r && r.id ? `${r.id} — ${esc(r.display || r.displayPhoneNumber || r.name || "")}` : JSON.stringify(r).slice(0, 160);
          return `• <code>${esc(line)}</code>`;
        })
        .join("<br/>") || "(empty)";
  }
  document.querySelector('[data-act="wa-status"]').addEventListener("click", () => runWhatsapp("status"));
  document.querySelector('[data-act="wa-numbers"]').addEventListener("click", () => runWhatsapp("list_numbers"));

  // Netlify quick actions. Unlike the Trello/Gmail/WhatsApp panels above, these do
  // NOT hit the REST API from the main process — they run through the MCP client
  // (mcp/netlify/index.js), so a working panel also proves the client can spawn
  // and talk to a server. Requires NETLIFY_AUTH_TOKEN in .env / config.json.
  const netlifyLine = (r) => {
    if (r.url) return `${r.name || r.id} — ${r.url}`;
    if (r.state) return [r.state, r.branch, r.commit_ref].filter(Boolean).join(" · ");
    if (r.key) return r.key;
    return JSON.stringify(r).slice(0, 160);
  };
  async function runNetlify(action, params) {
    const res = await withLoading("Calling the Netlify API…", () => api.netlify(action, params), {
      context: `netlify ${action}`,
    });
    const box = $("netlify-result");
    if (!res) return;
    if (!res.ok) {
      box.innerHTML = `<div class="empty">Error: ${esc(res.error)}</div>`;
      return;
    }
    const data = Array.isArray(res.result) ? res.result : [res.result];
    box.innerHTML =
      data
        .slice(0, 20)
        .map((r) => (r && typeof r === "object" ? `• <code>${esc(netlifyLine(r))}</code>` : `• ${esc(String(r))}`))
        .join("<br/>") || "(empty)";
  }
  document.querySelector('[data-act="netlify-sites"]').addEventListener("click", () => runNetlify("list_sites"));
  document.querySelector('[data-act="netlify-deploys"]').addEventListener("click", () => runNetlify("list_deploys"));
  document.querySelector('[data-act="netlify-env"]').addEventListener("click", async () => {
    const key = await askText({ title: "Netlify env", label: "Variable name (leave blank to list them all)" });
    if (key === null) return;
    const name = String(key || "").trim();
    runNetlify(name ? "get_env" : "list_env", name ? { key: name } : {});
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
    { key: "TRELLO_BOARD_NAME", label: "Board Name (display only)", section: "Trello", secret: false },
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
    // WhatsApp (Meta Cloud API) — one WABA holds the free test number + a real
    // (burner) number sharing the same system-user token. Active "from" number
    // = WHATSAPP_PHONE_NUMBER_ID; run the Tools → WhatsApp → "Numbers" action
    // to discover and copy the test/live phone-number IDs here.
    { key: "WHATSAPP_ACCESS_TOKEN", label: "Access Token (system user)", section: "WhatsApp", secret: true },
    { key: "WHATSAPP_WABA_ID", label: "WhatsApp Business Account ID", section: "WhatsApp", secret: false },
    { key: "WHATSAPP_PHONE_NUMBER_ID", label: "Active Phone Number ID", section: "WhatsApp", secret: false },
    { key: "WHATSAPP_TEST_PHONE_NUMBER_ID", label: "Test Number ID (free sandbox)", section: "WhatsApp", secret: false },
    { key: "WHATSAPP_API_VERSION", label: "Graph API Version", section: "WhatsApp", secret: false },
    { key: "WHATSAPP_APP_SECRET", label: "App Secret (webhook verify)", section: "WhatsApp", secret: true },
    { key: "WHATSAPP_WEBHOOK_VERIFY_TOKEN", label: "Webhook Verify Token", section: "WhatsApp", secret: true },
    // Frontdesk
    // Key store — all licensing data/logic lives in the sibling personal_key_manager repo.
    { key: "PKM_ROOT", label: "Key store root (pkm registries)", section: "Frontdesk", secret: false, placeholder: "~/Documents/GitHub/personal_key_manager" },
    { key: "PKM_REPO", label: "personal_key_manager repo", section: "Frontdesk", secret: false, placeholder: "~/Documents/GitHub/personal_key_manager" },
    { key: "PKM_REGISTRY", label: "Registry the frontdesk stack uses", section: "Frontdesk", secret: false, placeholder: "frontdesk-agent" },
    { key: "PKM_BIN", label: "pkm CLI path (optional override)", section: "Frontdesk", secret: false, placeholder: "<repo>/bin/pkm.mjs" },
    { key: "PKM_NODE", label: "Node binary used to run pkm (optional)", section: "Frontdesk", secret: false, placeholder: "(the app's own runtime)" },
    { key: "PKM_TIMEOUT_MS", label: "pkm command timeout (ms)", section: "Frontdesk", secret: false, placeholder: "20000" },
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
    // AWS (EC2 / RDP testing) — used by scripts like update-rdp-sg.sh. These env
    // vars are injected into spawned scripts; the AWS CLI also falls back to
    // ~/.aws when they are unset. Region/profile are plain; keys are secrets.
    { key: "AWS_ACCESS_KEY_ID", label: "AWS Access Key ID", section: "AWS", secret: true },
    { key: "AWS_SECRET_ACCESS_KEY", label: "AWS Secret Access Key", section: "AWS", secret: true },
    { key: "AWS_SESSION_TOKEN", label: "AWS Session Token (optional)", section: "AWS", secret: true },
    { key: "AWS_DEFAULT_REGION", label: "AWS Default Region", section: "AWS", secret: false },
    { key: "AWS_PROFILE", label: "AWS Profile (optional)", section: "AWS", secret: false },
    // Agent runner
    { key: "AGENT_RUNNER_ENABLED", label: "Agent Runner Enabled", section: "Agent runner", secret: false, options: ["true", "false"] },
    { key: "AGENT_TASK_INTERVAL", label: "Task Check Interval (ms)", section: "Agent runner", secret: false },
    { key: "AGENT_RUNNER_MAX_ROUNDS", label: "Max Turns per Frontdesk Event", section: "Agent runner", secret: false },
    { key: "AGENT_MAX_ITEMS_PER_PASS", label: "Max Queue Items per Wake-up", section: "Agent runner", secret: false },
    { key: "AGENT_RUNNER_VERBOSE", label: "Verbose Prompt Logging", section: "Agent runner", secret: false, options: ["true", "false"] },
    // Logging
    { key: "LOG_LEVEL", label: "Log Level", section: "Logging", secret: false, options: ["debug", "info", "warn", "error"] },
    { key: "LOG_DIR", label: "Log Directory", section: "Logging", secret: false },
    { key: "LOG_CONSOLE", label: "Echo to Console", section: "Logging", secret: false, options: ["0", "1", "true", "false"] },
    // Notification centre — the feed + read state under logs/notifications/.
    // Saving either of these needs no restart: the store reads them at startup and
    // the app is the only writer.
    { key: "NOTIFY_ENABLED", label: "Enable Notifications", section: "Notifications", secret: false, options: ["true", "false"] },
    { key: "NOTIFY_RETENTION_DAYS", label: "Keep Notifications (days)", section: "Notifications", secret: false },
    // Usage tracking (DS-mon) — per-LLM-call token usage buffer + push. Ollama is
    // never tracked (local + free). Mirrors the transcription agent's section.
    { key: "USAGE_TRACKING_ENABLED", label: "Enable Usage Tracking", section: "Usage tracking", secret: false, options: ["true", "false"] },
    { key: "DSMON_PUSH_URL", label: "DS-mon Push URL", section: "Usage tracking", secret: false },
    { key: "DSMON_PUSH_TOKEN", label: "DS-mon Push Token (required)", section: "Usage tracking", secret: true, placeholder: "required whenever the push URL is set" },
    { key: "DSMON_PUSH_INTERVAL", label: "Push Interval (ms)", section: "Usage tracking", secret: false },
    { key: "DSMON_INSTANCE_ID", label: "Instance ID", section: "Usage tracking", secret: false },
    { key: "DSMON_ENCRYPTION_KEY", label: "Encryption Key (AES-256, optional)", section: "Usage tracking", secret: true },
    { key: "DSMON_ENCRYPTION_KEY_ID", label: "Encryption Key ID", section: "Usage tracking", secret: false },
    { key: "CREDIT_POLL_INTERVAL", label: "Credit Poll Interval (ms)", section: "Usage tracking", secret: false },
    // GitHub backup (scripts/user/safe/github_backup.py) — read by the script from the
    // environment; config.json is authoritative here, so the .env copy is only a fallback.
    { key: "GITHUB_TOKEN", label: "GitHub Token (required by the backup script)", section: "GitHub backup", secret: true, placeholder: "ghp_… — scope `repo` (private repos) or `public_repo`" },
    { key: "GITHUB_USER", label: "GitHub User / Org", section: "GitHub backup", secret: false },
    { key: "GITHUB_REPOS", label: "Repo Allowlist (blank = the script's JSON list)", section: "GitHub backup", secret: false, placeholder: "repo-a,repo-b — blank = github-backup.repos.json" },
    // Chat (operator agentic loop)
    { key: "OPERATOR_CHAT_TOOLS", label: "Agentic Tools Enabled", section: "Chat", secret: false, options: ["true", "false"] },
    { key: "OPERATOR_CHAT_MAX_ROUNDS", label: "Max Tool Steps per Message", section: "Chat", secret: false },
    // Appearance
    { key: "APPEARANCE_THEME", label: "Appearance Theme", section: "Appearance", secret: false, options: ["light", "dark", "system"] },
    { key: "APPEARANCE_ACCENT_COLOR", label: "Accent Color (hex — blank = theme default)", section: "Appearance", secret: false },
    { key: "APPEARANCE_FONT_SIZE", label: "Font Size", section: "Appearance", secret: false, options: ["small", "medium", "large", "x-large", "xx-large"] },
  ];

  // ── Config (config.json) — TABBED field editor with source annotations ──
  // One section at a time, plus a filter that deliberately searches every section:
  // a search that only looked inside the active tab would be useless exactly when it
  // is wanted — when you know the key but not where it lives. The layout follows the
  // study_aide_agent config panel; section names and tab labels are separate because
  // a heading can afford a sentence and a tab strip cannot.
  const CONFIG_TAB_KEY = "frontdesk.configTab";
  /** Section names in declaration order — derived, so a new section needs no edit. */
  const CONFIG_SECTIONS = [...new Set(CONFIG_FIELDS.map((f) => f.section))];
  /** Short tab label per section (falls back to the section name). */
  const CONFIG_TAB_LABELS = {
    "LLM Provider": "Model",
    "Gmail / Google": "Google",
    "Agent runner": "Runner",
    "Usage tracking": "Usage",
    "GitHub backup": "GitHub",
  };
  const CONFIG_TAB_FALLBACK = CONFIG_SECTIONS[0];

  const configState = {
    values: {},
    sources: {},
    dirty: new Set(),
    raw: false,
    filter: "",
    // safe/trello-boards.json as main sees it (boards, resolved frontdesk lists, and
    // which env keys drift from the file). Rendered at the top of the Trello section.
    trelloBoards: null,
    // Which Google account the OPERATOR refresh token belongs to (google:status),
    // shown above the Gmail / Google fields next to the remint button.
    google: { connected: false, user: null },
    // A stored tab can outlive the section it names, so it is validated on read —
    // otherwise the panel would render nothing at all and say nothing about why.
    tab: (() => {
      try {
        const saved = localStorage.getItem(CONFIG_TAB_KEY);
        return saved && CONFIG_SECTIONS.includes(saved) ? saved : CONFIG_TAB_FALLBACK;
      } catch {
        return CONFIG_TAB_FALLBACK;
      }
    })(),
  };

  /** Fields belonging to one section. */
  const configSectionFields = (name) => CONFIG_FIELDS.filter((f) => f.section === name);

  /** The section a key lives in — used for the per-tab dirty counts. */
  const configKeySection = (key) => (CONFIG_FIELDS.find((f) => f.key === key) || {}).section;

  // Provider-aware metadata for the ⚙️ Config "LLM Provider" section — mirrors
  // shared/model-provider.mjs. Which keys apply per provider, the required API
  // key, and the default/placeholder model shown when the value is blank.
  const LLM_PROVIDERS = {
    deepseek: {
      label: "DeepSeek",
      hint: "Cloud API — requires a DeepSeek API key.",
      required: "DEEPSEEK_API_KEY",
      fields: [
        { key: "DEEPSEEK_API_KEY", secret: true, required: true },
        { key: "DEEPSEEK_MODEL", placeholder: "deepseek-v4-flash (default)" },
      ],
    },
    openai: {
      label: "OpenAI",
      hint: "Cloud API — requires an OpenAI API key.",
      required: "OPENAI_API_KEY",
      fields: [
        { key: "OPENAI_API_KEY", secret: true, required: true },
        { key: "OPENAI_MODEL", placeholder: "gpt-4o (default)" },
        { key: "OPENAI_BASE_URL", placeholder: "optional gateway/proxy override (default: api.openai.com/v1)" },
      ],
    },
    anthropic: {
      label: "Anthropic",
      hint: "Cloud API — requires an Anthropic API key.",
      required: "ANTHROPIC_API_KEY",
      fields: [
        { key: "ANTHROPIC_API_KEY", secret: true, required: true },
        { key: "ANTHROPIC_MODEL", placeholder: "claude-sonnet-4-5 (default)" },
        { key: "ANTHROPIC_BASE_URL", placeholder: "optional gateway/proxy override (default: api.anthropic.com)" },
        { key: "ANTHROPIC_MAX_TOKENS", placeholder: "4096" },
      ],
    },
    ollama: {
      label: "Ollama (local)",
      hint: "Local server — no API key needed.",
      required: null,
      fields: [
        { key: "OLLAMA_BASE_URL", placeholder: "http://127.0.0.1:11434" },
        { key: "OLLAMA_MODEL", placeholder: "required — e.g. deepseek-v4-flash" },
        { key: "OLLAMA_NUM_CTX", placeholder: "32768 | 65536 | 131072" },
      ],
    },
  };

  function activeProvider() {
    const raw = configState.values.LLM_PROVIDER && configState.values.LLM_PROVIDER.value;
    const p = String(raw || "deepseek").toLowerCase();
    return LLM_PROVIDERS[p] ? p : "deepseek";
  }

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
    const placeholder = f.placeholder ? ` placeholder="${escAttr(f.placeholder)}"` : "";
    const input = f.options
      ? `<select data-cfield="${escAttr(f.key)}">${f.options.map((o) => `<option value="${escAttr(o)}" ${String(val) === o ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`
      : `<input type="${inputType}" data-cfield="${escAttr(f.key)}" value="${escAttr(val)}"${placeholder} spellcheck="false" />`;
    const toggle = f.secret ? `<button type="button" class="cfg-secret-toggle" data-secret-toggle="${escAttr(f.key)}" title="show/hide">👁</button>` : "";
    const reqTag = f.providerRequired && !val ? `<span class="cfg-required" title="Required for the selected provider">required</span>` : "";
    return `
      <div class="config-field${f.providerRequired ? " cfg-required-field" : ""}">
        <label class="cfg-label" title="${escAttr(f.key)}">${esc(f.label)}${reqTag}</label>
        <div class="cfg-input-row">${input}${toggle}</div>
        <span class="cfg-source tag ${srcClass}">${srcLabel}</span>
      </div>`;
  }

  /**
   * Inner HTML for the LLM Provider section.
   *
   * Only the ACTIVE provider's keys are rendered, so switching provider does not
   * leave a wall of irrelevant inputs on screen (metadata mirrors
   * shared/model-provider.mjs).
   */
  function llmProviderBodyHTML() {
    const pick = CONFIG_FIELDS.find((f) => f.key === "LLM_PROVIDER");
    const temp = CONFIG_FIELDS.find((f) => f.key === "LLM_TEMPERATURE");
    const meta = LLM_PROVIDERS[activeProvider()];
    const rows = [`<div class="provider-summary"><span class="provider-badge">${esc(meta.label)}</span><span class="provider-hint">${esc(meta.hint)}</span></div>`];
    for (const f of meta.fields) {
      const def = CONFIG_FIELDS.find((x) => x.key === f.key);
      if (!def) continue;
      rows.push(configFieldHTML({ ...def, placeholder: f.placeholder, providerRequired: !!f.required }));
    }
    if (temp) rows.push(configFieldHTML(temp));
    return `${pick ? configFieldHTML(pick) : ""}<div class="provider-panel">${rows.join("")}</div>`;
  }

  /**
   * Inner HTML for the Gmail / Google section: a one-click remint of the OPERATOR
   * refresh token, above the fields that hold it.
   *
   * This is the in-app equivalent of `npm run setup:gmail-auth` and it requests the
   * identical scope set (shared/google-scopes.mjs), so re-consenting here cannot
   * leave the token weaker than the CLI's would be. Worth knowing why it exists:
   * the CLI only ever wrote `.env`, and config.json silently overrides that, so
   * "I re-ran the auth script and nothing changed" was the normal outcome. Main
   * writes whichever store wins and reports it back in `store`.
   */
  function googleOperatorBodyHTML() {
    const g = configState.google || { connected: false, user: null };
    const who = g.connected ? g.user || "connected" : "no refresh token set";
    return (
      `<div class="provider-summary"><span class="provider-badge">Operator token</span>` +
      `<span class="provider-hint">Used by every MCP server and the operator chat — ${esc(who)}</span></div>` +
      `<div><button id="google-connect">Connect Google</button>` +
      `<div class="provider-hint" id="google-connect-status">Opens the Google consent screen to mint a new refresh token ` +
      `(Gmail · Drive · Calendar · Tasks · Photos), then drops the MCP connections and restarts the services holding the old one.</div></div>` +
      configSectionFields("Gmail / Google").map(configFieldHTML).join("")
    );
  }

  /**
   * Inner HTML for the Trello section: the `safe/trello-boards.json` readout, then
   * the fields themselves.
   *
   * The board/list ids used to be maintained by hand here AND in the file AND in the
   * Netlify UI. The map is the source of truth now (shared/trello-boards.mjs), so the
   * section shows what it says and offers to adopt it; `scripts/trello-boards-sync.mjs`
   * does the same headless.
   */
  function trelloMapBodyHTML() {
    const b = configState.trelloBoards || { present: false, boards: {}, lists: {}, drift: [], projected: {}, frontdesk: { other: [] } };
    const projected = b.projected || {};
    const rows = Object.entries(b.boards || {})
      .map(([name, id]) => {
        const isFrontdesk = b.frontdesk && b.frontdesk.board === name;
        const listTxt = Object.entries((b.lists && b.lists[name]) || {})
          .map(([ln, lid]) => `${esc(ln)} → <code>${esc(lid)}</code>`)
          .join(" · ");
        return (
          `<div class="board-row"><strong>${esc(name)}</strong> <code>${esc(id)}</code>${isFrontdesk ? ' <span class="tag valid">frontdesk</span>' : ""}` +
          (listTxt ? `<div class="board-lists">${listTxt}</div>` : "") +
          `</div>`
        );
      })
      .join("");
    const drift = (b.drift || [])
      .map((d) => `<li><code>${esc(d.key)}</code> — file <code>${esc(d.file)}</code>, currently <code>${esc(d.current || "(empty)")}</code></li>`)
      .join("");
    return (
      `<div class="board-map">` +
      `<div class="provider-summary"><span class="provider-badge">Board map</span>` +
      `<span class="provider-hint">${b.present ? `safe/trello-boards.json` : `<b>not found</b> (gitignored — absent on a fresh checkout)`}` +
      (b.file ? ` — <code>${esc(b.file)}</code>` : "") +
      (b.error ? ` — <b>${esc(b.error)}</b>` : "") +
      `</span></div>` +
      (rows ? `<div class="board-rows">${rows}</div>` : `<div class="provider-hint">No boards listed.</div>`) +
      (drift
        ? `<div class="provider-hint">Out of sync with the file:<ul class="board-drift">${drift}</ul></div>`
        : `<div class="provider-hint">Every id below matches the board map.</div>`) +
      `<div><button id="trello-map-fill"${Object.keys(projected).length ? "" : " disabled"}>Use board map values</button>` +
      `<div class="provider-hint" id="trello-map-status">Fills the id fields from the file so you can review, then press Save. ` +
      `The same reconciliation runs headless: <code>node scripts/trello-boards-sync.mjs --apply</code>.</div></div>` +
      `</div>` +
      configSectionFields("Trello").map(configFieldHTML).join("")
    );
  }

  /** Inner HTML for one section — the fields themselves, with no wrapper. */
  function configBodyHTML(name) {
    if (name === "LLM Provider") return llmProviderBodyHTML();
    if (name === "Gmail / Google") return googleOperatorBodyHTML();
    if (name === "Trello") return trelloMapBodyHTML();
    return configSectionFields(name).map(configFieldHTML).join("");
  }

  /** A read-only group heading + fields, used by the filtered (all-sections) view. */
  function configGroupHTML(name, fields) {
    return (
      `<div class="config-section">` +
      `<h4 class="config-sec-head">${esc(name)}<span class="config-sec-count">${fields.length}</span></h4>` +
      `<div class="config-sec-body">${fields.map(configFieldHTML).join("")}</div>` +
      `</div>`
    );
  }

  /**
   * The tab strip, plus the Save label's dirty count.
   *
   * Split out of renderConfigForm() because it is the only part that must update
   * while you type — the fields themselves must not be re-created (that would steal
   * focus mid-keystroke).
   */
  function renderConfigMeta() {
    const strip = $("config-tabs");
    const saveBtn = $("config-save");
    if (saveBtn) saveBtn.textContent = configState.dirty.size ? `Save ${configState.dirty.size}` : "Save";
    if (!strip) return;

    // Filter mode spans every section, so a tab strip would misrepresent what is on
    // screen; the filter note takes its place.
    if (configState.filter.trim()) {
      strip.innerHTML = "";
      strip.classList.add("hidden");
      return;
    }
    strip.classList.remove("hidden");
    strip.innerHTML = CONFIG_SECTIONS.map((name) => {
      const count = configSectionFields(name).filter((f) => configState.dirty.has(f.key)).length;
      const active = name === configState.tab;
      return (
        `<button role="tab" aria-selected="${active ? "true" : "false"}" class="ctab${active ? " is-active" : ""}" data-ctab="${escAttr(name)}">` +
        `${esc(CONFIG_TAB_LABELS[name] || name)}` +
        `${count ? `<span class="ctab__count">${count}</span>` : ""}` +
        `</button>`
      );
    }).join("");
    strip.querySelectorAll("[data-ctab]").forEach((b) =>
      b.addEventListener("click", () => {
        configState.tab = b.dataset.ctab;
        try {
          localStorage.setItem(CONFIG_TAB_KEY, configState.tab);
        } catch {
          /* storage unavailable — the tab still applies for this session */
        }
        renderConfigForm();
      }),
    );
  }

  function renderConfigForm() {
    const wrap = $("config-fields");
    const raw = $("config-editor");
    if (configState.raw) {
      wrap.classList.add("hidden");
      raw.classList.remove("hidden");
      $("config-tabs")?.classList.add("hidden");
      const flat = {};
      for (const k of Object.keys(configState.values)) flat[k] = configState.values[k].value;
      raw.value = JSON.stringify(flat, null, 2);
      renderConfigMeta();
      return;
    }
    wrap.classList.remove("hidden");
    raw.classList.add("hidden");

    const needle = configState.filter.trim().toLowerCase();
    if (needle) {
      const groups = CONFIG_SECTIONS.map((name) => ({
        name,
        fields: configSectionFields(name).filter(
          (f) =>
            f.key.toLowerCase().includes(needle) ||
            f.label.toLowerCase().includes(needle) ||
            f.section.toLowerCase().includes(needle),
        ),
      })).filter((g) => g.fields.length);
      const total = groups.reduce((n, g) => n + g.fields.length, 0);
      wrap.innerHTML =
        `<div class="config-filter-note">Searching all ${CONFIG_SECTIONS.length} sections — ${total} setting(s) match.` +
        ` <button id="config-filter-clear">Clear filter</button></div>` +
        (groups.length ? groups.map((g) => configGroupHTML(g.name, g.fields)).join("") : '<div class="empty">No setting matches that filter.</div>');
      $("config-filter-clear")?.addEventListener("click", () => {
        configState.filter = "";
        const input = $("config-search");
        if (input) input.value = "";
        renderConfigForm();
      });
    } else {
      // One section at a time. No per-section heading: the tab already says it.
      wrap.innerHTML = `<div class="config-tab-body" data-ctab-body="${escAttr(configState.tab)}">${configBodyHTML(configState.tab)}</div>`;
    }

    wrap.querySelectorAll("[data-cfield]").forEach((el) =>
      el.addEventListener("input", (e) => {
        const k = e.currentTarget.dataset.cfield;
        if (!configState.values[k]) configState.values[k] = { value: "", source: "default" };
        configState.values[k].value = e.currentTarget.value;
        configState.dirty.add(k);
        configMsg("");
        renderConfigMeta(); // refresh the dirty counts on the affected tabs
      }),
    );
    // Switching provider re-renders so only the active provider's fields show.
    const llmSelect = wrap.querySelector('[data-cfield="LLM_PROVIDER"]');
    if (llmSelect) {
      llmSelect.addEventListener("change", () => {
        if (configState.values.LLM_PROVIDER) configState.values.LLM_PROVIDER.value = llmSelect.value;
        configState.dirty.add("LLM_PROVIDER");
        configMsg("");
        renderConfigForm();
      });
    }
    wrap.querySelectorAll("[data-secret-toggle]").forEach((b) =>
      b.addEventListener("click", () => {
        const input = wrap.querySelector(`[data-cfield="${b.dataset.secretToggle}"]`);
        if (!input) return;
        const show = input.type === "password";
        input.type = show ? "text" : "password";
        b.textContent = show ? "🙈" : "👁";
      }),
    );
    const googleBtn = $("google-connect");
    if (googleBtn) googleBtn.addEventListener("click", runGoogleConnect);
    // Adopt safe/trello-boards.json's ids into the fields (reviewed, then Saved —
    // this never writes on its own, so a surprising file cannot silently reconfigure
    // the operator).
    const mapFill = wrap.querySelector("#trello-map-fill");
    if (mapFill)
      mapFill.addEventListener("click", () => {
        const projected = (configState.trelloBoards && configState.trelloBoards.projected) || {};
        let filled = 0;
        for (const [key, value] of Object.entries(projected)) {
          if (!CONFIG_FIELDS.some((f) => f.key === key)) continue;
          if (!configState.values[key]) configState.values[key] = { value: "", source: "default" };
          configState.values[key].value = value;
          configState.dirty.add(key);
          filled += 1;
        }
        renderConfigForm();
        const note = $("trello-map-status");
        if (note) note.textContent = filled
          ? `${filled} field(s) filled from the board map — review, then press Save.`
          : "The board map has no values this section can use.";
        renderConfigMeta();
      });
    renderConfigMeta();
  }

  /**
   * Remint the operator Google token (main: google:connect).
   *
   * The browser flow means this can sit for minutes, so the loading overlay carries
   * a slowHint. On success the form is re-rendered (so the account shown updates);
   * on failure the error is written into the status line AND configMsg, because a
   * silent no-op here would look exactly like a button that does nothing.
   */
  async function runGoogleConnect() {
    const res = await withLoading("Opening the Google consent screen…", () => api.googleConnect(), {
      context: "google connect",
      slowHint: "Approve access in the browser window, then come back to this tab…",
    });
    if (!res) return;
    if (!res.ok) {
      const note = $("google-connect-status");
      if (note) note.textContent = `⚠️ ${res.error}`;
      configMsg(`Google connect failed: ${res.error}`, true);
      return;
    }
    await refreshConfig();
    const parts = [`token saved to ${res.store}`];
    if (res.backup) parts.push(`backup ${res.backup}`);
    if (res.restarted && res.restarted.length) parts.push(`restarted ${res.restarted.join(" + ")}`);
    if (res.closedMcp) parts.push(`${res.closedMcp} MCP connection(s) dropped`);
    configMsg(`Google token updated for ${res.user || "the operator"} — ${parts.join(", ")}.`, false);
  }

  async function refreshConfig() {
    const [c, g] = await Promise.all([api.configWithSources(), api.googleStatus().catch(() => null)]);
    const status = $("config-status");
    configState.google = g && g.ok !== false ? { connected: !!g.connected, user: g.user || null } : { connected: false, user: null };
    configState.values = {};
    configState.dirty = new Set();
    if (c && c.ok !== false && c.present !== undefined) {
      if (c.present) {
        status.innerHTML = `<span class="tag valid">✅ config.json present</span><span class="config-src">using <code>${esc(c.configPath)}</code> — overrides <code>.env</code></span>`;
      } else {
        status.innerHTML = `<span class="tag expired">⚠️ no config.json</span><span class="config-src">falling back to <code>.env</code> — press <b>Save</b> to create config.json from edited values</span>`;
      }
      configState.values = c.values || {};
      configState.trelloBoards = c.trelloBoards || null;
    } else {
      status.innerHTML = `<span class="tag expired">⚠️ config unavailable</span>`;
    }
    renderConfigForm();
    configMsg("");
  }

  $("config-search").addEventListener("input", (e) => {
    // Searches every section, not just the active tab — see renderConfigForm().
    configState.filter = e.target.value;
    renderConfigForm();
  });
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
    const res = await withLoading("Saving config.json…", () => api.configSave(payload), {
      context: "config save",
      slowHint: "Restarting the services this change affects…",
    });
    if (!res) return;
    if (res.ok) {
      const meta = LLM_PROVIDERS[String(res.provider || "deepseek").toLowerCase()] || LLM_PROVIDERS.deepseek;
      let msg = `Saved ${res.count} key(s) → config.json.`;
      if (res.restarted && res.restarted.length) {
        msg += ` LLM services restarted: ${res.restarted.join(", ")}. Provider is now live.`;
      } else {
        msg += ` No LLM services running — start them on the Dashboard to apply (the Chat tab picks up changes immediately).`;
      }
      if (meta.required && !(configState.values[meta.required] && configState.values[meta.required].value)) {
        msg += ` ⚠️ ${meta.label} has no ${meta.required} set — calls will fail until you add it.`;
      }
      // A key-store path or registry change takes effect for THIS window on the next
      // call (the adapter resolves paths per call), so re-probe for real rather than
      // trusting the cached verdict. The webhook server and runner resolve their
      // paths once at import and need a restart — their hints say so.
      if (Object.keys(payload).some((k) => k.startsWith("PKM_"))) {
        pkmState.registry = null; // let the probe use the (possibly new) default
        const c = await loadCaps({ fresh: true });
        msg += ` Key store: ${c.state}${c.reason ? ` — ${c.reason}` : ""}`;
        guarded("licenses", refreshLicenses);
      }
      configMsg(msg);
      refreshConfig();
    } else {
      configMsg(res.error || "Save failed", true);
    }
  });
  $("config-export").addEventListener("click", async () => {
    const res = await withLoading("Exporting config…", () => api.configExport(), { context: "config export" });
    if (!res) return;
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
    const res = await withLoading("Importing config…", () => api.configImport(text), {
      context: "config import",
      slowHint: "Applying and restarting affected services…",
    });
    if (!res) {
      e.target.value = "";
      return;
    }
    if (res.ok) {
      configMsg(`Imported ${res.count} key(s) → config.json. Restart services to apply.`);
      refreshConfig();
    } else {
      configMsg(res.error || "Import failed", true);
    }
    e.target.value = "";
  });

  // ── Usage (DS-mon LLM token usage + push status) ──
  const usageState = { timer: null };
  const fmtNum = (n) => (n == null ? "0" : Number(n).toLocaleString());
  const fmtTokens = (n) => {
    const v = Number(n) || 0;
    if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
    return String(v);
  };

  function usageCard(label, value) {
    return `<div class="usage-card"><div class="usage-card-value">${esc(value)}</div><div class="usage-card-label">${esc(label)}</div></div>`;
  }

  function renderUsageCredits(c) {
    const box = $("usage-credit");
    if (!box) return;
    box.innerHTML =
      c && c.balance != null
        ? `<span class="tag valid">✅ Available</span> <b>${esc(c.balance)}</b> <span class="config-src">DeepSeek credit balance</span>`
        : c
          ? `<span class="tag expired">⚠️ ${esc(c.error || "credit balance unavailable")}</span>`
          : "";
  }

  function usageRows(map) {
    return (
      Object.entries(map || {})
        .sort((a, b) => b[1].totalTokens - a[1].totalTokens)
        .map(
          ([k, v]) =>
            `<tr><td>${esc(k)}</td><td>${fmtNum(v.calls)}</td><td>${fmtTokens(v.promptTokens)}</td><td>${fmtTokens(v.completionTokens)}</td><td>${fmtTokens(v.totalTokens)}</td></tr>`,
        )
        .join("") || '<tr><td colspan="5" class="empty">no data</td></tr>'
    );
  }

  function usageTable(title, map) {
    return `<div class="usage-table-wrap"><h4>${esc(title)}</h4><table><thead><tr><th>Key</th><th>Calls</th><th>Input</th><th>Output</th><th>Total</th></tr></thead><tbody>${usageRows(map)}</tbody></table></div>`;
  }

  function renderUsage(agg, credits) {
    if (!agg || agg.ok === false) {
      $("usage-status").innerHTML = '<span class="tag expired">⚠️ usage unavailable</span>';
      return;
    }
    const d = agg.dsmon || {};
    // Paused = a PERMANENT failure (bad/missing push token). It must not render as
    // the transient "push failed" tag, which reads as "will retry shortly" when in
    // fact nothing is retried until DSMON_PUSH_TOKEN changes.
    const push = d.paused
      ? `<span class="tag expired">⏸️ paused: ${esc(d.reason || "error")} — fix DSMON_PUSH_TOKEN</span>`
      : d.ok === true
        ? `<span class="tag valid">✅ last push ${fmtNum(d.count)} record(s)</span>`
        : d.ok === false
          ? `<span class="tag expired">⚠️ push failed: ${esc(d.error || "error")}</span>`
          : '<span class="tag">no push yet</span>';
    $("usage-status").innerHTML =
      `<span class="tag ${agg.enabled ? "valid" : "expired"}">${agg.enabled ? "enabled" : "disabled"}</span>` +
      `<span class="config-src">${agg.enabled ? `pushing to <code>${esc(agg.pushUrl || "—")}</code>` : "Usage Tracking is off — enable it in ⚙️ Config"}</span>` +
      `<span class="config-src">buffered <b>${fmtNum(d.bufferCount)}</b> record(s) · instance <code>${esc(d.instanceId || "—")}</code></span>` +
      push +
      '<span id="usage-credit"></span>';
    renderUsageCredits(credits);

    const t = agg.totals || {};
    $("usage-cards").innerHTML =
      usageCard("Calls", fmtNum(t.calls)) +
      usageCard("Total Tokens", fmtTokens(t.totalTokens)) +
      usageCard("Input Tokens", fmtTokens(t.promptTokens)) +
      usageCard("Output Tokens", fmtTokens(t.completionTokens));
    $("usage-tables").innerHTML =
      usageTable("By provider", agg.byProvider) + usageTable("By source (flow)", agg.bySource) + usageTable("By model", agg.byModel);
  }

  async function refreshUsage() {
    // Interval comes from config (CREDIT_POLL_INTERVAL); fall back to 60s.
    const cfg = await api.configWithSources();
    const raw = cfg && cfg.values && cfg.values.CREDIT_POLL_INTERVAL ? cfg.values.CREDIT_POLL_INTERVAL.value : "60000";
    const interval = parseInt(raw, 10) || 60000;
    const sel = $("usage-interval");
    if (sel) sel.value = String(interval);

    const [agg, credits] = await Promise.all([api.usageAggregate(), api.usageCredits()]);
    renderUsage(agg, credits);

    if (usageState.timer) clearInterval(usageState.timer);
    usageState.timer = setInterval(async () => renderUsageCredits(await api.usageCredits()), interval);
  }

  $("usage-refresh").addEventListener("click", refreshUsage);
  $("usage-interval").addEventListener("change", async (e) => {
    const res = await api.configSave({ CREDIT_POLL_INTERVAL: String(e.target.value) });
    if (res && res.ok) refreshUsage();
  });
  $("usage-flush").addEventListener("click", async () => {
    const res = await withLoading("Pushing buffered usage to DS-mon…", () => api.usageFlush(), { context: "usage flush" });
    // usage:flush resolves even when the push failed, so report the real outcome
    // (200 / 401-403 token problem / network) instead of a blanket success.
    if (res) {
      if (res.ok) {
        toast(`Pushed ${fmtNum(res.count || 0)} record(s) to DS-mon.`, "ok");
      } else if (res.paused) {
        const why = res.reason === "token-missing" ? "No DSMON_PUSH_TOKEN configured" : "DS-mon rejected the push token";
        toast(`⚠️ ${why} — ${fmtNum(res.bufferCount || 0)} record(s) retained. Fix DSMON_PUSH_TOKEN in ⚙️ Config.`, "err");
      } else {
        toast(`⚠️ Push failed: ${res.error || "unknown error"}`, "err");
      }
    }
    await refreshUsage();
  });

  // ── Appearance (theme + accent color + font size + sidebar width) ──
  // Every token write lives in tokens.js (`window.Appearance`), so this renderer and
  // the main process's window background colour cannot disagree on the palette.
  const Appearance = window.Appearance;

  let appearanceInfo = { ...Appearance.DEFAULT_APPEARANCE };

  /** Reflect the current settings in the panel's own controls. */
  function syncAppearanceControls() {
    document.querySelectorAll(".theme-option").forEach((b) =>
      b.classList.toggle("active", b.dataset.theme === appearanceInfo.theme),
    );
    // "" is a meaningful value here: it means "the theme's built-in accent".
    document.querySelectorAll(".accent-swatch").forEach((b) =>
      b.classList.toggle("active", (b.dataset.accent || "") === (appearanceInfo.accentColor || "")),
    );
    document.querySelectorAll(".font-preset").forEach((b) =>
      b.classList.toggle("active", b.dataset.font === appearanceInfo.fontSize),
    );
    const hex = $("accent-hex");
    if (hex) hex.textContent = appearanceInfo.accentColor || "theme default";
    const picker = $("accent-picker");
    if (picker) picker.value = appearanceInfo.accentColor || Appearance.DEFAULT_APPEARANCE.accentColor;

    const range = $("sidebar-width-range");
    if (range) range.value = String(appearanceInfo.sidebarWidth);
    const label = $("sidebar-width-value");
    if (label) label.textContent = `${appearanceInfo.sidebarWidth} px`;
  }

  /** Apply tokens, then re-arm OS theme tracking if we are following the system. */
  function paintAppearance() {
    Appearance.applyAppearance(appearanceInfo);
    syncAppearanceControls();
    Appearance.unwatchSystemTheme();
    if (appearanceInfo.theme === "system") {
      // `applyAppearance` re-resolves "system" through matchMedia, so this fires
      // once per real OS change and needs no `effective` round-trip from main.
      Appearance.watchSystemTheme(() => paintAppearance());
    }
  }

  async function refreshAppearance() {
    const t = await api.getTheme();
    if (!t || !t.theme) return;
    appearanceInfo = Appearance.appearanceFromInfo(t);
    paintAppearance();
  }

  async function saveAppearance(patch) {
    const t = await api.setAppearance(patch);
    if (t) {
      appearanceInfo = Appearance.appearanceFromInfo(t);
      paintAppearance();
    }
  }

  /** Sidebar width is a per-machine preference, so it lives in localStorage. */
  function setSidebarWidth(px, persist) {
    appearanceInfo.sidebarWidth = Appearance.clampSidebarWidth(px);
    Appearance.applyAppearance(appearanceInfo);
    syncAppearanceControls();
    if (persist) Appearance.saveSidebarWidth(appearanceInfo.sidebarWidth);
  }

  function bindSidebarResize() {
    const handle = $("sidebar-resize");
    if (handle) {
      handle.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        const startX = e.clientX;
        const startWidth = appearanceInfo.sidebarWidth;
        const onMove = (ev) => setSidebarWidth(startWidth + (ev.clientX - startX), false);
        const onUp = () => {
          handle.removeEventListener("pointermove", onMove);
          handle.removeEventListener("pointerup", onUp);
          setSidebarWidth(appearanceInfo.sidebarWidth, true);
        };
        handle.addEventListener("pointermove", onMove);
        handle.addEventListener("pointerup", onUp);
      });
    }

    const range = $("sidebar-width-range");
    if (range) {
      range.addEventListener("input", (e) => setSidebarWidth(e.target.value, false));
      // Persist on release rather than on every input event.
      range.addEventListener("change", (e) => setSidebarWidth(e.target.value, true));
    }
  }

  document.querySelectorAll(".theme-option").forEach((b) =>
    b.addEventListener("click", () => saveAppearance({ theme: b.dataset.theme })),
  );
  document.querySelectorAll(".accent-swatch").forEach((b) =>
    b.addEventListener("click", () => saveAppearance({ accentColor: b.dataset.accent || "" })),
  );
  $("accent-picker")?.addEventListener("change", (e) => saveAppearance({ accentColor: e.target.value }));
  document.querySelectorAll(".font-preset").forEach((b) =>
    b.addEventListener("click", () => saveAppearance({ fontSize: b.dataset.font })),
  );
  bindSidebarResize();

  // ── About (About / Guide tabs; Guide is the electron/docs markdown browser) ──
  async function refreshAbout() {
    const r = await api.appVersion();
    const el = $("about-version");
    el.textContent = r && r.ok ? `${r.name} — v${r.version}` : "Dev Centre";
    // Mirror the identity into the status bar. `r.name` is `app.getName()`, which
    // in a packaged build is the same string the OS shows in the dock.
    if (r && r.ok) setStatusText("status-app", `${r.name} v${r.version}`, "");
  }

  // Guide = rendered markdown docs from electron/docs/*.md (served via main IPC).
  // Preferred order + friendly labels for the docs shipped with the app; any extra
  // .md files found on disk are appended alphabetically after these.
  const GUIDE_DOCS = [
    { file: "README.md", title: "🏠 Overview & Getting Started" },
    { file: "netlify-setup.md", title: "🌐 Netlify / Frontdesk Setup" },
    { file: "dashboard.md", title: "📊 Dashboard" },
    { file: "queue.md", title: "🔴 Queue" },
    { file: "logs.md", title: "📄 Logs" },
    { file: "sessions.md", title: "👥 Sessions" },
    { file: "keys.md", title: "🔑 Key Manager" },
    { file: "accounts.md", title: "🔐 Accounts & Keys" },
    { file: "config.md", title: "⚙️ Config" },
    { file: "usage.md", title: "📈 Usage" },
    { file: "tools.md", title: "🧰 Tools" },
    { file: "whatsapp.md", title: "💬 WhatsApp" },
    { file: "scripts.md", title: "📜 Scripts" },
    { file: "chat.md", title: "💬 Chat" },
    { file: "appearance.md", title: "🎨 Appearance" },
    { file: "about.md", title: "ℹ️ About" },
  ];
  const guideState = { docs: [], current: null };

  async function refreshGuide() {
    const res = await api.docsList();
    const files = (res && res.ok && res.files) || [];
    const byFile = {};
    for (const f of files) byFile[f.file] = f.title || f.file;
    const known = new Set(GUIDE_DOCS.map((d) => d.file));
    const ordered = GUIDE_DOCS.filter((d) => byFile[d.file]);
    for (const f of files) {
      if (!known.has(f.file)) ordered.push({ file: f.file, title: byFile[f.file] || f.file });
    }
    guideState.docs = ordered;
    const nav = $("guide-nav");
    const body = $("guide-body");
    if (!ordered.length) {
      nav.innerHTML = "";
      body.innerHTML = '<p class="hint">No guides found under electron/docs/.</p>';
      guideState.current = null;
      return;
    }
    nav.innerHTML = ordered
      .map((d) => `<button type="button" class="guide-item" data-doc="${escAttr(d.file)}">${esc(d.title)}</button>`)
      .join("");
    nav.querySelectorAll("[data-doc]").forEach((b) => b.addEventListener("click", () => loadGuideDoc(b.dataset.doc)));
    const cur = guideState.current && byFile[guideState.current] ? guideState.current : ordered[0].file;
    loadGuideDoc(cur);
  }

  async function loadGuideDoc(file) {
    const body = $("guide-body");
    const nav = $("guide-nav");
    guideState.current = file;
    nav.querySelectorAll("[data-doc]").forEach((b) => b.classList.toggle("active", b.dataset.doc === file));
    const status = $("guide-status");
    if (status) status.textContent = file;
    body.innerHTML = '<p class="hint">Loading…</p>';
    const res = await api.docsGet(file);
    body.innerHTML =
      res && res.ok
        ? window.renderMarkdown(res.content)
        : `<p class="hint">⚠️ Could not load ${esc(file)}${res && res.error ? ": " + esc(res.error) : ""}.</p>`;
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
    if (sub === "guide" && !guideState.docs.length) refreshGuide();
  }
  $("about-sub-info").addEventListener("click", () => setAboutTab("info"));
  $("about-sub-guide").addEventListener("click", () => setAboutTab("guide"));
  $("guide-refresh").addEventListener("click", refreshGuide);
  // Route external links inside rendered guides through the host shell.
  $("guide-body").addEventListener("click", (e) => {
    const a = e.target && e.target.closest ? e.target.closest("a[data-ext]") : null;
    if (!a) return;
    e.preventDefault();
    api.openExternal(a.getAttribute("href"));
  });

  // ── Chat (agentic for the operator channel; each chat persists to its own log file) ──
  const chatState = { sessions: [], current: null, entries: [], sending: false, pending: null };

  // Show the currently active LLM provider/model in the Chat header.
  async function refreshLlmChip() {
    const el = $("chat-provider");
    if (!el) return;
    const c = await api.config();
    if (c && c.llmProvider) el.textContent = `${c.llmProvider} · ${c.llmModel || ""}`;
    else el.textContent = "";
  }

  async function refreshChatSessions() {
    const res = await api.chatList();
    chatState.sessions = (res.ok && res.sessions) || [];
    refreshLlmChip();
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
    chatState.pending = null;
    const res = await api.chatHistory(id);
    chatState.entries = (res.ok && res.entries) || [];
    renderChat();
    refreshChatSessions();
  }
  function fmtArgs(args) {
    try {
      return JSON.stringify(args || {}, null, 0);
    } catch {
      return String(args);
    }
  }
  function renderChat() {
    const box = $("chat-box");
    if (!chatState.current) {
      box.innerHTML = '<div class="empty">Start a new chat or pick a session.</div>';
      return;
    }
    const rows = [];
    for (const e of chatState.entries) {
      const role = e.role === "user" ? "user" : e.role === "system" ? "system" : e.role === "tool" ? "tool" : "assistant";
      if (role === "system") {
        if (e.content === "session created") continue;
        rows.push(`<div class="chat-msg system"><div class="chat-role">System</div><div class="chat-body">${esc(e.content || "")}</div></div>`);
        continue;
      }
      if (role === "tool") {
        const prefix = e.error && !e.ok ? "⚠️ " : "";
        rows.push(`<div class="chat-msg tool"><div class="chat-role">${window.Icons.svg("tools", 12)}${esc(e.name || "tool")}</div><div class="chat-body">${esc(prefix + String(e.content || ""))}</div></div>`);
        continue;
      }
      const who = role === "user" ? "You" : "Agent";
      const chips = [];
      if (e.model) chips.push(`<span class="chat-model">${esc(e.model)}</span>`);
      const toks = usageTotal(e.usage);
      if (toks) chips.push(`<span class="chat-tok">${toks} tok</span>`);
      const meta = chips.length ? ` · ${chips.join(" · ")}` : "";
      // Assistant turns that ran tools show chips (auto read-only or approved actions).
      if (role === "assistant" && Array.isArray(e.toolCalls) && e.toolCalls.length) {
        for (const tc of e.toolCalls) {
          rows.push(`<div class="chat-tool"><span class="chat-tool-name">${esc(tc.name)}</span><code class="chat-tool-args">${esc(fmtArgs(tc.args))}</code></div>`);
        }
        continue;
      }
      rows.push(`<div class="chat-msg ${role}"><div class="chat-role">${who}${meta}</div><div class="chat-body">${esc(e.content || "")}</div></div>`);
    }
    // Live approval card for a pending mutating tool call (args are editable).
    if (chatState.pending && chatState.sending) {
      const p = chatState.pending;
      rows.push(
        `<div class="chat-approve">` +
          `<div class="chat-approve-title">⚠️ Action needs your approval</div>` +
          `<div class="chat-approve-name">${esc(p.name)}</div>` +
          `<textarea class="chat-approve-edit" spellcheck="false">${esc(fmtArgsJson(p.args))}</textarea>` +
          `<div class="chat-approve-btns">` +
          `<button class="primary" data-approve="1">Approve</button>` +
          `<button data-deny="1">Deny</button>` +
          `<button data-stopchat="1">■ Stop</button>` +
          `</div>` +
          `<div class="chat-approve-err" data-approve-err=""></div>` +
        `</div>`,
      );
    }
    // Tool-step budget exhausted → offer to carry on (history is persisted).
    const lastEntry = chatState.entries[chatState.entries.length - 1];
    if (!chatState.sending && lastEntry && lastEntry.role === "assistant" && isMaxStepsMsg(lastEntry.content)) {
      rows.push(
        `<div class="chat-continue">` +
          `<span>Tool-step limit reached for that message.</span>` +
          `<button id="chat-continue" class="primary">${iconLabel("play", 13, "Continue")}</button>` +
        `</div>`,
      );
    }
    box.innerHTML = rows.join("") || '<div class="empty">No messages.</div>';
    const ap = box.querySelector("[data-approve]");
    if (ap) ap.addEventListener("click", approveChat);
    const dn = box.querySelector("[data-deny]");
    if (dn) dn.addEventListener("click", denyChat);
    const st = box.querySelector("[data-stopchat]");
    if (st) st.addEventListener("click", stopChat);
    const cont = box.querySelector("#chat-continue");
    if (cont) cont.addEventListener("click", continueChat);
    box.scrollTop = box.scrollHeight;
  }

  // The agent stopped because it used its whole tool-step budget for one message.
  // The transcript is persisted, so a plain "continue" resumes with full context.
  function isMaxStepsMsg(text) {
    return typeof text === "string" && text.startsWith("[stopped: reached the maximum number of tool steps");
  }
  function continueChat() {
    if (chatState.sending) return;
    $("chat-input").value = "continue";
    sendChat();
  }
  function fmtArgsJson(args) {
    try {
      return JSON.stringify(args || {}, null, 2);
    } catch {
      return String(args || "");
    }
  }
  function usageTotal(usage) {
    if (!usage || typeof usage !== "object") return 0;
    if (usage.total_tokens) return usage.total_tokens;
    return (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
  }
  function approveChat() {
    const p = chatState.pending;
    if (!p) return;
    const edit = document.querySelector(".chat-approve-edit");
    const errEl = document.querySelector("[data-approve-err]");
    let editedArgs;
    if (edit && edit.value.trim()) {
      try {
        editedArgs = JSON.parse(edit.value);
      } catch {
        if (errEl) errEl.textContent = "Invalid JSON — fix it or Deny.";
        return;
      }
    }
    chatState.pending = null;
    renderChat();
    api.chatDecide(p.token, true, editedArgs !== undefined && typeof editedArgs === "object" ? editedArgs : undefined).catch(() => {});
  }
  function denyChat() {
    const p = chatState.pending;
    if (!p) return;
    chatState.pending = null;
    renderChat();
    api.chatDecide(p.token, false).catch(() => {});
  }
  async function stopChat() {
    if (chatState.current) {
      try {
        await api.chatStop(chatState.current);
      } catch {
        /* ignore */
      }
    }
    chatState.pending = null;
    renderChat();
  }
  // Live entries/approvals streamed from the main-process agentic loop.
  function appendChatStep(data) {
    if (!data) return;
    if (data.sessionId && chatState.current !== data.sessionId) return; // live session only
    if (data.kind === "approval") {
      chatState.pending = { token: data.token, name: data.name, args: data.args };
      renderChat();
      return;
    }
    if (data.entry) {
      const last = chatState.entries[chatState.entries.length - 1];
      if (last && last.ts === data.entry.ts) return;
      chatState.entries.push(data.entry);
      renderChat();
    }
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
    chatState.pending = null;
    chatMsg("… agent running — reads run automatically; mutating actions ask for approval");
    const startLen = chatState.entries.length;
    chatState.entries.push({ role: "user", content: text });
    renderChat();
    let res;
    try {
      res = await api.chatSend(chatState.current, text);
    } catch (err) {
      res = { ok: false, error: err.message || "send failed" };
    }
    chatState.sending = false;
    $("chat-send").disabled = false;
    chatState.pending = null;
    if (!res.ok) {
      // Main normally broadcasts the ⚠ error entry; add a fallback if it didn't.
      if (chatState.entries.length === startLen + 1) {
        chatState.entries.push({ role: "assistant", content: `⚠️ ${res.error || "send failed"}` });
      }
      chatMsg(res.error || "send failed", true);
    } else {
      // Streamed steps already appended the assistant reply; fallback if none arrived.
      if (chatState.entries.length === startLen + 1 && res.reply) {
        chatState.entries.push({ role: "assistant", content: res.reply, model: res.model });
      }
      chatMsg("sent");
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
    chatState.pending = null;
    renderChat();
    refreshChatSessions();
  });
  $("chat-refresh").addEventListener("click", () => {
    if (chatState.current) openChat(chatState.current);
    else refreshChatSessions();
  });
  // Subscribe to live agent steps (tool chips, results, approval requests).
  subscribe("onChatStep", appendChatStep);

  // ── Scripts (scripts/user runner — manual run only) ──
  const scriptState = { list: [], runs: [], outputs: {}, preflight: null, form: {}, open: new Set() };
  const scriptCap = 2000; // max buffered lines per script

  function appendScriptOutput(script, text) {
    if (!script) return;
    const arr = scriptState.outputs[script] || (scriptState.outputs[script] = []);
    arr.push(...String(text).split("\n"));
    if (arr.length > scriptCap) arr.splice(0, arr.length - scriptCap);
    const el = document.getElementById(`script-out-${script}`);
    if (el) {
      const stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
      el.textContent = arr.join("\n");
      if (stick) el.scrollTop = el.scrollHeight;
      // This writes the <pre> in place rather than re-rendering the card, so the
      // Clear button's disabled state (baked in at first paint, when the buffer
      // was still empty) has to be refreshed by hand or it never un-disables.
      const clear = el.closest(".script-card")?.querySelector("[data-clearout]");
      if (clear) clear.disabled = false;
    }
  }

  function renderScriptsPreflight() {
    const p = scriptState.preflight;
    const el = $("scripts-preflight");
    if (!el) return;
    if (!p) {
      el.innerHTML = "";
      return;
    }
    const tool = (name, ok, ver) =>
      `<span class="tag ${ok ? "valid" : "expired"}">${esc(name)} ${ok ? "✓" + (ver ? " " + esc(ver) : "") : "✗"}</span>`;
    const creds = p.awsCreds
      ? `<span class="tag valid">AWS creds ✓</span>`
      : `<span class="tag expired">AWS creds ✗ (set in ⚙️ Config or ~/.aws)</span>`;
    const region = p.awsRegion ? ` · region <code>${esc(p.awsRegion)}</code>` : "";
    const profile = p.awsProfile ? ` · profile <code>${esc(p.awsProfile)}</code>` : "";
    el.innerHTML = `<div class="script-preflight">${tool("aws", p.aws, p.awsVersion)} ${tool("node", p.node)} ${tool("python3", p.python3)} ${creds}${region}${profile}</div>`;
  }

  // A script gets a generated form when its manifest declares fields.
  function scriptHasForm(s) {
    const m = s && s.manifest;
    return !!m && !!m.params && !!m.positionals && m.params.length + m.positionals.length > 0;
  }

  // Per-script form state (script name -> field key -> value) so the 15s
  // auto-refresh re-renders without wiping what the user typed.
  function sfStore(name) {
    return (scriptState.form[name] = scriptState.form[name] || {});
  }

  function scriptFieldHTML(s, p) {
    const key = p.key;
    const st = sfStore(s.name);
    const cur = key in st ? st[key] : p.default !== undefined && p.default !== null ? String(p.default) : "";
    const ph = p.placeholder ? ` placeholder="${escAttr(p.placeholder)}"` : "";
    const requiredTag = p.required ? '<span class="cfg-required">required</span>' : "";
    const help = p.help ? `<span class="script-help">${esc(p.help)}</span>` : "";
    const label = `<span class="script-label" title="${escAttr(p.arg || p.key)}">${esc(p.label || p.key)} ${requiredTag}</span>`;

    if (p.type === "flag") {
      const on = key in st ? !!st[key] : !!p.default;
      let html = `<label class="script-check"><input type="checkbox" data-sf="${escAttr(key)}" ${on ? "checked" : ""}/><span>${esc(p.label || key)}</span>${requiredTag}</label>`;
      if (p.optionalValue) {
        const vk = key + ":value";
        const vcur = vk in st ? st[vk] : "";
        const browse =
          p.valueType === "file"
            ? `<button type="button" class="browse-btn" data-browsefor="${escAttr(p.browseFor || "openFile")}" data-browsetarget="${escAttr(vk)}">Browse…</button>`
            : "";
        html += `<div class="script-optval${on ? "" : " off"}"><span class="script-label-small">${esc(p.arg || "")}</span><input data-sf="${escAttr(vk)}" value="${escAttr(vcur)}" placeholder="${escAttr(p.valuePlaceholder || "")}" spellcheck="false"/>${browse}</div>`;
      }
      return `<div class="script-field flag">${html}${help}</div>`;
    }
    if (p.type === "dropdown") {
      const opts = Array.isArray(p.options) ? p.options : [];
      const optsHtml =
        (!p.required && !opts.some((o) => String(o) === cur) ? `<option value=""></option>` : "") +
        opts.map((o) => `<option value="${escAttr(o)}" ${String(o) === cur ? "selected" : ""}>${esc(o)}</option>`).join("");
      return `<div class="script-field">${label}<select data-sf="${escAttr(key)}">${optsHtml}</select>${help}</div>`;
    }
    if (p.type === "file") {
      return `<div class="script-field">${label}<div class="script-file-row"><input data-sf="${escAttr(key)}" value="${escAttr(cur)}" placeholder="${escAttr(p.placeholder || "path")}" spellcheck="false"/><button type="button" class="browse-btn" data-browsefor="${escAttr(p.browseFor || "openFile")}" data-browsetarget="${escAttr(key)}">Browse…</button></div>${help}</div>`;
    }
    const t = p.type === "number" ? "number" : "text";
    return `<div class="script-field">${label}<input type="${t}" data-sf="${escAttr(key)}" value="${escAttr(cur)}"${ph} spellcheck="false"/>${help}</div>`;
  }

  function scriptCardHTML(s) {
    const run = scriptState.runs.find((r) => r.script === s.name);
    const out = (scriptState.outputs[s.name] || []).join("\n");
    const hasForm = scriptHasForm(s);
    const argsBox = hasForm
      ? `<input class="script-args script-extra" data-sfextra="1" placeholder="extra args: --verbose  |  or [&quot;--verbose&quot;]" spellcheck="false"/>`
      : `<input class="script-args" placeholder="args: --dry-run -i i-0abc123  |  or [&quot;--dry-run&quot;,&quot;-i&quot;,&quot;i-0abc123&quot;]" spellcheck="false"/>`;
    // Clearing is renderer-only: renderScriptsList() repaints the <pre> from
    // scriptState.outputs, so dropping the buffer is the whole operation.
    const hasOut = (scriptState.outputs[s.name] || []).length > 0;
    const controls = `
        <div class="script-controls">
          ${argsBox}
          <button class="run-btn" data-run="${escAttr(s.name)}" ${run ? "disabled" : ""}>${iconLabel("play", 13, "Run")}</button>
          <button class="stop-btn" data-stop="${escAttr(s.name)}" ${run ? "" : "disabled"}>${iconLabel("stop", 13, "Stop")}</button>
          <button class="script-clear" data-clearout="${escAttr(s.name)}" ${hasOut ? "" : "disabled"} title="Clear this script's output">${iconLabel("trash", 13, "Clear")}</button>
        </div>`;
    const form = hasForm
      ? `<div class="script-form">${[...(s.manifest.positionals || []), ...(s.manifest.params || [])].map((p) => scriptFieldHTML(s, p)).join("")}</div>`
      : "";
    // Everything below the head (usage/form/controls/output) is collapsible;
    // cards start collapsed. Expansion state persists in scriptState.open.
    const isOpen = scriptState.open.has(s.name);
    const body = `<div class="script-body">${s.usage ? `<div class="script-usage">${esc(s.usage)}</div>` : ""}${form}${controls}<pre class="script-out log-box" id="script-out-${escAttr(s.name)}">${esc(out)}</pre></div>`;
    return `
        <div class="script-card${isOpen ? "" : " collapsed"}" data-card="${escAttr(s.name)}">
          <div class="script-head" data-script-toggle="${escAttr(s.name)}" title="click to expand/collapse">
            <span class="caret">${isOpen ? "▾" : "▸"}</span>
            <strong class="script-name">${esc(s.name)}</strong>
            <span class="tag">${esc(s.runner || "no runner")}</span>
            <span class="script-status ${run ? "running" : ""}">${run ? `<span class="status-dot"></span>running (pid ${run.pid})` : "idle"}</span>
            ${hasForm ? '<span class="tag valid" title="Fields from ' + escAttr(s.name) + '.params.json">form</span>' : ""}
          </div>
          ${body}
        </div>`;
  }

  function toggleScriptCard(card, name) {
    if (!card || !name) return;
    const caret = card.querySelector("[data-script-toggle] .caret");
    if (scriptState.open.has(name)) {
      scriptState.open.delete(name);
      card.classList.add("collapsed");
      if (caret) caret.textContent = "▸";
    } else {
      scriptState.open.add(name);
      card.classList.remove("collapsed");
      if (caret) caret.textContent = "▾";
    }
  }

  function bindScriptCard(card, s) {
    const name = s.name;
    // Collapse/expand on header click.
    card.querySelector("[data-script-toggle]")?.addEventListener("click", () => toggleScriptCard(card, name));
    // Keep a running script expanded so its live output stays visible.
    if (scriptState.runs.some((r) => r.script === name)) scriptState.open.add(name);
    // Persist edits so re-renders (run, 15s refresh) keep what was typed.
    card.querySelectorAll("[data-sf]").forEach((el) => {
      const save = () => {
        const st = sfStore(name);
        st[el.dataset.sf] = el.type === "checkbox" ? el.checked : el.value;
      };
      el.addEventListener("input", save);
      el.addEventListener("change", save);
    });
    // Optional-value flags: hide each value row until its own flag is checked.
    card.querySelectorAll(".script-field.flag").forEach((field) => {
      const chk = field.querySelector('.script-check input[type="checkbox"]');
      const row = field.querySelector(".script-optval");
      if (chk && row) chk.addEventListener("change", () => row.classList.toggle("off", !chk.checked));
    });

    const runBtn = card.querySelector("[data-run]");
    if (runBtn)
      runBtn.addEventListener("click", async () => {
        const st = scriptState.list.find((x) => x.name === name);
        if (!st) return;
        let payload;
        if (scriptHasForm(st)) {
          const values = {};
          for (const p of [...(st.manifest.positionals || []), ...(st.manifest.params || [])]) {
            const el = card.querySelector(`[data-sf="${p.key}"]`);
            if (!el) continue;
            if (p.type === "flag") {
              values[p.key] = el.checked;
              if (p.optionalValue) {
                const ve = card.querySelector(`[data-sf="${p.key}:value"]`);
                if (ve) values[p.key + ":value"] = ve.value;
              }
            } else {
              values[p.key] = el.value;
            }
          }
          const missing = [...(st.manifest.positionals || []), ...(st.manifest.params || [])].filter((p) => {
            if (!p.required) return false;
            return p.type === "flag" ? !values[p.key] : !String(values[p.key] || "").trim();
          });
          if (missing.length) {
            appendScriptOutput(name, `⚠️ ${missing.map((p) => `"${p.label || p.key}" is required`).join("; ")}\n`);
            return;
          }
          const extraEl = card.querySelector("[data-sfextra]");
          payload = { values, extra: extraEl ? extraEl.value : "" };
        } else {
          const argsEl = card.querySelector(".script-args");
          payload = argsEl ? argsEl.value : "";
        }
        const res = await api.scriptsRun(name, payload);
        if (!res.ok) {
          appendScriptOutput(name, `⚠️ ${res.error}\n`);
          return;
        }
        scriptState.runs.push({ script: name, runId: res.runId, pid: res.pid });
        scriptState.open.add(name); // expand so live output is visible
        renderScriptsList();
      });
    const stopBtn = card.querySelector("[data-stop]");
    if (stopBtn)
      stopBtn.addEventListener("click", async () => {
        await api.scriptsStop(name);
        appendScriptOutput(name, "■ stopped by user\n");
        scriptState.runs = scriptState.runs.filter((r) => r.script !== name);
        renderScriptsList();
      });
    const clearBtn = card.querySelector("[data-clearout]");
    if (clearBtn)
      clearBtn.addEventListener("click", () => {
        delete scriptState.outputs[name];
        renderScriptsList();
      });
    card.querySelectorAll("[data-browsetarget]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const res = await api.scriptsPick({ browseFor: btn.dataset.browsefor || "openFile" });
        if (!res.ok) {
          appendScriptOutput(name, `⚠️ ${res.error}\n`);
          return;
        }
        if (res.canceled || !res.path) return;
        const targetKey = btn.dataset.browsetarget;
        sfStore(name)[targetKey] = res.path;
        const target = card.querySelector(`[data-sf="${targetKey}"]`);
        if (target) target.value = res.path;
      }),
    );
  }

  function renderScriptsList() {
    const box = $("scripts-list");
    if (!box) return;
    if (!scriptState.list.length) {
      box.innerHTML = '<div class="empty">No scripts found under scripts/user/.</div>';
      return;
    }
    box.innerHTML = scriptState.list.map(scriptCardHTML).join("");
    box.querySelectorAll(".script-card").forEach((card) => {
      const nm = card.dataset.card;
      const s = scriptState.list.find((x) => x.name === nm);
      if (s) bindScriptCard(card, s);
    });
  }

  async function refreshScripts() {
    const res = await api.scriptsList();
    if (!res.ok) {
      const box = $("scripts-list");
      if (box) box.innerHTML = `<div class="empty">${esc(res.error || "failed to list")}</div>`;
      return;
    }
    scriptState.list = res.scripts || [];
    scriptState.runs = res.runs || [];
    scriptState.preflight = res.preflight || null;
    renderScriptsPreflight();
    renderScriptsList();
  }
  subscribe("onScriptOutput", (d) => {
    if (d && d.script) appendScriptOutput(d.script, d.text || "");
  });
  subscribe("onScriptsUpdate", (d) => {
    scriptState.runs = (d && d.runs) || [];
    renderScriptsList();
  });
  $("scripts-refresh").addEventListener("click", refreshScripts);

  // ── Queue: collapse / filter / sort ──
  function bindQueueControls() {
    for (const q of Object.keys(QUEUE_IDS)) {
      const ids = QUEUE_IDS[q];
      const st = queueState[q];

      $(ids.toggle)?.addEventListener("click", () => {
        st.collapsed = !st.collapsed;
        // The collapse preference is per-machine UI state, not config.
        try {
          const map = {};
          for (const [k, v] of Object.entries(queueState)) map[k] = v.collapsed;
          localStorage.setItem(QUEUE_COLLAPSE_KEY, JSON.stringify(map));
        } catch {
          /* storage unavailable — the toggle still applies for this session */
        }
        applyQueuePanel(q);
      });

      // Filter and sort re-render from the cache; only Refresh re-fetches.
      $(ids.type)?.addEventListener("change", (e) => {
        st.type = e.target.value;
        paintQueue(q);
      });
      $(ids.sort)?.addEventListener("change", (e) => {
        st.sort = e.target.value;
        paintQueue(q);
      });
      $(ids.search)?.addEventListener("input", (e) => {
        st.search = e.target.value;
        paintQueue(q);
      });

      // Apply a remembered collapse before the first fetch, so the panel does not
      // flash open and then shut.
      applyQueuePanel(q);
    }
  }

  // ── Queue: clear-all (hard-clear a whole queue) ──
  function bindQueueClearAll() {
    const hook = (id, queue, label) => {
      $(id)?.addEventListener("click", async () => {
        if (!window.confirm(`Clear ALL items from the ${label} queue?\nThis permanently removes every item (pending + cleared) from ${queue === "priority" ? "priority.jsonl" : "misc_notifications.jsonl"}.`)) return;
        await api.eventsClearAll(queue);
        refreshQueue();
      });
    };
    hook("queue-clear-priority", "priority", "Priority");
    hook("queue-clear-misc", "misc_notifications", "Misc notifications");
  }

  // ── Log Out (ends the session, stops backend services, returns to the gate) ──
  // The reply is deliberately NOT awaited: main swaps this document for the gate, which
  // destroys the calling renderer, so the promise usually never settles. Same rule gate.js
  // documents for a successful login, in the other direction.
  document.getElementById("logout-btn").addEventListener("click", () => {
    if (window.confirm("Log out of Dev Centre? Backend services will stop.")) api.authLogout();
  });

  // ── Quit (stops backend services via main's before-quit) ──
  document.getElementById("quit-btn").addEventListener("click", () => {
    if (window.confirm("Quit Dev Centre? Backend services will stop.")) api.quit();
  });

  // ── Init ──
  // Each step is isolated: a failure in one must not skip the others (the legacy
  // version ran them bare, so one bad binding silently disabled everything after).
  const safeInit = (label, fn) => {
    try {
      fn();
    } catch (err) {
      reportError(err, label);
    }
  };

  // ── Role ──
  // The two tier_1-only nav buttons ship `hidden` — fail-closed, and _layout.css has to
  // restate `[hidden]` because their `display: flex` would otherwise win — so a tier_2
  // operator never sees a control that could only ever error. They are revealed only for
  // a tier_1 session.
  //
  // This is presentation, not the control. Main refuses the channels behind those tabs
  // outright (TIER_1_ONLY in main/dev-centre-auth.js), and it would not have loaded THIS
  // document at all without a session — the locked screen is gate.html, a separate one.
  safeInit("role", () => {
    // Guarded like every other step here, and `safeInit` is what makes that matter: an
    // unguarded throw would skip the whole rest of the initialisation (the failure the
    // comment above this section is about). It is reachable — `scripts/render-screenshots.mjs`
    // loads this document with no preload at all, and the renderer has no bridge then.
    if (!api || typeof api.authState !== "function") return;
    api
      .authState()
      .then((res) => {
        const state = (res && res.state) || {};
        // Who is signed in, in the sidebar footer. Deliberately BEFORE the tier check below
        // and shown for BOTH tiers: knowing which seat this is is what makes Log Out
        // meaningful, and `state()` only reports the email while a session is live.
        const who = document.getElementById("session-identity");
        if (who) {
          const label = state.email ? `${state.email}${state.role ? ` — ${state.role}` : ""}` : "";
          if (label) {
            who.textContent = label;
            who.title = label;
            who.removeAttribute("hidden");
          }
        }
        if (state.role !== "tier_1") return;
        document.querySelectorAll('[data-role-min="tier_1"]').forEach((el) => el.removeAttribute("hidden"));
      })
      .catch(() => {
        /* leave them hidden: an unreadable role is not a reason to reveal tier_1 controls */
      });
  });

  safeInit("dashboard", refreshDashboard);
  safeInit("config", refreshConfig);
  // ── Notification centre ──
  // The durable feed is owned by the main process (electron/src/main/notifications.js):
  // one JSONL file per day under logs/notifications/feed/. This view renders and
  // acknowledges only — the read marks live in main, so the dots survive a restart
  // and cannot drift from the list.
  const NOTIF_COLS = [
    { key: "ts", label: "Time" },
    { key: "source", label: "Source" },
    { key: "level", label: "Level" },
    { key: "title", label: "Notification" },
  ];
  /** Notification source → the sidebar tab that acknowledges it. */
  const NOTIF_TAB = { queue: "queue", logs: "logs", chat: "chat", dashboard: "dashboard", sessions: "sessions", scripts: "scripts" };
  const NOTIF_COLLAPSE_KEY = "notif-collapsed-days";
  const notifState = {
    rows: [],
    counts: null,
    sort: "ts",
    dir: -1,
    source: "",
    level: "",
    query: "",
    unreadOnly: false,
    expanded: new Set(),
    collapsed: new Set(),
  };

  function loadNotifCollapsed() {
    try {
      const raw = JSON.parse(localStorage.getItem(NOTIF_COLLAPSE_KEY) || "[]");
      if (Array.isArray(raw)) notifState.collapsed = new Set(raw);
    } catch {
      /* first run */
    }
  }

  function saveNotifCollapsed() {
    try {
      localStorage.setItem(NOTIF_COLLAPSE_KEY, JSON.stringify([...notifState.collapsed]));
    } catch {
      /* storage blocked — the panel still works, it just will not remember */
    }
  }

  /**
   * Unread is derived from main's read marks rather than tracked here: a second
   * source of truth for "has this been seen" is exactly the bug that let the queue
   * and the runner disagree about what had been handled.
   */
  function notifIsUnread(e) {
    const read = notifState.counts?.read || {};
    return Date.parse(e.ts) > Math.max(read.global || 0, read[e.source] || 0);
  }

  function notifHaystack(e) {
    return `${e.title} ${e.body || ""} ${e.source} ${e.level}`.toLowerCase();
  }

  /** Paint every sidebar dot from the counts main handed us. */
  function paintNotifDots() {
    const bySource = notifState.counts?.bySource || {};
    for (const [source, tab] of Object.entries(NOTIF_TAB)) {
      const btn = document.querySelector(`#sidebar-nav .sidebar-btn[data-tab="${tab}"]`);
      if (!btn) continue;
      const n = bySource[source] || 0;
      if (n > 0) btn.setAttribute("data-unread", "1");
      else btn.removeAttribute("data-unread");
      btn.title = n > 0 ? `${n} unread notification${n === 1 ? "" : "s"}` : "";
    }
    const self = document.querySelector('#sidebar-nav .sidebar-btn[data-tab="notifications"]');
    if (self) {
      const total = notifState.counts?.total || 0;
      if (total > 0) self.setAttribute("data-unread", "1");
      else self.removeAttribute("data-unread");
      self.title = total > 0 ? `${total} unread notification${total === 1 ? "" : "s"}` : "";
    }
  }

  /** A source tab clears its own dot; the notification panel clears them all. */
  function acknowledgeTab(tab) {
    if (!notifState.counts) return; // counts not loaded yet — the first refresh paints
    if (tab === "notifications") {
      if (!notifState.counts.total) return;
      void Promise.resolve(api.notificationsRead({ all: true }))
        .then((counts) => {
          notifState.counts = counts || notifState.counts;
          paintNotifDots();
          renderNotifications();
        })
        .catch(() => {});
      return;
    }
    const source = Object.keys(NOTIF_TAB).find((s) => NOTIF_TAB[s] === tab);
    if (!source || !notifState.counts.bySource?.[source]) return;
    void Promise.resolve(api.notificationsRead({ source }))
      .then((counts) => {
        notifState.counts = counts || notifState.counts;
        paintNotifDots();
      })
      .catch(() => {});
  }

  /** Facets come from the data, so a new source needs no change here. */
  function paintNotifSources() {
    const sel = $("notif-source");
    if (!sel) return;
    const sources = notifState.counts?.sources || Object.keys(NOTIF_TAB);
    const unread = notifState.counts?.bySource || {};
    sel.innerHTML =
      `<option value="">All sources</option>` +
      sources.map((s) => `<option value="${escAttr(s)}">${esc(s)}${unread[s] ? ` (${unread[s]})` : ""}</option>`).join("");
    sel.value = notifState.source;
  }

  function renderNotifications() {
    const box = $("notif-box");
    if (!box) return;

    const needle = notifState.query.trim().toLowerCase();
    const filtered = notifState.rows.filter((e) => {
      if (notifState.source && e.source !== notifState.source) return false;
      if (notifState.level && e.level !== notifState.level) return false;
      if (notifState.unreadOnly && !notifIsUnread(e)) return false;
      if (needle && !notifHaystack(e).includes(needle)) return false;
      return true;
    });

    const k = notifState.sort;
    const val = (e) => (k === "ts" ? Date.parse(e.ts || "") || 0 : String(e[k] ?? "").toLowerCase());
    // Same comparator as the sessions table: `-dir` for "a sorts before b" is what
    // makes dir = -1 mean newest-first. Getting the sign the other way round silently
    // renders the list oldest-first, which looks plausible until you read a timestamp.
    const sorted = filtered.slice().sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (av === bv) return 0;
      return av < bv ? -notifState.dir : notifState.dir;
    });

    const count = $("notif-count");
    if (count) {
      const unread = notifState.counts?.total || 0;
      const shown = filtered.length === notifState.rows.length ? `${filtered.length}` : `${filtered.length} of ${notifState.rows.length}`;
      count.textContent = unread ? `${shown} · ${unread} unread` : shown;
    }
    paintNotifSources();

    if (!notifState.rows.length) {
      box.innerHTML =
        '<div class="empty">No notifications yet. They collect here as the app works: frontdesk messages, errors, chat turns, service changes, seat logins and script runs.</div>';
      return;
    }

    const head = `<div class="n-sortrow">${NOTIF_COLS.map((c) => {
      const active = notifState.sort === c.key;
      const arrow = active ? (notifState.dir === -1 ? " ▼" : " ▲") : "";
      return `<button class="n-sort${active ? " n-sort--active" : ""}" data-nsort="${escAttr(c.key)}" title="Sort by ${escAttr(c.label)}">${esc(c.label)}${arrow}</button>`;
    }).join("")}</div>`;

    // One group per day, newest first; the day heading is the collapse handle.
    const groups = new Map();
    for (const e of sorted) {
      const day = String(e.ts).slice(0, 10);
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day).push(e);
    }

    const body = [...groups.entries()]
      .map(([day, items]) => {
        const collapsed = notifState.collapsed.has(day);
        const rows = items
          .map((e) => {
            const open = notifState.expanded.has(e.id);
            const unread = notifIsUnread(e);
            return `<div class="n-row n-row--clickable${open ? " n-row--open" : ""}${unread ? " n-row--unread" : ""}" data-nid="${escAttr(e.id)}" title="${open ? "Click to hide details" : "Click to show details"}">
              <span class="n-when">${esc(new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }))}</span>
              <span class="n-src" data-source="${escAttr(e.source)}">${esc(e.source)}</span>
              <span class="n-level" data-level="${escAttr(e.level)}">${esc(e.level)}</span>
              <span class="n-title">${esc(e.title)}${e.body ? `<span class="n-body">${esc(e.body)}</span>` : ""}</span>
            </div>`;
          })
          .join("");
        return `<div class="n-group${collapsed ? " n-group--collapsed" : ""}">
          <button class="n-head" data-nday="${escAttr(day)}" title="Show or hide this day"><span class="n-caret">${collapsed ? "▸" : "▾"}</span>${esc(day)}<span class="n-count">${items.length}</span></button>
          <div class="n-rows">${rows}</div>
        </div>`;
      })
      .join("");

    box.innerHTML = head + body;
    if (!body) box.innerHTML = head + '<div class="n-empty">Nothing matches those filters.</div>';

    box.querySelectorAll("[data-nsort]").forEach((b) =>
      b.addEventListener("click", () => {
        const key = b.dataset.nsort;
        if (notifState.sort === key) notifState.dir *= -1;
        else {
          notifState.sort = key;
          // Newest-first for time; A→Z for the text columns.
          notifState.dir = key === "ts" ? -1 : 1;
        }
        renderNotifications();
      }),
    );
    box.querySelectorAll("[data-nday]").forEach((b) =>
      b.addEventListener("click", () => {
        const day = b.dataset.nday;
        if (notifState.collapsed.has(day)) notifState.collapsed.delete(day);
        else notifState.collapsed.add(day);
        saveNotifCollapsed();
        renderNotifications();
      }),
    );
    box.querySelectorAll("[data-nid]").forEach((row) =>
      row.addEventListener("click", () => {
        const id = row.dataset.nid;
        if (notifState.expanded.has(id)) notifState.expanded.delete(id);
        else notifState.expanded.add(id);
        renderNotifications();
      }),
    );
  }

  async function refreshNotifications() {
    const res = await api.notificationsList({ limit: 500 });
    notifState.rows = (res && res.items) || [];
    notifState.counts = (res && res.counts) || null;
    paintNotifDots();
    renderNotifications();
  }

  /** Counts only — keeps the dots honest without rebuilding the panel. */
  async function refreshNotifCounts() {
    const res = await api.notificationsList({ limit: 1 });
    notifState.counts = (res && res.counts) || null;
    paintNotifDots();
  }

  function bindNotifications() {
    loadNotifCollapsed();
    $("notif-search")?.addEventListener("input", (e) => {
      notifState.query = e.target.value;
      renderNotifications();
    });
    $("notif-source")?.addEventListener("change", (e) => {
      notifState.source = e.target.value;
      renderNotifications();
    });
    $("notif-level")?.addEventListener("change", (e) => {
      notifState.level = e.target.value;
      renderNotifications();
    });
    $("notif-unread")?.addEventListener("change", (e) => {
      notifState.unreadOnly = e.target.checked;
      renderNotifications();
    });
    $("notif-refresh")?.addEventListener("click", () => guarded("notifications", refreshNotifications));
    $("notif-clear")?.addEventListener("click", async () => {
      try {
        await api.notificationsClear();
        notifState.rows = [];
        await refreshNotifications();
        toast("Notifications cleared", "ok");
      } catch (err) {
        reportError(err, "notifications:clear");
      }
    });
    // Live rows: a new notification moves the dots immediately, and lands in the
    // list without a round trip when the panel is already open.
    subscribe("onNotification", (entry) => {
      if (!entry || !entry.id) return;
      notifState.rows = [entry, ...notifState.rows].slice(0, 500);
      if (notifState.counts) {
        notifState.counts.bySource[entry.source] = (notifState.counts.bySource[entry.source] || 0) + 1;
        notifState.counts.total = (notifState.counts.total || 0) + 1;
      }
      paintNotifDots();
      if ($("tab-notifications")?.classList.contains("active")) renderNotifications();
    });
  }

  safeInit("appearance", refreshAppearance);
  safeInit("about", refreshAbout);
  // Probe the key store up front, so the status pill and every pkm control are
  // correct before the Key Manager is ever opened. Nothing here mints or revokes —
  // it only asks personal_key_manager what it will allow.
  guarded("keys", () => loadCaps());
  safeInit("logs", bindLogFilters);
  safeInit("logs", bindLogStream);
  safeInit("logs", bindLogFiles);
  safeInit("queue", bindQueueClearAll);
  safeInit("queue", bindQueueControls);
  safeInit("sessions", bindSessions);
  // Bind before the first fetch (so the filters work the moment the tab opens) and
  // fetch straight away, so the sidebar dots are right before the panel is ever
  // visited.
  safeInit("notifications", bindNotifications);
  safeInit("notifications", refreshNotifications);
  setInterval(() => {
    // Light background refresh of health + dashboard while visible (guarded, so
    // a transient failure can't wedge the visible panel).
    const active = (id) => document.querySelector(`#tab-${id}`)?.classList.contains("active");
    if (active("dashboard")) guarded("dashboard", refreshDashboard);
    if (active("queue")) guarded("queue", refreshQueue);
    if (active("logs")) guarded("logs", refreshLogs);
    if (active("accounts")) guarded("accounts", refreshAccounts);
    if (active("config")) guarded("config", refreshConfig);
    if (active("about")) guarded("about", refreshAbout);
    if (active("chat")) guarded("chat", refreshChatSessions);
    if (active("scripts")) guarded("scripts", refreshScripts);
    // Keep the key-store pill honest without spawning the CLI again — the probe
    // reuses its cached liveness verdict inside that window.
    if (active("licenses")) guarded("keys", () => loadCaps());
    // The push keeps the dots live; this is the safety net if one is missed.
    if (active("notifications")) guarded("notifications", refreshNotifications);
    else guarded("notif-dots", refreshNotifCounts);
  }, 15000);
})();
