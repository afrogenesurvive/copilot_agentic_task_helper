#!/usr/bin/env node

/**
 * Google Calendar MCP Server
 *
 * Provides tools for listing, searching, and managing Google Calendar events.
 * Uses the Model Context Protocol (stdio transport) for Copilot integration.
 *
 * Reuses the same OAuth2 credentials as the Gmail MCP server (combined scopes).
 * Environment variables (from .env):
 *   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import "dotenv/config";
import { sanitizeObject } from "../../scripts/sanitize.mjs";
import { calendarTools } from "../../shared/tool-manifest.js";

/* ── Auth (reuses Gmail OAuth2 credentials with combined scopes) ── */

function getAuthClient() {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    throw new Error("Missing Google OAuth2 credentials in environment");
  }
  const oauth2 = new OAuth2Client(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  return oauth2;
}

const calendar = google.calendar({ version: "v3", auth: getAuthClient() });
const tasks = google.tasks({ version: "v1", auth: getAuthClient() });

/* ── Helpers ── */

/**
 * Format a Calendar event object into a clean response shape.
 */
function formatEvent(event) {
  return {
    id: event.id,
    summary: event.summary || null,
    description: event.description || null,
    location: event.location || null,
    status: event.status,
    start: event.start || null,
    end: event.end || null,
    recurrence: event.recurrence || null,
    recurringEventId: event.recurringEventId || null,
    creator: event.creator ? { email: event.creator.email, displayName: event.creator.displayName || null } : null,
    organizer: event.organizer ? { email: event.organizer.email, displayName: event.organizer.displayName || null } : null,
    attendees: event.attendees
      ? event.attendees.map((a) => ({
          email: a.email,
          displayName: a.displayName || null,
          responseStatus: a.responseStatus,
          optional: a.optional || false,
        }))
      : [],
    htmlLink: event.htmlLink || null,
    created: event.created,
    updated: event.updated,
    colorId: event.colorId || null,
    transparency: event.transparency || null,
    visibility: event.visibility || null,
  };
}

/**
 * Parse a date string or date-time object into ISO string.
 */
function parseDateTime(dt) {
  if (!dt) return null;
  return dt.dateTime || dt.date || null;
}

/**
 * Resolve a calendar name or ID to a proper calendar ID.
 *
 * Looks up friendly calendar names from safe/calendars.json.
 * If the input matches a known calendar name, returns its ID.
 * If the input is already an ID or not found, returns it as-is.
 * Falls back to "primary" if nothing is provided.
 */
function resolveCalendarId(calendarId) {
  if (!calendarId) return "primary";

  // Try loading the calendar reference file
  try {
    const refPath = new URL("../../safe/calendars.json", import.meta.url);
    const ref = JSON.parse(fs.readFileSync(refPath, "utf8"));
    if (ref.byName && ref.byName[calendarId]) {
      return ref.byName[calendarId];
    }
  } catch {
    // File doesn't exist or is invalid — just use the provided value
  }

  return calendarId;
}

/**
 * List all available calendars (from the reference file if it exists)
 * and return a human-readable summary.
 */
function getCalendarSummary() {
  try {
    const refPath = new URL("../../safe/calendars.json", import.meta.url);
    const ref = JSON.parse(fs.readFileSync(refPath, "utf8"));
    if (ref.list && ref.list.length > 0) {
      const lines = ref.list.map((c) => {
        const tag = c.primary ? " (primary)" : "";
        return `   • ${c.name}${tag} — ${c.id}`;
      });
      return `Available calendars:\n${lines.join("\n")}`;
    }
  } catch {
    // No reference file
  }
  return "Run 'node scripts/setup-calendar-ref.js' to generate a calendar reference.";
}

/* ── Sanitization helpers ── */

function safeText(text) {
  return { type: "text", text };
}

function safeJson(data) {
  const sanitized = sanitizeObject(data);
  return { type: "text", text: JSON.stringify(sanitized, null, 2) };
}

/* ── Tool call logger ── */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, "..", "..", "logs", "tool_call");

function logToolCall(name, args, summary) {
  const ts = new Date().toISOString();
  const today = ts.slice(0, 10);
  const argsStr = JSON.stringify(args).slice(0, 200);
  const respStr = typeof summary === "string" ? summary.slice(0, 120) : "done";
  fs.mkdirSync(LOG_DIR, { recursive: true });

  for (const [eventName, details] of [
    ["tool_call", `calendar/${name} input=${argsStr}`],
    ["tool_response", `calendar/${name} output=${respStr}`],
  ]) {
    const line = `[${ts}] EVENT name=${eventName} details=${details}`;
    const entry = { timestamp: ts, name: eventName, details };
    fs.appendFileSync(path.join(LOG_DIR, `${today}_verbose.log`), JSON.stringify(entry) + "\n");
    fs.appendFileSync(path.join(LOG_DIR, `${today}.log`), line + "\n");
    console.error(`[mcp] ${line}`);
  }
}

/* ── MCP Server ── */

const server = new Server({ name: "calendar-mcp-server", version: "1.0.0" }, { capabilities: { tools: {} } });

/* ── Tool call handler ── */

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  let result;
  let summary;
  switch (name) {
    case "calendar_list_calendars":
      result = await handleListCalendars();
      try {
        const d = JSON.parse(result.content?.[0]?.text || "[]");
        summary = `${d.length} calendars`;
      } catch {
        summary = "done";
      }
      break;
    case "calendar_list_events":
      result = await handleListEvents(args);
      try {
        const d = JSON.parse(result.content?.[0]?.text || "[]");
        summary = `${d.length} events`;
      } catch {
        summary = "done";
      }
      break;
    case "calendar_get_event":
      result = await handleGetEvent(args);
      try {
        const d = JSON.parse(result.content?.[0]?.text || "{}");
        summary = `"${d.summary || "(no title)"}" at ${parseDateTime(d.start) || "?"}`;
      } catch {
        summary = "done";
      }
      break;
    case "calendar_create_event":
      result = await handleCreateEvent(args);
      try {
        const d = JSON.parse(result.content?.[0]?.text || "{}");
        summary = `"${d.summary || "(no title)"}" created (id: ${d.id})`;
      } catch {
        summary = "done";
      }
      break;
    case "calendar_update_event":
      result = await handleUpdateEvent(args);
      try {
        const d = JSON.parse(result.content?.[0]?.text || "{}");
        summary = `"${d.summary || "(no title)"}" updated`;
      } catch {
        summary = "done";
      }
      break;
    case "calendar_list_tasks":
      result = await handleListTasks(args);
      try {
        const d = JSON.parse(result.content?.[0]?.text || "[]");
        summary = `${d.length} tasks`;
      } catch {
        summary = "done";
      }
      break;
    case "calendar_create_task":
      result = await handleCreateTask(args);
      try {
        const d = JSON.parse(result.content?.[0]?.text || "{}");
        summary = `"${d.title || "(no title)"}" created (id: ${d.id})`;
      } catch {
        summary = "done";
      }
      break;
    case "calendar_update_task":
      result = await handleUpdateTask(args);
      try {
        const d = JSON.parse(result.content?.[0]?.text || "{}");
        summary = `"${d.title || "(no title)"}" updated (${d.status || "?"})`;
      } catch {
        summary = "done";
      }
      break;
    case "calendar_list_tasklists":
      result = await handleListTasklists();
      try {
        const d = JSON.parse(result.content?.[0]?.text || "[]");
        summary = `${d.length} task lists`;
      } catch {
        summary = "done";
      }
      break;
    default:
      result = { content: [safeText(`Unknown tool: ${name}`)], isError: true };
      summary = "unknown tool";
  }
  logToolCall(name, args, summary);
  return result;
});

/* ── Tool handlers ── */

async function handleListEvents(args) {
  const calendarId = resolveCalendarId(args.calendarId);
  const maxResults = Math.min(args.maxResults || 20, 100);
  const timeMin = args.timeMin || new Date().toISOString();
  const timeMax = args.timeMax || undefined;
  const q = args.query || undefined;
  const singleEvents = args.singleEvents !== false;

  try {
    const res = await calendar.events.list({
      calendarId,
      timeMin,
      timeMax,
      q,
      maxResults,
      singleEvents,
      orderBy: "startTime",
      fields:
        "items(id,summary,description,location,status,start,end,recurrence,recurringEventId,creator,organizer,attendees,htmlLink,created,updated,colorId,transparency,visibility)",
    });
    const events = (res.data.items || []).map(formatEvent);
    return { content: [safeJson(events)] }; // Event summaries sanitized
  } catch (err) {
    return { content: [safeText(`Error listing events: ${err.message}`)], isError: true };
  }
}

async function handleGetEvent(args) {
  const eventId = args.eventId;
  if (!eventId) {
    return { content: [safeText("Missing required parameter: eventId")], isError: true };
  }
  const calendarId = resolveCalendarId(args.calendarId);

  try {
    const res = await calendar.events.get({
      calendarId,
      eventId,
      fields:
        "id,summary,description,location,status,start,end,recurrence,recurringEventId,creator,organizer,attendees,htmlLink,created,updated,colorId,transparency,visibility",
    });
    return { content: [safeJson(formatEvent(res.data))] }; // Event details sanitized
  } catch (err) {
    return { content: [safeText(`Error getting event: ${err.message}`)], isError: true };
  }
}

async function handleCreateEvent(args) {
  const calendarId = resolveCalendarId(args.calendarId);
  const { summary, description, location, start, end, attendees, recurrence, transparency, colorId } = args;

  if (!summary) {
    return { content: [safeText("Missing required parameter: summary")], isError: true };
  }
  if (!start || !end) {
    return { content: [safeText("Missing required parameters: start and end (ISO date/time strings)")], isError: true };
  }

  const event = {
    summary,
    description: description || "",
    location: location || "",
    start: typeof start === "string" ? { dateTime: start } : start,
    end: typeof end === "string" ? { dateTime: end } : end,
    attendees: attendees ? (Array.isArray(attendees) ? attendees : [attendees]).map((a) => (typeof a === "string" ? { email: a } : a)) : undefined,
    recurrence: recurrence || undefined,
    transparency: transparency || undefined,
    colorId: colorId || undefined,
  };

  try {
    const res = await calendar.events.insert({
      calendarId,
      requestBody: event,
      fields: "id,summary,status,start,end,htmlLink",
    });
    return { content: [safeJson(formatEvent(res.data))] };
  } catch (err) {
    return { content: [safeText(`Error creating event: ${err.message}`)], isError: true };
  }
}

/* ── Calendar List Calendars ── */

async function handleListCalendars() {
  try {
    const res = await calendar.calendarList.list({
      fields: "items(id,summary,description,primary,selected,backgroundColor,accessRole,timeZone)",
    });
    const items = (res.data.items || []).map((c) => ({
      id: c.id,
      name: c.summary || "(unnamed)",
      description: c.description || null,
      primary: !!c.primary,
      selected: !!c.selected,
      accessRole: c.accessRole,
      timeZone: c.timeZone,
      backgroundColor: c.backgroundColor || null,
    }));
    return { content: [safeJson(items)] };
  } catch (err) {
    return { content: [safeText(`Error listing calendars: ${err.message}`)], isError: true };
  }
}

/* ── Calendar Update Event ── */

async function handleUpdateEvent(args) {
  const calendarId = resolveCalendarId(args.calendarId);
  const { eventId, summary, description, location, start, end, attendees, recurrence, transparency, colorId } = args;

  if (!eventId) {
    return { content: [safeText("Missing required parameter: eventId")], isError: true };
  }

  // Build update body — only include provided fields
  const body = {};
  if (summary !== undefined) body.summary = summary;
  if (description !== undefined) body.description = description;
  if (location !== undefined) body.location = location;
  if (start !== undefined) body.start = typeof start === "string" ? { dateTime: start } : start;
  if (end !== undefined) body.end = typeof end === "string" ? { dateTime: end } : end;
  if (attendees !== undefined) {
    body.attendees = (Array.isArray(attendees) ? attendees : [attendees]).map((a) => (typeof a === "string" ? { email: a } : a));
  }
  if (recurrence !== undefined) body.recurrence = recurrence.length > 0 ? recurrence : [];
  if (transparency !== undefined) body.transparency = transparency;
  if (colorId !== undefined) body.colorId = colorId;

  try {
    const res = await calendar.events.patch({
      calendarId,
      eventId,
      requestBody: body,
      fields: "id,summary,status,start,end,location,description,recurrence,attendees,htmlLink,transparency,colorId",
    });
    return { content: [safeJson(formatEvent(res.data))] };
  } catch (err) {
    return { content: [safeText(`Error updating event: ${err.message}`)], isError: true };
  }
}

/* ── Tasks Helpers ── */

function formatTask(task) {
  return {
    id: task.id,
    title: task.title || "",
    notes: task.notes || null,
    status: task.status || "needsAction",
    due: task.due || null,
    completed: task.completed || null,
    updated: task.updated,
    position: task.position,
    parent: task.parent || null,
    links: task.links || [],
    deleted: !!task.deleted,
    hidden: !!task.hidden,
  };
}

/* ── Tasks Handlers ── */

async function handleListTasks(args) {
  const tasklistId = args.tasklistId || "@default";
  const maxResults = Math.min(args.maxResults || 50, 100);
  const dueMin = args.dueMin || undefined;
  const dueMax = args.dueMax || undefined;
  const showCompleted = args.showCompleted !== false;
  const showHidden = args.showHidden || false;

  try {
    const res = await tasks.tasks.list({
      tasklist: tasklistId,
      maxResults,
      dueMin,
      dueMax,
      showCompleted,
      showHidden,
    });
    const items = (res.data.items || []).map(formatTask);
    return { content: [safeJson(items)] };
  } catch (err) {
    return { content: [safeText(`Error listing tasks: ${err.message}`)], isError: true };
  }
}

async function handleCreateTask(args) {
  const tasklistId = args.tasklistId || "@default";
  const { title, notes, due, status } = args;

  if (!title) {
    return { content: [safeText("Missing required parameter: title")], isError: true };
  }

  const body = { title, notes: notes || "", status: status || "needsAction" };
  if (due) body.due = due;

  try {
    const res = await tasks.tasks.insert({
      tasklist: tasklistId,
      requestBody: body,
    });
    return { content: [safeJson(formatTask(res.data))] };
  } catch (err) {
    return { content: [safeText(`Error creating task: ${err.message}`)], isError: true };
  }
}

async function handleUpdateTask(args) {
  const tasklistId = args.tasklistId || "@default";
  const { taskId, title, notes, due, status } = args;

  if (!taskId) {
    return { content: [safeText("Missing required parameter: taskId")], isError: true };
  }

  const body = {};
  if (title !== undefined) body.title = title;
  if (notes !== undefined) body.notes = notes;
  if (due !== undefined) body.due = due;
  if (status !== undefined) body.status = status;

  try {
    const res = await tasks.tasks.patch({
      tasklist: tasklistId,
      task: taskId,
      requestBody: body,
    });
    return { content: [safeJson(formatTask(res.data))] };
  } catch (err) {
    return { content: [safeText(`Error updating task: ${err.message}`)], isError: true };
  }
}

async function handleListTasklists() {
  try {
    const res = await tasks.tasklists.list({
      maxResults: 50,
      fields: "items(id,title,updated)",
    });
    const items = (res.data.items || []).map((tl) => ({
      id: tl.id,
      title: tl.title,
      updated: tl.updated,
    }));
    return { content: [safeJson(items)] };
  } catch (err) {
    return { content: [safeText(`Error listing task lists: ${err.message}`)], isError: true };
  }
}

/* ── Tool definitions (from shared manifest) ── */

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: calendarTools,
}));

/* ── Start ── */

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("✅ Calendar MCP Server running on stdio");
