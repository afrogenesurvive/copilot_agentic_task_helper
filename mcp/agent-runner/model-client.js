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
import { callChatHistory, getModelName, getProvider } from "../../shared/model-provider.mjs";
import { sanitizeObject } from "../../scripts/sanitize.stub.mjs";

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
 * Flatten + sanitize an untrusted value before interpolating it into a prompt.
 *
 * Two things happen here and both matter:
 *   - newlines are collapsed, so a card name containing "\n\nYou are now …" can no
 *     longer restructure the prompt around it;
 *   - the prompt-injection sanitizer runs over the value.
 *
 * Queue events are already sanitized when read back (poller.js), but daily task
 * text is not sanitized anywhere else — this is the boundary that guarantees it
 * regardless of where the value came from.
 */
function safeValue(value, field) {
  if (value === undefined || value === null) return "";
  const flat = String(value)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return sanitizeObject({ v: flat }, { auditSource: `model/${field}` }).v;
}

/**
 * Build a concise task summary for the model.
 * @param {object} task — { lineIndex, text, raw }
 * @returns {string}
 */
export function buildTaskContext(task) {
  return [
    `Task to complete: "${safeValue(task.text, "task")}"`,
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
    lines.push(`Message: "${safeValue(event.data.text, "event.text").slice(0, 500)}"`);
  }

  if (event.data?.rule) {
    lines.push(`Matched rule: "${safeValue(event.data.rule, "event.rule")}"`);
    lines.push(`Requested tool: ${safeValue(event.data.tool, "event.tool")}`);
  }

  if (event.data?.originalEvent?.data?.card?.id) {
    lines.push(`Card ID (Trello hex ID): ${safeValue(event.data.originalEvent.data.card.id, "card.id")}`);
    if (event.data.originalEvent.data.card.name) {
      lines.push(`Card name: "${safeValue(event.data.originalEvent.data.card.name, "card.name")}"`);
    }
  }

  if (event.data?.originalEvent?.data?.list?.id) {
    lines.push(`List ID: ${safeValue(event.data.originalEvent.data.list.id, "list.id")}`);
    if (event.data.originalEvent.data.list.name) {
      lines.push(`List name: "${safeValue(event.data.originalEvent.data.list.name, "list.name")}"`);
    }
  }
  if (event.data?.originalEvent?.data?.board?.id) {
    lines.push(`Board ID: ${safeValue(event.data.originalEvent.data.board.id, "board.id")}`);
    if (event.data.originalEvent.data.board.name) {
      lines.push(`Board name: "${safeValue(event.data.originalEvent.data.board.name, "board.name")}"`);
    }
  }

  if (event.data?.subject) {
    lines.push(`Subject: "${safeValue(event.data.subject, "event.subject")}"`);
  }

  if (event.data?.direction) {
    lines.push(`Direction: ${safeValue(event.data.direction, "event.direction")}`);
  }

  return lines.join("\n");
}

/**
 * The runner's system prompt.
 *
 * The frontdesk contract is stated twice on purpose: the seat comes from the
 * event and never from the model, so `sub` is not offered as a parameter at all
 * (removed from `frontdeskTools` in shared/tool-manifest.js) — the model used to
 * invent one (`"frontdesk"`, `"frontdesk_user"`, even the question text) and the
 * reply endpoint rejected it with unknown_seat.
 */
function buildSystemMessage() {
  return [
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
    "- Frontdesk: frontdesk_reply (send an encrypted reply to a chat user — text only)",
    "",
    "Rules:",
    "- Choose ONE tool and provide ALL required parameters",
    "- If the event is a frontdesk message, reply helpfully but don't make up information",
    "- For frontdesk_message events, the user gets an answer ONLY when you call frontdesk_reply. A read tool (gmail_list_messages, trello_get_lists, web_search, …) is a step towards that answer, not the answer: its result is fed back to you, so read first and then call frontdesk_reply with what you found.",
    "- Do not read more than twice before replying. If you already have enough to answer, or the reads did not turn up the thing you were looking for, reply anyway and say what you found.",
    "- frontdesk_reply takes text only. Never pass a 'sub' — the runner supplies the correct seat from the event.",
    "- If a tool fails, try a different tool that could answer the question; if none can, call frontdesk_reply explaining that briefly rather than retrying the same call.",
    "- If you're unsure, use trello_add_comment to ask for clarification",
    "- Never make up card IDs, list IDs, or other identifiers",
    "- Respond only with a tool call — no explanatory text",
  ].join("\n");
}

/**
 * Call the configured LLM with an event or task context and tool definitions.
 * Delegates to shared/model-provider.mjs for the provider-specific request.
 *
 * @param {object|string} context — A queue event object OR a plain context string
 * @param {Array} toolDefs — Tool definitions from shared/tool-manifest.js
 * @param {object} [opts]
 * @param {Array}  [opts.history] — provider messages from earlier steps of the
 *   same event (see `toolStepMessages`), so a read tool's result — or its error —
 *   can be fed back for another turn.
 * @param {string} [opts.step] — usage-attribution label for this turn
 * @returns {object|null} { name, arguments, reply, reasoning_content, usage },
 *   or null when the model chose no tool call.
 * @throws {Error} with `code === "MODEL_ERROR"` when the provider call itself
 *   fails. Callers MUST tell this apart from `null`: an LLM outage is not the same
 *   event as "nothing to do", and treating it as the latter used to mark the
 *   user's message as processed and drop it (index.js step 1).
 */
export async function callModel(context, toolDefs, opts = {}) {
  // Support both event objects and plain context strings
  const eventContext = typeof context === "string" ? context : buildEventContext(context);
  const history = Array.isArray(opts.history) ? opts.history : [];
  const systemMessage = buildSystemMessage();

  // Log the full prompt for audit when AGENT_RUNNER_VERBOSE=true
  logPrompt(systemMessage, eventContext, toolDefs);

  try {
    const { toolCall, reply, usage, reasoning_content } = await callChatHistory({
      systemMessage,
      messages: [{ role: "user", content: eventContext }, ...history],
      tools: toolDefs,
      meta: { source: "agent-runner", step: opts.step || "decision" },
    });

    if (!toolCall) {
      const said = reply ? ` — model said: "${String(reply).slice(0, 100)}"` : "";
      console.log(`   ⚠️ [MODEL] No tool call returned${said}`);
      return null;
    }

    console.log(`   🤖 [MODEL] ${getProvider()}/${getModelName()} chose: ${toolCall.name}(${JSON.stringify(toolCall.arguments)})`);
    return { name: toolCall.name, arguments: toolCall.arguments, reply: reply || "", reasoning_content, usage };
  } catch (err) {
    console.error(`   ❌ [MODEL] API call failed: ${err.message}`);
    const wrapped = new Error(err.message || "model call failed");
    wrapped.code = "MODEL_ERROR";
    throw wrapped;
  }
}

/**
 * Provider-shaped history entries for one completed tool step.
 *
 * Lives next to the prompt because of the rule it encodes: on DeepSeek every
 * replayed assistant turn must carry `reasoning_content` or the API 400s (the
 * operator chat hit the same thing — see `toProviderMessages` in
 * electron/src/main/chat-agent.mjs). An empty string is a valid value, so this
 * only omits the field when the provider never sent one.
 *
 * The call id is generated locally: the shared provider returns only
 * `{name, arguments}`, and `tool_calls[].id` / `tool_call_id` merely have to be
 * consistent with each other inside the history we resend.
 */
export function toolStepMessages(decision, toolText, callId) {
  return [
    {
      role: "assistant",
      content: decision.reply || "",
      tool_calls: [
        {
          id: callId,
          type: "function",
          function: { name: decision.name, arguments: JSON.stringify(decision.arguments ?? {}) },
        },
      ],
      ...(decision.reasoning_content != null ? { reasoning_content: decision.reasoning_content } : {}),
    },
    { role: "tool", content: String(toolText ?? ""), tool_call_id: callId },
  ];
}
