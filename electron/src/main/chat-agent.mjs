/**
 * Operator chat agent — Electron main process.
 *
 * Turns the operator Chat into a VS Code-chat-like agentic loop:
 *   model proposes a tool → read-only tools run automatically; mutating tools
 *   pause for operator approval (Approve/Deny in the renderer) → the tool runs
 *   (via the agent-runner's shared executor) → its (sanitized) result is fed
 *   back to the model → repeat until it answers in plain text (bounded rounds).
 *
 * Channel/origin enforcement lives in main.js: this loop is ONLY used for the
 * `operator` channel. Frontdesk chats never get tools.
 *
 * Dependencies are injected by the caller (persistEntry, requestApproval) so
 * this module stays pure and testable.
 */
import { callChatHistory, getModelName, getProvider } from "../../../shared/model-provider.mjs";
import { allTools } from "../../../shared/tool-manifest.js";
import { executeToolCall } from "../../../mcp/agent-runner/tool-executor.js";
import { sanitize } from "../../../scripts/sanitize.stub.mjs";

// Tools the shared executor can actually run (trello + gmail + web).
// frontdesk_reply is intentionally excluded — it belongs to the frontdesk
// agent path, not the operator console.
const SUPPORTED_TOOLS = new Set([
  "trello_add_comment",
  "trello_get_card",
  "trello_list_cards",
  "trello_get_lists",
  "trello_get_card_actions",
  "trello_create_card",
  "trello_update_card",
  "trello_create_checklist",
  "trello_add_checklist_item",
  "gmail_list_messages",
  "gmail_get_message",
  "gmail_send_message",
  "web_search",
  "web_fetch",
  // WhatsApp (Meta Cloud API) — reads auto-run; sends require approval
  "whatsapp_status",
  "whatsapp_list_numbers",
  "whatsapp_list_messages",
  "whatsapp_send_text",
  "whatsapp_send_template",
  "whatsapp_mark_read",
]);

// Read-only tools run automatically; anything else requires operator approval.
const READ_TOOLS = new Set([
  "trello_get_card",
  "trello_list_cards",
  "trello_get_lists",
  "trello_get_card_actions",
  "gmail_list_messages",
  "gmail_get_message",
  "web_search",
  "web_fetch",
  // WhatsApp reads — run automatically (no approval needed)
  "whatsapp_status",
  "whatsapp_list_numbers",
  "whatsapp_list_messages",
]);

export const OPERATOR_TOOLS = (allTools || []).filter((t) => SUPPORTED_TOOLS.has(t.name));

// Read-only tool names (operator chat: run automatically). Electron merges its
// local read tools (fs/task/queue reads) into this set at call time.
export const OPERATOR_READ_TOOLS = READ_TOOLS;

export function isReadTool(name) {
  return READ_TOOLS.has(name);
}

/**
 * Tool-step budget for ONE user message: model⇄tool rounds before the loop
 * wraps up. Configurable via OPERATOR_CHAT_MAX_ROUNDS (default 24, clamped
 * 1–100) — the old hard-coded 8 was too tight for multi-read agentic flows.
 */
const MAX_ROUNDS = (() => {
  const n = parseInt(process.env.OPERATOR_CHAT_MAX_ROUNDS || "24", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 100) : 24;
})();
const MAX_TOOL_TEXT = 2000;

function summarize(res) {
  if (!res || !res.ok) return `[error] ${(res && res.error) || "failed"}`;
  let out;
  try {
    out = JSON.stringify(res.result !== undefined ? res.result : res);
  } catch {
    out = String((res.result !== undefined && res.result) || "ok");
  }
  if (out.length > MAX_TOOL_TEXT) out = out.slice(0, MAX_TOOL_TEXT) + "…(truncated)";
  return out;
}

// Map persisted entries into provider messages. `assistant` entries that carry
// toolCalls become an assistant turn with tool_calls; the matching `tool`
// entries become role:'tool' results with the same tool_call_id.
function toProviderMessages(history) {
  const items = [];
  for (const e of history) {
    if (!e || e.role === "system" || e.role === "tool_use") continue;
    if (e.role === "user") {
      items.push({ role: "user", content: String(e.content ?? "") });
    } else if (e.role === "tool") {
      items.push({ role: "tool", content: String(e.content ?? ""), tool_call_id: e.toolCallId });
    } else if (e.role === "assistant") {
      // DeepSeek thinking mode: every replayed assistant turn must carry a
      // reasoning_content field — the API 400s on a missing one (even for turns
      // where the model produced no chain-of-thought). Replay the stored value,
      // and for DeepSeek fall back to "" so legacy/first-run turns stay valid.
      const msg = { role: "assistant", content: String(e.content ?? "") };
      const reasoning = typeof e.reasoning_content === "string" ? e.reasoning_content : null;
      if (reasoning != null) msg.reasoning_content = reasoning;
      else if (getProvider() === "deepseek") msg.reasoning_content = "";
      const tcs = Array.isArray(e.toolCalls) ? e.toolCalls : [];
      if (tcs.length) {
        msg.tool_calls = tcs.map((t) => ({
          id: t.id,
          type: "function",
          function: {
            name: t.name,
            arguments: typeof t.args === "string" ? t.args : JSON.stringify(t.args ?? {}),
          },
        }));
      }
      items.push(msg);
    }
  }
  return items;
}

/**
 * Run the agentic loop for one operator message.
 * @param {object} opts
 * @param {string} opts.systemMessage   — operator system prompt
 * @param {Array}  opts.entries         — existing persisted entries (includes the new user msg)
 * @param {function} opts.persistEntry  — async (entry) -> stamped entry; appends to JSONL + streams to UI
 * @param {function} opts.requestApproval — async ({name,args}) -> {approved, editedArgs?} — shows Approve/Deny
 * @param {AbortSignal} [opts.signal]   — abort (Stop button)
 * @param {string}  [opts.model]        — model label for the assistant entry
 * @param {number}  [opts.temperature]  — LLM temperature override
 * @param {function} [opts.provider]    — test seam; defaults to callChatHistory
 * @param {function} [opts.execute]     — test seam; defaults to executeToolCall
 * @param {Array}    [opts.tools]       — tool defs to advertise; defaults to OPERATOR_TOOLS
 * @param {Set}      [opts.readTools]   — names that auto-run; defaults to OPERATOR_READ_TOOLS
 * @returns {Promise<{ok:boolean, reply:string, model:string, usage:object|null, maxSteps?:boolean}>}
 *          `maxSteps: true` means the tool-step budget was exhausted and the
 *          reply is the wrap-up/sentinel message (the loop did not answer freely).
 */
export async function runOperatorAgent({
  systemMessage,
  entries = [],
  persistEntry,
  requestApproval,
  signal,
  model,
  temperature,
  provider = callChatHistory,
  execute = executeToolCall,
  tools = OPERATOR_TOOLS,
  readTools = READ_TOOLS,
}) {
  const history = [...entries];
  const record = async (entry) => {
    const stamped = await persistEntry(entry);
    if (stamped) history.push(stamped);
    return stamped;
  };
  const throwIfAborted = () => {
    if (signal && signal.aborted) {
      const e = new Error("stopped by user");
      e.code = "ABORTED";
      throw e;
    }
  };

  let rounds = 0;
  let lastUsage = null;
  let lastReasoning = null;
  while (rounds < MAX_ROUNDS) {
    throwIfAborted();
    const res = await provider({
      systemMessage,
      messages: toProviderMessages(history),
      tools,
      temperature,
      meta: { source: "operator-agent", step: rounds + 1 },
    });
    if (res && res.usage) lastUsage = res.usage;
    // `??` (not `||`): an empty-string reasoning_content is still a value DeepSeek
    // requires back on the next request.
    if (res && res.reasoning_content != null) lastReasoning = res.reasoning_content;

    // Plain-text answer → done.
    if (!res || !res.toolCall) {
      const reply = String((res && res.reply) || "(no reply)");
      const final = await record({ role: "assistant", content: reply, model, usage: lastUsage || undefined, reasoning_content: res?.reasoning_content ?? undefined });
      return { ok: true, reply, model, usage: lastUsage || undefined, entry: final };
    }

    // A tool call. Read-only → auto-run. Mutating → ask the operator first.
    const { name, arguments: proposedArgs } = res.toolCall;
    const callId = `call_${rounds}`;
    const args = (proposedArgs && typeof proposedArgs === "object") ? proposedArgs : {};

    let approved = true;
    let execArgs = args;
    if (!readTools.has(name)) {
      throwIfAborted();
      let decision;
      try {
        decision = await requestApproval({ name, args });
      } catch {
        decision = { approved: false, reason: "approval unavailable" };
      }
      approved = !!(decision && decision.approved);
      throwIfAborted();
      if (!approved) {
        const reason = (decision && decision.reason) || "denied by operator";
        await record({ role: "assistant", content: "", toolCalls: [{ id: callId, name, args }], reasoning_content: res?.reasoning_content ?? undefined });
        await record({ role: "tool", toolCallId: callId, name, content: `[operator denied ${name}: ${reason}]` });
        rounds++;
        continue;
      }
      if (decision.editedArgs) execArgs = decision.editedArgs;
    }

    await record({ role: "assistant", content: "", toolCalls: [{ id: callId, name, args: execArgs }], reasoning_content: res?.reasoning_content ?? undefined });

    let result;
    try {
      result = await execute(name, execArgs, { isFrontdesk: false });
    } catch (err) {
      result = { ok: false, tool: name, error: err.message };
    }
    // External content (Trello/Gmail/web) is sanitized before it reaches the model.
    const raw = summarize(result);
    const safeText = typeof sanitize === "function" ? sanitize(raw) : raw;
    await record({
      role: "tool",
      toolCallId: callId,
      name,
      content: safeText,
      ok: !!result.ok,
      error: result.error || null,
    });
    rounds++;
  }

  // Out of steps: ask the model for a wrap-up answer instead of stopping cold.
  // The tools stay advertised because some providers reject an empty tool list
  // paired with tool_choice:"auto" — if it still proposes a tool we fall back to
  // the sentinel message (and the UI offers a Continue button either way).
  let wrapText = null;
  try {
    throwIfAborted();
    const wrap = await provider({
      systemMessage:
        systemMessage +
        "\n\nYou have reached this message's tool-step limit. Do not call any more tools — answer now " +
        "with what you already know, and state clearly what is still unfinished.",
      messages: toProviderMessages(history),
      tools,
      temperature,
      meta: { source: "operator-agent", step: "wrap-up" },
    });
    if (wrap && !wrap.toolCall && wrap.reply) {
      wrapText = String(wrap.reply);
      if (wrap.usage) lastUsage = wrap.usage;
      if (wrap.reasoning_content != null) lastReasoning = wrap.reasoning_content;
    }
  } catch (err) {
    if (err && err.code === "ABORTED") throw err;
    /* provider failure — fall through to the sentinel message */
  }

  const maxSteps = !wrapText;
  const msg = wrapText || "[stopped: reached the maximum number of tool steps for one message]";
  const final = await record({ role: "assistant", content: msg, model, usage: lastUsage || undefined, reasoning_content: lastReasoning ?? undefined });
  return { ok: true, reply: msg, model, usage: lastUsage, entry: final, maxSteps };
}

export { getModelName };
