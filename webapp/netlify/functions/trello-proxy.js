/**
 * Netlify Function: /api/trello-proxy
 *
 * Proxies Trello API requests so the API key & token stay server-side.
 * The browser never sees the Trello credentials.
 *
 * Also adds an HMAC signature to commentCard actions so the webhook
 * handler can verify the message came through the authorized proxy.
 *
 * Usage (from the webapp):
 *   POST /.netlify/functions/trello-proxy
 *   Body: { path, method?, body?, params? }
 *
 *   path   — Trello API path, e.g. "/lists/{id}/cards" or "/cards/{id}/actions/comments"
 *   method — HTTP method (default: "GET")
 *   body   — Request body for POST/PUT
 *   params — Extra URL params
 *
 * Requires env vars (set in Netlify UI):
 *   TRELLO_API_KEY, TRELLO_API_TOKEN
 *   FRONTEND_SECRET — shared secret for message signing (optional)
 */

const TRELLO_BASE = "https://api.trello.com/1";
const crypto = require("crypto");

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Method not allowed" });
  }

  const { path, method = "GET", body, params = {} } = JSON.parse(event.body || "{}");

  if (!path || typeof path !== "string") {
    return respond(400, { error: "Missing or invalid 'path'" });
  }

  const apiKey = process.env.TRELLO_API_KEY;
  const apiToken = process.env.TRELLO_API_TOKEN;

  if (!apiKey || !apiToken) {
    return respond(500, { error: "Trello credentials not configured on server" });
  }

  // Build URL with credentials
  const qs = new URLSearchParams({ key: apiKey, token: apiToken, ...params });
  const url = `${TRELLO_BASE}${path.startsWith("/") ? path : "/" + path}?${qs}`;

  try {
    const options = {
      method,
      headers: { "Content-Type": "application/json" },
    };

    if (body && method !== "GET") {
      // For commentCard actions, sign the text with the frontend secret
      if (path.includes("/actions/comments") && body.text && process.env.FRONTEND_SECRET) {
        const sig = crypto.createHmac("sha256", process.env.FRONTEND_SECRET).update(body.text).digest("hex").slice(0, 16);
        body.text = body.text + ` [sig:${sig}]`;
      }
      options.body = JSON.stringify(body);
    }

    const resp = await fetch(url, options);
    const text = await resp.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    return respond(resp.status, data);
  } catch (err) {
    return respond(500, { error: err.message });
  }
};

function respond(status, body) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, max-age=0",
    },
    body: JSON.stringify(body),
  };
}
