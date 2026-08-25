/**
 * Loopback Google OAuth for the operator dashboard.
 *
 * Mirrors ai_transcription_agent/electron/src/main/gmailOAuth.ts: opens the
 * consent screen in the system browser, listens on an ephemeral loopback port
 * for the redirect, exchanges the code for a refresh token, and binds it to a
 * seat via safe/frontdesk-accounts.json (setSeatGoogle). This works WITHOUT the
 * tunnel being up — ideal for the operator assigning accounts to seats.
 */
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const { pathToFileURL } = require("url");
const { shell } = require("electron");

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/calendar",
  "openid",
  "email",
].join(" ");

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v2/userinfo";
const AUTH_TIMEOUT_MS = 10 * 60 * 1000;

const CLOSE_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Authorization complete</title></head>
<body style="font-family:system-ui,sans-serif;background:#0d1117;color:#c9d1d9;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center"><h2 style="color:#3fb950">✓ Authorization complete</h2>
<p>You can close this tab and return to Frontdesk Operator.</p></div></body></html>`;

async function accountsModule(repoRoot) {
  return import(pathToFileURL(path.join(repoRoot, "scripts", "frontdesk-accounts.mjs")).href);
}

/**
 * Run the consent → redirect → token-exchange → userinfo flow for a seat.
 * @param {string} repoRoot — repo root (for the accounts module path)
 * @param {string} sub — the seat to bind the resulting Google account to
 * @returns {Promise<{ok:boolean, user?:string, sub?:string, error?:string}>}
 */
function connectGoogleForSeat(repoRoot, sub) {
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
        const acc = await accountsModule(repoRoot);
        acc.setSeatGoogle(sub, { user: email || null, refreshToken, clientId: GMAIL_CLIENT_ID, clientSecret: GMAIL_CLIENT_SECRET });
        resolve({ ok: true, user: email || null, sub });
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
      const params = new URLSearchParams({
        client_id: GMAIL_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: SCOPES,
        access_type: "offline",
        prompt: "consent",
        state,
      });
      shell.openExternal(`${AUTH_ENDPOINT}?${params}`);
    });
  });
}

module.exports = { connectGoogleForSeat };
