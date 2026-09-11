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

## Agentic operator mode (tool access)

Operator chats are agentic — the model can **chain tools** to actually get things done, and tool
activity appears inline as chips/result bubbles:

- **Read-only tools run automatically** (no prompt): Trello reads (`get_card`, `list_cards`,
  `get_lists`, `get_card_actions`), Gmail reads (`list_messages`, `get_message`), web
  (`web_search`, `web_fetch`), plus scoped local reads — `fs_list_dir`, `fs_read_file`
  (allowlisted to `scripts/user`, `logs`, `tasks`, `docs`, `notes.txt`), `task_read_today`, and
  `queue_list_priority` / `queue_list_misc`.
- **State-changing actions ask for approval first**: a card appears with the tool + its
  parameters and **Approve / Deny / ■ Stop** buttons. This covers Trello writes (create/update/
  comment/checklists), `gmail_send_message`, and local writes like `task_check_item` and
  `queue_clear_item`.
- **Stop** aborts the running loop at any time; pending approvals auto-deny after ~2 minutes.
- Results from Trello/Gmail/web/queues/files are sanitized before they're fed back to the model.

The loop is bounded — the agent gets `OPERATOR_CHAT_MAX_ROUNDS` tool steps per message (default
**24**, clamped to 1–100; set it in ⚙️ Config → Chat). When the budget runs out the agent is asked
for one final **wrap-up call with no tools**, so you still get an answer that says what it found and
what is unfinished. If even that fails, the reply is
`[stopped: reached the maximum number of tool steps for one message]` and the transcript shows a
**▶ Continue** button — history (including tool calls + results) is persisted, so continuing resumes
with full context.

**Configuration** — set `OPERATOR_CHAT_TOOLS=false` in config to fall back to plain Q&A with no
tools, and `OPERATOR_CHAT_MAX_ROUNDS` to raise or lower the per-message tool-step budget. Tools are
only ever enabled on the **operator** channel; frontdesk chats remain read-only, tool-less Q&A by
design.

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
