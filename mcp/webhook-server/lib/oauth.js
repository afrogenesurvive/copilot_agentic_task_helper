/**
 * Google OAuth — "Connect with Google" for the frontdesk.
 *
 * Mirrors the loopback consent flow from ai_transcription_agent (gmailOAuth.ts)
 * but as web routes on the webhook server, since the frontdesk is a browser app
 * behind the tunnel. On approval the callback exchanges the code for a refresh
 * token and writes GMAIL_* into the local .env, then reloads process.env.
 *
 * Routes (wired in index.js):
 *   GET /oauth/google/start    — validate frontdesk session → 302 to Google consent
 *   GET /oauth/google/callback — exchange code → write .env → success page
 *
 * Note: after a successful connect, the running webhook server picks up the new
 * env vars immediately (process.env updated), but the Gmail/Drive/Calendar MCP
 * servers are separate processes and must be restarted to use the new token.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { setSeatGoogle } from "../../../scripts/frontdesk-accounts.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");
const ENV_FILE = path.join(ROOT, ".env");

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/calendar",
  "openid",
  "email",
].join(" ");

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v2/userinfo";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const AUTH_TIMEOUT_MS = 10 * 60 * 1000;

// state -> { sub, expiresAt }
const pending = new Map();

function baseUrl() {
  return (process.env.WEBHOOK_BASE_URL || `http://localhost:${process.env.WEBHOOK_PORT || "3199"}`).replace(/\/+$/, "");
}

/** Replace or append a KEY=VALUE line in .env and update process.env in-place. */
function writeEnvVar(key, value) {
  process.env[key] = value;
  let content = "";
  try {
    content = fs.readFileSync(ENV_FILE, "utf8");
  } catch {
    content = "";
  }
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(content)) {
    content = content.replace(re, line);
  } else {
    content = (content.endsWith("\n") || content === "" ? content : content + "\n") + `${line}\n`;
  }
  fs.writeFileSync(ENV_FILE, content, "utf8");
}

/** Build the Google consent redirect URL for an authenticated session. */
export function startGoogleOAuth(session) {
  const { GMAIL_CLIENT_ID } = process.env;
  if (!GMAIL_CLIENT_ID) {
    return { error: "GMAIL_CLIENT_ID not configured — add it to .env first." };
  }
  const state = crypto.randomBytes(16).toString("hex");
  pending.set(state, { sub: session.sub, expiresAt: Date.now() + AUTH_TIMEOUT_MS });
  const params = new URLSearchParams({
    client_id: GMAIL_CLIENT_ID,
    redirect_uri: `${baseUrl()}/oauth/google/callback`,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return { url: `${AUTH_ENDPOINT}?${params.toString()}` };
}

/** Handle the OAuth callback: exchange code → write .env → success page. */
export async function handleGoogleOAuthCallback(req, res) {
  const { code, state, error: errParam } = req.query || {};
  const p = pending.get(state);
  pending.delete(state);
  if (!p || Date.now() >= p.expiresAt) {
    return res.status(400).type("html").send(simplePage("Invalid or expired authorization state.", false));
  }
  if (errParam) {
    return res.status(400).type("html").send(simplePage(`Google authorization failed: ${errParam}`, false));
  }
  if (!code) {
    return res.status(400).type("html").send(simplePage("No authorization code returned.", false));
  }

  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET) {
    return res.status(500).type("html").send(simplePage("OAuth client not configured (GMAIL_CLIENT_ID/SECRET).", false));
  }

  try {
    const tokenRes = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        client_id: GMAIL_CLIENT_ID,
        client_secret: GMAIL_CLIENT_SECRET,
        redirect_uri: `${baseUrl()}/oauth/google/callback`,
        grant_type: "authorization_code",
      }),
    });
    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      console.error(`   ❌ [OAUTH] Token exchange failed (${tokenRes.status}): ${body}`);
      return res.status(500).type("html").send(simplePage(`Token exchange failed (${tokenRes.status}).`, false));
    }
    const tokens = await tokenRes.json();

    const refreshToken = tokens.refresh_token || process.env.GMAIL_REFRESH_TOKEN;
    if (!refreshToken) {
      return res.status(500).type("html").send(simplePage("No refresh_token returned. Please try again (offline access).", false));
    }

    let email = "";
    try {
      const ui = await fetch(USERINFO_ENDPOINT, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
      const uj = await ui.json();
      email = uj.email || "";
    } catch {
      /* email is best-effort */
    }

    writeEnvVar("GMAIL_CLIENT_ID", GMAIL_CLIENT_ID);
    writeEnvVar("GMAIL_CLIENT_SECRET", GMAIL_CLIENT_SECRET);
    writeEnvVar("GMAIL_REFRESH_TOKEN", refreshToken);
    if (email) writeEnvVar("GMAIL_USER", email);

    // Bind the account to the seat that initiated the consent (state → sub), so
    // the agent runner uses THIS account when acting on behalf of this seat.
    setSeatGoogle(p.sub, { user: email || null, refreshToken, clientId: GMAIL_CLIENT_ID, clientSecret: GMAIL_CLIENT_SECRET });

    console.log(`   ✅ [OAUTH] Google connected as "${email || p.sub}" — .env + seat "${p.sub}" updated.`);
    console.log(`   ⚠️  [OAUTH] Restart the Gmail/Drive/Calendar MCP servers for the new token to take effect.`);

    const webapp = (process.env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean)[0] || "/";
    return res.status(200).type("html").send(
      simplePage(
        `Connected to Google as <strong>${email ? escapeHtml(email) : "you"}</strong>. The credentials were written to the agent's .env.<br/>` +
          `The Gmail/Drive/Calendar services will pick them up after a restart.`,
        true,
        webapp,
      ),
    );
  } catch (err) {
    console.error(`   ❌ [OAUTH] Callback error: ${err.message}`);
    return res.status(500).type("html").send(simplePage(`Unexpected error: ${err.message}`, false));
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function simplePage(message, ok, backUrl) {
  const color = ok ? "#3fb950" : "#f85149";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Google Connect</title></head>
<body style="font-family:system-ui,sans-serif;background:#0d1117;color:#c9d1d9;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center;max-width:520px">
<h2 style="color:${color}">${ok ? "✓ Authorization complete" : "⚠ Authorization failed"}</h2>
<p>${message}</p>
${backUrl ? `<p><a href="${escapeHtml(backUrl)}" style="color:#58a6ff">← Return to the app</a></p>` : ""}
<p style="color:#8b949e;font-size:13px">You can close this tab.</p>
</div></body></html>`;
}
