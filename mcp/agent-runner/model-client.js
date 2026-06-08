/**
 * Model Client — calls DeepSeek V4 API with function calling
 *
 * Takes an event's context, sends it to DeepSeek along with tool
 * definitions from the shared manifest, and returns the model's
 * chosen tool call (function name + arguments).
 *
 * Environment:
 *   DEEPSEEK_API_KEY — API key for DeepSeek V4
 *   AGENT_MODEL      — Model name (default: "deepseek-chat")
 */

const DEEPSEEK_BASE = "https://api.deepseek.com/v1";

/**
 * Build the DeepSeek API request body from event context and tool definitions.
 * @param {object} event — The queue event data
 * @param {Array} toolDefs — Tool definitions from tool-manifest.js (already in MCP format)
 * @returns {object} Request body for DeepSeek chat completions
 */
function buildRequest(event, toolDefs) {
  // Map MCP tool definitions → DeepSeek function calling format
  const tools = toolDefs.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema, // JSON Schema — pass through verbatim
    },
  }));

  // Build a concise event summary for the model
  const eventContext = buildEventContext(event);

  return {
    model: process.env.AGENT_MODEL || "deepseek-chat",
    messages: [
      {
        role: "system",
        content: [
          "You are an autonomous business workflow agent. Your job is to process incoming events",
          "and decide what action to take. You have a set of tools available (Trello, Gmail).",
          "",
          "Rules:",
          "- Choose ONE tool and provide ALL required parameters",
          "- If the event is a frontdesk message, reply helpfully but don't make up information",
          "- If you're unsure, use trello_add_comment to ask for clarification",
          "- Never make up card IDs, list IDs, or other identifiers",
          "- Respond only with a tool call — no explanatory text",
        ].join("\n"),
      },
      {
        role: "user",
        content: eventContext,
      },
    ],
    tools,
    tool_choice: "auto",
    temperature: 0.1, // Low temperature for predictable tool selection
  };
}

/**
 * Build a concise human-readable summary of the event for the model.
 * Strips internal metadata (IDs, timestamps) so the model sees clean intent.
 */
function buildEventContext(event) {
  const lines = [`New ${event.source}/${event.type} event:`];

  if (event.data?.text) {
    lines.push(`Message: "${event.data.text.slice(0, 500)}"`);
  }

  if (event.data?.rule) {
    lines.push(`Matched rule: "${event.data.rule}"`);
    lines.push(`Requested tool: ${event.data.tool}`);
  }

  if (event.data?.originalEvent?.data?.card?.name) {
    lines.push(`Card: "${event.data.originalEvent.data.card.name}"`);
  }

  if (event.data?.originalEvent?.data?.list?.name) {
    lines.push(`List: "${event.data.originalEvent.data.list.name}"`);
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
 * Call the DeepSeek V4 API with an event and tool definitions.
 * @param {object} event — The queue event
 * @param {Array} toolDefs — Tool definitions from shared/tool-manifest.js
 * @returns {object|null} { name: string, arguments: object } or null if no tool call
 */
export async function callModel(event, toolDefs) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.error("   ❌ [MODEL] DEEPSEEK_API_KEY not set in .env");
    return null;
  }

  const body = buildRequest(event, toolDefs);

  try {
    const response = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`   ❌ [MODEL] API error ${response.status}: ${text.slice(0, 200)}`);
      return null;
    }

    const result = await response.json();
    const choice = result.choices?.[0];
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
    console.error(`   ❌ [MODEL] API call failed: ${err.message}`);
    return null;
  }
}
