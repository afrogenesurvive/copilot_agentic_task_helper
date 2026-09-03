# 📄 Logs

The Logs tab has two sub-tabs: **Live** (a streaming, filterable view of log entries) and
**Files** (browse and open saved log files on disk).

## Live

- **Filters** — narrow by:
  - **Source** — `webhook`, `runner`, `mcp`, `tunnel`, `frontdesk`, `notifications`, `electron`.
  - **Sub-source** — `trello`, `gmail`, `drive`, `calendar`, `sheets`, `web-search`, `queue`,
    `http`, `tool`, `model`, `action`, `send`, `reply`, `session`, `cloudflared`.
  - **Level** — `debug`, `info`, `warn`, `error`.
  - **Search box** — free-text filter across the message + data fields.
- **auto-scroll** checkbox — keeps the view pinned to the newest lines (default on).
- **⏸ Pause / ▶ Resume** — pauses the live stream so you can read without it jumping.
- **Clear** — wipes the in-memory log buffer (does not delete files).
- Each row shows time, level, source/sub-source, and message. Rows with extra JSON data have a
  **▸** toggle to expand the pretty-printed payload.

## Files

- Files are grouped by source; each row shows the file name, size, and last-modified time.
- **Click a file** to open it. Then use:
  - **Tail 500** — load just the last 500 lines.
  - **Full** — load the whole file.
  - **Search** — toggle a line filter box; JSON lines are pretty-printed to make them readable.
- The viewer is read-only and shows line numbers.

## Notes

- The live buffer keeps a rolling window (newest entries win).
- Saved logs live under `logs/` (e.g. `logs/tool_call/…`, `logs/webhook/…`) — the Files view is a
  safe way to read them without touching a terminal.
