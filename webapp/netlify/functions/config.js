/**
 * Netlify Function: /api/config
 *
 * Serves the frontdesk runtime config to the client-side app. Mirrors the
 * webhook-server's /api/config route so the webapp is host-agnostic (Netlify
 * or tunnel). NO secrets are served — Trello API key/token and user hashes
 * never reach the browser (the trello-proxy function holds them server-side).
 *
 * Required env vars (set in Netlify UI):
 *   WEBHOOK_BASE_URL            — the tunnel URL (backend)
 *   FRONTDESK_AGENT_PUBKEY      — agent X25519 public key (encryption peer)
 *   TRELLO_BOARD_ID
 *   TRELLO_LIST_FRONTEDESK_INPUT, TRELLO_LIST_FRONTEDESK_OUTPUT
 *   FRONTDESK_SESSION_TTL       — optional (default 7200)
 */

exports.handler = async function (event) {
  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  const config = {
    TRELLO_API_KEY: "",
    TRELLO_API_TOKEN: "",
    TRELLO_BOARD_ID: process.env.TRELLO_BOARD_ID || "",
    TRELLO_LIST_FRONTEDESK_INPUT: process.env.TRELLO_LIST_FRONTEDESK_INPUT || "",
    TRELLO_LIST_FRONTEDESK_OUTPUT: process.env.TRELLO_LIST_FRONTEDESK_OUTPUT || "",
    WEBHOOK_BASE_URL: process.env.WEBHOOK_BASE_URL || "",
    FRONTDESK_AGENT_PUBKEY: process.env.FRONTDESK_AGENT_PUBKEY || "",
    FRONTDESK_SESSION_TTL: process.env.FRONTDESK_SESSION_TTL || "7200",
  };

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, max-age=0",
    },
    body: JSON.stringify(config),
  };
};
