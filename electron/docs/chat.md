# 💬 Chat

The Chat tab lets you talk to the **configured LLM agent** directly from the dashboard — useful
for quick questions about queues, logs, or anything else the agent can help with.

## Layout

- **Provider/model chip** (top) — shows the active LLM provider + model, e.g.
  `deepseek · deepseek-v4-flash`. This is set in ⚙️ Config → LLM Provider.
- **Session list** (left) — your previous chats, newest first, each showing message count and
  last activity.
- **Conversation** (center) — user/system/assistant bubbles; assistant messages tag the model
  used.
- **Composer** — a multi-line input with a **Send** button.

## Common actions

- **+ New chat** — starts a fresh session.
- **Send a message** — type and press **Enter** to send; **Shift+Enter** inserts a newline.
- **Refresh** — re-syncs the current session from disk.

## Persistence

Every session is saved to its own file under `logs/electron_chat/`, so chats survive restarts and
appear in the session list next time you open the app.

## Notes

- The agent here is prompted with a generic operator-assistant system prompt (configurable via
  `ELECTRON_CHAT_SYSTEM_PROMPT`).
- Chat calls go through the same provider logic as the agent runner, so switching provider in
  ⚙️ Config takes effect immediately for Chat; saving provider keys also restarts the runner and
  webhook services in the background.
- If the configured provider has no API key set, sends fail with a clear error — add the key in
  ⚙️ Config.
