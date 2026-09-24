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
activity appears inline as chips/result bubbles.

Tools come from two places:

- **The MCP client** (`electron/src/main/mcp-client.mjs`) — every configured MCP server except
  Photos: **Trello, Gmail, Drive, Calendar, Sheets, Web Search, WhatsApp and Netlify**. A server is
  spawned as a child process the **first time** one of its tools is called and reused from then on
  (closed again after `MCP_CLIENT_IDLE_MS` of inactivity, default 10 minutes). Nothing is spawned
  merely to list the tools — the advertised list comes from `shared/tool-manifest.js`, the same
  arrays the servers themselves import, so the two cannot drift.
- **Electron-local tools** (`electron/src/main/local-tools.mjs`) — scoped repo access:
  `fs_list_dir`, `fs_read_file` (allowlisted to `scripts/user`, `logs`, `tasks`, `docs`,
  `notes.txt`), `task_read_today`, the two queue readers, and the two local write tools.

**Read vs approve** is decided by `electron/src/main/mcp-policy.mjs` and is **fail-closed** —
anything not explicitly listed as read-only raises an Approve/Deny card:

- **Auto-run (no prompt)** — the list/get/search reads: Trello reads (`get_card`, `list_cards`,
  `get_lists`, `get_card_actions`, `get_checklists`), Gmail reads (`list_messages`, `get_message`),
  web (`web_search`, `web_fetch`), Drive reads (`list_files`, `get_file`, `search_files`), the
  Calendar/Tasks reads (`list_calendars`, `list_events`, `get_event`, `list_tasks`,
  `list_tasklists`), Sheets reads (`get_values`, `get_metadata`), WhatsApp reads (`status`,
  `list_numbers`, `list_messages`), the Netlify reads (`list_sites`, `get_site`, `get_account`,
  `list_env`, `get_env`, `list_deploys`, `get_deploy`), plus the local reads above.
- **Approve first** — everything that writes: Trello create/update/comment/checklists,
  `gmail_send_message`, the Drive writes — **including `drive_delete_file` and `drive_move_file`**,
  which the autonomous runner refuses outright but the operator console allows behind a card — the
  Calendar event/task writes, the Sheets writes, the WhatsApp sends, the Netlify writes
  (`update_site`, `set_env`, `delete_env`, `trigger_build`, `restore_deploy`), and the local
  `task_check_item` / `queue_clear_item`.
- **Never offered** — `frontdesk_reply` (it belongs to the frontdesk channel, where the seat comes
  from the event and never from the model) and every `photos_*` tool (picker-only: a human has to
  open the returned URI, and `photos_picker_download` writes to a caller-chosen local directory).
- **Stop** aborts the running loop at any time; pending approvals auto-deny after ~2 minutes.
- Results from Trello/Gmail/web/Drive/Calendar/Sheets/WhatsApp/Netlify/queues/files are sanitized
  before they're fed back to the model. The web tools are the *same implementation* the
  web-search MCP server uses (`shared/web-tools.mjs`), so the chat and the MCP can't drift:
  identical DuckDuckGo parsing, identical page extraction, and both refuse loopback/private hosts —
  a model-chosen URL can't be used to read the local backend.

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
design. `MCP_CLIENT_IDLE_MS` controls how long an MCP child is kept alive between calls (default
600000; set `0` to keep them connected until the app quits).

**Where a tool call actually goes.** The chat no longer runs tools through the agent runner's shared
executor. `mcp/agent-runner/tool-executor.js` still serves the autonomous runner and the frontdesk
channel, with its own `FRONTDESK_ALLOWLIST` / `BLOCKLIST` gates — which is why the runner refuses
`drive_delete_file`/`drive_move_file` while this console allows them behind an approval card. The
two rule sets are independent on purpose; see `electron/src/main/mcp-policy.mjs`.

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
