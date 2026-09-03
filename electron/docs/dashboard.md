# 📊 Dashboard

The Dashboard is the home view. It shows the **health badge** in the header and a list of the
local services this app manages, with live output for each one.

## What you'll see

- **Health badge (top-right)** — `webhook 3199 ok` when the webhook server answers its `/health`
  endpoint, or `webhook down` when it doesn't.
- **Service tabs** — one button per service. They appear in the following states:

  - `● running` — the process is up (title shows the pid).
  - `○ stopped` — the service is configured but not running.
  - `not configured` — no runnable command is set (for example the Cloudflare tunnel when no
    tunnel token/ID is configured).

- **Detail panel** for the selected service:
  - Status line (`● running (pid N)` / `○ stopped` / `not configured`).
  - **▶ Start**, **⏹ Stop**, and **Refresh** buttons.
  - A live health JSON summary when the service exposes one (e.g. the webhook server).
  - A read-only tail of the service's most recent output (last ~500 lines), auto-scrolled.

## Services you can manage

- **Webhook server** — the Express API + queue engine (port 3199). The queue, logs, chat and
  webapp depend on it, so it's usually left running.
- **Agent runner** — the autonomous runner that processes priority queue items and daily tasks.
- **Cloudflare tunnel** — only appears as "configured" when `CLOUDFLARE_TUNNEL_TOKEN` or
  `CLOUDFLARE_TUNNEL_ID` is set in config.
- **MCP `<name>`** — `trello`, `gmail`, `drive`, `calendar`, `sheets`, `web-search`. Each starts
  the matching MCP server with the credentials from your current config.
- **Per-seat MCP instances** — when you spawn MCPs for a seat from the 🔐 Accounts tab, their
  services also show up here so you can start/stop and inspect them.

## Common actions

- **Start the stack** — select **Webhook server** → **▶ Start**, then start **Agent runner** (and
  the tunnel if you need remote access).
- **Troubleshoot a failing service** — select it and read the tail output; the last lines usually
  state the reason (missing env var, port in use, etc.).
- **Restart after editing config** — saving LLM/provider settings in ⚙️ Config automatically
  restarts the runner and webhook server; other services you restart manually here.

## Notes

- Starting/stopping here only affects **local** processes. The Dashboard does not change what is
  deployed on Netlify — that hosting is configured separately (see `netlify-setup.md`).
- A service that exits shows `[process exited code=N]` at the end of its output and reverts to
  `stopped`.
