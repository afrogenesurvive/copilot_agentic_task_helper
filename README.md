# Copilot Agentic Task Helper

A system that connects GitHub Copilot with external services (Trello, Gmail) via MCP servers, enabling automated task management and notification processing.

## Architecture

```
User ↔ Copilot ↔ MCP Servers (Trello, Gmail) ↔ External APIs
                                          ↕
                               Webhook Server (notification relay)
                                          ↕
                               Webapp (Collaborator Chat)
```

## Key Components

- **MCP Servers**: Trello and Gmail integrations in `mcp/`
- **Webhook Server**: Relays notifications from external services in `mcp/webhook-server/`
- **Collaborator Chat Webapp**: Static web app in `webapp/` for remote chat via Trello
- **Notification System**: Logs and processes events in `logs/`
- **Daily Tasks**: Task tracking in `tasks/`

## Notification Processing

The webhook server handles three notification paths:

| Path                                       | Queue       | Tool Dispatch                | Agent Action                                                   |
| ------------------------------------------ | ----------- | ---------------------------- | -------------------------------------------------------------- |
| **Non-frontdesk** (Gmail, Trello updates)  | ✅ Enqueued | ✅ Runs (tool calls allowed) | Executes tools when prompted                                   |
| **Authorized frontdesk** (with passphrase) | ❌ Skipped  | ❌ Skipped                   | Auto-answers read-only questions                               |
| **Unauthorized frontdesk** (no passphrase) | ✅ Enqueued | ✅ Runs (agent_log only)     | Sends generic response, logs to `logs/frontdesk/unauthorized/` |

> To process pending notifications, prompt the agent (e.g., "check for new items").
> The agent does not autonomously poll the queue — it's prompt-driven.

## Security Overview

The system uses a **defense-in-depth** approach:

1. **Trello API proxy** (`webapp/netlify/functions/trello-proxy.js`) — All Trello API calls from the webapp go through a Netlify function, keeping the API key and token server-side. The browser never sees credentials.

2. **HMAC message signing** — The proxy signs frontdesk comments with `FRONTEND_HMAC_SECRET` (HMAC-SHA256). The webhook handler verifies the signature, making direct Trello API calls detectable.

3. **Passphrase auto-authorization** — Frontdesk messages prefixed with `---passphrase---` are auto-authorized for read-only agent responses, skipping the queue entirely.

4. **Prompt injection sanitization** — All external data (Trello, Gmail, webhook events) is sanitized via `scripts/sanitize.mjs` before the agent processes it.

See `webapp/README.md` for deployment setup and `AGENTS.md` for full security documentation.

## Getting Started

1. Install dependencies: `npm install` (or per MCP server)
2. Set up environment variables (see `webapp/README.md`)
3. Start MCP servers as needed
4. Deploy the webapp to Netlify (see `webapp/README.md`)
