/**
 * Edge Function: inject-hash
 *
 * Intercepts requests for /app.js and replaces all __X__ placeholders
 * with environment variable values at the CDN edge.
 *
 * Injects:
 *   __ADMIN_HASH__        → USER_ADMIN_HASH
 *   __COLLABORATOR_HASH__ → USER_COLLABORATOR_HASH
 *   __TRELLO_KEY_[1-3]__  → TRELLO_API_KEY (split into thirds)
 *   __TRELLO_TOKEN_[1-3]__→ TRELLO_API_TOKEN (split into thirds)
 *   __LIST_ID_INPUT__     → TRELLO_LIST_FRONTEDESK_INPUT
 *   __LIST_ID_OUTPUT__    → TRELLO_LIST_FRONTEDESK_OUTPUT
 *   __BOARD_ID__          → TRELLO_BOARD_ID
 *
 * Secrets are never written to disk — only swapped in-memory per request.
 */

/** Split a string into three roughly equal parts */
function splitThirds(str) {
  if (!str) return ["", "", ""];
  const len = str.length;
  const third = Math.ceil(len / 3);
  return [str.slice(0, third), str.slice(third, third * 2), str.slice(third * 2)];
}

export default async (request, context) => {
  const url = new URL(request.url);

  // Only run on the app.js file
  if (!url.pathname.endsWith("/app.js")) {
    return context.next();
  }

  const response = await context.next();
  const contentType = response.headers.get("content-type") || "";

  // Only modify JavaScript responses
  if (!contentType.includes("javascript")) {
    return response;
  }

  const original = await response.text();
  let modified = original;

  // ── User hashes ──
  const adminHash = Deno.env.get("USER_ADMIN_HASH") || "";
  if (modified.includes("__ADMIN_HASH__")) {
    modified = modified.replaceAll("__ADMIN_HASH__", adminHash);
  }

  const collabHash = Deno.env.get("USER_COLLABORATOR_HASH") || "";
  if (modified.includes("__COLLABORATOR_HASH__")) {
    modified = modified.replaceAll("__COLLABORATOR_HASH__", collabHash);
  }

  // ── Trello API key (split into thirds) ──
  const apiKey = Deno.env.get("TRELLO_API_KEY") || "";
  const [k1, k2, k3] = splitThirds(apiKey);
  if (modified.includes("__TRELLO_KEY_1__")) {
    modified = modified.replaceAll("__TRELLO_KEY_1__", k1);
  }
  if (modified.includes("__TRELLO_KEY_2__")) {
    modified = modified.replaceAll("__TRELLO_KEY_2__", k2);
  }
  if (modified.includes("__TRELLO_KEY_3__")) {
    modified = modified.replaceAll("__TRELLO_KEY_3__", k3);
  }

  // ── Trello list & board IDs (no API key/token — those are server-side only) ──
  const listInput = Deno.env.get("TRELLO_LIST_FRONTEDESK_INPUT") || "";
  if (modified.includes("__LIST_ID_INPUT__")) {
    modified = modified.replaceAll("__LIST_ID_INPUT__", listInput);
  }

  const listOutput = Deno.env.get("TRELLO_LIST_FRONTEDESK_OUTPUT") || "";
  if (modified.includes("__LIST_ID_OUTPUT__")) {
    modified = modified.replaceAll("__LIST_ID_OUTPUT__", listOutput);
  }

  const boardId = Deno.env.get("TRELLO_BOARD_ID") || "";
  if (modified.includes("__BOARD_ID__")) {
    modified = modified.replaceAll("__BOARD_ID__", boardId);
  }

  // ── Webhook server URL (the tunnel URL for deployed environments) ──
  const webhookUrl = Deno.env.get("WEBHOOK_BASE_URL") || "";
  if (modified.includes("__WEBHOOK_BASE_URL__")) {
    modified = modified.replaceAll("__WEBHOOK_BASE_URL__", webhookUrl);
  }

  // ── Webhook server API token (for authenticated requests) ──
  const webhookToken = Deno.env.get("WEBHOOK_API_TOKEN") || "";
  if (modified.includes("__WEBHOOK_API_TOKEN__")) {
    modified = modified.replaceAll("__WEBHOOK_API_TOKEN__", webhookToken);
  }

  // No placeholders found — pass through unchanged
  if (modified === original) {
    return response;
  }

  return new Response(modified, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};
