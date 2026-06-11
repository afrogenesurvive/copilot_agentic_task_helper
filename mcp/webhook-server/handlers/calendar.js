/**
 * Calendar Webhook Handler — Google Calendar push notification callbacks
 *
 * Receives Google Calendar change notifications, logs them with details
 * fetched from the Calendar API, and enqueues them for processing.
 *
 * Calendar sends HTTP push notifications with headers:
 *   x-goog-channel-id, x-goog-resource-id, x-goog-resource-state
 *
 * The notification tells us *something* changed. To get event details,
 * we fetch recent/recurring changes from the Calendar API.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { enqueueEvent } from "../lib/event-queue.js";
import { dispatch } from "../lib/tool-dispatch.js";
import { sanitizeObject } from "../../../scripts/sanitize.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, "..", "..", "..", "logs", "webhook");
const NOTIFY_DIR = path.resolve(__dirname, "..", "..", "..", "logs", "notifications", "calendar");
const EVENT_STATE_PATH = path.resolve(__dirname, "..", "..", "..", "logs", "notifications", ".calendar-event-state.json");

function logVerbose(entry) {
  const ts = new Date().toISOString();
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(path.join(LOG_DIR, `${ts.slice(0, 10)}_verbose.log`), JSON.stringify({ ts, ...entry }) + "\n");
}

function logNotification(entry) {
  const ts = entry.ts || new Date().toISOString();
  const day = ts.slice(0, 10);
  fs.mkdirSync(NOTIFY_DIR, { recursive: true });
  fs.appendFileSync(path.join(NOTIFY_DIR, `${day}.jsonl`), JSON.stringify(entry) + "\n");
}

function getCalendarAuth() {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) return null;
  const oauth2 = new OAuth2Client(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  return oauth2;
}

/**
 * Format a dateTime or date string into a human-friendly short form.
 */
function fmtDT(dt, allDay) {
  if (!dt) return "—";
  if (allDay) return dt; // already YYYY-MM-DD
  // "2026-06-19T15:00:00-05:00" → "Jun 19 15:00"
  const d = new Date(dt);
  if (isNaN(d.getTime())) return dt;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getMonth()]} ${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Generate human-readable diffs by comparing an event's current fields
 * against the previously saved state.
 *
 * @param {object} ev  — Current event data
 * @param {object} old — Previous event data (from saved state), or null
 * @returns {string[]} Array of human-readable change descriptions
 */
function computeEventDiffs(ev, old) {
  if (!old) {
    // No previous state — check if this is a recurring instance exception
    if (ev.recurring) return ["Recurring instance modified"];
    return ["New event (no previous state to compare)"];
  }
  if (ev.status === "cancelled") return ["Event deleted/cancelled"];

  const diffs = [];

  // --- Summary (title) ---
  if (ev.summary !== old.summary) {
    if (old.summary === "(no title)") diffs.push(`Title set: "${ev.summary}"`);
    else if (ev.summary === "(no title)") diffs.push(`Title removed (was: "${old.summary}")`);
    else diffs.push(`Title changed: "${old.summary}" → "${ev.summary}"`);
  }

  // --- Location ---
  if (ev.location !== old.location) {
    if (!old.location && ev.location) diffs.push(`Location added: "${ev.location}"`);
    else if (old.location && !ev.location) diffs.push(`Location removed (was: "${old.location}")`);
    else diffs.push(`Location changed: "${old.location}" → "${ev.location}"`);
  }

  // --- Description ---
  if (ev.description !== old.description) {
    const oldLen = (old.description || "").length;
    const newLen = (ev.description || "").length;
    if (!old.description && ev.description) diffs.push(`Description added (${newLen} chars)`);
    else if (old.description && !ev.description) diffs.push(`Description removed (was ${oldLen} chars)`);
    else diffs.push(`Description changed (${oldLen} → ${newLen} chars)`);
  }

  // --- Start time ---
  if (ev.start !== old.start) {
    const oldStart = fmtDT(old.start, old.allDay);
    const newStart = fmtDT(ev.start, ev.allDay);
    diffs.push(`Start moved: ${oldStart} → ${newStart}`);
  }

  // --- End time ---
  if (ev.end !== old.end) {
    const oldEnd = fmtDT(old.end, old.allDay);
    const newEnd = fmtDT(ev.end, ev.allDay);
    diffs.push(`End moved: ${oldEnd} → ${newEnd}`);
  }

  // --- All-day toggling ---
  if (ev.allDay !== old.allDay) {
    diffs.push(`All-day toggled: ${old.allDay ? "yes → no" : "no → yes"}`);
  }

  // --- Status ---
  if (ev.status !== old.status) {
    diffs.push(`Status changed: ${old.status} → ${ev.status}`);
  }

  // --- Recurrence rule ---
  if (ev.recurrenceRule !== old.recurrenceRule) {
    if (!old.recurrenceRule && ev.recurrenceRule) diffs.push(`Recurrence added: ${ev.recurrenceRule}`);
    else if (old.recurrenceRule && !ev.recurrenceRule) diffs.push(`Recurrence removed`);
    else diffs.push(`Recurrence changed: ${old.recurrenceRule} → ${ev.recurrenceRule}`);
  }

  // --- Conference (video meeting) ---
  const oldConf = old.conference?.name || old.conference?.type || null;
  const newConf = ev.conference?.name || ev.conference?.type || null;
  if (newConf !== oldConf) {
    if (!oldConf && newConf) diffs.push(`Conference added: ${ev.conference?.name || ev.conference?.type || "yes"}`);
    else if (oldConf && !newConf) diffs.push(`Conference removed`);
    else diffs.push(`Conference changed`);
  }

  // --- Attendee changes ---
  const oldAttendeeEmails = new Set((old.attendees || []).map((a) => a.email));
  const newAttendeeEmails = new Set((ev.attendees || []).map((a) => a.email));
  const added = (ev.attendees || []).filter((a) => !oldAttendeeEmails.has(a.email));
  const removed = (old.attendees || []).filter((a) => !newAttendeeEmails.has(a.email));
  if (added.length > 0) diffs.push(`Attendees added: ${added.map((a) => a.email).join(", ")}`);
  if (removed.length > 0) diffs.push(`Attendees removed: ${removed.map((a) => a.email).join(", ")}`);

  // --- Visibility ---
  if (ev.visibility !== old.visibility) {
    diffs.push(`Visibility: ${old.visibility || "default"} → ${ev.visibility || "default"}`);
  }

  // --- Transparency (busy/free) ---
  if (ev.transparency !== old.transparency) {
    const oldLabel = old.transparency === "transparent" ? "free" : old.transparency === "opaque" ? "busy" : old.transparency || "default";
    const newLabel = ev.transparency === "transparent" ? "free" : ev.transparency === "opaque" ? "busy" : ev.transparency || "default";
    diffs.push(`Shows as: ${oldLabel} → ${newLabel}`);
  }

  // --- Color ---
  if (ev.colorId !== old.colorId) {
    diffs.push(`Color changed: ${old.colorId || "none"} → ${ev.colorId || "none"}`);
  }

  return diffs.length > 0 ? diffs : ["Unknown change (sequence increased)"];
}

/**
 * Extract a minimal snapshot of event fields we want to track for change detection.
 * Only the fields that are meaningful for diffing are included.
 */
function eventSnapshot(ev) {
  return {
    summary: ev.summary,
    description: ev.description,
    status: ev.status,
    start: ev.start,
    end: ev.end,
    allDay: ev.allDay,
    location: ev.location,
    recurrenceRule: ev.recurrenceRule,
    colorId: ev.colorId,
    transparency: ev.transparency,
    visibility: ev.visibility,
    conference: ev.conference,
    attendees: ev.attendees ? ev.attendees.map((a) => ({ email: a.email, response: a.response })) : [],
  };
}

/**
 * Load the previously saved event state from disk.
 * @returns {object} Map of eventId → snapshot
 */
function loadEventState() {
  try {
    if (fs.existsSync(EVENT_STATE_PATH)) {
      return JSON.parse(fs.readFileSync(EVENT_STATE_PATH, "utf8"));
    }
  } catch {
    /* ignore corrupt state */
  }
  return {};
}

/**
 * Save the current event state to disk.
 */
function saveEventState(state) {
  try {
    fs.mkdirSync(path.dirname(EVENT_STATE_PATH), { recursive: true });
    fs.writeFileSync(EVENT_STATE_PATH, JSON.stringify(state), "utf8");
  } catch (err) {
    console.error(`   ⚠️  [CALENDAR] Failed to save event state: ${err.message}`);
  }
}

/**
 * Fetch recent Calendar event changes using the Calendar API.
 * Uses a saved syncToken to get incremental changes since last check.
 *
 * Classifies each event with a changeType:
 *   - "deleted"  — event was cancelled/removed
 *   - "updated"  — event was modified (sync token ensures only changes are returned)
 *   - "snapshot" — initial sync (no previous sync token); these are baseline events
 *
 * Also computes per-event diffs by comparing against previously saved state.
 */
async function fetchCalendarChanges() {
  try {
    const auth = getCalendarAuth();
    if (!auth) {
      console.error("   ⚠️  [CALENDAR] No Google auth available");
      return {};
    }
    const calendar = google.calendar({ version: "v3", auth });

    // Try to load the saved syncToken
    const syncStatePath = path.resolve(__dirname, "..", "..", "..", "logs", "notifications", ".calendar-sync-token.json");
    let syncToken = null;
    try {
      if (fs.existsSync(syncStatePath)) {
        syncToken = JSON.parse(fs.readFileSync(syncStatePath, "utf8")).syncToken;
      }
    } catch {
      /* ignore */
    }

    const isInitialSync = !syncToken;
    const prevState = loadEventState();

    // Fetch changes since the last sync token, or recent events
    const params = {
      calendarId: "primary",
      showDeleted: true,
      singleEvents: true, // expand recurring events into instances
      maxResults: 50,
      fields:
        "items(id,summary,description,status,location,start,end,created,updated," +
        "recurringEventId,recurrence,colorId,creator,organizer," +
        "attendees,htmlLink,transparency,visibility,sequence,locked," +
        "guestsCanModify,guestsCanInviteOthers,guestsCanSeeOtherGuests," +
        "attachments,conferenceData),nextSyncToken",
    };

    if (syncToken) {
      params.syncToken = syncToken;
    } else {
      // No sync token yet — fetch events from the past 24 hours as a baseline
      params.timeMin = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      params.timeMax = new Date().toISOString();
    }

    const res = await calendar.events.list(params);
    const items = res.data.items || [];
    const nextSyncToken = res.data.nextSyncToken;

    // Save the new sync token for incremental sync
    if (nextSyncToken) {
      fs.mkdirSync(path.dirname(syncStatePath), { recursive: true });
      fs.writeFileSync(syncStatePath, JSON.stringify({ syncToken: nextSyncToken }), "utf8");
    }

    // Build the new event state map (for saving after diffing)
    const newState = {};

    // Classify each event's change type and compute diffs
    const events = items.map((e) => {
      let changeType;
      if (e.status === "cancelled") {
        changeType = "deleted";
      } else if (isInitialSync) {
        changeType = "snapshot"; // baseline data, not a delta change
      } else {
        changeType = "updated"; // sync token guarantees this event changed
      }

      // Make sure e.start?.dateTime has a timezone for proper comparison
      // Google Calendar API returns dateTime in local time with offset
      const ev = {
        id: e.id,
        changeType,
        summary: e.summary || "(no title)",
        description: e.description || null,
        status: e.status,
        start: e.start?.dateTime || e.start?.date || null,
        end: e.end?.dateTime || e.end?.date || null,
        allDay: !!e.start?.date,
        location: e.location || null,
        created: e.created,
        updated: e.updated,
        recurring: !!e.recurringEventId,
        recurrenceRule: e.recurrence?.[0] || null,
        colorId: e.colorId || null,
        organizer: e.organizer ? { name: e.organizer.displayName || e.organizer.email, email: e.organizer.email } : null,
        creator: e.creator ? { name: e.creator.displayName || e.creator.email, email: e.creator.email } : null,
        attendees: e.attendees
          ? e.attendees.map((a) => ({
              email: a.email,
              name: a.displayName || null,
              response: a.responseStatus,
              optional: a.optional || false,
            }))
          : [],
        responses: e.attendees
          ? {
              accepted: e.attendees.filter((a) => a.responseStatus === "accepted").length,
              declined: e.attendees.filter((a) => a.responseStatus === "declined").length,
              tentative: e.attendees.filter((a) => a.responseStatus === "tentative").length,
              pending: e.attendees.filter((a) => a.responseStatus === "needsAction").length,
            }
          : null,
        link: e.htmlLink || null,
        conference: e.conferenceData ? { name: e.conferenceData.name || null, type: e.conferenceData.conferenceSolution?.type || null } : null,
        attachments: e.attachments ? e.attachments.map((a) => ({ title: a.title, mimeType: a.mimeType, url: a.fileUrl })) : [],
        transparency: e.transparency || null,
        visibility: e.visibility || null,
        guestsCanModify: e.guestsCanModify ?? null,
        sequence: e.sequence || 0,
        locked: e.locked ?? null,
        guestsCanInviteOthers: e.guestsCanInviteOthers ?? null,
        guestsCanSeeOtherGuests: e.guestsCanSeeOtherGuests ?? null,
        // Diffs computed below
        diffs: [],
      };

      // Compute diffs against previous state (if this isn't initial sync)
      if (!isInitialSync) {
        const old = prevState[e.id] || null;
        ev.diffs = computeEventDiffs(ev, old);
      } else {
        ev.diffs = ["Baseline snapshot (initial sync)"];
      }

      // Build new state entry for non-deleted events so we can diff next time
      if (e.status !== "cancelled") {
        newState[e.id] = eventSnapshot(ev);
      }
      // Remove deleted events from state so they don't appear in future diffs

      return ev;
    });

    // Persist the updated event state
    saveEventState(newState);

    // Compute change type breakdown
    const changeCounts = {};
    for (const ev of events) {
      changeCounts[ev.changeType] = (changeCounts[ev.changeType] || 0) + 1;
    }
    const breakdown = Object.entries(changeCounts)
      .map(([type, count]) => `${type}:${count}`)
      .join(", ");

    // --- Terminal output with rich diffs ---
    console.error(`   📅 [CALENDAR] ${events.length} event(s) — ${breakdown}`);
    for (const ev of events.slice(0, 15)) {
      let icon;
      switch (ev.changeType) {
        case "deleted":
          icon = "🗑️";
          break;
        case "snapshot":
          icon = "📸";
          break;
        case "updated":
          icon = "🔄";
          break;
        default:
          icon = "📅";
          break;
      }
      const when = ev.allDay ? ev.start : ev.start?.replace("T", " ").slice(0, 16);
      const loc = ev.location ? ` @ ${ev.location}` : "";
      console.error(`   📅 [CALENDAR]   ${icon} ${ev.changeType.padEnd(9)} ${ev.summary}${loc} (${when})`);

      // Print each diff line indented below the event
      if (ev.diffs && ev.diffs.length > 0) {
        for (const diff of ev.diffs.slice(0, 8)) {
          console.error(`   📅 [CALENDAR]     · ${diff}`);
        }
        if (ev.diffs.length > 8) {
          console.error(`   📅 [CALENDAR]     · ... and ${ev.diffs.length - 8} more changes`);
        }
      }
    }
    if (events.length > 15) {
      console.error(`   📅 [CALENDAR]   ... and ${events.length - 15} more`);
    }

    return { events, count: events.length, isInitialSync, changeCounts };
  } catch (err) {
    console.error(`   ❌ [CALENDAR] fetchCalendarChanges: ${err.message}`);
    return {};
  }
}

/**
 * Handle Calendar push notification (POST).
 * Logs the notification with details and enqueues it.
 */
export async function calendarPushHandler(req, res) {
  const ts = new Date().toISOString();
  const body = req.body || {};
  const headers = req.headers || {};

  // Calendar HTTP headers carry channel metadata
  const channelId = headers["x-goog-channel-id"] || "?";
  const resourceId = headers["x-goog-resource-id"] || "?";
  const resourceState = headers["x-goog-resource-state"] || "?";

  console.log(`📅 [CALENDAR] Push — state:${resourceState} channel:${channelId.slice(0, 20)}`);

  logVerbose({
    type: "push_received",
    source: "calendar",
    channelId,
    resourceId,
    resourceState,
    messageId: body.message?.messageId,
  });

  // Fetch event details from the Calendar API
  console.log(`   📅 [CALENDAR] Fetching event changes...`);
  const details = await fetchCalendarChanges();

  // Build the notification entry for persistent logging
  const entry = {
    ts,
    source: "calendar",
    type: resourceState === "sync" ? "sync" : "change",
    data: sanitizeObject({
      channelId,
      resourceId,
      resourceState,
      eventCount: details.count || undefined,
      isInitialSync: details.isInitialSync || undefined,
      changeTypes: details.changeCounts || undefined, // <-- NEW: change type breakdown
      events: details.events
        ? details.events.slice(0, 20).map((e) => ({
            id: e.id,
            changeType: e.changeType,
            diffs: e.diffs, // <-- NEW: human-readable change descriptions
            summary: e.summary,
            description: e.description,
            status: e.status,
            start: e.start,
            end: e.end,
            allDay: e.allDay,
            location: e.location,
            created: e.created,
            updated: e.updated,
            recurring: e.recurring,
            recurrenceRule: e.recurrenceRule,
            sequence: e.sequence,
            organizer: e.organizer,
            creator: e.creator,
            attendees: e.attendees,
            responses: e.responses,
            link: e.link,
            conference: e.conference,
            attachments: e.attachments,
            transparency: e.transparency,
            visibility: e.visibility,
            guestsCanModify: e.guestsCanModify,
            locked: e.locked,
          }))
        : undefined,
    }),
  };
  Object.keys(entry.data).forEach((k) => entry.data[k] === undefined && delete entry.data[k]);
  logNotification(entry);

  // Print a rich summary to the terminal
  const changeSummary = details.changeCounts
    ? Object.entries(details.changeCounts)
        .map(([t, c]) => `${c} ${t}`)
        .join(", ")
    : `${details.count || 0} event(s)`;
  const initTag = details.isInitialSync ? " (initial sync/snapshot)" : "";
  console.log(`   📅 [CALENDAR] ${resourceState === "sync" ? "🔁 Sync" : "🔄 Change"}: ${changeSummary}${initTag}`);

  // Build and route the event
  const event = {
    source: "calendar",
    type: resourceState === "sync" ? "sync" : "change",
    data: sanitizeObject({
      channelId,
      resourceId,
      resourceState,
      eventCount: details.count || 0,
      isInitialSync: details.isInitialSync || false,
      changeTypes: details.changeCounts || {},
      events: details.events
        ? details.events.slice(0, 20).map((e) => ({
            id: e.id,
            changeType: e.changeType,
            diffs: e.diffs,
            summary: e.summary,
            status: e.status,
            start: e.start,
            end: e.end,
            allDay: e.allDay,
            location: e.location,
            sequence: e.sequence,
          }))
        : [],
    }),
  };

  enqueueEvent(event, "misc_notifications");
  dispatch(event);
  console.log(`   📅 [CALENDAR] Event → misc_notifications (tool dispatch → priority)`);

  res.status(200).json({ status: "received" });
}
