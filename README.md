# Copilot Agentic Task Helper

A system that connects GitHub Copilot with external services (Trello, Gmail, Google Drive, Google Calendar) via MCP servers.

## What It Does

- **Task management via Trello** — Read cards, create cards, add comments, and manage lists directly through Copilot
- **Email access via Gmail** — Search, read, and send emails from Copilot
- **File access via Google Drive** — List, search, and read Drive files from Copilot
- **Calendar management via Google Calendar** — List, view, and create calendar events from Copilot
- **Collaborator Chat** — A static webapp that lets a remote collaborator send messages to Copilot through a Trello-based chat interface
- **Notification relay** — A webhook server that receives push notifications from Trello, Gmail, Drive, and Calendar and queues them for the agent to process

## Components

- `mcp/trello/` — MCP server for Trello API access
- `mcp/gmail/` — MCP server for Gmail API access
- `mcp/drive/` — MCP server for Google Drive API access
- `mcp/calendar/` — MCP server for Google Calendar API access
- `mcp/webhook-server/` — Express server that receives and relays webhook notifications
- `webapp/` — Static web app for the collaborator chat interface

## Getting Started

1. Install dependencies: `npm install` (or per MCP server)
2. Set up environment variables (see `.env`)
3. Run OAuth auth: `npm run setup:gmail-auth` (Grants Gmail + Drive + Calendar scopes with one token)
4. Start MCP servers as needed
5. Deploy the webapp
