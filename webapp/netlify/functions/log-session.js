/**
 * Netlify Function: /api/log-session
 *
 * Receives frontdesk session events (login/logout) from the webapp
 * and writes them as a Trello card on a dedicated session_logs list.
 * The webhook server receives the Trello webhook and writes the data
 * to logs/frontdesk/sessions/ on the local filesystem.
 *
 * Requires env vars:
 *   TRELLO_API_KEY, TRELLO_API_TOKEN — Trello credentials (same as trello-proxy)
 *   TRELLO_LIST_SESSION_LOGS — ID of the "session_logs" Trello list
 *
 * Usage (from the webapp):
 *   POST /.netlify/functions/log-session
 *   Body: { user, action, userAgent, timezone, language }
 */

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Method not allowed" });
  }

  const { user, action, userAgent, timezone, language } = JSON.parse(event.body || "{}");

  if (!user || !action) {
    return respond(400, { error: "Missing required fields: user, action" });
  }

  // Extract IP from Netlify headers
  const ip =
    event.headers["x-forwarded-for"]?.split(",")[0]?.trim() || event.headers["client-ip"] || event.headers["x-nf-client-connection-ip"] || "unknown";

  const apiKey = process.env.TRELLO_API_KEY;
  const apiToken = process.env.TRELLO_API_TOKEN;
  const listId = process.env.TRELLO_LIST_SESSION_LOGS;

  if (apiKey && apiToken && listId) {
    const ts = new Date().toISOString();
    const entry = { ts, user, action, ip, userAgent: userAgent || null, timezone: timezone || null, language: language || null };

    // Create a Trello card — name is human-readable, desc is structured JSON
    const cardName = `${action === "login" ? "🔓" : "🔒"} ${action.charAt(0).toUpperCase() + action.slice(1)} — ${user} — ${ip}`;
    const cardDesc = JSON.stringify(entry);

    try {
      const url = `https://api.trello.com/1/cards?idList=${encodeURIComponent(listId)}&key=${encodeURIComponent(apiKey)}&token=${encodeURIComponent(apiToken)}&name=${encodeURIComponent(cardName)}&desc=${encodeURIComponent(cardDesc)}`;
      const resp = await fetch(url, { method: "POST" });
      if (resp.ok) {
        console.log(`[session-log] Created Trello card: ${action} — ${user}`);
      } else {
        const text = await resp.text();
        console.error(`[session-log] Trello API error (${resp.status}): ${text}`);
      }
    } catch (err) {
      console.error(`[session-log] Failed to create Trello card: ${err.message}`);
    }
  } else {
    console.warn("[session-log] TRELLO_API_KEY, TRELLO_API_TOKEN, or TRELLO_LIST_SESSION_LOGS not set");
  }

  return respond(200, { status: "logged" });
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
