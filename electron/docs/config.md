# ⚙️ Config

The Config tab edits the app's plain-JSON configuration. There are two storage locations:

- **`config.json`** at the repo root — when present it **overrides** `.env`.
- **`.env`** — used as a fallback when `config.json` is absent. Pressing **Save** writes a
  `config.json` from the values you changed.
- Run `npm run config:init` (`scripts/config-from-env.mjs`) to (re)create `config.json` by
  mirroring every `.env` key. It is merge-safe and leaves `.env` untouched as the fallback.

The header shows which source is active: `✅ config.json present` or
`⚠️ no config.json … falling back to .env`.

## The form

Settings are grouped into sections, each field showing its **source tag** (`config.json`,
`.env`, or `default`):

- **LLM Provider** — a provider picker (DeepSeek / OpenAI / Anthropic / Ollama). Only the active
  provider's fields are shown (API key, model, base URL, etc.), plus the shared temperature.
  Required keys are marked **required** when missing.
- **Webhook** — port, base URL, API token, CORS origins, autostart, reminder interval.
  The API token guards the queue-admin API (`/events`, `/api/queue-status`, `/api/tasks`,
  `/api/rules`) and the server **fails closed**: with no token set those routes return
  `503` instead of serving unauthenticated, so set one (or leave the queue API disabled).
- **Trello** — API key/token, board and list IDs, webhook model IDs/actions.
- **Gmail / Google** — client ID/secret, refresh token, user, Pub/Sub topic/subscription. The
  section opens with a **Connect Google** button that remints the **operator** refresh token
  (the one every MCP server and the 💬 Chat tab run on) straight from the dashboard: it opens the
  Google consent screen, saves the new token to whichever store wins (see below) and drops the
  MCP connections plus restarts the runner/webhook so nothing keeps serving the old one. It
  requests Gmail (+ filters), Drive, **Calendar**, **Tasks** and Photos — the same scope set as
  `npm run setup:gmail-auth`, so either route gives the token identical capabilities. Use it when
  the token is stale, revoked, or was minted before a scope was added (e.g. Tasks).
- **WhatsApp** — Meta Cloud API: system-user access token, WABA ID, active phone-number ID
  (test or burner), optional test-number ID, API version, app secret + webhook verify token.
  See `whatsapp.md` for how to set up the free test number and a real (burner) number.
- **Frontdesk** — use-Trello / log-to-Trello toggles, agent public key, session TTL. The
  **HMAC secret** and **auth passphrase** are **legacy Trello-mirror settings**: they are only
  consulted when `FRONTDESK_USE_TRELLO=true`, and the webapp's current licence + E2E chat path
  ignores them entirely.
- **Tunnel** — Cloudflare tunnel token / ID / domain.
- **AWS** — access key/secret/session token, region, profile (used by helper scripts).
- **Usage tracking** — DS-mon master toggle, push URL / token / interval / instance ID, optional
  AES-256 encryption key (+ key ID), and the Usage-tab credit poll interval. See `usage.md`.
- **Agent runner** — enabled toggle, task interval, verbose prompt logging.
- **Logging** — log level, directory, console echo.
- **Appearance** — `light` / `dark` / `system` (same setting as the 🎨 Appearance tab).

Secret fields render as password inputs with a **👁 / 🙈** toggle to reveal.

**Which file a value is in matters.** `config.json` is PRIMARY; `.env` only supplies keys
`config.json` omits, and a copy of the same key in both files means the `.env` one is ignored.
**Save** and **Connect Google** both write the store that wins — but if you edit `.env` by hand,
check the ⚙️ Config tab is not showing that key as coming from `config.json`.

## Buttons

- **Refresh** — re-read config from disk.
- **Raw JSON / Form view** — switch between the sectioned form and a full JSON editor.
- **💾 Save** — **merges** the keys you changed into `config.json` (other keys are preserved;
  clearing a field to empty reverts it to `.env`/default). If you changed any LLM/provider **or
  usage-tracking** keys, the runner and webhook services restart automatically so the change is
  live; the 💬 Chat tab picks LLM changes up immediately.
- **📤 Export** — downloads the current config as `config.json`.
- **📥 Import** — loads a JSON file you pick and writes it to `config.json`.

## Notes

- Saving **merges** — only keys you actually change are updated, so other settings (including
  other providers' keys) are preserved. Clearing a field to empty removes it from `config.json`,
  falling back to `.env` or the built-in default.
- Validation is light: e.g. saving an LLM provider with no API key succeeds but warns that calls
  will fail until the key is added.
- Config here is the **local** operator config. Netlify-hosted settings for the webapp are
  separate — see `netlify-setup.md`.
