/**
 * The gate's controller.
 *
 * Two jobs, and deliberately no third: show what the gate knows (is anything even
 * configured, and what will be checked?), and submit the credential. On success it
 * reveals NOTHING itself — main swaps the window to the dashboard. A renderer that can
 * un-hide the dashboard would not be a gate, so there is no hidden-state here to
 * reveal; this document simply stops existing.
 *
 * The `api` surface is the same preload the dashboard uses, but while locked the only
 * channels main answers are `auth:state`, `auth:login` and the two cosmetic reads
 * (`app:version`, `app:getTheme`). Everything else rejects with "locked: …".
 */
(function () {
  "use strict";

  var api = window.api;
  if (!api) return; // no bridge (should be impossible — the same preload as the dashboard)

  function $(id) {
    return document.getElementById(id);
  }

  function showError(text) {
    var el = $("gate-error");
    if (!el) return;
    el.textContent = text || "";
    el.hidden = !text;
  }

  function setBusy(on) {
    var submit = $("gate-submit");
    if (!submit) return;
    submit.disabled = !!on;
    submit.textContent = on ? "Checking…" : "Sign in";
  }

  /**
   * The terminal state: no credential source holds anything, so no attempt can
   * succeed. Better to say that plainly than to invite guesses at a form that cannot
   * work — and `auth.login` would answer `no_admins_configured` anyway.
   */
  function lockForm(detail) {
    var email = $("gate-email");
    var secret = $("gate-secret");
    var submit = $("gate-submit");
    if (email) email.disabled = true;
    if (secret) secret.disabled = true;
    if (submit) {
      submit.disabled = true;
      submit.textContent = "Nothing to sign in with";
    }
    var notice = $("gate-setup");
    var text = $("gate-setup-detail");
    if (notice) notice.hidden = false;
    if (text) text.textContent = detail || "";
  }

  function signIn(event) {
    if (event) event.preventDefault();
    var emailEl = $("gate-email");
    var secretEl = $("gate-secret");
    if (!emailEl || !secretEl) return;

    showError("");
    setBusy(true);
    api
      .authLogin(emailEl.value.trim(), secretEl.value)
      .then(function (res) {
        // A success does not come back here: main loads the dashboard, which destroys
        // this document. Landing here with ok:true therefore means the swap did not
        // happen, and saying so beats leaving the operator on a "Checking…" button.
        if (res && res.ok) {
          showError("Signed in, but the dashboard did not open. Restart Dev Centre.");
          return;
        }
        setBusy(false);
        if (secretEl) secretEl.value = ""; // a wrong secret is not worth keeping in the field
        showError((res && (res.detail || res.reason)) || "Sign in failed.");
      })
      .catch(function (err) {
        setBusy(false);
        showError(err && err.message ? err.message : "Sign in failed.");
      });
  }

  var form = $("gate-form");
  if (form) form.addEventListener("submit", signIn);

  /**
   * Close = QUIT the app, exactly as the dashboard sidebar's Quit button does.
   *
   * It used to hide the window. Hiding is right for the DASHBOARD — the app's job is to
   * keep the backend services running — but the gate is what the window shows when nobody
   * is signed in, so a close button that only hid left a locked operator with no way out
   * of the app except the tray's right-click menu or Cmd+Q. `app:quit` is on the gate's
   * allow-list for this reason (see main/dev-centre-auth.js), and main.js quits on a close
   * of the window ITSELF while this document is loaded, so both routes agree.
   *
   * The confirmation is deliberately the sidebar's exact wording: quitting stops the
   * webhook server, the agent runner and the tunnel, which is not obvious from a login
   * screen. A refused `invoke` is reported rather than swallowed, so the button can never
   * look dead while locked.
   */
  var closeBtn = $("gate-close");
  if (closeBtn) {
    closeBtn.addEventListener("click", function () {
      if (!window.confirm("Quit Dev Centre? Backend services will stop.")) return;
      api.quit().catch(function (err) {
        showError(err && err.message ? err.message : "Could not quit Dev Centre.");
      });
    });
  }

  // The app's palette, read the same way the menu-bar panel reads it, so the gate is
  // not a differently-coloured screen in front of the dashboard.
  api
    .getTheme()
    .then(function (t) {
      if (window.Appearance) {
        window.Appearance.applyAppearance(window.Appearance.appearanceFromInfo(t));
      }
    })
    .catch(function () {});

  api
    .appVersion()
    .then(function (r) {
      var el = $("gate-version");
      if (r && r.ok && el) el.textContent = "v" + r.version;
    })
    .catch(function () {});

  // What the gate can say without a session. Identities are NOT disclosed while locked
  // (main's state() reports counts only), so this is all there is — and it is enough to
  // tell "wrong secret" apart from "you have not set this up yet".
  api
    .authState()
    .then(function (res) {
      var state = (res && res.state) || {};

      if (state.needsSetup) {
        // One thing per line: the part of this an operator cannot guess is the absolute
        // paths, and a single run-on sentence of them is unreadable at this width.
        // Written as one string because the notice is filled with `textContent`, and
        // kept by `white-space: pre-line` in gate.css.
        //
        // Reaching here means a seat licence cannot help either — main only reports
        // needsSetup when .env is empty, the registry is empty AND the key store's master
        // ring is unreadable, so the third line is the reason the other two matter.
        lockForm(
          "No credentials found.\n\n" +
            "Add an admin to DEV_CENTRE_ADMINS in\n" +
            (state.envPath || ".env") +
            "\n\nor register a user:\n" +
            "node scripts/dev-centre-roles.mjs add <email> --role tier_2\n\n" +
            (state.registryPath || "safe/dev-centre-roles.json") +
            "\n\nNo seat licence can sign in either: the key store has no readable master ring " +
            "(PKM_ROOT / PKM_REGISTRY in Config).",
        );
        return;
      }

      var hint = $("gate-hint");
      if (hint) {
        var hours = Math.round((state.limitSeconds || 43200) / 3600);
        var registryUsers = state.registryCount || 0;
        hint.textContent =
          "Admins come from .env; everyone else is in the gitignored role registry (" +
          registryUsers +
          " " +
          (registryUsers === 1 ? "user" : "users") +
          "). " +
          // Named only when the key store is actually readable: offering a route that
          // cannot work is worse than saying nothing. WHICH addresses are admins is never
          // disclosed here — the list lives in the main process and is deliberately not
          // part of this state object.
          (state.licenceReady
            ? "A seat licence (" +
              (state.licenceRegistry || "this app") +
              " registry) also works: paste it in Secret and type the address it was issued to. "
            : "") +
          "A session lasts " +
          hours +
          " h and is resumed on the next launch while it is still valid.";
      }

      // Anything wrong with the configuration is worth showing before an attempt is
      // made — e.g. the same address in both sources, where `.env` wins.
      if (state.problems && state.problems.length) {
        showError(state.problems.join(" · "));
      }

      var first = $("gate-email");
      if (first) first.focus();
    })
    .catch(function () {
      // The gate is the one screen that has to work when nothing else does, so a
      // failure to read state is reported rather than swallowed.
      showError("Could not read the gate's state. Restart Dev Centre.");
    });
})();
