/**
 * Model Client — multi-provider LLM client (a la ai_transcription_agent)
 *
 * All provider logic lives in shared/model-provider.mjs (single source of
 * truth shared with the webhook-server inline execute flow). Supported:
 *   LLM_PROVIDER=deepseek  (default)  — DEEPSEEK_API_KEY
 *   LLM_PROVIDER=openai               — OPENAI_API_KEY (+ OPENAI_MODEL / OPENAI_BASE_URL)
 *   LLM_PROVIDER=anthropic            — ANTHROPIC_API_KEY (+ ANTHROPIC_MODEL / ANTHROPIC_BASE_URL / ANTHROPIC_MAX_TOKENS)
 *   LLM_PROVIDER=ollama               — OLLAMA_BASE_URL + OLLAMA_MODEL (+ OLLAMA_NUM_CTX)
 *
 * Takes an event's context, sends it to the configured provider along with
 * tool definitions from the shared manifest, and returns the model's chosen
 * tool call (function name + arguments).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "../../shared/logger.mjs";
import { callChat, getModelName, getProvider } from "../../shared/model-provider.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_LOG_DIR = path.resolve(__dirname, "..", "..", "logs", "agent-runner", "prompts");

/**
 * Log the full prompt sent to the LLM for audit/review.
 * Writes to logs/agent-runner/prompts/YYYY-MM-DD.jsonl.
 * Only active when AGENT_RUNNER_VERBOSE=true is set.
 */
function logPrompt(systemMessage, userContext, tools) {
  if (process.env.AGENT_RUNNER_VERBOSE !== "true") return;
  const ts = new Date().toISOString();
  const day = ts.slice(0, 10);
  const entry = {
    ts,
    type: "model_prompt",
    systemMessage,
    userContext,
    toolCount: tools.length,
    toolNames: tools.map((t) => t.function?.name || t.name),
    model: getModelName(),
  };
  try {
    fs.mkdirSync(PROMPT_LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(PROMPT_LOG_DIR, `${day}.jsonl`), JSON.stringify(entry) + "\n");
  } catch (err) {
    console.error(`   ❌ [MODEL] Failed to log prompt: ${err.message}`);
  }
  log({ source: "runner", subSource: "model", level: "debug", message: "model prompt", data: { type: "model_prompt", toolCount: entry.toolCount, model: entry.model } });
}

/**
 * Build a concise task summary for the model.
 * @param {object} task — { lineIndex, text, raw }
 * @returns {string}
 */
export function buildTaskContext(task) {
  return [
    `Task to complete: "${task.text}"`,
    "",
    "You are a daily task automation agent. Use available tools to make progress on this task.",
    "If the task requires actions you can't take (file edits, deployments, environment changes), reply with '[skip]' to mark it as not actionable by automation.",
    "If you can make progress (read queues, send notifications, comment on cards), do so now.",
  ].join("\n");
}

/**
 * Build a concise human-readable summary of the event for the model.
 * Strips internal metadata (IDs, timestamps) so the model sees clean intent.
 * @param {object} event — The queue event
 * @returns {string}
 */
export function buildEventContext(event) {
  const lines = [`New ${event.source}/${event.type} event:`];

  if (event.data?.text) {
    lines.push(`Message: "${event.data.text.slice(0, 500)}"`);
  }

  if (event.data?.rule) {
    lines.push(`Matched rule: "${event.data.rule}"`);
    lines.push(`Requested tool: ${event.data.tool}`);
  }

  if (event.data?.originalEvent?.data?.card?.id) {
    lines.push(`Card ID (Trello hex ID): ${event.data.originalEvent.data.card.id}`);
    if (event.data.originalEvent.data.card.name) {
      lines.push(`Card name: "${event.data.originalEvent.data.card.name}"`);
    }
  }

  if (event.data?.originalEvent?.data?.list?.id) {
    lines.push(`List ID: ${event.data.originalEvent.data.list.id}`);
    if (event.data.originalEvent.data.list.name) {
      lines.push(`List name: "${event.data.originalEvent.data.list.name}"`);
    }
  }
  if (event.data?.originalEvent?.data?.board?.id) {
    lines.push(`Board ID: ${event.data.originalEvent.data.board.id}`);
    if (event.data.originalEvent.data.board.name) {
      lines.push(`Board name: "${event.data.originalEvent.data.board.name}"`);
    }
  }

  if (event.data?.subject) {
    lines.push(`Subject: "${event.data.subject}"`);
  }

  if (event.data?.direction) {
    lines.push(`Direction: ${event.data.direction}`);
  }

  return lines.join("\n");
}

/**
 * Call the configured LLM with an event or task context and tool definitions.
 * Delegates to shared/model-provider.mjs for the provider-specific request.
 * @param {object|string} context — A queue event object OR a plain context string
 * @param {Array} toolDefs — Tool definitions from shared/tool-manifest.js
 * @returns {object|null} { name: string, arguments: object } or null if no tool call
 */
export async function callModel(context, toolDefs) {
  // Support both event objects and plain context strings
  const eventContext = typeof context === "string" ? context : buildEventContext(context);

  const systemMessage = [
    "You are an autonomous business workflow agent. Your job is to process incoming events",
    "and decide what action to take. You have a full set of tools available (Trello, Gmail, Web Search).",
    "",
    "Context rules:",
    "- Frontdesk events (chat messages): only read & comment tools allowed",
    "- Non-frontdesk events: all tools available including create/update",
    "",
    "Available tools:",
    "- Trello: trello_add_comment, trello_get_card, trello_list_cards, trello_get_lists, trello_get_card_actions, trello_get_checklists, trello_create_card, trello_update_card, trello_create_checklist, trello_add_checklist_item",
    "- Gmail: gmail_list_messages, gmail_get_message, gmail_send_message",
    "- Web: web_search (search the web), web_fetch (fetch a URL and read content)",
    "- Frontdesk: frontdesk_reply (send an encrypted reply to a chat user — pass sub + text)",
    "",
    "Rules:",
    "- Choose ONE tool and provide ALL required parameters",
    "- If the event is a frontdesk message, reply helpfully but don't make up information",
    "- For frontdesk_message events (source: frontdesk), answer the user and reply with frontdesk_reply(sub=<the event's sub>, text=<your answer>)",
    "- If you're unsure, use trello_add_comment to ask for clarification",
    "- Never make up card IDs, list IDs, or other identifiers",
    "- Respond only with a tool call — no explanatory text",
  ].join("\n");

  // Log the full prompt for audit when AGENT_RUNNER_VERBOSE=true
  logPrompt(systemMessage, eventContext, toolDefs);

  try {
    const { toolCall, reply } = await callChat({
      systemMessage,
      userContext: eventContext,
      tools: toolDefs,
    });

    if (!toolCall) {
      const said = reply ? ` — model said: "${String(reply).slice(0, 100)}"` : "";
      console.log(`   ⚠️ [MODEL] No tool call returned${said}`);
      return null;
    }

    console.log(`   🤖 [MODEL] ${getProvider()}/${getModelName()} chose: ${toolCall.name}(${JSON.stringify(toolCall.arguments)})`);
    return { name: toolCall.name, arguments: toolCall.arguments };
  } catch (err) {
    console.error(`   ❌ [MODEL] API call failed: ${err.message}`);
    return null;
  }
}
