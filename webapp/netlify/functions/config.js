/**
 * Netlify Function: /api/config
 *
 * Serves Trello + login configuration from Netlify environment variables
 * to the client-side app. The app fetches this on startup and merges the
 * values into its CONFIG object.
 *
 * Required env vars (set in Netlify UI or via netlify env:import):
 *   TRELLO_API_KEY, TRELLO_API_TOKEN
 *   TRELLO_BOARD_ID
 *   TRELLO_LIST_FRONTEDESK_INPUT, TRELLO_LIST_FRONTEDESK_OUTPUT
 *   USER_<name>_HASH  — any number of user login hashes
 *
 * See webapp/.env for the full list.
 */

// Netlify Functions use CommonJS exports.handler for .js files
exports.handler = async function (event, context) {
  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  // Collect all USER_<name>_HASH vars dynamically
  const userHashes = {};
  for (const [key, value] of Object.entries(process.env)) {
    const match = key.match(/^USER_(.+)_HASH$/);
    if (match && value) {
      userHashes[key] = value;
    }
  }

  const config = {
    TRELLO_API_KEY: process.env.TRELLO_API_KEY || "",
    TRELLO_API_TOKEN: process.env.TRELLO_API_TOKEN || "",
    TRELLO_BOARD_ID: process.env.TRELLO_BOARD_ID || "",
    TRELLO_LIST_FRONTEDESK_INPUT: process.env.TRELLO_LIST_FRONTEDESK_INPUT || "",
    TRELLO_LIST_FRONTEDESK_OUTPUT: process.env.TRELLO_LIST_FRONTEDESK_OUTPUT || "",
    ...userHashes,
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
