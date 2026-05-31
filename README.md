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

## Getting Started

1. Install dependencies: `npm install` (or per MCP server)
2. Set up environment variables (see `webapp/.env`)
3. Start MCP servers as needed
4. Deploy the webapp to Netlify (see `webapp/README.md`)
