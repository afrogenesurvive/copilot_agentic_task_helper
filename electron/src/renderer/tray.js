/**
 * The menu-bar popover's controller.
 *
 * Four values and the head of the priority queue — that is the whole job. It
 * shares the dashboard's preload bridge (`window.api`) and its design tokens, but
 * none of its code: app.js is a single 3,900-line IIFE whose helpers are private,
 * so the handful of functions needed here are re-stated rather than reached into.
 * The pill *strings* are copied deliberately — the status bar is the reference
 * for how each state reads, and a divergence between the two would be a bug.
 *
 * Refresh model: fetch when the panel opens, not on a timer. main.js sends
 * `tray:refresh` on every show, and the panel is only on screen for a few seconds
 * at a time, so a polling loop here would be pure waste — the dashboard already
 * polls these same endpoints while it is visible.
 */
(function () {
  "use strict";

  var api = window.api;
  if (!api) return; // no bridge (should be impossible — the same preload as the dashboard)

  var ROW_LIMIT = 5; // rows before the list scrolls

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

  /** Set a pill's text + colour. `kind` maps to status-pill--<kind>. */
  function setPill(id, text, kind, title) {
    var el = $(id);
    if (!el) return;
    el.className = "status-pill" + (kind ? " status-pill--" + kind : "");
    el.textContent = text;
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
  }

  async function paintQueue() {
    var res = await api.queue();
    var list = $("tray-items");
    if (!res || res.status === 0) {
      setPill("tray-queue", "queue ?", "bad", "Webhook server not reachable");
      if (list) list.replaceChildren(emptyRow("Webhook server not reachable."));
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
    paintItems((json.priority && json.priority.items) || []);
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

  function paintItems(items) {
    var list = $("tray-items");
    var note = $("tray-items-note");
    if (!list) return;
    var shown = items.slice(0, ROW_LIMIT);
    if (note) note.textContent = items.length > shown.length ? shown.length + " of " + items.length : "";
    list.replaceChildren();
    if (!shown.length) return void list.append(emptyRow("✅ Empty"));
    for (var i = 0; i < shown.length; i += 1) list.append(itemRow(shown[i]));
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  function refresh() {
    // Each value paints as soon as it has an answer. They are four independent
    // reads, and the key store in particular can be slow — the panel should not
    // sit blank waiting for the slowest one.
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
  }

  function openDashboard() {
    api.trayOpenDashboard();
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

  var open = $("tray-open");
  if (open) open.addEventListener("click", openDashboard);
  // The health pill is a button in the status bar too; here it doubles as the
  // second way out of the panel.
  var health = $("tray-health");
  if (health) health.addEventListener("click", openDashboard);

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") api.trayHide();
  });

  // Dismiss-on-blur deliberately lives in main.js (the BrowserWindow's own `blur`
  // event) and not here: it has to stand down while DevTools is open, and a second
  // listener in the page would close the panel out from under the inspector.

  // Shown → re-read. main.js sends this on every open, including the first, so the
  // load-time refresh below covers a send that arrives before this listener was
  // bound.
  api.onTrayRefresh(refresh);
  refresh();
})();
