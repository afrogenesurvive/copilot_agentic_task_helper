# 📊 Dashboard

The Dashboard is the home view. It shows the **health badge** in the header and a list of the
local services this app manages, with live output for each one.

## What you'll see

- **Health badge (top-right)** — `webhook 3199 ok` when the webhook server answers its `/health`
  endpoint, or `webhook down` when it doesn't.
- **Service tabs** — one button per service. They appear in the following states:

  - `● running` — the process is up (title shows the pid).
  - `● running (external)` — the process is up but was started **outside** the dashboard (for
    example the webhook server run as a background daemon). It can't be controlled from here, so
    its Start / Restart / Stop buttons are disabled.
  - `○ stopped` — the service is configured but not running.
  - `not configured` — no runnable command is set (for example the Cloudflare tunnel when no
    tunnel token/ID is configured).

- **Detail panel** for the selected service:
  - Status line (`● running (pid N)` / `● running (external — started outside the dashboard)` /
    `○ stopped` / `not configured`).
  - **▶ Start**, **↻ Restart**, **⏹ Stop**, and **Refresh** buttons. For external services the
    Start / Restart / Stop buttons are disabled — the dashboard can only control processes it
    started itself.
  - A live health JSON summary when the service exposes one (e.g. the webhook server).
  - For the **MCP whatsapp** service, a WhatsApp summary line: token/WABA configured (✅/❌),
    the **active phone number** (test vs live) and connected status, plus a **List numbers**
    helper to copy phone-number IDs into Config.
  - A read-only tail of the service's most recent output (last ~500 lines), auto-scrolled.

## Services you can manage

- **Webhook server** — the Express API + queue engine (port 3199). The queue, logs, chat and
  webapp depend on it, so it's usually left running.
- **Agent runner** — the autonomous runner that processes priority queue items and daily tasks.
- **Cloudflare tunnel** — only appears as "configured" when `CLOUDFLARE_TUNNEL_TOKEN` or
  `CLOUDFLARE_TUNNEL_ID` is set in config.
- **MCP `<name>`** — `trello`, `gmail`, `drive`, `calendar`, `sheets`, `web-search`, `whatsapp`.
  Each starts the matching MCP server with the credentials from your current config. The
  **MCP whatsapp** card additionally shows the active number and connection status (see above).
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

- **Operator-only:** this dashboard is the operator's single view of every local service, seat,
  license, and account binding. Seats/collaborators of the public chat webapp never see it —
  they only use their own webapp chat.
- Starting/stopping here only affects **local** processes. The Dashboard does not change what is
  deployed on Netlify — that hosting is configured separately (see `netlify-setup.md`).
- A service that exits shows `[process exited code=N]` at the end of its output and reverts to
  `stopped`.
