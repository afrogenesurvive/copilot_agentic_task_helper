# 🌐 Netlify / Frontdesk Setup

The frontdesk system has two halves:

1. **A local/tunnel backend** — the webhook server (port 3199), agent runner, and registered
   webhooks that actually answer visitors. This is what the Dashboard in this app runs.
2. **A Netlify-hosted webapp** — the public UI shell visitors log into and chat with, plus a
   degraded-mode Trello relay. Netlify hosts **only this shell**: it never runs the agent, and no
   secrets ever reach the browser.

This page is the step-by-step guide for the **Netlify side**. Getting the frontdesk live end to
end means doing this hosting setup **and** keeping the tunnel backend running.

## Netlify project dashboard — what to set

### 1. Site & deploy settings

- Link the repo as a Netlify site. The included `netlify.toml` already sets the build base to
  `webapp/` and the publish directory to `public/`, so no build command is needed (static files).
- **Functions**: the two serverless functions live in `webapp/netlify/functions/` and should be
  auto-discovered as `/.netlify/functions/config` and `/.netlify/functions/trello-proxy`. If the
  dashboard's **Functions** page shows none, set **Site configuration → Functions →
  directory = `netlify/functions`** (relative to the base).
- Trigger a deploy once the settings/env below are in place.

### 2. Environment variables

Add these in **Site configuration → Environment variables** (apply to Production — add the same
for any previews you test), then redeploy:

Required:

- `WEBHOOK_BASE_URL` — the public URL of your tunnel backend (e.g. `https://chat.example.com`).
  The webapp calls the backend through this.
- `FRONTDESK_AGENT_PUBKEY` — the agent's X25519 public key from your local `.env` (encryption
  peer for chat).
- `TRELLO_BOARD_ID`
- `TRELLO_LIST_FRONTEDESK_INPUT`
- `TRELLO_LIST_FRONTEDESK_OUTPUT`
- `TRELLO_API_KEY`, `TRELLO_API_TOKEN` — kept **server-side** by the proxy only; never sent to the
  browser.

Optional:

- `FRONTEND_HMAC_SECRET` — shared secret used to sign messages through the proxy (when enabled).
- `FRONTDESK_SESSION_TTL` — session lifetime in seconds (default `7200`).

### 3. Verify after deploy

- Open `https://<your-site>.netlify.app/.netlify/functions/config` — it should return the runtime
  config JSON (board/list IDs, `WEBHOOK_BASE_URL`, `FRONTDESK_AGENT_PUBKEY`) with
  `TRELLO_API_KEY` and `TRELLO_API_TOKEN` **empty**. Empty values prove the secrets are not being
  leaked to the browser.
- POST to `/.netlify/functions/trello-proxy` — it should respond with something other than a 500
  (a 500 means the Trello credentials are not configured).
- Open the site and log in with a license key — the chat should route through
  `WEBHOOK_BASE_URL`.

### 4. Domain & CORS

- Add your site URL to the backend's allow-list by setting `CORS_ORIGINS` in the **backend's**
  `.env` on the tunnel host (e.g. `https://<site>.netlify.app,https://chat.example.com`). This is
  not a Netlify setting.
- If you use a custom domain, configure it under **Domain management** and include it in
  `CORS_ORIGINS` too.

## What Netlify actually does here

| Concern | Handled by |
| --- | --- |
| Public UI shell + license login page | Netlify (static files in `webapp/public/`) |
| Runtime `/api/config` for the browser | Netlify function `config` |
| Degraded-mode Trello relay (store-and-forward when the tunnel is down) | Netlify function `trello-proxy` |
| License verification, chat send/poll, sessions, OAuth | The tunnel backend (webhook server) |
| Listening for Trello/Gmail changes | The tunnel backend's registered webhooks |
| Actually answering visitors (the agent) | The tunnel backend (webhook server + agent runner) |

## Staying on top of the backend

- Keep the webhook server (and tunnel) running — start them from the 📊 Dashboard and leave this
  app open, or run them via the normal start scripts.
- If `WEBHOOK_BASE_URL` is unreachable, the webapp falls back to **degraded mode**: sends are
  stored and relayed through the Trello proxy until the tunnel returns. Live chat and license
  login still need the backend up.
- Register the webhooks/tunnel once (startup scripts do this) so Trello/Gmail events reach the
  webhook server.
