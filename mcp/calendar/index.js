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
 * Get default calendar ID or a named one.
 */
function resolveCalendarId(calendarId) {
  return calendarId || "primary";
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
  const { summary, description, location, start, end, attendees, recurrence } = args;

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
  };

  try {
    const res = await calendar.events.insert({
      calendarId,
      requestBody: event,
      fields: "id,summary,status,start,end,htmlLink",
    });
    return { content: [safeJson(formatEvent(res.data))] }; // New event data sanitized
  } catch (err) {
    return { content: [safeText(`Error creating event: ${err.message}`)], isError: true };
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
