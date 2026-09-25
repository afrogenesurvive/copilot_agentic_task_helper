/**
 * Loopback Google OAuth for the operator dashboard.
 *
 * Mirrors ai_transcription_agent/electron/src/main/gmailOAuth.ts: opens the
 * consent screen in the system browser, listens on an ephemeral loopback port
 * for the redirect and exchanges the code for a refresh token — all without the
 * tunnel being up.
 *
 * Two destinations, one flow (`runLoopbackFlow`):
 *   - `connectGoogleForSeat(repo, sub)` — Accounts tab. Binds a collaborator's own
 *     Google account to a seat in safe/frontdesk-accounts.json (setSeatGoogle).
 *     The agent runner uses it when acting for that seat; the operator chat does
 *     not (its MCP children run on process.env).
 *   - `connectGoogleOperator(repo)` — Config tab's "Connect Google". Remints the
 *     OPERATOR token (GMAIL_REFRESH_TOKEN) that every MCP server and the operator
 *     chat actually run on, into whichever store wins (config.json over .env —
 *     see shared/google-token.cjs). This is the dashboard equivalent of
 *     `npm run setup:gmail-auth`, requesting the identical scope set from
 *     shared/google-scopes.mjs so neither route can mint a weaker token.
 */
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const { pathToFileURL } = require("url");
const { shell } = require("electron");

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v2/userinfo";
const AUTH_TIMEOUT_MS = 10 * 60 * 1000;

const CLOSE_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Authorization complete</title></head>
<body style="font-family:system-ui,sans-serif;background:#0d1117;color:#c9d1d9;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center"><h2 style="color:#3fb950">✓ Authorization complete</h2>
<p>You can close this tab and return to Dev Centre.</p></div></body></html>`;

async function accountsModule(repoRoot) {
  return import(pathToFileURL(path.join(repoRoot, "scripts", "frontdesk-accounts.mjs")).href);
}

/** Canonical scope sets (shared/google-scopes.mjs) so this flow and the CLI
 *  (scripts/gmail-auth.mjs) cannot ask for different capabilities. */
async function loadScopes(repoRoot) {
  return import(pathToFileURL(path.join(repoRoot, "shared", "google-scopes.mjs")).href);
}

/**
 * Consent → redirect → token-exchange → userinfo, parameterised by which scope
 * set is requested and what happens to the resulting refresh token.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {"operator"|"seat"} opts.flow — picks OPERATOR_SCOPES / SEAT_SCOPES
 * @param {function} opts.onToken — async (refreshToken, email) => extra result fields
 * @returns {Promise<{ok:boolean, user?:string, error?:string}>}
 */
function runLoopbackFlow({ repoRoot, flow, onToken }) {
  return new Promise((resolve) => {
    const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET } = process.env;
    if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET) {
      return resolve({ ok: false, error: "GMAIL_CLIENT_ID/SECRET not configured in .env" });
    }

    const state = crypto.randomBytes(16).toString("hex");
    let settled = false;
    let server = null;
    let timer = null;

    const settle = async (port, code, errParam) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        server && server.close();
      } catch {
        /* already closed */
      }
      if (errParam) return resolve({ ok: false, error: `Google authorization failed: ${errParam}` });
      if (!code) return resolve({ ok: false, error: "No authorization code returned." });

      try {
        const tokenRes = await fetch(TOKEN_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code,
            client_id: GMAIL_CLIENT_ID,
            client_secret: GMAIL_CLIENT_SECRET,
            redirect_uri: `http://127.0.0.1:${port}/`,
            grant_type: "authorization_code",
          }),
        });
        if (!tokenRes.ok) {
          return resolve({ ok: false, error: `Token exchange failed (${tokenRes.status})` });
        }
        const tokens = await tokenRes.json();
        const refreshToken = tokens.refresh_token;
        if (!refreshToken) {
          return resolve({ ok: false, error: "No refresh_token returned (offline access not granted)." });
        }
        let email = "";
        try {
          const ui = await fetch(USERINFO_ENDPOINT, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
          const uj = await ui.json();
          email = uj.email || "";
        } catch {
          /* best-effort */
        }
        // A throw in onToken (e.g. unwritable config) must surface as an error,
        // not as a silent success the operator cannot see.
        const extra = (await onToken(refreshToken, email || null)) || {};
        resolve({ ok: true, user: email || null, ...extra });
      } catch (err) {
        resolve({ ok: false, error: err.message });
      }
    };

    timer = setTimeout(() => settle(null, null, null).then(() => {}), AUTH_TIMEOUT_MS);

    server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (url.searchParams.get("state") !== state) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid state parameter.");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(CLOSE_PAGE);
      void settle(server.address().port, url.searchParams.get("code"), url.searchParams.get("error"));
    });

    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const redirectUri = `http://127.0.0.1:${port}/`;
      void (async () => {
        const mod = await loadScopes(repoRoot);
        const scopes = (flow === "operator" ? mod.OPERATOR_SCOPES : mod.SEAT_SCOPES).join(" ");
        const params = new URLSearchParams({
          client_id: GMAIL_CLIENT_ID,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: scopes,
          access_type: "offline",
          prompt: "consent",
          state,
        });
        shell.openExternal(`${AUTH_ENDPOINT}?${params}`);
      })();
    });
  });
}

/**
 * Bind a Google account to a seat (Accounts tab → Connect Google).
 * @param {string} repoRoot — repo root (for the accounts + scopes module paths)
 * @param {string} sub — the seat to bind the resulting Google account to
 * @returns {Promise<{ok:boolean, user?:string, sub?:string, error?:string}>}
 */
function connectGoogleForSeat(repoRoot, sub) {
  return runLoopbackFlow({
    repoRoot,
    flow: "seat",
    onToken: async (refreshToken, email) => {
      const acc = await accountsModule(repoRoot);
      acc.setSeatGoogle(sub, {
        user: email || null,
        refreshToken,
        clientId: process.env.GMAIL_CLIENT_ID,
        clientSecret: process.env.GMAIL_CLIENT_SECRET,
      });
      return { sub };
    },
  });
}

/**
 * Remint the OPERATOR refresh token (Config tab → Connect Google).
 *
 * Note the caller MUST also refresh `process.env` and drop the MCP client's
 * children afterwards — the servers read credentials at spawn, so an already
 * connected child keeps serving with the old token.
 *
 * @param {string} repoRoot
 * @returns {Promise<{ok:boolean, user?:string, store?:string, backup?:string, error?:string}>}
 */
function connectGoogleOperator(repoRoot) {
  return runLoopbackFlow({
    repoRoot,
    flow: "operator",
    onToken: (refreshToken) => {
      const { saveOperatorRefreshToken } = require(path.join(repoRoot, "shared", "google-token.cjs"));
      const saved = saveOperatorRefreshToken(refreshToken);
      if (!saved.ok) throw new Error(saved.error);
      if (typeof process.env !== "undefined") process.env.GMAIL_REFRESH_TOKEN = refreshToken;
      return { store: saved.store, backup: saved.backup || null };
    },
  });
}

module.exports = { connectGoogleForSeat, connectGoogleOperator };
