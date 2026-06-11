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
  {
    name: "trello_get_checklists",
    description: "Get all checklists on a Trello card, including their items",
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string", description: "Card ID" },
      },
      required: ["cardId"],
    },
  },
  {
    name: "trello_create_checklist",
    description: "Create a new checklist on a Trello card",
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string", description: "Card ID to add the checklist to" },
        name: { type: "string", description: "Checklist name/title" },
      },
      required: ["cardId", "name"],
    },
  },
  {
    name: "trello_add_checklist_item",
    description: "Add an item to a Trello checklist",
    inputSchema: {
      type: "object",
      properties: {
        checklistId: { type: "string", description: "Checklist ID to add the item to" },
        name: { type: "string", description: "Item text" },
        checked: { type: "boolean", description: "Whether the item should start checked (optional, default false)" },
      },
      required: ["checklistId", "name"],
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

export const driveTools = [
  {
    name: "drive_list_files",
    description: "List files and folders in a Google Drive folder (default: root). Returns metadata for each file.",
    inputSchema: {
      type: "object",
      properties: {
        folderId: { type: "string", description: "Folder ID to list contents of (omit or 'root' for root)" },
        pageSize: { type: "number", description: "Max results (default 20, max 100)", default: 20 },
      },
    },
  },
  {
    name: "drive_get_file",
    description: "Get detailed info about a Drive file, including content (for text/docs) or metadata only.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "Drive file ID" },
        includeContent: { type: "boolean", description: "Include file content (default true). Set false for large files.", default: true },
      },
      required: ["fileId"],
    },
  },
  {
    name: "drive_search_files",
    description: "Search Drive files by name query. Returns matching file metadata.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (matched against file name)" },
        pageSize: { type: "number", description: "Max results (default 20, max 100)", default: 20 },
      },
      required: ["query"],
    },
  },
];

export const calendarTools = [
  {
    name: "calendar_list_events",
    description: "List upcoming events from Google Calendar. Filters by date range and optional search query.",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: { type: "string", description: "Calendar ID (default: 'primary')" },
        maxResults: { type: "number", description: "Max results (default 20, max 100)", default: 20 },
        timeMin: { type: "string", description: "Start of date range (ISO 8601, default: now)" },
        timeMax: { type: "string", description: "End of date range (ISO 8601, optional)" },
        query: { type: "string", description: "Free-text search in event title/description (optional)" },
        singleEvents: { type: "boolean", description: "Expand recurring events into instances (default true)", default: true },
      },
    },
  },
  {
    name: "calendar_get_event",
    description: "Get detailed info about a specific Calendar event by its event ID.",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: { type: "string", description: "Calendar ID (default: 'primary')" },
        eventId: { type: "string", description: "Calendar event ID" },
      },
      required: ["eventId"],
    },
  },
  {
    name: "calendar_create_event",
    description: "Create a new event on Google Calendar. Requires start and end date/time.",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: { type: "string", description: "Calendar ID (default: 'primary')" },
        summary: { type: "string", description: "Event title" },
        description: { type: "string", description: "Event description (optional)" },
        location: { type: "string", description: "Event location (optional)" },
        start: { type: "string", description: "Start date/time as ISO 8601 string, e.g. '2026-06-10T14:00:00-05:00' or '2026-06-10'" },
        end: { type: "string", description: "End date/time as ISO 8601 string" },
        attendees: {
          type: "array",
          items: { type: "string" },
          description: "Attendee email addresses (optional)",
        },
        recurrence: {
          type: "array",
          items: { type: "string" },
          description: "RRULE strings for recurring events, e.g. ['RRULE:FREQ=WEEKLY;BYDAY=MO'] (optional)",
        },
      },
      required: ["summary", "start", "end"],
    },
  },
];

/** Combined list of all tools for use by the agent runner */
export const allTools = [...trelloTools, ...gmailTools, ...driveTools, ...calendarTools];
