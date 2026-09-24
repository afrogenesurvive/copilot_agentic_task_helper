/**
 * Operator-chat tool policy — which advertised tools auto-run, which need the
 * operator's Approve/Deny card, and which the console must never offer.
 *
 * The classification lives here (not in chat-agent.mjs, and not in the manifest)
 * because it is a *policy* decision, not a schema one: `shared/tool-manifest.js`
 * describes the tools for every consumer — the MCP servers, VS Code, the Tools
 * tab and the chat — and the safety split differs per consumer. The agent runner
 * and the frontdesk channel keep their own gates in
 * `mcp/agent-runner/tool-executor.js` (`FRONTDESK_ALLOWLIST` / `BLOCKLIST`); this
 * file governs the operator console only, and the two are independent on purpose.
 *
 * Fail-closed: anything not listed in READ_ONLY needs approval, so a tool added to
 * the manifest tomorrow is never silently auto-run. NEVER_IN_CHAT is belt-and-braces
 * — `availableTools()` in mcp-client.mjs already excludes these servers, so a
 * mistake there still cannot reach them.
 *
 * Two deliberate differences from the executor's rules:
 *   - `drive_delete_file` / `drive_move_file` are BLOCKLISTed for autonomous use in
 *     the runner, but are allowed here behind an approval card (operator decision,
 *     2026-09-24). They are therefore absent from READ_ONLY, not blocked.
 *   - `drive_get_file` and `sheets_get_values` read file contents, but they are
 *     plain reads with no side effects, so they auto-run like Gmail reads do.
 */

/** Tool names that run without asking. Everything else prompts first. */
export const READ_ONLY = new Set([
  // Trello reads
  "trello_get_card",
  "trello_list_cards",
  "trello_get_lists",
  "trello_get_card_actions",
  "trello_get_checklists",
  // Gmail reads
  "gmail_list_messages",
  "gmail_get_message",
  // Web
  "web_search",
  "web_fetch",
  // Drive reads
  "drive_list_files",
  "drive_get_file",
  "drive_search_files",
  // Calendar / Tasks reads
  "calendar_list_calendars",
  "calendar_list_events",
  "calendar_get_event",
  "calendar_list_tasks",
  "calendar_list_tasklists",
  // Sheets reads
  "sheets_get_values",
  "sheets_get_metadata",
  // WhatsApp reads
  "whatsapp_status",
  "whatsapp_list_numbers",
  "whatsapp_list_messages",
  // Netlify reads
  "netlify_list_sites",
  "netlify_get_site",
  "netlify_get_account",
  "netlify_list_env",
  "netlify_get_env",
  "netlify_list_deploys",
  "netlify_get_deploy",
]);

/**
 * Never advertised to the operator chat, whatever the manifest says.
 * `frontdesk_reply` belongs to the frontdesk agent path (its seat comes from the
 * event, never from the model); `photos_*` is picker-only and can write to a
 * caller-chosen local directory.
 */
export const NEVER_IN_CHAT = new Set([
  "frontdesk_reply",
  "photos_picker_start",
  "photos_picker_poll",
  "photos_picker_list",
  "photos_picker_download",
  "photos_picker_delete",
]);

/** "read" (auto-run) | "approve" | "blocked". */
export function classify(toolName) {
  if (NEVER_IN_CHAT.has(toolName)) return "blocked";
  return READ_ONLY.has(toolName) ? "read" : "approve";
}

/** True when the chat may offer this tool at all. */
export function admits(toolName) {
  return !NEVER_IN_CHAT.has(toolName);
}

/** Built for chat-agent.mjs: `tools` advertised, `readTools` auto-run. */
export function filterTools(tools) {
  return (tools || []).filter((t) => t && admits(t.name));
}

/** Read-only names, for merging with the Electron-local read tools. */
export function readToolNames() {
  return new Set(READ_ONLY);
}
