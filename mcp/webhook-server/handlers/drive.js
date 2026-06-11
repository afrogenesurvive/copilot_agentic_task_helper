/**
 * Drive Webhook Handler — Google Drive push notification callbacks
 *
 * Receives Google Drive change notifications, logs them with details
 * fetched from the Drive API, and enqueues them for processing.
 *
 * Drive sends HTTP push notifications (not Pub/Sub) with headers:
 *   x-goog-channel-id, x-goog-resource-id, x-goog-resource-state
 * The body may contain a Pub/Sub-style wrapper if routed via Cloud Pub/Sub.
 *
 * Unlike Gmail, Drive push notifications are thin signals — they just say
 * *something* changed. To get details, we fetch the current change feed
 * from the Drive API.
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
const NOTIFY_DIR = path.resolve(__dirname, "..", "..", "..", "logs", "notifications", "drive");

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

function getDriveAuth() {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) return null;
  const oauth2 = new OAuth2Client(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  return oauth2;
}

/**
 * Fetch recent Drive change details using the Drive API.
 * Returns info about changed files and their types.
 */
async function fetchDriveChanges() {
  try {
    const auth = getDriveAuth();
    if (!auth) {
      console.error("   ⚠️  [DRIVE] No Google auth available");
      return {};
    }
    const drive = google.drive({ version: "v3", auth });
    console.log("   📁 [DRIVE] Fetching change details...");

    // Get the current page token to fetch changes since the last sync
    const tokenRes = await drive.changes.getStartPageToken({});
    const currentToken = tokenRes.data.startPageToken;

    // Try to load the saved page token, otherwise start fresh
    const statePath = path.resolve(__dirname, "..", "..", "..", "logs", "notifications", ".drive-page-token.json");
    let savedToken = null;
    try {
      if (fs.existsSync(statePath)) {
        savedToken = JSON.parse(fs.readFileSync(statePath, "utf8")).pageToken;
      }
    } catch {
      /* ignore */
    }

    if (!savedToken) {
      // First run — just save the current token and return
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify({ pageToken: currentToken }), "utf8");
      console.error("   📁 [DRIVE] Initial page token saved, no changes to report yet");
      return { savedToken: true, currentPageToken: currentToken };
    }

    // Fetch changes since the saved token
    console.error(`   📁 [DRIVE] Fetching changes since token ${savedToken.slice(0, 20)}...`);
    const changesRes = await drive.changes.list({
      pageToken: savedToken,
      spaces: "drive",
      fields:
        "changes(fileId,file(id,name,mimeType,size,parents,createdTime,modifiedTime,lastModifyingUser,owners,webViewLink,shared,md5Checksum,version,copyRequiresWriterPermission,viewedByMe,viewedByMeTime,isAppAuthorized,capabilities(canEdit,canShare,canRename,canDelete,canMoveChildrenWithinDrive)),trashed),newStartPageToken,teamDriveId",
    });

    const changes = changesRes.data.changes || [];
    const newStartToken = changesRes.data.newStartPageToken || currentToken;
    console.error(`   📁 [DRIVE] ${changes.length} change(s) returned from API`);

    // Save the new start token
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ pageToken: newStartToken }), "utf8");

    const files = changes.map((c) => {
      // Classify the change type based on what we can detect
      let changeClass;
      if (c.removed || c.trashed) {
        changeClass = "deleted";
      } else {
        changeClass = "modified"; // Drive API doesn't distinguish created vs updated in changes feed
      }

      return {
        fileId: c.fileId,
        changeClass, // <-- NEW: explicit classification: "deleted" or "modified"
        name: c.file?.name || "(unknown)",
        mimeType: c.file?.mimeType || "?",
        size: c.file?.size || null,
        time: c.time,
        removed: c.removed || false,
        trashed: c.file?.trashed || false,
        changeType: c.changeType || "unknown",
        directory: c.file?.parents?.[0] || null, // parent folder ID
        modifiedTime: c.file?.modifiedTime || null,
        createdTime: c.file?.createdTime || null,
        lastModifiedBy: c.file?.lastModifyingUser?.displayName || null,
        lastModifiedByEmail: c.file?.lastModifyingUser?.emailAddress || null, // <-- NEW
        owners: c.file?.owners?.map((o) => ({ displayName: o.displayName, emailAddress: o.emailAddress })) || [], // <-- NEW: richer owner info
        shared: c.file?.shared || false,
        webViewLink: c.file?.webViewLink || null,
        driveId: c.driveId || null,
        version: c.file?.version || null, // <-- NEW: file version counter
        md5Checksum: c.file?.md5Checksum || null, // <-- NEW: content checksum
        viewedByMe: c.file?.viewedByMe ?? null, // <-- NEW: whether current user has viewed
        viewedByMeTime: c.file?.viewedByMeTime || null, // <-- NEW: when user last viewed
        capabilities: c.file?.capabilities
          ? {
              // <-- NEW: file capabilities
              canEdit: c.file.capabilities.canEdit ?? null,
              canShare: c.file.capabilities.canShare ?? null,
              canRename: c.file.capabilities.canRename ?? null,
              canDelete: c.file.capabilities.canDelete ?? null,
            }
          : null,
      };
    });

    // Compute change type breakdown
    const changeCounts = {};
    for (const f of files) {
      changeCounts[f.changeClass] = (changeCounts[f.changeClass] || 0) + 1;
    }
    const breakdown = Object.entries(changeCounts)
      .map(([type, count]) => `${type}:${count}`)
      .join(", ");

    console.error(`   📁 [DRIVE] ${files.length} change(s) — ${breakdown}`);
    for (const f of files.slice(0, 15)) {
      let icon;
      switch (f.changeClass) {
        case "deleted":
          icon = "🗑️";
          break;
        case "modified":
          icon = f.mimeType?.includes("folder") ? "📁" : "📄";
          break;
        default:
          icon = "❓";
          break;
      }
      const sizeInfo = f.size ? ` (${(f.size / 1024).toFixed(1)}KB)` : "";
      const loc = f.directory ? ` [folder:${f.directory.slice(0, 10)}...]` : "";
      const by = f.lastModifiedBy ? ` by:${f.lastModifiedBy}` : "";
      const tag = f.mimeType?.includes("folder") ? "folder" : f.mimeType?.split("/").pop() || "?";
      console.error(`   📁 [DRIVE]   ${icon} ${f.changeClass.padEnd(9)} ${f.name}${sizeInfo}${loc}${by} (${tag})`);
    }
    if (files.length > 15) {
      console.error(`   📁 [DRIVE]   ... and ${files.length - 15} more`);
    }

    return { changes: files, count: files.length, changeCounts, currentPageToken: newStartToken };
  } catch (err) {
    console.error(`   ❌ [DRIVE] fetchDriveChanges: ${err.message}`);
    return {};
  }
}

/**
 * Handle Drive push notification (POST).
 * Logs the notification with details and enqueues it.
 */
export async function drivePushHandler(req, res) {
  const ts = new Date().toISOString();
  const body = req.body || {};
  const headers = req.headers || {};

  // Drive HTTP headers carry channel metadata
  const channelId = headers["x-goog-channel-id"] || "?";
  const resourceId = headers["x-goog-resource-id"] || "?";
  const resourceState = headers["x-goog-resource-state"] || "?";
  const changed = headers["x-goog-changed"] || "";

  console.log(`📁 [DRIVE] Push — state:${resourceState} channel:${channelId.slice(0, 20)}`);

  logVerbose({
    type: "push_received",
    source: "drive",
    channelId,
    resourceId,
    resourceState,
    changed,
    messageId: body.message?.messageId,
  });

  // Fetch change details from the Drive API
  console.log(`   📁 [DRIVE] Fetching change details...`);
  const details = await fetchDriveChanges();

  // Build the notification entry for persistent logging
  const entry = {
    ts,
    source: "drive",
    type: resourceState === "sync" ? "sync" : "change",
    data: sanitizeObject({
      channelId,
      resourceId,
      resourceState,
      changed: changed || undefined,
      changeCount: details.count || undefined,
      changeTypes: details.changeCounts || undefined, // <-- NEW: change class breakdown
      files: details.changes
        ? details.changes.slice(0, 20).map((f) => ({
            fileId: f.fileId,
            changeClass: f.changeClass, // <-- NEW: "deleted" or "modified"
            name: f.name,
            mimeType: f.mimeType,
            size: f.size,
            removed: f.removed,
            trashed: f.trashed, // <-- NEW
            changeType: f.changeType,
            directory: f.directory,
            modifiedTime: f.modifiedTime,
            createdTime: f.createdTime,
            lastModifiedBy: f.lastModifiedBy,
            lastModifiedByEmail: f.lastModifiedByEmail, // <-- NEW
            owners: f.owners, // <-- NEW: richer owner data
            shared: f.shared,
            webViewLink: f.webViewLink,
            version: f.version, // <-- NEW
            md5Checksum: f.md5Checksum, // <-- NEW
            capabilities: f.capabilities, // <-- NEW
            viewedByMe: f.viewedByMe, // <-- NEW
            viewedByMeTime: f.viewedByMeTime, // <-- NEW
          }))
        : undefined,
    }),
  };
  // Strip undefined keys
  Object.keys(entry.data).forEach((k) => entry.data[k] === undefined && delete entry.data[k]);
  logNotification(entry);

  // Print a rich summary to the terminal
  const changeSummary = details.changeCounts
    ? Object.entries(details.changeCounts)
        .map(([t, c]) => `${c} ${t}`)
        .join(", ")
    : `${details.count || 0} file(s)`;
  console.log(`   📁 [DRIVE] ${resourceState === "sync" ? "🔁 Sync" : "🔄 Change"}: ${changeSummary}`);

  // Build and route the event
  const event = {
    source: "drive",
    type: resourceState === "sync" ? "sync" : "change",
    data: sanitizeObject({
      channelId,
      resourceId,
      resourceState,
      changed,
      changeCount: details.count || 0,
      changeTypes: details.changeCounts || {},
      changes: details.changes ? details.changes.slice(0, 20) : [],
    }),
  };

  enqueueEvent(event, "misc_notifications");
  dispatch(event);
  console.log(`   📁 [DRIVE] Event → misc_notifications (tool dispatch → priority)`);

  res.status(200).json({ status: "received" });
}
