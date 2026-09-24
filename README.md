# Copilot Agentic Task Helper

A system that connects GitHub Copilot with external services (Trello, Gmail, Google Drive, Google Calendar) via MCP servers.

## What It Does

- **Task management via Trello** — Read cards, create cards, add comments, and manage lists directly through Copilot
- **Email access via Gmail** — Search, read, and send emails from Copilot
- **File access via Google Drive** — List, search, and read Drive files from Copilot
- **Calendar management via Google Calendar** — List, view, and create calendar events from Copilot
- **Tasks, Sheets, and Photos** — Google Tasks, spreadsheet read/write, and picker-based Google Photos access from Copilot
- **WhatsApp + Netlify** — Meta WhatsApp Cloud API sends/templates/inbox and Netlify site, env-var and deploy management
- **Operator dashboard (macOS Electron)** — start/stop the whole local stack, watch queues/logs/sessions, manage seat licences and key rings, and chat with the same agent from one window
- **Collaborator Chat** — a static webapp that lets a remote collaborator chat with the agent over license-key login and end-to-end encryption; Trello is only the tunnel-down relay
- **Notification relay** — A webhook server that receives push notifications from Trello, Gmail, Drive, and Calendar and queues them for the agent to process

## Components

- `mcp/trello/` — MCP server for Trello API access
- `mcp/gmail/` — MCP server for Gmail API access
- `mcp/drive/` — MCP server for Google Drive API access
- `mcp/calendar/` — MCP server for Google Calendar API access
- `mcp/photos/` — MCP server for Google Photos (Library + Picker APIs)
- `mcp/sheets/` — MCP server for Google Sheets read/write
- `mcp/web-search/` — MCP server for DuckDuckGo search and page fetching
- `mcp/netlify/` — MCP server for Netlify API access (sites, env vars, deploys)
- `mcp/whatsapp/` — MCP server for Meta WhatsApp Cloud API access (text/template sends, phone numbers, inbound inbox)
- `mcp/webhook-server/` — Express server that receives and relays webhook notifications
- `electron/` — macOS operator dashboard (Electron): services, queues, logs, sessions, key manager, config, chat
- `webapp/` — Static web app for the collaborator chat interface

## Getting Started

1. Install dependencies: `npm install` (or per MCP server)
2. Set up environment variables (see `.env`)
3. Run OAuth auth: `npm run setup:gmail-auth` (one token for Gmail + filters, Drive, Calendar, Tasks and Photos)
4. Start MCP servers as needed
5. Run the operator dashboard: `npm run electron:install` (one-time) then `npm run electron:dev`
6. Deploy the webapp
