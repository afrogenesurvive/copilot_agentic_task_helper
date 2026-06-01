# Custom Agents

## agent-workflow

Used for daily task management and notification processing across the Trello/Gmail/webhook ecosystem.

### Instructions

You are a task workflow agent. When given a new day's context:

1. Read the daily task file from `tasks/YYYY-MM-DD.md`
2. Process any pending notifications
3. Process any pending tool calls in `logs/pending-tool-calls/`
4. Report what was accomplished

### Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Copilot Agent (this agent)                                             │
│  Communicates via stdio with MCP Servers                                │
│                                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────────────┐ │
│  │ Trello MCP   │  │ Gmail MCP    │  │ Webhook Server (port 3199)     │ │
│  │ Server       │  │ Server       │  │  - Trello callbacks            │ │
│  │ (stdio)      │  │ (stdio)      │  │  - Gmail Pub/Sub push          │ │
│  │ Tools:       │  │ Tools:       │  │  - Event queue                 │ │
│  │ - create_card│  │ - list_msgs  │  │  - Tool log viewer (/tool-logs)│ │
│  │ - get_card   │  │ - get_msg    │  │  - Live terminal tail (🔧)     │ │
│  │ - list_cards │  │ - send_msg   │  │  - Tool dispatch rules engine  │ │
│  │ - add_comment│  │              │  │  - Auto-renewing Gmail watch   │ │
│  │ - update_card│  │              │  └────────────────────────────────┘ │
│  │ - get_lists  │  │              │                                     │
│  └──────────────┘  └──────────────┘                                     │
└──────────────────────────────────────────────────────────────────────────┘
```

### MCP Server Tools

#### Trello MCP Server (`mcp/trello/index.js`) — stdio transport

| Tool                 | Description                                | Required Params  |
| -------------------- | ------------------------------------------ | ---------------- |
| `trello_create_card` | Create a new card in a list                | `listId`, `name` |
| `trello_get_card`    | Get full card details by ID                | `cardId`         |
| `trello_list_cards`  | List all cards in a list                   | `listId`         |
| `trello_add_comment` | Add a comment to a card                    | `cardId`, `text` |
| `trello_update_card` | Update card fields (name, desc, pos, etc.) | `cardId`         |
| `trello_get_lists`   | Get all lists on a board                   | `boardId`        |

Uses `TRELLO_KEY`, `TRELLO_TOKEN`, `TRELLO_BASE_URL` from environment.

#### Gmail MCP Server (`mcp/gmail/index.js`) — stdio transport

| Tool                  | Description                                 | Required Params         |
| --------------------- | ------------------------------------------- | ----------------------- |
| `gmail_list_messages` | Search/list Gmail messages (maxResults≤100) | (optional `query`)      |
| `gmail_get_message`   | Get a single message with full body         | `id`                    |
| `gmail_send_message`  | Send a plain text email                     | `to`, `subject`, `body` |

Uses `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `GMAIL_USER` from environment.

Both servers **auto-log** all tool calls to `logs/tool_call/` — no wrapper needed.

### Data Sources — Tool Calls Required

When the user asks about Trello or Gmail data, **always use the MCP tools** — never read flat log files directly.

| Data                        | Use This                                                                | Instead Of                                  |
| --------------------------- | ----------------------------------------------------------------------- | ------------------------------------------- |
| Trello boards/cards/changes | `mcp_trello_trello_get_lists`, `trello_create_card`, etc. via MCP       | Reading `logs/notifications/trello/*.jsonl` |
| Gmail messages              | `mcp_gmail_gmail_list_messages`, `mcp_gmail_gmail_get_message`          | Reading `logs/notifications/gmail/*.jsonl`  |
| Pending tool calls          | `logs/pending-tool-calls/queue.jsonl` (this is the authoritative queue) | —                                           |

Log files under `logs/notifications/` are for **persistence/backup only** — they contain deduplicated push notification metadata, not full data. Use the MCP tools to get real-time, complete data.

### Webhook Server (`mcp/webhook-server/index.js`)

Express server on port **3199** that receives push notifications from Trello and Gmail.

| Endpoint               | Method | Description                       |
| ---------------------- | ------ | --------------------------------- |
| `/webhooks/trello`     | HEAD   | Trello webhook verification       |
| `/webhooks/trello`     | POST   | Trello webhook callbacks          |
| `/webhooks/gmail/push` | POST   | Gmail Pub/Sub push delivery       |
| `/webhooks/gmail/push` | GET    | Gmail push verification           |
| `/events`              | GET    | Read all pending events           |
| `/events/:id`          | DELETE | Clear a processed event           |
| `/health`              | GET    | Health check                      |
| `/tool-logs`           | GET    | View recent tool call log entries |

### Notification Log Formats

#### Trello notifications (`logs/notifications/trello/YYYY-MM-DD.jsonl`)

Each entry contains these fields (undefined ones stripped):

```json
{
  "ts": "ISO timestamp",
  "source": "trello",
  "type": "createCard|updateCard|commentCard|updateCheckItemStateOnCard|...",
  "data": {
    "board": "Board name",
    "list": "List name",
    "card": "Card name",
    "checklist": "Checklist name (if applicable)",
    "checkItem": "Checklist item name (if applicable)"
  }
}
```

#### Gmail notifications (`logs/notifications/gmail/YYYY-MM-DD.jsonl`)

Each entry contains these fields (undefined ones stripped):

```json
{
  "ts": "ISO timestamp",
  "source": "gmail",
  "type": "new_message",
  "data": {
    "from": "Sender email",
    "subject": "Email subject",
    "date": "Email date header",
    "snippet": "Gmail snippet"
  }
}
```

### Tool Dispatch Rules (`safe/webhook-tool-rules.json`)

When webhook events arrive, the tool dispatch engine checks rules and enqueues tool calls. Supports:

- Matching by `source` (gmail/trello), `type`, and `conditions`
- Conditions: `equals`, `contains`, `regex`, `exists`
- Variable interpolation: `{{event.data.field.path}}`
- Enables/disables rules per-rule

Current rules:

- **Frontdesk input needs human approval**: Flags new cards in "frontdesk_input" list
- (Others disabled by default — see `safe/webhook-tool-rules.json`)

### Event Queue (`logs/pending-tool-calls/queue.jsonl`)

The authoritative queue for pending tool calls. Persisted to disk for crash recovery. Examples:

```json
{"id":"1717000000000-abc123","source":"trello","type":"createCard","data":{...},"queuedAt":"..."}
{"id":"1717000000001-def456","source":"tool_dispatch","type":"pending_tool_call","data":{...},"queuedAt":"..."}
```

### Logging System

| Path                                    | Description                                        |
| --------------------------------------- | -------------------------------------------------- |
| `logs/tool_call/YYYY-MM-DD.log`         | Human-readable tool call log                       |
| `logs/tool_call/YYYY-MM-DD_verbose.log` | JSONL format tool call log                         |
| `logs/notifications/gmail/*.jsonl`      | Gmail push notification metadata (backup only)     |
| `logs/notifications/trello/*.jsonl`     | Trello webhook notification metadata (backup only) |
| `logs/webhook/{date}_verbose.log`       | Webhook server runtime logs                        |
| `logs/pending-tool-calls/queue.jsonl`   | Authoritative pending tool call queue              |

### Scripts

| Script                                                 | Purpose                                         |
| ------------------------------------------------------ | ----------------------------------------------- |
| `mcp/webhook-server/scripts/start-all.sh`              | Full startup: tunnel → .env → server → webhooks |
| `mcp/webhook-server/scripts/start-webhook.sh`          | Setup script for tunnel + webhooks              |
| `mcp/webhook-server/scripts/setup-trello-webhook.js`   | Register Trello webhooks                        |
| `mcp/webhook-server/scripts/setup-gmail-watch.js`      | Set up Gmail push notification watch            |
| `mcp/webhook-server/scripts/update-push-endpoint.js`   | Update Trello webhook callback URL              |
| `mcp/webhook-server/scripts/update-pubsub-endpoint.js` | Update GCloud Pub/Sub push endpoint             |
| `mcp/webhook-server/scripts/check-gmail-watch.js`      | Verify Gmail watch status                       |
| `scripts/mcp-log-wrapper.mjs`                          | Legacy stdio wrapper for MCP log interception   |
| `scripts/log-tool-call.mjs`                            | Standalone tool call logger (CLI usage)         |

### Tools Available

- All default Copilot tools
- MCP: Trello (board/card/list management), Gmail (read/search/send)
- Task workflow: daily task files, notification logs (backup only), event queue, tool dispatch rules
