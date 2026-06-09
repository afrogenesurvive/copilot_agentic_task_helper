/**
 * Tool Manifest — Shared tool definitions
 *
 * Single source of truth for all MCP tool schemas.
 * Imported by:
 *   - MCP servers (trello, gmail) to respond to VS Code's tools/list request
 *   - Agent runner to send tool definitions to DeepSeek V4 function calling
 *
 * Each tool follows the JSON Schema format (inputSchema),
 * which maps directly to OpenAI/DeepSeek function `parameters`.
 *
 * Adding a new tool here makes it available everywhere automatically.
 */

export const trelloTools = [
  {
    name: "trello_create_card",
    description: "Create a new Trello card in a list",
    inputSchema: {
      type: "object",
      properties: {
        listId: { type: "string", description: "ID of the list to create the card in" },
        name: { type: "string", description: "Card title" },
        desc: { type: "string", description: "Card description (optional)" },
      },
      required: ["listId", "name"],
    },
  },
  {
    name: "trello_get_card",
    description: "Get detailed info about a Trello card",
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string", description: "Trello hex/numeric card ID (NOT the card name — use the hex ID like '6a1cd3381d9b38f6994cd76d')" },
      },
      required: ["cardId"],
    },
  },
  {
    name: "trello_list_cards",
    description: "List all cards in a Trello list",
    inputSchema: {
      type: "object",
      properties: {
        listId: { type: "string", description: "List ID" },
      },
      required: ["listId"],
    },
  },
  {
    name: "trello_add_comment",
    description: "Add a comment to a Trello card",
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string", description: "Trello hex/numeric card ID (NOT the card name — use the hex ID like '6a1cd3381d9b38f6994cd76d')" },
        text: { type: "string", description: "Comment text" },
      },
      required: ["cardId", "text"],
    },
  },
  {
    name: "trello_update_card",
    description: "Update a Trello card's fields (name, desc, pos, etc.)",
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string", description: "Trello hex/numeric card ID (NOT the card name — use the hex ID like '6a1cd3381d9b38f6994cd76d')" },
        name: { type: "string", description: "New card title (optional)" },
        desc: { type: "string", description: "New description (optional)" },
        pos: { type: "string", description: "Position: 'top', 'bottom', or a number (optional)" },
        closed: { type: "boolean", description: "Archive/unarchive card (optional)" },
      },
      required: ["cardId"],
    },
  },
  {
    name: "trello_get_lists",
    description: "Get all lists on a Trello board",
    inputSchema: {
      type: "object",
      properties: {
        boardId: { type: "string", description: "Board ID" },
      },
      required: ["boardId"],
    },
  },
  {
    name: "trello_get_card_actions",
    description: "Get actions (comments, updates, etc.) for a Trello card. Use filter=commentCard to get only comments.",
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string", description: "Trello hex/numeric card ID (NOT the card name — use the hex ID like '6a1cd3381d9b38f6994cd76d')" },
        filter: {
          type: "string",
          description: "Action filter: 'commentCard', 'createCard', 'updateCard', or 'all' (default: 'commentCard')",
        },
      },
      required: ["cardId"],
    },
  },
];

export const gmailTools = [
  {
    name: "gmail_list_messages",
    description: "List Gmail messages matching a search query",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Gmail search query (same as search box syntax)" },
        maxResults: { type: "number", description: "Max results (default 10, max 100)", default: 10 },
      },
    },
  },
  {
    name: "gmail_get_message",
    description: "Get a Gmail message by ID with full body content",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Message ID" },
        format: {
          type: "string",
          enum: ["full", "metadata"],
          description: "'full' returns decoded body + headers; 'metadata' returns headers + snippet",
          default: "full",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "gmail_send_message",
    description: "Send a plain text email",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject" },
        body: { type: "string", description: "Email body text" },
      },
      required: ["to", "subject", "body"],
    },
  },
];

/** Combined list of all tools for use by the agent runner */
export const allTools = [...trelloTools, ...gmailTools];
