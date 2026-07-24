# Changelog

## [main-1] — 2026-07-24

### Added

- **Gmail multi-account support** (`mcp/gmail/index.js`): Added `userId` parameter to all Gmail tools (`gmail_list_messages`, `gmail_get_message`, `gmail_send_message`), supporting both the default account (`michael.grandison@gmail.com`) and `entclinicmobay@gmail.com` via `GMAIL_REFRESH_TOKEN_2`/`GMAIL_USER_2` env vars.
- **Sheets MCP Server** (`mcp/sheets/`): New MCP server with 5 tools — `sheets_get_metadata`, `sheets_get_values`, `sheets_update_values`, `sheets_insert_rows`, `sheets_copy_paste_format`. Provides per-cell Google Sheets editing for the Bills Check Master spreadsheet.
- **xlsx-to-Sheet conversion script** (`scripts/convert-xlsx-to-sheet.mjs`): One-time utility to convert the existing xlsx to a native Google Sheet.
- **`mcp:sheets` npm script** in `package.json` for running the Sheets MCP server directly.
- **`sheetsTools` export** in `shared/tool-manifest.js` — tool definitions shared with the agent runner and MCP servers.

### Changed

- **`shared/tool-manifest.js`**: All Gmail tool descriptions updated to document multi-account `userId` support. Added `sheetsTools` array with 5 Sheet tool definitions. `allTools` now includes `sheetsTools`.
- **Local config** (gitignored): `.vscode/mcp.json` updated with Sheets MCP server entry. `safe/office_monthly_bills_extraction_agent.md` updated with Sheets API workflow replacing xlsx download/upload pattern.
