# Copilot Agentic Task Helper

A system that connects GitHub Copilot with external services (Trello, Gmail) via MCP servers.

## What It Does

- **Task management via Trello** — Read cards, create cards, add comments, and manage lists directly through Copilot
- **Email access via Gmail** — Search, read, and send emails from Copilot
- **Collaborator Chat** — A static webapp that lets a remote collaborator send messages to Copilot through a Trello-based chat interface
- **Notification relay** — A webhook server that receives push notifications from Trello and Gmail and queues them for the agent to process

## Components

- `mcp/trello/` — MCP server for Trello API access
- `mcp/gmail/` — MCP server for Gmail API access
- `mcp/webhook-server/` — Express server that receives and relays webhook notifications
- `webapp/` — Static web app for the collaborator chat interface

## Getting Started

1. Install dependencies: `npm install` (or per MCP server)
2. Set up environment variables
3. Start MCP servers as needed
4. Deploy the webapp
