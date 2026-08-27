/**
 * Model Provider — multi-provider LLM client (single source of truth)
 *
 * Ported from the ai_transcription_agent multi-provider pattern. Used by BOTH
 * the agent runner (`mcp/agent-runner/model-client.js`) and the webhook-server
 * inline `execute` flow so provider logic lives in exactly one place.
 *
 *   LLM_PROVIDER=deepseek  (default, requires DEEPSEEK_API_KEY)
 *   LLM_PROVIDER=openai    (requires OPENAI_API_KEY; optional OPENAI_BASE_URL / OPENAI_MODEL)
 *   LLM_PROVIDER=anthropic (requires ANTHROPIC_API_KEY; optional ANTHROPIC_BASE_URL / ANTHROPIC_MODEL / ANTHROPIC_MAX_TOKENS)
 *   LLM_PROVIDER=ollama    (uses OLLAMA_BASE_URL + OLLAMA_MODEL; optional OLLAMA_NUM_CTX)
 *
 * Fetch-based (Node 18+ global fetch), so it works in any process without an
 * SDK dependency. Both provider request shapes are normalized to a single
 * return: { toolCall: { name, arguments } | null, reply: string | null, usage }.
 */

export const PROVIDER = (process.env.LLM_PROVIDER || "deepseek").toLowerCase();

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";

/** Resolve the active model name from env, with per-provider defaults. */
function resolveModel() {
  if (PROVIDER === "ollama") return process.env.OLLAMA_MODEL || null;
  if (PROVIDER === "openai") return process.env.OPENAI_MODEL || "gpt-4o";
  if (PROVIDER === "anthropic") return process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
  return process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
}

export const MODEL = resolveModel();

/** Current model name — used by the runner / webhook-server for logging. */
export function getModelName() {
  return MODEL;
}

function resolveEndpoint() {
  if (PROVIDER === "ollama") return `${OLLAMA_BASE_URL.replace(/\/$/, "")}/v1/chat/completions`;
  if (PROVIDER === "openai") return `${(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "")}/chat/completions`;
  if (PROVIDER === "anthropic") return `${(process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`;
  return "https://api.deepseek.com/chat/completions";
}

function resolveApiKey() {
  if (PROVIDER === "deepseek") return process.env.DEEPSEEK_API_KEY;
  if (PROVIDER === "openai") return process.env.OPENAI_API_KEY;
  if (PROVIDER === "anthropic") return process.env.ANTHROPIC_API_KEY;
  return "ollama"; // Ollama doesn't require a real key
}

/**
 * Provider-scoped key guard — throws a friendly, actionable error when the
 * active provider's API key is missing, so misconfiguration surfaces instead
 * of silently skipping work.
 * @returns {string} The resolved API key (always "ollama" for Ollama).
 */
export function keyGuard() {
  if (PROVIDER === "ollama") return "ollama"; // no key required
  const key = resolveApiKey();
  const label =
    PROVIDER === "deepseek"
      ? "DEEPSEEK_API_KEY"
      : PROVIDER === "openai"
        ? "OPENAI_API_KEY"
        : PROVIDER === "anthropic"
          ? "ANTHROPIC_API_KEY"
          : null;
  if (!key) throw new Error(`${label} not set — add it to .env (LLM_PROVIDER=${PROVIDER})`);
  return key;
}

/** Map MCP tool definitions to OpenAI function-calling format. */
export function mapTools(toolDefs) {
  return (toolDefs || []).map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

/**
 * Check Ollama server health via /api/tags. Returns boolean.
 * Non-Ollama providers always return true.
 */
export async function checkOllamaHealth() {
  if (PROVIDER !== "ollama") return true;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${OLLAMA_BASE_URL.replace(/\/$/, "")}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Call the configured provider with tool calling.
 * @param {object} opts
 * @param {string} opts.systemMessage — system prompt
 * @param {string} opts.userContext   — user message / task or event context
 * @param {Array} [opts.tools]        — tool defs from shared/tool-manifest.js
 * @param {number} [opts.temperature] — defaults to LLM_TEMPERATURE or 0.1
 * @returns {Promise<{toolCall: {name: string, arguments: object}|null, reply: string|null, usage: object|null}>}
 */
export async function callChat({ systemMessage, userContext, tools = [], temperature }) {
  keyGuard();

  // Fail fast if Ollama is down (instead of retrying / timing out)
  if (PROVIDER === "ollama") {
    const healthy = await checkOllamaHealth();
    if (!healthy) {
      throw new Error(
        `Ollama server is not responding (${OLLAMA_BASE_URL}/api/tags). Start Ollama or check OLLAMA_BASE_URL.`,
      );
    }
  }

  const temp = temperature ?? parseFloat(process.env.LLM_TEMPERATURE || "0.1");

  if (PROVIDER === "anthropic") {
    return callAnthropic({ systemMessage, userContext, tools, temperature: temp });
  }
  return callOpenAiCompatible({ systemMessage, userContext, tools, temperature: temp });
}

/** Anthropic Messages API — different request/response shape from OpenAI. */
async function callAnthropic({ systemMessage, userContext, tools, temperature }) {
  const body = {
    model: MODEL,
    system: systemMessage,
    messages: [{ role: "user", content: userContext }],
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    })),
    tool_choice: { type: "auto" },
    max_tokens: parseInt(process.env.ANTHROPIC_MAX_TOKENS || "4096", 10),
    temperature,
  };

  const res = await fetch(resolveEndpoint(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": keyGuard(),
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${errText.slice(0, 500)}`);
  }

  const data = await res.json();

  // Normalize Anthropic usage to the OpenAI-compatible shape so callers work
  // identically across providers.
  const usage = data.usage
    ? {
        prompt_tokens: data.usage.input_tokens || 0,
        completion_tokens: data.usage.output_tokens || 0,
        total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
        prompt_tokens_details: { cached_tokens: data.usage.cache_read_input_tokens || 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
      }
    : null;

  const toolUse = (data.content || []).find((b) => b && b.type === "tool_use");
  if (!toolUse || data.stop_reason !== "tool_use") {
    const reply = (data.content || [])
      .filter((b) => b && b.type === "text")
      .map((b) => b.text)
      .join("\n");
    return { toolCall: null, reply: reply || null, usage };
  }

  return { toolCall: { name: toolUse.name, arguments: toolUse.input || {} }, reply: null, usage };
}

/** OpenAI-compatible path — shared by deepseek, openai, and ollama. */
async function callOpenAiCompatible({ systemMessage, userContext, tools, temperature }) {
  const body = {
    model: MODEL,
    messages: [
      { role: "system", content: systemMessage },
      { role: "user", content: userContext },
    ],
    tools: mapTools(tools),
    tool_choice: "auto",
    temperature,
    stream: false,
  };

  // DeepSeek-specific reasoning params — only sent to DeepSeek (other providers reject them)
  if (PROVIDER === "deepseek") {
    body.thinking = { type: "enabled" };
    body.reasoning_effort = "high";
  }
  // Ollama-specific: forwarded by Ollama's /v1 endpoint
  if (PROVIDER === "ollama") {
    body.num_ctx = getNumCtx();
  }

  const res = await fetch(resolveEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${keyGuard()}` },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`${PROVIDER} API ${res.status}: ${errText.slice(0, 500)}`);
  }

  const data = await res.json();
  const usage = data.usage || null;
  const message = data.choices?.[0]?.message;
  const toolCall = message?.tool_calls?.[0];

  if (!toolCall) {
    const reply = message?.content || null;
    return { toolCall: null, reply, usage };
  }

  let args;
  try {
    args = JSON.parse(toolCall.function.arguments);
  } catch {
    return { toolCall: null, reply: message?.content || null, usage };
  }

  return { toolCall: { name: toolCall.function.name, arguments: args }, reply: message?.content || null, usage };
}

function getNumCtx() {
  const val = parseInt(process.env.OLLAMA_NUM_CTX || "32768", 10);
  // Only allow valid values: 32768, 65536, 131072
  return [32768, 65536, 131072].includes(val) ? val : 32768;
}
