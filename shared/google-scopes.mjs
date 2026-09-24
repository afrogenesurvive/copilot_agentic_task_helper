/**
 * Canonical Google OAuth scope sets.
 *
 * Two flows mint Google refresh tokens in this repo, and they must never drift:
 *
 *   1. `scripts/gmail-auth.mjs` (CLI: `npm run setup:gmail-auth`) — writes the
 *      OPERATOR token that every MCP server and the Electron operator chat use.
 *   2. `electron/src/main/oauth.js` (`connectGoogleOperator`, the Config tab's
 *      "Connect Google") — remints that same operator token from the dashboard.
 *
 * They used to carry separate inline lists, which is exactly how a dashboard
 * remint could silently produce a weaker token than the CLI (the old UI flow
 * omitted `gmail.settings.basic` and every Photos scope, so re-consenting from
 * the UI would have broken Gmail filters and all Photos tools).
 *
 * `SEAT_SCOPES` is the narrower per-seat set: it is bound to a collaborator's
 * own account in `safe/frontdesk-accounts.json` and only ever drives the agent
 * runner's Trello/Gmail tools, so it deliberately stays small.
 *
 * Scope notes that cost real debugging time (2026-09-24):
 *   - `calendar.events` / `calendar.events.readonly` do NOT cover
 *     `CalendarList.list`, so `calendar_list_calendars` answered 403
 *     "Insufficient Permission". The full `calendar` scope does.
 *   - Nothing in the Calendar API implies Tasks access — `calendar_list_tasks`
 *     and friends need `tasks` explicitly.
 */

/** Full operator token: Gmail + Drive + Calendar + Tasks + Photos + identity. */
export const OPERATOR_SCOPES = [
  // Gmail — read/send/labels. `gmail.settings.basic` is required to create and
  // manage FILTERS (auto-labelling); without it users.settings.filters.* fails
  // 403 insufficientPermissions.
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  // Drive — full, because the MCP server has create/update/move/delete tools.
  "https://www.googleapis.com/auth/drive",
  // Calendar — the full scope rather than the events pair, so CalendarList.list
  // works. The seat flow has requested this for years, so the OAuth client is
  // already configured and verified for it.
  "https://www.googleapis.com/auth/calendar",
  // Google Tasks — calendar_list_tasks / calendar_create_task / calendar_update_task.
  "https://www.googleapis.com/auth/tasks",
  // Photos — Library API app-created scopes (Google removed the old
  // `photoslibrary` / `photoslibrary.readonly` scopes on 2025-03-31), plus the
  // Picker API, which is the only interactive route to real library items.
  "https://www.googleapis.com/auth/photoslibrary.appendonly",
  "https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata",
  "https://www.googleapis.com/auth/photoslibrary.edit.appcreateddata",
  "https://www.googleapis.com/auth/photospicker.mediaitems.readonly",
  // Identity — lets the flow label the token with the account's email address.
  "openid",
  "email",
];

/** Per-seat binding (Accounts tab): a collaborator's own Google account. */
export const SEAT_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/calendar",
  "openid",
  "email",
];
