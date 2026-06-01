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

## Security Overview

The system uses a **defense-in-depth** approach:

1. **Trello API proxy** (`webapp/netlify/functions/trello-proxy.js`) — All Trello API calls from the webapp go through a Netlify function, keeping the API key and token server-side. The browser never sees credentials.

2. **HMAC message signing** — The proxy signs frontdesk comments with `FRONTEND_SECRET` (HMAC-SHA256). The webhook handler verifies the signature, making direct Trello API calls detectable.

3. **Prompt injection sanitization** — All external data (Trello, Gmail, webhook events) is sanitized via `scripts/sanitize.mjs` before the agent processes it.

See `webapp/README.md` for deployment setup and `AGENTS.md` for full security documentation.

## Getting Started

1. Install dependencies: `npm install` (or per MCP server)
2. Set up environment variables (see `webapp/README.md`)
3. Start MCP servers as needed
4. Deploy the webapp to Netlify (see `webapp/README.md`)
