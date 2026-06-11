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
    description:
      "List files and folders in a Google Drive folder (default: root). Returns metadata for each file. You can specify folderId as a folder path (e.g. 'Projects/Reports'), a folder name, or an ID — run 'node scripts/setup-drive-ref.js' to build the path map.",
    inputSchema: {
      type: "object",
      properties: {
        folderId: {
          type: "string",
          description:
            "Folder path, name, or ID to list contents of (omit or 'root' for root). Examples: 'Projects', 'Projects/Reports', or a drive file ID.",
        },
        pageSize: { type: "number", description: "Max results (default 20, max 100)", default: 20 },
      },
    },
  },
  {
    name: "drive_get_file",
    description:
      "Get detailed info about a Drive file, including content (for text/docs/sheets) or metadata only. For Google Docs/Sheets, the content is exported as plain text.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "Drive file ID" },
        includeContent: {
          type: "boolean",
          description: "Include file content (default true). Set false for large files.",
          default: true,
        },
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
  {
    name: "drive_create_file",
    description:
      "Create a new file in Google Drive. Supports Google Docs, Sheets, folders, and plain text files. For docs/sheets, set mimeType to 'application/vnd.google-apps.document' or 'application/vnd.google-apps.spreadsheet'. For folders, set mimeType to 'application/vnd.google-apps.folder'.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "File or folder name" },
        mimeType: {
          type: "string",
          description:
            "MIME type. Common values: 'application/vnd.google-apps.document' (Google Doc), 'application/vnd.google-apps.spreadsheet' (Sheet), 'application/vnd.google-apps.folder' (folder), 'text/plain' (plain text), 'text/csv' (CSV), 'application/json' (JSON). Default: Google Doc.",
          default: "application/vnd.google-apps.document",
        },
        content: {
          type: "string",
          description: "Text content to write to the file (for non-Google-format files like text/plain, text/csv, application/json). Optional.",
        },
        parentFolderId: {
          type: "string",
          description:
            "Folder ID, path, or name to create the file in. Omit or use 'root' for root. Examples: 'Projects/Reports', 'My Folder', or a drive folder ID.",
        },
        description: { type: "string", description: "Optional file description" },
      },
      required: ["name"],
    },
  },
  {
    name: "drive_update_file",
    description:
      "Update a Drive file's metadata (name, description) or content. For plain text files you can replace the content. For Google Docs/Sheets, use the web UI or export/re-import for content changes — this tool updates metadata.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "Drive file ID to update" },
        name: { type: "string", description: "New file name (optional)" },
        description: { type: "string", description: "New description (optional)" },
        content: {
          type: "string",
          description: "New text content (for plain text / CSV / JSON files only; not for Google Docs/Sheets). Optional.",
        },
      },
      required: ["fileId"],
    },
  },
  {
    name: "drive_move_file",
    description: "Move a file or folder to a different parent folder in Google Drive. Can also be used to rename by specifying a new name.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "Drive file or folder ID to move" },
        newParentFolderId: {
          type: "string",
          description:
            "Destination folder ID, path, or name. Examples: 'Projects/Archive', 'My Folder', or a drive folder ID. Use 'root' to move to root.",
        },
        newName: { type: "string", description: "Optional new name for the file after moving (rename while moving)." },
      },
      required: ["fileId", "newParentFolderId"],
    },
  },
  {
    name: "drive_create_folder",
    description: "Create a new folder in Google Drive. You can specify a parent folder by ID, path, or name.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Folder name" },
        parentFolderId: {
          type: "string",
          description:
            "Parent folder ID, path, or name to create the folder inside. Omit or use 'root' for root. Examples: 'Projects', 'My Folder', or a drive folder ID.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "drive_delete_file",
    description: "Move a file or folder to the Drive trash (soft delete). You can restore it from the Drive web UI. Folders are trashed recursively.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "Drive file or folder ID to trash" },
      },
      required: ["fileId"],
    },
  },
];

export const calendarTools = [
  {
    name: "calendar_list_calendars",
    description:
      "List all available Google Calendars for the authenticated user. Returns each calendar's ID, name, primary status, access role, and timezone.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "calendar_list_events",
    description:
      "List upcoming events from Google Calendar. Filters by date range and optional search query. You can specify calendarId as a friendly calendar name (e.g. 'Work', 'Personal') instead of the ID.",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: {
          type: "string",
          description: "Calendar name or ID (default: 'primary'). Use a friendly name like 'Work' or 'Personal' if the reference file exists.",
        },
        maxResults: { type: "number", description: "Max results (default 20, max 100)", default: 20 },
        timeMin: {
          type: "string",
          description: "Start of date range (ISO 8601, default: now). Use for daily/weekly/monthly queries. Example: '2026-06-11T00:00:00Z'",
        },
        timeMax: {
          type: "string",
          description:
            "End of date range (ISO 8601, optional). Use with timeMin to get events within a specific period. Example: '2026-06-11T23:59:59Z'",
        },
        query: { type: "string", description: "Free-text search in event title/description (optional)" },
        singleEvents: {
          type: "boolean",
          description: "Expand recurring events into instances (default true)",
          default: true,
        },
      },
    },
  },
  {
    name: "calendar_get_event",
    description:
      "Get detailed info about a specific Calendar event by its event ID. Returns full event details including attendees, location, recurrence, and conference data.",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: { type: "string", description: "Calendar name or ID (default: 'primary')" },
        eventId: { type: "string", description: "Calendar event ID" },
      },
      required: ["eventId"],
    },
  },
  {
    name: "calendar_create_event",
    description: "Create a new event on Google Calendar. Supports setting title, description, location, time, attendees, and recurrence rules.",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: { type: "string", description: "Calendar name or ID (default: 'primary')" },
        summary: { type: "string", description: "Event title" },
        description: { type: "string", description: "Event description (optional)" },
        location: { type: "string", description: "Event location (optional)" },
        start: {
          type: "string",
          description: "Start date/time as ISO 8601 string, e.g. '2026-06-10T14:00:00-05:00' or '2026-06-10' for all-day.",
        },
        end: {
          type: "string",
          description: "End date/time as ISO 8601 string. Must be after start.",
        },
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
        transparency: {
          type: "string",
          enum: ["opaque", "transparent"],
          description: "Whether the event blocks time on the calendar. 'opaque' (busy, default) or 'transparent' (free).",
        },
        colorId: {
          type: "string",
          description:
            "Color ID for the event (1-11). Maps to: 1=lavender, 2=sage, 3=grape, 4=flamingo, 5=banana, 6=tangerine, 7=peacock, 8=graphite, 9=blueberry, 10=basil, 11=tomato.",
        },
      },
      required: ["summary", "start", "end"],
    },
  },
  {
    name: "calendar_update_event",
    description: "Update an existing Google Calendar event. Any field you provide will be updated. Omit fields you want to keep unchanged.",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: { type: "string", description: "Calendar name or ID (default: 'primary')" },
        eventId: { type: "string", description: "Calendar event ID to update" },
        summary: { type: "string", description: "New event title (optional)" },
        description: { type: "string", description: "New description (optional)" },
        location: { type: "string", description: "New location (optional)" },
        start: {
          type: "string",
          description: "New start date/time as ISO 8601 string (optional). Use to move/reschedule the event.",
        },
        end: {
          type: "string",
          description: "New end date/time as ISO 8601 string (optional). Use to move/reschedule the event.",
        },
        attendees: {
          type: "array",
          items: { type: "string" },
          description: "Replace attendee list with these email addresses (optional)",
        },
        recurrence: {
          type: "array",
          items: { type: "string" },
          description: "Replace recurrence rules (optional). Pass an empty array to remove recurrence.",
        },
        transparency: {
          type: "string",
          enum: ["opaque", "transparent"],
          description: "Change busy/free status (optional).",
        },
        colorId: {
          type: "string",
          description: "Change event color (1-11, optional).",
        },
      },
      required: ["eventId"],
    },
  },
  {
    name: "calendar_list_tasks",
    description: "List Google Tasks from a task list. Returns tasks with their title, status, due date, and notes. You can filter by a date range.",
    inputSchema: {
      type: "object",
      properties: {
        tasklistId: {
          type: "string",
          description: "Task list ID (default: '@default' for the default task list). Use calendar_list_tasklists to find other task lists.",
          default: "@default",
        },
        maxResults: { type: "number", description: "Max results (default 50, max 100)", default: 50 },
        dueMin: {
          type: "string",
          description: "Lower bound for due date (ISO 8601, optional). Use with dueMax to find tasks due within a period.",
        },
        dueMax: {
          type: "string",
          description: "Upper bound for due date (ISO 8601, optional). Use with dueMin to find tasks due within a period.",
        },
        showCompleted: {
          type: "boolean",
          description: "Whether to include completed tasks (default true)",
          default: true,
        },
        showHidden: {
          type: "boolean",
          description: "Whether to show hidden/completed tasks (default false)",
          default: false,
        },
      },
    },
  },
  {
    name: "calendar_create_task",
    description: "Create a new task in Google Tasks. Can set title, due date, and notes.",
    inputSchema: {
      type: "object",
      properties: {
        tasklistId: {
          type: "string",
          description: "Task list ID (default: '@default' for the default task list).",
          default: "@default",
        },
        title: { type: "string", description: "Task title" },
        notes: { type: "string", description: "Task notes/description (optional)" },
        due: {
          type: "string",
          description: "Due date as RFC 3339 timestamp (optional). Example: '2026-06-15T00:00:00Z'",
        },
        status: {
          type: "string",
          enum: ["needsAction", "completed"],
          description: "Task status (default: 'needsAction')",
          default: "needsAction",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "calendar_update_task",
    description: "Update an existing Google Task. Can mark as complete, change title, update due date, or add notes.",
    inputSchema: {
      type: "object",
      properties: {
        tasklistId: {
          type: "string",
          description: "Task list ID containing the task (default: '@default').",
          default: "@default",
        },
        taskId: { type: "string", description: "Task ID to update" },
        title: { type: "string", description: "New task title (optional)" },
        notes: { type: "string", description: "New notes (optional)" },
        due: {
          type: "string",
          description: "New due date as RFC 3339 timestamp (optional). Set to null/empty to remove due date.",
        },
        status: {
          type: "string",
          enum: ["needsAction", "completed"],
          description: "Change task status (optional). Set to 'completed' to mark done.",
        },
      },
      required: ["taskId"],
    },
  },
  {
    name: "calendar_list_tasklists",
    description: "List all Google Task lists available to the authenticated user. Returns each task list's ID and name.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

export const webSearchTools = [
  {
    name: "web_search",
    description:
      "Search the web using DuckDuckGo. Returns a list of results with title, URL, and snippet for each. No API key required. Good for finding current information, news, documentation, and general web content.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        maxResults: { type: "number", description: "Maximum results to return (default 10, max 20)", default: 10 },
      },
      required: ["query"],
    },
  },
  {
    name: "web_fetch",
    description:
      "Fetch a web page and extract its main readable content. Returns the page title, URL, and clean text content (HTML stripped). Good for reading articles, documentation, or any web page.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full URL (including https://) of the page to fetch" },
      },
      required: ["url"],
    },
  },
];

/** Combined list of all tools for use by the agent runner */
export const allTools = [...trelloTools, ...gmailTools, ...driveTools, ...calendarTools, ...webSearchTools];
