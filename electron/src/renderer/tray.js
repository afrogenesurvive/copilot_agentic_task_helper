/**
 * The menu-bar popover's controller.
 *
 * The four status values, then three tabs: Services, Queues (priority | misc) and
 * Notifications. It shares the dashboard's preload bridge (`window.api`) and its
 * design tokens, but none of its code: app.js is a single huge IIFE whose helpers
 * are private, so the handful of functions needed here are re-stated rather than
 * reached into. The pill *strings* are copied deliberately — the status bar is the
 * reference for how each state reads, and a divergence between the two would be a
 * bug.
 *
 * Refresh model: fetch when the panel opens, not on a timer. main.js sends
 * `tray:refresh` on every show, and the panel is only on screen for a few seconds
 * at a time, so a polling loop here would be pure waste — the dashboard already
 * polls these same endpoints while it is visible. The one push it does listen to
 * is `notifications:new`, which keeps the uncleared count live while it is open.
 *
 * Rows are NOT capped by the panel's height: each list scrolls, so everything the
 * API returned is rendered and the heading states how many there are. The panel's own
 * size comes from the corner grip (bindZoom below), which scales the window and the
 * page together — the panel is deliberately not a resizable window.
 */
(function () {
  "use strict";

  var api = window.api;
  if (!api) return; // no bridge (should be impossible — the same preload as the dashboard)

  // Newest-first rows fetched for the Notifications tab. The panel is a glance;
  // the dashboard's own Notifications tab is where all 500 live.
  var NOTIF_LIMIT = 50;

  /**
   * The panel's scale, mirrored from main.js. Main is the authority — it also clamps a
   * request to what the current display can fit — so this is kept in step from the
   * `tray:refresh` payload on every open and from the grip's own replies.
   */
  var currentScale = 1;

  /** True for the duration of a grip drag. Read by bindAutoHide below. */
  var zoomDragging = false;

  /**
   * Every paint is wrapped: a throw in one of these must not take the rest of the
   * panel with it. (In the dashboard a single unguarded module-level call once
   * killed every later binding in the IIFE — same hazard, smaller file.)
   */
  function guarded(label, fn) {
    try {
      return fn();
    } catch (err) {
      console.log("[tray] " + label + " failed:", err && err.message);
    }
  }

  function $(id) {
    return document.getElementById(id);
  }

  /**
   * Set a pill's text + colour. `kind` maps to status-pill--<kind>.
   *
   * The text goes into the pill's own `[data-pill-text]` span when it has one: the
   * health pill is a <button> with a status dot inside it, and `textContent` on the
   * pill itself deletes that dot on the first paint.
   */
  function setPill(id, text, kind, title) {
    var el = $(id);
    if (!el) return;
    el.className = "status-pill" + (kind ? " status-pill--" + kind : "");
    var target = el.querySelector("[data-pill-text]") || el;
    target.textContent = text;
    if (title) el.title = title;
  }

  /** "2m ago" for anything recent, a locale time for anything older than a day. */
  function timeAgo(iso) {
    var t = Date.parse(iso || "");
    if (!t) return "";
    var secs = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (secs < 60) return secs + "s ago";
    var mins = Math.round(secs / 60);
    if (mins < 60) return mins + "m ago";
    var hours = Math.round(mins / 60);
    if (hours < 24) return hours + "h ago";
    var days = Math.round(hours / 24);
    if (days < 7) return days + "d ago";
    return new Date(t).toLocaleDateString();
  }

  // The dashboard's own labels for a queue row: `tool_dispatch` is the dispatch
  // engine rather than a source, so it reads as "dispatch". Kept in step with
  // app.js's queueTypeLabel().
  function rowLabel(item) {
    if (item.source === "tool_dispatch") return "dispatch";
    return item.source || "unknown";
  }

  function clip(s, n) {
    return String(s == null ? "" : s).slice(0, n || 120);
  }

  /**
   * Somewhere to point the eye on a row: the most specific human-readable field
   * the event actually carries. The order is deliberate — frontdesk text, then a
   * dispatch rule, then an email subject, then a Trello card name, and only then
   * the raw `source/type`, which tells the operator nothing they cannot already
   * see in the row's label.
   */
  function rowDesc(item) {
    var d = item.data || {};
    if (d.text) return '"' + clip(d.text) + '"';
    if (d.rule) return clip(d.rule);
    if (d.message) return clip(d.message);
    if (d.subject) return clip(d.subject);
    var ev = d.originalEvent && d.originalEvent.data;
    if (ev) {
      if (ev.card && ev.card.name) return clip(ev.card.name);
      if (ev.subject) return clip(ev.subject);
      if (ev.text) return '"' + clip(ev.text) + '"';
    }
    if (d.from) return clip(d.from);
    if (d.snippet) return clip(d.snippet);
    return item.type || "";
  }

  // ── The four values ───────────────────────────────────────────────────────

  async function paintHealth() {
    var res = await api.health();
    if (!res || !res.ok) return setPill("tray-health", "webhook down", "bad");
    var json = res.json || {};
    var sanitiser = json.sanitizer || {};
    // The panel is the only place besides GET /health that surfaces this, and an
    // inactive sanitiser means external content is not being filtered at all —
    // too important to hide behind the dashboard.
    var note = sanitiser.active ? "sanitiser active" : "sanitiser INACTIVE";
    setPill(
      "tray-health",
      "webhook :" + json.port,
      "ok",
      "Backend health — click for the dashboard\n" + note,
    );
  }

  async function paintServices() {
    var svcs = (await api.svcList()) || [];
    var running = svcs.filter(function (s) {
      return s.running;
    }).length;
    var kind = svcs.length === 0 ? "" : running === svcs.length ? "ok" : running > 0 ? "warn" : "bad";
    setPill(
      "tray-services",
      "services " + running + "/" + svcs.length,
      kind,
      "Local services running (out of " + svcs.length + ")",
    );
    // The same array the pill counted, so the tab and the count cannot disagree.
    // Running first: the tab's job is "what is up?", and the MCP servers sit at the
    // bottom as `down` until the chat spawns one.
    var ordered = svcs.slice().sort(function (a, b) {
      if (a.running !== b.running) return a.running ? -1 : 1;
      return String(a.label || a.name).localeCompare(String(b.label || b.name));
    });
    fillList($("tray-services-list"), ordered.map(serviceRow), "No services configured");
  }

  /** The last queue response, split by queue. Both arrive in one request. */
  var queueItems = { priority: [], misc: [] };
  var queueError = "";

  async function paintQueue() {
    var res = await api.queue();
    if (!res || res.status === 0) {
      setPill("tray-queue", "queue ?", "bad", "Webhook server not reachable");
      queueItems = { priority: [], misc: [] };
      queueError = "Webhook server not reachable.";
      renderQueue();
      return;
    }
    var json = res.json || {};
    var pending = (json.priority && json.priority.pending) || 0;
    var misc = (json.misc && json.misc.pending) || 0;
    // Nothing waiting is the good case, so it gets no colour and no shout; a
    // backlog is the thing worth noticing.
    setPill(
      "tray-queue",
      "queue " + pending,
      pending > 0 ? "warn" : "",
      pending + " unactioned priority item(s)\n" + misc + " in misc_notifications",
    );
    // /api/queue-status carries both queues (the 20 newest of each), so switching
    // the Priority/Misc sub-tab re-renders — it never re-fetches.
    queueError = "";
    queueItems = {
      priority: (json.priority && json.priority.items) || [],
      misc: (json.misc && json.misc.items) || [],
    };
    renderQueue();
  }

  async function paintKeys() {
    // pkmStatus, not pkmCapabilities: status does not force a re-probe of the
    // store, and this panel must never be the reason the pkm CLI is spawned.
    var res = await api.pkmStatus();
    var caps = res && res.data && res.data.capabilities;
    if (!caps || !caps.state) return setPill("tray-keys", "keys …", "");
    // The dashboard's GATE_PILL map, verbatim — one vocabulary for one state.
    var PILL = {
      ready: ["keys ✓", "ok"],
      "read-only": ["keys read-only", "warn"],
      "blocklist-unreadable": ["keys ⚠ revocation off", "bad"],
      "blocklist-missing": ["keys ⚠ revocation off", "bad"],
      "store-missing": ["keys no store", "bad"],
      "cli-missing": ["keys no pkm", "bad"],
      "cli-broken": ["keys pkm error", "bad"],
      unknown: ["keys …", ""],
    };
    var p = PILL[caps.state] || PILL.unknown;
    setPill("tray-keys", p[0], p[1], caps.reason || "Key store: " + caps.state);
  }

  // ── The list ──────────────────────────────────────────────────────────────

  function emptyRow(text) {
    var li = document.createElement("li");
    li.className = "empty";
    li.textContent = text;
    return li;
  }

  function itemRow(item) {
    var li = document.createElement("li");
    li.className = "tray__item";

    var top = document.createElement("div");
    top.className = "tray__item-top";

    var label = document.createElement("span");
    label.className = "tray__item-label";
    // `seqNo` is the operator's handle for the row everywhere else in the app
    // (the terminal prints the same number), so the panel shows it too.
    label.textContent = "#" + (item.seqNo != null ? item.seqNo : "?") + " " + rowLabel(item);

    var time = document.createElement("span");
    time.className = "tray__item-time";
    time.textContent = timeAgo(item.queuedAt);

    top.append(label, time);

    var desc = document.createElement("div");
    desc.className = "tray__item-desc";
    // textContent, never innerHTML: frontdesk messages are attacker-influenced,
    // and this is the one place in the app that renders them outside the Queue
    // tab's own escaping.
    desc.textContent = rowDesc(item);

    li.append(top, desc);
    return li;
  }

  /**
   * Replace a list's rows, or show one line instead.
   *
   * Nothing caps the row count: the window is resizable and `.tray__list` scrolls,
   * so everything the API returned is rendered and the heading states how many.
   */
  function fillList(list, rows, emptyText) {
    if (!list) return;
    list.replaceChildren();
    if (!rows.length) return void list.append(emptyRow(emptyText));
    for (var i = 0; i < rows.length; i += 1) list.append(rows[i]);
  }

  // ── Queues tab ────────────────────────────────────────────────────────────

  function renderQueue() {
    var items = queueItems[activeSubTab] || [];
    var note = $("tray-items-note");
    if (note) note.textContent = items.length ? items.length + " items" : "";
    fillList($("tray-items"), items.map(itemRow), queueError || "✅ Empty");
  }

  // ── Services tab ──────────────────────────────────────────────────────────

  function serviceRow(svc) {
    var li = document.createElement("li");
    li.className = "tray__svc";

    var dot = document.createElement("span");
    dot.className = "tray__svc-dot";
    // `external` is up but was NOT started by this app — its own colour, because
    // "running" alone would hide that nothing here can restart it.
    dot.setAttribute("data-state", !svc.running ? "down" : svc.external ? "external" : "up");

    var label = document.createElement("span");
    label.className = "tray__svc-label";
    label.textContent = svc.label || svc.name;

    var meta = document.createElement("span");
    meta.className = "tray__svc-meta";
    meta.textContent = !svc.running ? "down" : svc.pid ? "pid " + svc.pid : "up";

    li.append(dot, label, meta);
    return li;
  }

  // ── Notifications tab ─────────────────────────────────────────────────────

  var notifState = { clearedAt: 0 };

  /**
   * A row's "new" edge is the same rule the menu-bar badge counts — newer than the
   * last clear — and deliberately NOT the read marks: opening a tab marks rows read
   * without dealing with them.
   */
  function notifIsUncleared(entry) {
    return Date.parse(entry.ts) > (notifState.clearedAt || 0);
  }

  function notificationRow(entry) {
    var li = document.createElement("li");
    li.className = "tray__notif";
    if (notifIsUncleared(entry)) li.setAttribute("data-unread", "1");

    var top = document.createElement("div");
    top.className = "tray__notif-top";

    // The dashboard's own source/level chips (components/_notification-center.css),
    // so a source has one colour in both places.
    var src = document.createElement("span");
    src.className = "n-src";
    src.setAttribute("data-source", entry.source);
    src.textContent = entry.source;

    var level = document.createElement("span");
    level.className = "n-level";
    level.setAttribute("data-level", entry.level);
    level.textContent = entry.level;

    var time = document.createElement("span");
    time.className = "tray__notif-time";
    time.textContent = timeAgo(entry.ts);

    top.append(src, level, time);

    var title = document.createElement("div");
    title.className = "tray__notif-title";
    // textContent, never innerHTML: a title carries Trello card names and email
    // subjects, which are attacker-influenced.
    title.textContent = entry.title;

    li.append(top, title);
    return li;
  }

  /** The tab badge and the menu-bar icon read the same counter, so they agree. */
  function paintUncleared(count) {
    var n = Math.max(0, count || 0);
    var tab = $("tray-tab-notifications");
    var el = $("tray-notif-count");
    if (tab) {
      if (n > 0) tab.setAttribute("data-uncleared", "1");
      else tab.removeAttribute("data-uncleared");
    }
    if (el) el.textContent = n > 9 ? "9+" : String(n);
  }

  /** The count alone — one item fetched and discarded. Used on load and per push. */
  async function refreshNotificationCount() {
    var res = await api.notificationsList({ limit: 1 });
    var counts = (res && res.counts) || {};
    notifState.clearedAt = counts.clearedAt || 0;
    paintUncleared(counts.uncleared || 0);
  }

  async function paintNotifications() {
    var res = await api.notificationsList({ limit: NOTIF_LIMIT });
    var items = (res && res.items) || [];
    var counts = (res && res.counts) || {};
    notifState.clearedAt = counts.clearedAt || 0;
    paintUncleared(counts.uncleared || 0);

    var note = $("tray-notif-note");
    if (note) {
      note.textContent = items.length
        ? items.length + " shown · " + (counts.uncleared || 0) + " uncleared"
        : "";
    }
    fillList($("tray-notif-list"), items.map(notificationRow), "Nothing yet");
  }

  // ── Tabs ──────────────────────────────────────────────────────────────────

  var activeTab = "services";
  var activeSubTab = "priority";

  function forEachEl(list, fn) {
    for (var i = 0; i < list.length; i += 1) fn(list[i]);
  }

  function bindClicks(selector, handler) {
    forEachEl(document.querySelectorAll(selector), function (el) {
      el.addEventListener("click", function () {
        handler(el);
      });
    });
  }

  /** Swap the visible pane. The pills above stay put — they are the always-on part. */
  function showTab(name) {
    if (!name) return;
    activeTab = name;
    forEachEl(document.querySelectorAll("[data-tray-tab]"), function (btn) {
      var on = btn.getAttribute("data-tray-tab") === name;
      btn.setAttribute("aria-selected", on ? "true" : "false");
      var pane = $(btn.getAttribute("aria-controls"));
      if (pane) pane.hidden = !on;
    });
    // Fetched on first view rather than with the pills: it is the one list of 50
    // rather than 20, and most opens never look at it.
    if (name === "notifications") {
      guarded("notifications", function () {
        paintNotifications().catch(function () {});
      });
    }
  }

  function showSubTab(name) {
    activeSubTab = name === "misc" ? "misc" : "priority";
    forEachEl(document.querySelectorAll("[data-tray-subtab]"), function (btn) {
      var on = btn.getAttribute("data-tray-subtab") === activeSubTab;
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
    renderQueue();
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  /**
   * The locked panel.
   *
   * The panel is reachable from the menu bar WITHOUT signing in — that is the point of
   * it — but while locked main answers only `auth:state` plus this panel's own
   * window-management channels, so every read below rejects. Four dashes would look like
   * a dead backend, so say what is actually true instead.
   */
  function paintLocked() {
    setPill("tray-health", "locked", "bad", "Dev Centre is locked — sign in to see the stack");
    setPill("tray-services", "—", "plain");
    setPill("tray-queue", "—", "plain");
    setPill("tray-keys", "—", "plain");
    // The only useful thing to do from here, and the only route from the panel to the
    // gate: `tray:openDashboard` is allowed without a session.
    var open = $("tray-open");
    if (open) open.textContent = "Sign in to Dev Centre";
  }

  function paintAll() {
    // Each value paints as soon as it has an answer. They are independent reads,
    // and the key store in particular can be slow — the panel should not sit blank
    // waiting for the slowest one.
    guarded("health", function () {
      paintHealth().catch(function () {});
    });
    guarded("services", function () {
      paintServices().catch(function () {});
    });
    guarded("queue", function () {
      paintQueue().catch(function () {});
    });
    guarded("keys", function () {
      paintKeys().catch(function () {});
    });
    // The count only — the Notifications list itself waits until its tab is shown.
    guarded("notif-count", function () {
      refreshNotificationCount().catch(function () {});
    });
  }

  function refresh() {
    // Re-checked on every open rather than once, because the panel has no other way to
    // learn that a session went away.
    api
      .authState()
      .then(function (res) {
        var state = (res && res.state) || {};
        if (state.locked) return paintLocked();
        return paintAll();
      })
      // State unreadable: fall through to the normal reads rather than blanking the panel
      // on a guess. `auth:state` is always allowed, so this should be unreachable.
      .catch(paintAll);
  }

  function openDashboard() {
    api.trayOpenDashboard();
  }

  /**
   * The bottom-right grip: drag to scale the panel, double-click to reset it.
   *
   * The window is not drag-resizable — a frameless window that can be resized reads as
   * an ordinary window to macOS (edge affordances, Mission Control, a slot in the
   * window cycle), which is exactly what a menu-bar panel must not look like. So this
   * handle is what the operator pulls instead, and main.js's applyPopoverScale resizes
   * the window AND sets a matching zoom factor.
   *
   * That has a convenient consequence: the layout viewport stays the same width in CSS
   * pixels at every scale, so the text and rows actually get bigger rather than the
   * layout reflowing, and the pointer's delta is simply `delta / panelWidth` of the
   * panel. Nothing here needs the base pixel size, and because each frame re-derives
   * from the ORIGINAL start scale — never from the clamped reply — a request main.js
   * trims to fit the screen still leaves the handle under the pointer.
   */
  function bindZoom() {
    var grip = $("tray-zoom");
    var panel = document.querySelector(".tray__panel");
    if (!grip || !panel) return;

    var pointerId = null;
    var startX = 0;
    var startY = 0;
    var startScale = 1;
    var startWidth = 1;
    var startHeight = 1;
    var pending = null; // requested but not yet sent
    var lastSent = null; // the last value actually sent, for the release below
    var frame = 0;

    function send(scale, persist) {
      return api.trayZoom(scale, persist).then(function (applied) {
        if (typeof applied === "number" && applied > 0) currentScale = applied;
        return applied;
      });
    }

    // At most one IPC per frame. The move events arrive faster than a window can be
    // resized, and a queued one would be overwritten before it had any visible effect.
    function flush() {
      frame = 0;
      if (pending == null) return;
      var wanted = pending;
      pending = null;
      lastSent = wanted;
      // persist:false — one write for the gesture, not one per frame.
      send(wanted, false).catch(function () {});
    }

    function onMove(e) {
      if (pointerId === null || e.pointerId !== pointerId) return;
      var dx = e.clientX - startX;
      // The height is locked to the width, so a purely horizontal pull would let the
      // handle outrun the cursor as the panel grows downwards. Both axes are therefore
      // expressed in width units (the vertical one scaled by the panel's own aspect)
      // and the one the operator pulled further wins — the usual trick for resizing
      // something whose aspect ratio cannot change.
      var dy = (e.clientY - startY) * (startWidth / startHeight);
      var delta = Math.abs(dy) > Math.abs(dx) ? dy : dx;
      pending = startScale * (1 + delta / startWidth);
      if (!frame) frame = requestAnimationFrame(flush);
    }

    function onEnd(e) {
      if (pointerId === null || (e && e.pointerId !== pointerId)) return;
      pointerId = null;
      zoomDragging = false;
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onEnd);
      grip.removeEventListener("pointercancel", onEnd);
      try {
        grip.releasePointerCapture(e.pointerId);
      } catch (_) {
        /* never captured, or already released */
      }
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      // Persist where the drag came to rest. Send what the last frame ASKED for
      // rather than `currentScale`: main.js does the clamping, and its replies are
      // async, so currentScale can still be a frame behind at this point.
      var resting = pending != null ? pending : lastSent != null ? lastSent : currentScale;
      pending = null;
      send(resting, true).catch(function () {});
    }

    grip.addEventListener("pointerdown", function (e) {
      if (e.button !== 0 || pointerId !== null) return;
      pointerId = e.pointerId;
      zoomDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startScale = currentScale;
      startWidth = panel.clientWidth || 1;
      startHeight = panel.clientHeight || 1;
      e.preventDefault();
      // Capture the pointer, so the drag survives leaving the window — which it
      // always does, because pulling the handle right or down grows the window out
      // from under the cursor.
      try {
        grip.setPointerCapture(e.pointerId);
      } catch (_) {
        /* not fatal: the drag then just ends when the pointer leaves */
      }
      grip.addEventListener("pointermove", onMove);
      grip.addEventListener("pointerup", onEnd);
      grip.addEventListener("pointercancel", onEnd);
    });

    grip.addEventListener("dblclick", function (e) {
      e.preventDefault();
      send(1, true).catch(function () {});
    });
  }

  // Both of these are async and must not leak an unhandled rejection, so each
  // swallows its own failure — a panel that cannot read the version still works.
  api
    .appVersion()
    .then(function (r) {
      var el = $("tray-version");
      if (r && r.ok && el) el.textContent = "v" + r.version;
    })
    .catch(function () {});

  // Same path as the dashboard (app.js's paintAppearance), so the panel is in the
  // right palette from its first frame rather than inheriting the CSS fallbacks.
  api
    .getTheme()
    .then(function (t) {
      window.Appearance.applyAppearance(window.Appearance.appearanceFromInfo(t));
    })
    .catch(function () {});

  bindClicks("[data-tray-tab]", function (btn) {
    showTab(btn.getAttribute("data-tray-tab"));
  });
  bindClicks("[data-tray-subtab]", function (btn) {
    showSubTab(btn.getAttribute("data-tray-subtab"));
  });

  var open = $("tray-open");
  if (open) open.addEventListener("click", openDashboard);
  // The health pill is a button in the status bar too; here it doubles as the
  // second way out of the panel.
  var health = $("tray-health");
  if (health) health.addEventListener("click", openDashboard);

  // The corner grip. Its listeners are bound once, on pointerdown, rather than kept
  // permanently live — the panel is open for seconds at a time and this way a stray
  // pointermove anywhere in the app costs nothing.
  bindZoom();

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") api.trayHide();
  });

  // A new entry while the panel is open. The count is re-read rather than
  // incremented locally, because it is the same number the menu-bar badge shows —
  // and only a clear in the dashboard lowers either of them.
  api.onNotification(function () {
    guarded("notif-count", function () {
      refreshNotificationCount().catch(function () {});
    });
    if (activeTab === "notifications") {
      guarded("notifications", function () {
        paintNotifications().catch(function () {});
      });
    }
  });

  // Dismiss-on-blur lives in main.js (the BrowserWindow's own `blur` event, which has
  // to stand down while DevTools is open). It cannot be the ONLY way out, though: the
  // panel is shown with showInactive() so that opening it cannot pull focus off another
  // app's full-screen window, and a window that never gains focus never fires `blur`.
  // So leave on pointer-leave as well — but only while the panel is still unfocused.
  // Once the operator has clicked inside, the app is active, blur takes over, and
  // moving the pointer out no longer closes anything.
  (function bindAutoHide() {
    var timer = null;
    function cancel() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }
    document.body.addEventListener("mouseleave", function () {
      cancel();
      // A grip drag grows or shrinks the window under the pointer, so the pointer is
      // routinely outside the panel for the whole gesture — and it is out there on
      // purpose, so this is not the "walked away from it" case this handler is for.
      if (zoomDragging) return;
      // A short grace period, so clipping the panel's edge on the way to a button — or
      // dragging the zoom grip — does not close it under the pointer.
      timer = setTimeout(function () {
        timer = null;
        if (!document.hasFocus()) api.trayHide();
      }, 250);
    });
    document.body.addEventListener("mouseenter", cancel);
  })();

  // Shown → re-read. main.js sends this on every open, including the first, so the
  // load-time refresh below covers a send that arrives before this listener was
  // bound. The payload carries the panel's current scale, which is how the grip stays
  // in step with a scale main.js clamped on a different display.
  api.onTrayRefresh(function (payload) {
    if (payload && typeof payload.scale === "number" && payload.scale > 0) {
      currentScale = payload.scale;
    }
    refresh();
  });

  showTab(activeTab);
  showSubTab(activeSubTab);
  refresh();
})();
