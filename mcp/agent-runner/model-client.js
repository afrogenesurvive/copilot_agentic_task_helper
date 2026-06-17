/**
 * Model Client — calls DeepSeek V4 API with function calling via the OpenAI SDK
 *
 * Takes an event's context, sends it to DeepSeek along with tool
 * definitions from the shared manifest, and returns the model's
 * chosen tool call (function name + arguments).
 *
 * Uses the OpenAI SDK because DeepSeek's API is fully compatible with it.
 *
 * Environment:
 *   DEEPSEEK_API_KEY — API key for DeepSeek V4
 *   AGENT_MODEL      — Model name (default: "deepseek-chat")
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_LOG_DIR = path.resolve(__dirname, "..", "..", "logs", "agent-runner", "prompts");

/**
 * Log the full prompt sent to DeepSeek for audit/review.
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
    model: process.env.AGENT_MODEL || "deepseek-v4-flash",
  };
  try {
    fs.mkdirSync(PROMPT_LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(PROMPT_LOG_DIR, `${day}.jsonl`), JSON.stringify(entry) + "\n");
  } catch (err) {
    console.error(`   ❌ [MODEL] Failed to log prompt: ${err.message}`);
  }
}

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY || "",
  baseURL: "https://api.deepseek.com",
});

/**
 * Map MCP tool definitions to OpenAI's tool calling format.
 */
function mapTools(toolDefs) {
  return toolDefs.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
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
 * Call the DeepSeek V4 API with an event or task context and tool definitions.
 * Uses the OpenAI SDK under the hood.
 * @param {object|string} context — A queue event object OR a plain context string
 * @param {Array} toolDefs — Tool definitions from shared/tool-manifest.js
 * @returns {object|null} { name: string, arguments: object } or null if no tool call
 */
export async function callModel(context, toolDefs) {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error("   ❌ [MODEL] DEEPSEEK_API_KEY not set in .env");
    return null;
  }

  const tools = mapTools(toolDefs);

  // Support both event objects and plain context strings
  const eventContext = typeof context === "string" ? context : buildEventContext(context);
  const model = process.env.AGENT_MODEL || "deepseek-v4-flash";

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
    "",
    "Rules:",
    "- Choose ONE tool and provide ALL required parameters",
    "- If the event is a frontdesk message, reply helpfully but don't make up information",
    "- If you're unsure, use trello_add_comment to ask for clarification",
    "- Never make up card IDs, list IDs, or other identifiers",
    "- Respond only with a tool call — no explanatory text",
  ].join("\n");

  // Log the full prompt for audit when AGENT_RUNNER_VERBOSE=true
  logPrompt(systemMessage, eventContext, tools);

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        {
          role: "system",
          content: systemMessage,
        },
        {
          role: "user",
          content: eventContext,
        },
      ],
      tools,
      tool_choice: "auto",
      temperature: 0.1,
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      stream: false,
    });

    const choice = response.choices?.[0];
    const toolCall = choice?.message?.tool_calls?.[0];

    if (!toolCall) {
      const reply = choice?.message?.content || "(empty)";
      console.log(`   ⚠️ [MODEL] No tool call returned — model said: "${reply.slice(0, 100)}"`);
      return null;
    }

    // Parse the arguments JSON string
    let args;
    try {
      args = JSON.parse(toolCall.function.arguments);
    } catch {
      console.error(`   ❌ [MODEL] Invalid JSON in tool arguments: "${toolCall.function.arguments}"`);
      return null;
    }

    console.log(`   🤖 [MODEL] DeepSeek chose: ${toolCall.function.name}(${JSON.stringify(args)})`);
    return { name: toolCall.function.name, arguments: args };
  } catch (err) {
    // OpenAI SDK errors include status code and message
    const status = err.status ? ` (HTTP ${err.status})` : "";
    console.error(`   ❌ [MODEL] API call failed${status}: ${err.message}`);
    return null;
  }
}
