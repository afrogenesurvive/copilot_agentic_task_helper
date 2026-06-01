# Copilot Instructions — Collaborator Chat

## Coding Style

- Use ES modules (`import`/`export`) for Node.js scripts
- Use CommonJS (`require`) for Netlify Functions
- JavaScript with JSDoc comments for functions
- Async/await over raw promises
- Prefer `fetch` over axios for HTTP

## Project Conventions

- MCP servers live in `mcp/<name>/` with their own `package.json`
- MCP SDK pattern: use `CallToolRequestSchema` / `ListToolsRequestSchema` from `@modelcontextprotocol/sdk` (v1.29.0+)
- `google-auth-library` v10.6.2: import `{ OAuth2Client }` directly (NOT `google.auth.OAuth2`)
- Daily tasks in `tasks/YYYY-MM-DD.md`
- Notifications logged to `logs/notifications/<source>/YYYY-MM-DD.jsonl`
- Webhook events logged to `logs/webhook/YYYY-MM-DD.log`
- Tool calls logged to `logs/tool_call/YYYY-MM-DD.log`

## MCP Tool Usage

- Trello: use for board/card/list management — never read `logs/notifications/trello/` for current data
- Trello: `trello_get_card_actions` (with `filter=commentCard`) reads card comments via MCP instead of raw API calls
- Frontdesk reply workflow: read comments on today's `frontdesk_input` card → find/create today's `frontdesk_output` card → add reply as comment
- Gmail: use `mcp_gmail_gmail_list_messages` + `mcp_gmail_gmail_get_message` for reading emails — never read `logs/notifications/gmail/` for current data
- Never expose credentials in code — use env vars or the edge function
- Tool call logging is **automatic** — both MCP servers (`mcp/trello/index.js` and `mcp/gmail/index.js`) have built-in `logToolCall()` functions that write to `logs/tool_call/`. The webhook server also polls this log and displays new entries in the terminal with a 🔧 prefix every 2 seconds.
- The legacy `mcp-log-wrapper.mjs` wrapper is also available but superseded by direct logging in the MCP servers.

## Data Retrieval Rules

When asked about Trello or Gmail content:

1. **Always use MCP tools first** — they give real-time, complete data
2. Log files under `logs/notifications/` contain only push notification metadata (trimmed to `{direction, from, to, subject, date, snippet}` for Gmail or `{board, list, card, checklist, checkItem}` for Trello) — treat them as **backup/audit only**, not as a data source for answering questions
3. Pending tool calls: read from `logs/pending-tool-calls/queue.jsonl` (that's the authoritative queue)
4. Tool call logs: use `/tool-logs` endpoint on the webhook server or read `logs/tool_call/YYYY-MM-DD.log` directly

## Webhook Server

- Express server on port **3199** (`mcp/webhook-server/index.js`)
- Receives Trello webhook callbacks and Gmail Pub/Sub push notifications
- Gmail watch covers both **INBOX** (received) and **SENT** (sent) labels — both directions captured
- Notification log entries include a `direction` field (`"received"` or `"sent"`) to distinguish
- Event queue (`/events`) persists to `logs/pending-tool-calls/queue.jsonl`
- Tool dispatch rules engine reads `safe/webhook-tool-rules.json`
- Live tool call tail: displays 🔧 prefixed lines in the webhook terminal every 2 seconds
- Tool call viewer: `GET /tool-logs?lines=20` on the webhook server
