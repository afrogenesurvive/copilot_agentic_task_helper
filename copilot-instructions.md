# Copilot Instructions — Collaborator Chat

## Coding Style

- Use ES modules (`import`/`export`) for Node.js scripts
- Use CommonJS (`require`) for Netlify Functions
- JavaScript with JSDoc comments for functions
- Async/await over raw promises
- Prefer `fetch` over axios for HTTP

## Project Conventions

- MCP servers live in `mcp/<name>/` with their own `package.json`
- Daily tasks in `tasks/YYYY-MM-DD.md`
- Notifications logged to `logs/notifications/<source>/YYYY-MM-DD.jsonl`
- Webhook events logged to `logs/webhook/YYYY-MM-DD.log`
- Tool calls logged to `logs/tool_call/YYYY-MM-DD.log`

## MCP Tool Usage

- Trello: use for board/card/list management
- Gmail: use for reading and sending emails
- Never expose credentials in code — use env vars or the edge function
