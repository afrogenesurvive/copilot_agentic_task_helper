# ⚙️ Config

The Config tab edits the app's plain-JSON configuration. There are two storage locations:

- **`config.json`** at the repo root — when present it **overrides** `.env`.
- **`.env`** — used as a fallback when `config.json` is absent. Pressing **Save** writes a
  `config.json` from the values you changed.

The header shows which source is active: `✅ config.json present` or
`⚠️ no config.json … falling back to .env`.

## The form

Settings are grouped into sections, each field showing its **source tag** (`config.json`,
`.env`, or `default`):

- **LLM Provider** — a provider picker (DeepSeek / OpenAI / Anthropic / Ollama). Only the active
  provider's fields are shown (API key, model, base URL, etc.), plus the shared temperature.
  Required keys are marked **required** when missing.
- **Webhook** — port, base URL, API token, CORS origins, autostart, reminder interval.
- **Trello** — API key/token, board and list IDs, webhook model IDs/actions.
- **Gmail / Google** — client ID/secret, refresh token, user, Pub/Sub topic/subscription.
- **Frontdesk** — use-Trello / log-to-Trello toggles, agent public key, session TTL, HMAC
  secret, auth passphrase.
- **Tunnel** — Cloudflare tunnel token / ID / domain.
- **AWS** — access key/secret/session token, region, profile (used by helper scripts).
- **Agent runner** — enabled toggle, task interval, verbose prompt logging.
- **Logging** — log level, directory, console echo.
- **Appearance** — `light` / `dark` / `system` (same setting as the 🎨 Appearance tab).

Secret fields render as password inputs with a **👁 / 🙈** toggle to reveal.

## Buttons

- **Refresh** — re-read config from disk.
- **Raw JSON / Form view** — switch between the sectioned form and a full JSON editor.
- **💾 Save** — writes only the keys you changed to `config.json`. If you changed any LLM/provider
  keys, the runner and webhook services restart automatically so the new provider is live; the
  💬 Chat tab picks changes up immediately.
- **📤 Export** — downloads the current config as `config.json`.
- **📥 Import** — loads a JSON file you pick and writes it to `config.json`.

## Notes

- Only keys you actually change are written, so other settings (including other providers'
  keys) are preserved.
- Validation is light: e.g. saving an LLM provider with no API key succeeds but warns that calls
  will fail until the key is added.
- Config here is the **local** operator config. Netlify-hosted settings for the webapp are
  separate — see `netlify-setup.md`.
