/**
 * Executable tool names — what the autonomous agent runner can actually run.
 *
 * Single source of truth for the rules UI's tool dropdown and the
 * `/api/rules/tools` endpoint. The runner executes these via HANDLERS in
 * `mcp/agent-runner/tool-executor.js`; `agent_log` is a pseudo-tool that hands
 * the model a free-form instruction instead of a specific tool call.
 *
 * Keep in sync with HANDLERS in mcp/agent-runner/tool-executor.js — the runner
 * logs a drift warning at startup if the two lists disagree.
 */

export const AGENT_LOG_TOOL = "agent_log";

export const EXECUTABLE_TOOLS = [
  // Trello
  "trello_add_comment",
  "trello_get_card",
  "trello_list_cards",
  "trello_get_lists",
  "trello_get_card_actions",
  "trello_create_card",
  "trello_update_card",
  "trello_create_checklist",
  "trello_add_checklist_item",
  // Gmail
  "gmail_list_messages",
  "gmail_get_message",
  "gmail_send_message",
  // Web search
  "web_search",
  "web_fetch",
  // WhatsApp
  "whatsapp_status",
  "whatsapp_list_numbers",
  "whatsapp_list_messages",
  "whatsapp_send_text",
  "whatsapp_send_template",
  "whatsapp_mark_read",
  // Frontdesk
  "frontdesk_reply",
];
