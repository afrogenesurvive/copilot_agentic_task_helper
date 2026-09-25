# Changelog

## [0.4.3-1] — 2026-09-25

### The Dashboard's single bulk button is now a service picker

**Restart all down (N)** could only ever *start what was stopped*, so it sat disabled whenever everything
was already running — and it could not restart a service that was up. It has been replaced by
**Start / restart…**, which sits between the sidebar's heading and the service list.

Click it and the rail becomes a picker: every service gets a checkbox, with the core services
(webhook, runner, tunnel) already ticked and any service that is not configured greyed out. Tick what you
want and press **Start / restart (N)** — each ticked service that is **down is started**, and each one that
is **up is restarted**. The picker then closes itself, the rail returns to its normal rows, and the report
above the service details says what happened (`✅ started …  ·  🔁 restarted …  ·  ❌ …  ·  skipped …
(reason)`). **Cancel** backs out, clears the ticks and the report, and changes nothing.

The MCP servers are selectable here, because an explicit tick is a deliberate choice per server — which
the old button's blanket "core services only" rule could not be. A service that is running but was started
**outside** the app is reported as skipped rather than restarted: Dev Centre can only stop the processes it
started itself, so it will not kill a runner you launched yourself.

## [0.4.2-4] — 2026-09-25

### The sign-in screen's close button now quits, and the menu-bar icon follows the menu bar

Closing the app **while the sign-in screen is showing now quits it**, exactly like the sidebar's Quit,
after asking *"Quit Dev Centre? Backend services will stop."* It used to hide the window instead, which
left a locked app with no way out besides the tray's right-click menu or Cmd+Q. The window's own close
button — the red dot, or Cmd+W — does the same while you are signed out, so the two agree. Nothing
changes once you are signed in: closing the window still hides the dashboard and the backend keeps
running.

The **menu-bar icon** is now **white, always**. It previously took its colour from the *system* menu-bar
appearance, and before that from the app's own **Appearance** setting — which Electron applies to the menu
bar item itself, so a pinned theme drew the mark in the menu bar's *opposite* colour. Neither signal is
reliable on macOS 26, where the menu bar's tint comes from the wallpaper, so the mark no longer tries to
match it: it is the same white on every menu bar. On a light menu bar a white mark is faint by design —
the red **uncleared-notification count** beside it is what reads. The badge itself is unchanged.

While you are signed out, the menu-bar **panel** no longer sits behind the sign-in prompt loading data it
cannot have: each pane says *sign in to see…* instead of "Loading…", the counts are blanked rather than
showing numbers read before the lock, and the panel stops asking at all — a locked app used to write a
refused-read error to its log for every notification it had ever recorded.

## [0.4.2-3] — 2026-09-25

### The app is now Dev Centre, and it is gated behind a sign-in

**Dev Centre** is the new name (it was *Frontdesk Operator*). The desktop app and the web frontdesk
that collaborators chat with are two different things, and sharing a name kept causing confusion; the
dock, application menu, About panel, window title, sidebar and menu-bar panel all say Dev Centre now.
Your remembered panel size and window preferences are carried over from the old name automatically on
first launch.

Launching it now asks for an **email and secret**. Admins are listed in `DEV_CENTRE_ADMINS` in `.env`
and always get everything. Everyone else lives in the gitignored role registry
(`safe/dev-centre-roles.json`, managed with `node scripts/dev-centre-roles.mjs`) at **tier_2** —
everything except **Key Manager** and **Accounts & Keys**. Those two tabs are not shown for tier_2,
and the channels behind them are refused outright, so hiding them is presentation rather than the
control. A session lasts 12 hours by default (`DEV_CENTRE_SESSION_LIMIT`) and is resumed on the next
launch while it is still valid.

The sign-in screen is a separate document rather than an overlay: while locked, the dashboard's code
is never evaluated at all. The menu-bar panel still opens without signing in, and its **Sign in to
Dev Centre** button is the way to the gate. The gate has its own **close button**, which hides the
window exactly as closing it always has — the backend keeps running, and the panel, the dock icon or
the tray menu all bring it back. Quit stays on the tray's right-click menu, so a locked app is never
stuck with no way out.

Your secret may be a plain text string, or a `scrypt$…` verifier minted by
`pkm claims set … --password-stdin`, which lets you keep a real password without storing it here.

### The Config tab can no longer see or set the admin list

`DEV_CENTRE_ADMINS` is stripped from every config surface — the Config tab, its per-key source view
and the config export — and refused by both save and import. Writing it would have outranked the
built-in default and let a tier_2 operator promote themselves.

### Menu-bar panel

- **It no longer un-focuses a full-screen window.** The panel is a non-activating macOS `panel`
  window, so it floats above other apps — full-screen ones included — and stays out of Mission
  Control, without stealing focus from whatever you were doing.
- **The corner grip zooms instead of dragging the window edge.** Pulling the bottom-right handle
  scales the panel and everything in it together (double-click resets it), because a frameless window
  that can be drag-resized is an ordinary window as far as macOS is concerned. The scale is
  remembered per gesture, not per frame.
- **The startup crash is fixed.** Badge rendering raced itself on a single hidden window, which could
  bring the whole app down with a segfault a second or two after launch.
- **A second launch focuses the first** instead of quietly starting a second copy of the webhook
  server, the agent runner and the tunnel.

## [0.4.2-2] — 2026-09-24

### Dashboard: one action to bring every down service back up

A dead runner or a dropped tunnel used to mean reading the service list and starting each one by
hand. The Dashboard now has **Restart all down (N)** above the detail panel — N is how many core
services are down, and the button is disabled at zero. It never touches a service that is already
up (including one started outside the dashboard) and leaves MCP servers alone, because the chat's
in-process client already owns a copy of each. The line beside it reports what started, what
failed, and what was skipped as not configured.

That also fixes something which would have made the button dangerous: the **Agent runner**, when
started from your own terminal, was reported as *stopped*. The dashboard now checks the runner's
pidfile, so it shows `running (external)` — and the button will not start a second runner to compete
for the same queue.

Two clicks in a row cannot start everything twice: while a bulk start is in flight the second
request is refused instead of acted on.

## [0.4.2-1] — 2026-09-24

### Key Manager: bind an identity to a licence, and test a login before handing the key over

`pkm` gained **claims** — an optional `email` and a scrypt password *verifier* signed into a seat's
certificate — and the Key Manager now surfaces the whole of it:

- **Claims panel.** Pick a seat and see its claim in both of the places it lives, side by side: the
  signed certificate (what an app enforces) and the ledger record (what the next resign reads). A row
  goes amber where the two disagree, and the badge names the drift — `in-sync`, `ledger-only`,
  `cert-only`, `mismatch` or `no-cert`.
- **Set, clear and resign from one form.** A blank field leaves that claim alone. **Apply + resign**
  re-signs the certificate, which *changes the licence string*, so the replacement arrives in the same
  display-once modal an issued key uses — hand it to the seat owner, because their old key still
  carries the old claims.
- **Reveal verifier** shows the stored verifier exactly as `pkm` holds it. Display-once: unlike a
  password, a verifier is offline-crackable by whoever has it.
- **Backfill emails** retro-fits a claim from each seat id, with a dry run that writes nothing.
- **Claims drift** and **Test credentials…** joined the Verify row — the first finds a certificate that
  no longer matches its ledger, the second runs the login check *offline*, so "will this email and
  password actually work?" is answered before the key is handed over. A revoked seat is refused before
  the signature is even examined.
- A password is passed to `pkm` on stdin, never on its command line, which `ps` can read.

### Groundwork for signing the desktop app in

The credentials core for gating the desktop app behind a sign-in is written and tested, but **not yet
wired to a screen** — a gitignored role registry with two tiers, an email/secret check that accepts
either a plaintext secret or a verifier minted by `pkm`, and a session with a wall-clock limit that is
re-checked at launch and never interrupts a running app. The app rename and the sign-in screen land
next, so nothing changes about how the app starts today.

## [0.4.1-2] — 2026-09-24

### The menu-bar panel is tabbed, resizable, and carries an uncleared count

The panel was four read-only pills and five priority rows in a fixed 340×440 window. It is now a small
console:

- **Three tabs** — Services, Queues and Notifications. **Queues** has Priority and Misc sub-tabs, and the
  **Notifications** tab lists the feed with a red count on the tab itself. The four status pills stay
  above the tabs, so "is the stack alive?" still needs no click.
- **Resizable**, and the size is remembered. Every list scrolls, so nothing is truncated at the old five
  rows any more.
- **A red count on the menu-bar icon** — the notifications recorded since you last pressed **Clear** in
  the Notifications tab, capped at `9+`. Opening the panel does *not* clear it: a badge that disappears
  the moment you glance at it cannot tell you there is something to deal with.

Two fixes came out of the restructure: the panel never linked the stylesheets its pills, buttons and
notification chips are actually defined in (the pills were rendering unstyled), and painting the health
pill deleted its own status dot on the first frame.

## [0.4.1-1] — 2026-09-24

### Filter rows, one source of truth for Trello ids, a crypto audit trail, a menu-bar endpoint, clearable script output

Five pieces of work, all operator-facing.

**1. The Queue and Notifications filter fields no longer stack in a column.**

Two bugs behind one symptom. The shared input rule is
`input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"])` — four
attribute selectors inside `:not()`, so specificity `(0,4,1)`. `.q-search` is `(0,1,0)`, and losing a
declaration only stops it applying when a competing rule sets the **same property**, so the shared
`width: 100%` kept winning and every field claimed a whole line of the wrapping `.panel__actions` row.
`width: auto` therefore cannot fix it; a non-auto `flex-basis` can, because a flex item's basis
overrides `width` for its main size. The second bug: a wrapping flex row's intrinsic width **does not
include its gaps**, so a content-sized `.panel__actions` came out exactly one gap-sum too narrow and
pushed the last control onto a second line — it now grows into the slack the header's `space-between`
was leaving unused. Fixes Queue, Notifications, Sessions, Config and the Logs filter row.

**2. Trello board and list ids have one source of truth.**

They were hand-maintained in three places: `safe/trello-boards.json` (read by a single user script),
`TRELLO_*` in `config.json`/`.env`, and the Netlify site env. `shared/trello-boards.mjs` is now the
reader for everyone, `scripts/trello-boards-sync.mjs` reports drift and can write both the local config
and the Netlify env, `GET /api/config` resolves the ids from the file (env fallback), the Config tab
shows what the file says with a **Use board map values** button, and the Trello MCP tools accept
`boardName`/`listName` — the agent used to guess raw ids because it had no way to look a board up.
`TRELLO_BOARD_ID` was the one key that had never been populated on any host; the webapp's Account view
now shows the board it is talking to.

**3. Frontdesk encryption and decryption are audited.**

They were not logged at all: every failure path returned a reason to the caller and dropped it, and the
HTTP middleware logs at `debug`, which `LOG_LEVEL=info` filters out — so a failed sign-in left no trace
in any file. Every licence verify, envelope decrypt, reply encrypt, degraded `[fd1]` verify and rejected
session now writes to `logs/frontdesk/crypto/YYYY-MM-DD.jsonl` and to `logs/live` as a `frontdesk/crypto`
line (success `info`, auth rejection `warn`, decrypt/encrypt failure `error`), and failures raise a
notification — throttled, because the licence route is public. Rows never carry keys or message text.
This is also what makes a reply that could not be encrypted visible instead of silent.

**4. `GET /api/menubar`, and a written answer on a Swift menu-bar app.**

One read-only, operator-token-gated snapshot of what the backend can answer about itself: services
(webhook / runner / tunnel), queue counts and a sanitized one-line preview per item — never message
bodies — plus the sanitizer state and both versions. `scripts/pkm-status.mjs` covers the key-store pill,
which is not backend state. The accompanying study records why the panel is easy in AppKit and the data
is not; the short version is that Electron also owns the service lifecycle, so a native client is a
read-only companion for now.

**5. Scripts-tab output can be cleared.**

Each script card has a **Clear** button that empties that card's output pane (other cards keep theirs)
and is disabled while the pane is empty. It clears the renderer buffer only — the durable record is
`logs/live/` and the notification feed.

## [0.3.2-7] — 2026-09-24

### Documentation catch-up for the tray panel, the MCP client and the Google token

A docs pass over the four entries below, plus the older statements they sat next to.

- **"All MCP servers autostart" was no longer true.** Corrected in `copilot-instructions.md`,
  `docs/safe/frontdesk-v2-operator.md` and `docs/safe/backend-setup.md`: the app autostarts the
  webhook server, the agent runner and the tunnel only. `OPERATOR_AUTOSTART_MCP=true` is what
  restores MCP autostart, and `OPERATOR_AUTOSTART=false` skips the backend entirely.
- **The Electron docs did not mention the menu-bar at all.** `docs/electron.md` and the internal
  copy now record the panel (left-click vs right-click), that closing the window hides it, the
  panel's own document (`tray.html` + `tray.js` + `styles/tray.css`) and the two new main-process
  modules (`mcp-client.mjs`, `mcp-policy.mjs`).
- **Two sidebar rows were wrong.** The 🧰 Tools row now lists the WhatsApp and Netlify quick
  actions, and the 📜 Scripts tab — which had no row in either Electron doc — is documented.
- **`npm run check:wiring` is documented.** `scripts/check-pkm-wiring.mjs` (preload ↔
  `ipcMain.handle` parity, every `pkm:*` channel present in both IPCs docs, every `data-pkm-write`
  naming a real gated command, no unreferenced preload method) joins the renderer check in the
  source map and the conventions list.
- The root `README.md` gained the components and capabilities it had never listed
  (`mcp/photos/`, `mcp/sheets/`, `mcp/web-search/`, `electron/`, plus Tasks/Sheets/Photos and the
  operator dashboard), its OAuth step now names the real scope set, and `electron/docs/about.md`
  lists the guides that actually exist (Usage and WhatsApp were missing from it).

## [0.3.2-6] — 2026-09-24

### Google tokens: a Connect button, the missing scopes, and a store that actually wins

Three things made a stale Google token hard to fix from the app.

- **⚙️ Config → Connect Google** remints the **operator** refresh token in place — the token every
  MCP server and the 💬 Chat tab run on. Consent opens in the browser; the new token is saved, the
  MCP connections are dropped and the runner/webhook are restarted, so nothing keeps serving the
  old one. The only in-app Google button until now was on the Accounts tab, and it binds a *seat*,
  not the operator, so "reconnect Google" there never changed what the Chat tab could reach.
- **Tasks and calendar-list access were never requested.** The token asked for `calendar.events` /
  `calendar.events.readonly`, which do not cover `CalendarList.list`, and nothing in the Calendar
  API implies Tasks. `calendar_list_calendars` and `calendar_list_tasks` therefore answered 403
  "Insufficient Permission" with no way to fix it from the app. Both scopes are now requested — one
  consent fixes them.
- **The CLI was writing to a file that could never win.** `config.json` is primary and `.env` only
  supplies keys it omits, and this repo's `config.json` defines `GMAIL_REFRESH_TOKEN`. So
  `npm run setup:gmail-auth` updated `.env`, changed nothing, and reported success. Both the CLI
  and the new button now write whichever store wins, back it up first and say which one they used.

The CLI, the dashboard button and the per-seat flow now share one scope definition
(`shared/google-scopes.mjs`), so they cannot drift into minting tokens with different capabilities.

## [0.3.2-5] — 2026-09-24

### The operator chat speaks MCP, and Netlify joins the app

The Chat tab could reach Trello, Gmail, Web Search and WhatsApp — nothing else. Tool calls ran
through the agent runner's in-process executor, so every new server meant a third copy of its REST
logic. Both problems are gone.

- **An in-process MCP client** (`electron/src/main/mcp-client.mjs`) gives the operator chat every
  configured MCP server: Trello, Gmail, **Drive, Calendar, Sheets**, Web Search, WhatsApp and
  **Netlify**. A server is spawned as a stdio child the first time one of its tools is called, then
  reused until it exits or goes idle. The advertised tool list still comes from
  `shared/tool-manifest.js` — listing tools costs no processes.
- **Read vs approve moved into `electron/src/main/mcp-policy.mjs`** and is fail-closed: anything not
  listed as read-only raises the Approve/Deny card. `drive_delete_file` and `drive_move_file`, which
  the autonomous runner refuses outright, are now available to the operator behind a card.
- **Photos is deliberately excluded** — picker-only, needs a human to open a URI, and its download
  tool writes to a caller-chosen directory. So is `frontdesk_reply`, which belongs to the frontdesk
  channel.
- **Netlify is a managed service**: `mcp:netlify` appears on the Dashboard, and Tools gains a
  **Netlify** panel (Sites / Env vars / Deploys) that runs through the MCP client.
- Netlify's 12 tool schemas moved out of `mcp/netlify/index.js` into `shared/tool-manifest.js`, so
  the server, the Tools-tab manifest and the chat's advertised tools cannot drift.
- The MCP servers are **no longer autostarted** — the chat's client owns its own children, and
  starting both would leave two processes per server. `OPERATOR_AUTOSTART_MCP=true` restores the old
  behaviour; `MCP_CLIENT_IDLE_MS` (default 10 minutes) controls how long an idle child is kept.

## [0.3.2-4] — 2026-09-24

### The menu-bar item opens a panel, not just a menu

Answering "is the stack actually alive?" meant opening the dashboard. The menu-bar icon now opens a panel
instead, carrying the same four values as the status bar — webhook health, services running, unactioned
priority items, key store — plus the five most recent priority items, each with its queue number, source and
arrival time. **Open dashboard** sits at the bottom, and the health pill opens it too.

The menu itself is unchanged, it has just moved: **left**-click is the panel, **right**-click is the menu
(Open dashboard / Start webhook server / Start agent runner / Quit). That split is not cosmetic — on macOS a
menu-bar item that owns a context menu hands every left-click to that menu, so a panel and a menu cannot both
live on the left button.

The panel is 340×440, positioned under its icon and clamped to the screen so a crowded menu bar cannot push
it off the edge. Escape, clicking elsewhere, or opening the dashboard all dismiss it. It is not resizable, and
it never appears in the window list you cycle through with Cmd+`.

### Closing the dashboard window left the tray item pointing at nothing

Closing the window destroyed it, and every route back then failed **silently**: the tray item checked for a
window that no longer existed and did nothing, and the dock icon did nothing because the "no windows open"
case was only handled at startup. Closing now hides the window instead, and all four ways back in — the
menu-bar panel, the right-click menu, the dock icon, a queue notification — go through one path that rebuilds
the window when it is gone, un-minimises it when it is not, and takes focus. That last part is what makes it
feel right: a menu-bar click does not activate an application on macOS, so without it the window came back
behind whatever you were using.

Closing the window still leaves the stack running, as before — quit from the menu or the sidebar.

## [0.3.2-3] — 2026-09-24

### Key Manager: it declines in advance, and it can answer "will this key log in?"

The Key Manager drives a separate key store that owns every licence, key ring and revocation record; this
console is a client of it. This work was already in the app — it shipped alongside the entries below — but was
never written up, so it is recorded here, together with the one action that was missing.

**It refuses rather than half-working.** Every action the console can take is declared up front, and the key
store is asked whether it can support each one *before* anything runs. When it cannot — the store's CLI is
missing or not answering, the registry has no master ring yet, or the revocation list cannot be read — the
affected controls are disabled and say why, and the request is refused even if it is attempted anyway. A
control is unavailable for its own reason rather than the whole tab going read-only.

**Per-seat detail**, so one seat's key id, expiry, issue date and remaining days can be read without opening
the ledger file.

**A Verify row** for the questions that matter when issuing a licence: does this key actually complete a login
(not merely carry a valid signature), do the encryption keys really round-trip, is a revoked seat still refused
and do the apps that embed the revocation list agree with it, are the key files readable by anyone but you, and
does the exported bundle still match its signature. These checks stay available whenever the store can be
reached at all — a store you cannot change is still one you can interrogate.

**Export bundle.** The bundle a companion app reads was being generated but could not be produced from the
console at all. It can now, next to the other store actions, and it reports where it wrote and which key
signed it. Running the bundle check afterwards confirms the two agree.

## [0.3.2-2] — 2026-09-24

### A notification centre for the operator console

Everything worth knowing was either transient — a message that faded after four seconds — or invisible
unless you happened to be looking at the right panel. A service that stopped in the small hours, a script
that failed, a collaborator who signed in, an error in the background: none of them left a lasting trace.

There is now a **Notifications** item in the sidebar listing everything that has happened, newest first.
Columns sort on click, the list searches and filters by source and level, entries are grouped by day in
sections you can collapse, and clicking one shows the detail behind it.

A red dot appears on the sidebar item a notification belongs to — Queue for a new chat message, Logs for
an error, Chat for a reply or a reply that failed, Dashboard for a service that stopped unexpectedly,
Sessions for a sign-in, Scripts for a run that finished or failed. Opening a tab marks its own
notifications as seen; opening the notification list clears every dot.

Stopping a service or a script yourself is never reported as a failure, and sign-outs are not reported at
all — the feed is for things you would want to have been told about.

Notifications are stored in the log folder, one file per day with the "seen" marks beside them, so they
survive a restart. Old files are removed after 30 days by default. That, and a master on/off switch, are
both in the Config tab.

## [0.3.2-1] — 2026-09-24

### Frontdesk chat: answers that never arrived, and one that arrived four times

A single day of logs revealed four separate faults behind a chat that looked silent from the outside.

**Replies were addressed to a seat that does not exist.** The agent was asked for a reply "seat" it
had no way to know, guessed one, and the reply was refused — so the question was never answered. That
parameter no longer exists: the seat comes from the licence the message arrived with, and it is now the
only thing that can decide it.

**The same message could be answered repeatedly while newer ones waited.** Two parts of the system
kept their own copy of the message queue, and one of them rewrote the other's work — so events that had
already been handled came back to life, and because the queue is served oldest-first, new messages sat
behind them. The two now agree on what has been handled, and one wake-up drains the backlog instead of
handling a single item.

**A question that needed a lookup got no answer at all.** Asking for the latest email made the agent
read your inbox and then stop — the result was never passed back to it, so nothing was ever sent. The
agent now takes another turn with what it read and is expected to finish with an answer.

**Failures were silent.** A reply that failed was marked done and forgotten. Failures now get a second
attempt, the user gets a short apology rather than silence, and anything still failing is recorded for
the operator instead of disappearing.

New settings, both optional: `AGENT_RUNNER_MAX_ROUNDS` (default 5) bounds how many steps one chat
question may take, and `AGENT_MAX_ITEMS_PER_PASS` (default 10) bounds how much of a backlog one wake-up
drains.

If the operator console is open, restart the agent runner from the Dashboard — it is a long-lived
process and does not pick up code changes on its own.

## [0.3.1-2] — 2026-09-24

### The app was called "Electron" in the dock

In development the process runs out of Electron's own bundle, so the dock tooltip, the bold
application menu and the About panel all read "Electron", under Electron's icon. `productName` in
`package.json` is only honoured when packaging, and `app.setName()` does not affect the name the OS
uses, so neither half of the identity was actually applied.

Both are now set for dev *and* packaged builds, and the About panel reports the same name the OS
shows. The tray icon was a 1×1 transparent placeholder — the menu-bar item was invisible — and is now
a real macOS template image.

The icon is generated rather than drawn: it rasterises a glyph from the interface's own icon set onto
the standard macOS rounded plate, so the app icon cannot drift away from the icons inside the app.
Regenerate it with `npm --prefix electron run make:icon`.

### The accent-colour swatches were invisible, and two modals were unstyled

The renderer's Content-Security-Policy sets `style-src 'self'` with no `'unsafe-inline'`, which
silently drops inline `style="…"` attributes. Twenty-two of them were load-bearing: every accent
swatch drew its own colour that way, and both modal overlays got their fixed positioning that way.
The swatches rendered as identical blank circles and the modals rendered inline in the page flow.

Every inline style is gone. Swatch colours come from `data-*` attribute selectors, and theme tokens
are written through the CSSOM — which means the stricter policy is kept rather than relaxed to
`'unsafe-inline'` to accommodate them.

### The dashboard restyle

The single 1,876-line stylesheet is now a design system split across 21 files, with the palette, type
scale and radii as tokens. Dark is the default and light is a full second palette.

Also in this pass: sidebar navigation uses inline SVG icons instead of emoji; a status bar carries
health, service-count and queue-count pills; toasts stack, so a second message can no longer silently
replace one you have not read; the sidebar is resizable; and a failure in one startup step no longer
skips the steps after it.

### The collaborator webapp matches the operator console

It now uses the same token names and palette as the desktop app, so the two read as one product.
Roughly 29% of its stylesheet styled elements that do not exist anywhere in the markup; that is
deleted, and the placeholder colour values and hand-mixed translucent tints became tokens and
`color-mix()`. The page stays entirely self-contained — no webfont, no images, no third-party
request.

### The hosted web frontdesk could not reach its backend

The public copy of the collaborator webapp asks its own host for the runtime settings it needs in order
to find the backend. That request went to a path only the local backend serves, so on the hosted site it
returned a 404: the app kept an empty backend address and the login card reported "No backend
configured", even though the site's own settings were present and correct.

The hosted copy now obtains its settings the same way the local one does, and it falls back to the
function path if that route is ever missing — so the login card reports the backend as connected.

## [0.3.1-1] — 2026-09-23

### A frontdesk reply could be addressed to a seat that does not exist

The agent runner's reply tool took the recipient's seat from the model's own output — but the model
was never shown that id, so it had to invent one. It invented the name of the event's *source*
(`frontdesk`) rather than a real seat, the backend correctly refused it, and the reply was lost. The
failure surfaced as an API error, which made it look like a backend fault rather than a bad argument.

The seat now comes from the event itself, where the licence-verified identity already lives, and the
model is no longer asked for it at all. A model-supplied id can no longer choose which collaborator a
reply is encrypted for; when the two disagree the event wins, and the override is logged.

## [0.2.10-4] — 2026-09-23

### Config tab gains a GitHub backup section, and imported values stop being polluted

`config.json` and `.env` are separate files with a per-key precedence rule, and values imported
from `.env` had arrived with their trailing comments glued on — so the OpenAI and Anthropic API
keys were stored as `sk-… # for LLM_PROVIDER=…`, which cannot authenticate, and the log level read
`info           # debug|info|warn|error`. The `.env` parser now ends an unquoted value at a
whitespace-preceded `#`, the five affected values in `config.json` were cleaned, and the keys
missing from it (the GitHub backup trio) were added.

The ⚙️ Config tab also gains a **GitHub backup** section — token (masked, with the reveal toggle),
user/org, and repo allowlist — so the repository backup script can be configured from the UI
together with everything else, instead of only by hand-editing `.env`.

## [0.2.10-3] — 2026-09-23

### The web chat now explains itself

The frontdesk webapp explained exactly one thing — how to log in — so a collaborator had no in-app
answer to "what am I allowed to ask this for?". It now carries a third tab, **📖 How to use**, which
states in plain terms how to send and receive messages, that replies are not instant, what the agent
can look up versus what it will not change, what the Account tab's Google/Trello rows mean, and what
to do when a session ends or the connection drops. It is static markup and issues no requests, so it
cannot expose one seat's activity to another.

Tab switching was hard-wired for exactly two tabs, so a third could not be expressed at all; it is
now a table plus a single handler, and a fourth tab is a one-line change.

### Docs

- New `docs/safe/web-frontdesk-use.md` — the collaborator-facing guide the new tab mirrors: logging in,
  the session countdown, sending/receiving, what the agent can and cannot be asked to do, the Account
  tab, and a symptom → action troubleshooting table. It deliberately carries no file paths, environment
  variables, ports or internal names, so it can be handed to a seat as-is.
- `docs/safe/frontdesk-quickstart.md` and `docs/safe/frontdesk-v2-operator.md` link it, and the operator
  runbook's "no Status tab in the webapp" note now records that the new tab is static.

## [0.2.10-2] — 2026-09-23

### Frontdesk: two reachable routes closed, and a silent failure made loud

The web frontdesk chat is licence-authenticated with end-to-end encryption, but two of its routes
were trusting the wrong thing:

- **The internal reply route was publicly reachable.** `/api/frontdesk/reply` — where the agent posts
  an encrypted answer back to a seat — was covered by a broad public-path prefix, so its only guard
  was a check that was skipped entirely when `WEBHOOK_API_TOKEN` was unset. Anyone able to reach the
  hostname could then inject text into a seat's outbox. It now goes through the standard token guard,
  which fails closed (503) when no token is configured.
- **The session-log route accepted unauthenticated writes.** It took a bare `user` field as a
  fallback, so login/logout rows could be appended without a session. It now requires one, and the
  identity always comes from the session rather than the request body.
- **An expired session no longer hides.** Sessions live in memory, so a backend restart logs everyone
  out. The webapp used to keep reporting "online" while quietly diverting every message into the
  offline outbox, where a dead token meant it could never be delivered. It now explains the expiry and
  returns the user to the login screen.
- `GET /health` reports whether the prompt-injection sanitizer is actually active, so a deployment
  missing its private sanitizer file is visible instead of silently unfiltered.

### Web search: one implementation instead of two

The Electron chat's `web_search`/`web_fetch` and the web-search MCP server now share a single
implementation, so they cannot disagree: snippets decode HTML entities properly (`&#x27;` used to
appear literally), a change in the search page's markup can no longer silently return zero results,
and both paths refuse loopback/private hosts so a model-chosen URL cannot read the local backend.

### Netlify env tooling fixed, and the chat now reports its connection status

- **The Netlify MCP's environment-variable tools were broken** — they called `/sites/{id}/env`, which
  does not exist, so listing or setting a site variable failed with a 404. They now use the real
  contract (account-scoped path with `site_id`, one value per deploy context), discover the account
  from the site so only `NETLIFY_SITE_ID` is needed, and read a variable before writing it so
  `is_secret`, the scopes and any context you did not name are preserved.
- **The web chat now shows whether it can actually reach the backend.** The login card carries a live
  status line naming the host it will call, and it tells "backend unreachable" apart from "no backend
  configured on this host" — the misconfiguration that previously surfaced only as a generic "Cannot
  reach the server". After login the same probe drives the online/offline badge, the backend host in
  the header, and a Backend row on the Account tab; it also warns when the injection sanitizer is off.

### Sanitization hardening

Prompt-injection filtering now happens at the *sources* as well as the callers: tool results are
sanitized where they are produced, prompt construction flattens and sanitizes each value it
interpolates, and the log sinks sanitize on the way to disk (the live log is rendered by the desktop
app, and one of its fields was built from request data). The deliberately-raw webhook forensic dumps
are unchanged and now documented as never-replay.

### Docs

- New `docs/safe/frontdesk-quickstart.md` — issue a seat, run the backend, host the webapp, and verify
  the encrypted round trip end to end.
- Frontdesk documentation brought up to date with the licence + E2E flow; the older HMAC and passphrase
  flow is now labelled as the legacy Trello mirror it is.

### Every user script now has a UI form, plus Trello/GitHub backup and disk cleanup

The 📜 Scripts tab is the app's manual script runner. Every script under `scripts/user/` now has a
generated form, and three tools that previously lived only in other repos were brought in.

- **New cards.** `trello-backup.mjs` — a complete JSON snapshot of every board (one file per board
  plus a manifest index), using the Trello credentials already configured. `github_backup.py` —
  mirrors each repo, exports a readable code snapshot and writes issues/pulls/releases metadata;
  Python standard library only. Plus the eight disk-cleanup scripts behind `master_cleanup.sh`,
  each with its own card.
- **Forms for the last two hold-outs.** `gmail-clear-labelled-updates.mjs` exposes its dry-run,
  label, account, rollback-manifest and restore options; `convert-xlsx-to-sheet.mjs` gained `--name`
  and `--dry-run` so it can target a file without editing the source. The daily rollover card gained
  the board-id / list-id overrides.
- **Bug fix.** `convert-xlsx-to-sheet.mjs` crashed on launch with
  `ENOENT … scripts/user/.env` — it read a hard-coded `../.env` that had been wrong since the script
  moved into `scripts/user/safe/`. It now loads configuration the same way every other script does.
- **Safety.** Every destructive card ships with `--dry-run` pre-checked, so a real delete is two
  deliberate actions. The cleanup master no longer skips a subscript just because a copy lost its
  executable bit — it falls back to `bash <script>`.
- **Docs.** `electron/docs/scripts.md` now covers the two scanned folders (flat, no subfolders), the
  dry-run defaults, the no-stdin caveat, and the rollover script's output contract.

The new scripts live in `scripts/user/safe/`, which is gitignored — the same folder as the existing
personal tools — so nothing here adds third-party or credentialed code to the repo.

## [0.2.10-1] — 2026-09-22

### Gmail setup can now manage filters, and credential backups can't be committed

- **Gmail filter support.** The Google consent scope was widened so the account can create and manage
  Gmail filters — the auto-label rules that file mail and skip the inbox — on top of the existing read
  and send access.
- **Re-running the Google setup is now safe.** It forces a fresh consent screen and refuses to save an
  empty credential, so an interrupted or failed setup can no longer overwrite working credentials. The
  refreshed credential is saved automatically with the previous one backed up first, instead of being
  printed out for manual copy-paste.
- **Credential backups are ignored by git.** The ignore rule previously matched only the exact
  environment file, so the automatic timestamped backups could have been committed. Those backups
  contain live credentials.

## [0.2.9-1] — 2026-09-19

### DS-mon: a bad push token now pauses tracking instead of retrying forever

DS-mon's sync server was hardened: it now requires the bearer token on **every** route and fails closed
without one. That turned a `401` from a transient blip into a **permanent** condition, while the tracker
still treated every non-2xx as retryable:

- **`401`/`403` is now classified as permanent** (`shared/usage-tracker.mjs`). Tracking pauses after a
  single rejection: the 60 s fast retry is not re-armed, no new records are buffered, and every buffered
  record is retained untouched. A corrected `DSMON_PUSH_TOKEN` clears the pause and replays the backlog
  on the next timer tick — the periodic timer deliberately stays armed for that reason.
- This removes the misleading `Buffer exceeds … dropping record (host unreachable?)` death spiral, which
  is exactly how an auth misconfiguration used to look like a network outage while silently discarding
  usage data.
- `getDsmonStatus()` reports `paused` + `reason`, so the 📈 Usage tab renders a distinct
  `⏸️ paused: unauthorized` tag instead of the transient "push failed" one, and **Flush now** reports the
  real outcome (200 / token problem / network) rather than a blanket success.
- Tracking now refuses to start when `USAGE_TRACKING_ENABLED=true` and a push URL is set but
  `DSMON_PUSH_TOKEN` is empty — the same fail-closed posture DS-mon takes itself.

### 🔒 Webhook server: auth now fails closed

`requireAuth` called `next()` when `WEBHOOK_API_TOKEN` was unset, which left the entire queue-admin
surface open to anyone who could reach the port — reading the event queues, clearing them (including a
whole-queue wipe), and reading the task list and tool-dispatch rules. The Cloudflare tunnel publishes
that port to the internet, so this was reachable, not hypothetical.

Those routes now answer **503** when no token is configured, and the reason is logged once at startup
instead of being retried per request. The intentionally-public paths (health check, webhook callbacks,
the frontdesk/licence/session/OAuth endpoints and the static webapp) are unchanged.
`WEBHOOK_API_TOKEN` is now documented as required wherever the webhook environment is described.

### Docs

- `electron/docs/usage.md` — the push token is required; a `401` is a configuration error, not an
  outage; added the paused state and its troubleshooting entries.
- `electron/docs/config.md`, `docs/electron.md` — the push contract and the token requirement.

## [0.2.8-4] — 2026-09-11

### Key Manager — every registry and every ring (Electron)

- The tab is no longer hardwired to one registry. A **registry picker** at the top of the 🔑 Key Manager
tab scopes every call, so every registry in the key store is managed from the same UI. The line beside it
summarises the selected registry's app id, signing engine, ring/seat/revocation counts, and whether it
reads its revocation blocklist **live** or **embeds** it in its own source files.
- **Ring management added** (previously CLI-only): the rings table lists every master key with its
  default/retired state, and **＋ New ring**, **Retire**, **Make default** and **🔑 Agent key**
  (X25519 peer keypair, `ed25519+x25519` registries only) are now buttons.
- **🔄 Sync blocklist** rewrites the blocklist embedded in a registry's consumer-app source files
  (e.g. `transcription-agent` → `electron/src/main/license.ts`, `python-backend/license.py`) and
  tells you to rebuild. A revoke for an embedding registry now also warns in the UI that the sync +
  rebuild is still outstanding.
- The picker line states how each registry reaches its blocklist — *read live* vs *embedded*.

### Key Manager — loading fixed (it could hang forever)

The tab could sit on `checking…` / `loading…` indefinitely with no error. Four compounding causes,
all fixed:

- **Wrong spawn target.** `key-manager.mjs` ran `spawn(process.execPath, …)` — inside Electron that
  is the **Electron binary**, not node, so `pkm.mjs` was opened as a desktop app that never exited.
  It now runs the CLI as Node (`ELECTRON_RUN_AS_NODE=1`), with `PKM_NODE` as an override.
- **No timeout.** A hung CLI deadlocked the serialised command queue forever. Every `pkm` run is now
  hard-bounded by `PKM_TIMEOUT_MS` (default 20s) and killed (SIGTERM → SIGKILL), reporting
  `pkm <cmd> timed out after Ns and was killed`.
- **No error path in the renderer.** `refreshLicenses()` awaited IPC with no `try/catch`, so a
  rejection left the initial placeholder text on screen. Loaders are now guarded and paint a
  Retry-able error box; a global `unhandledrejection` handler rescues any panel still showing
  `loading…`/`checking…` and drops the overlay.

### Paths are config, not code

- Key-store locations are now **config-driven** (`PKM_REPO`, `PKM_ROOT`, `PKM_REGISTRY`, `PKM_BIN`,
  and the command timeout) instead of being hardcoded, and the Key Manager picks up a change without a
  restart. A single shared resolver reads the store's own registry index, so a registry whose directory
  differs from its id resolves correctly.

### Loading overlays everywhere (Electron UI)

Ported the `ai_transcription_agent` pattern:

- **Blocking overlay** (`#loading-overlay`) with a spinner, a contextual message, an optional
  progress bar, a slow-operation hint after 8s, and an optional Cancel — wired into service
  start/stop/**restart**, webhook re-register, every `pkm` mutation, licence validation, config
  save/export/import, seat account connect/set/spawn/stop, usage flush, and the Trello/Gmail/
  WhatsApp quick actions.
- **Inline skeletons** (`.loading-block`) and **Retry-able error boxes** (`.panel-error`) for panel
  and tab fetches, plus a focused transient notice (`#toast`) for results that used to be `alert()`.

### Docs

- `docs/ipcs.md` — the 15 registry-aware `pkm:*` channels and their payloads.
- `electron/README.md`, `electron/docs/keys.md` — registry picker, rings, sync blocklist, corrected
  Refresh semantics, and where every path comes from.

## [0.2.8-3] — 2026-09-11

### Licensing — management moved out of this repo

- Key **management** (rings, seat ledger, revocation blocklist, audit) now lives in a separate local
  key-store repo driven by its `pkm` CLI — one source of truth, shared with the other app that issues
  licences. This repo keeps only a **read-only verifier**.
- **🔑 Licenses became 🔑 Key Manager** — issue / revoke / unrevoke / validate / archive-expired / audit,
  driven entirely through the CLI. Issued licences are **display-once** (a modal with Copy that clears on
  close); the app never stores or logs them.
- The in-repo key store and its management scripts were **removed**, along with the matching npm scripts;
  where the store lives is now configured in ⚙️ Config instead of being hardcoded.
- `electron/docs/licenses.md` → [`electron/docs/keys.md`](../electron/docs/keys.md).

## [0.2.8-2] — 2026-09-10

### Operator chat — DeepSeek 400 fixed

- Continued operator conversations no longer abort with a DeepSeek `400`: *the `reasoning_content`
  in the thinking mode must be passed back to the API*. Once a tool-using conversation continues,
  DeepSeek needs the reasoning trail replayed on every assistant turn — including turns where the
  model produced no chain-of-thought, and history written by earlier builds. Both are now handled,
  so affected chats recover on their own instead of wedging (no need to clear the session).

## [0.2.8-1] — 2026-09-10

### Electron UI — layout

- **Chat tab** — the panel, session list, transcript and composer now fill the full tab height
  (the fixed `52vh`/`48vh`/`42vh` caps are gone).
- **Logs tab** — the panel plus the **Live** log box and the **Files** list/viewer fill the tab;
  the log box and file preview grow with the window instead of stopping at `55vh`/`50vh`.
- **Dashboard** — service tabs moved into a **collapsible sidebar** with per-service status dots
  (collapse state remembered per machine), the operator-only note now sits **above** the detail
  panel, and the sidebar + detail + log tail fill the tab.

### Electron UI — Appearance (accent + font size)

- New **accent color** control: nine presets (including *Theme default*) plus a custom color picker;
  drives `--accent` (buttons, active tabs, chat bubbles, highlights).
- New **font size** control: five presets (Small → XX-L) that scale the whole UI via a `--fs-scale`
  root font size.
- New config keys `APPEARANCE_ACCENT_COLOR` (blank = theme default) and `APPEARANCE_FONT_SIZE`,
  both also editable in ⚙️ Config → Appearance. New IPC `app:setAppearance`.

### Operator chat — tool-step budget

- `OPERATOR_CHAT_MAX_ROUNDS` (default **24**, clamped 1–100) replaces the hard-coded 8-step cap;
  editable in ⚙️ Config → Chat next to `OPERATOR_CHAT_TOOLS`.
- Hitting the cap no longer dead-ends: the agent gets one final **tool-free wrap-up** call and
  answers with what it has (stating what's unfinished). If that fails, the sentinel reply is used
  and the Chat tab shows a **▶ Continue** button — history is persisted, so continuing resumes with
  full context. `chat:send` also returns `maxSteps: true` in that case.

### Docs

- Updated `electron/docs/appearance.md`, `chat.md`, `dashboard.md`, `logs.md` and the guide index;
  refreshed `docs/electron.md` (UI table + operator chat) and `docs/ipcs.md` (`app:setAppearance`).

## [0.2.7-1] — 2026-09-09

### Config: config.json + merge-on-save

- **`config.json` created from `.env`** — `npm run config:init` (`scripts/config-from-env.mjs`)
  mirrors every `.env` key into a repo-root `config.json` (merge-safe; `.env` is left in place as
  the fallback). A `config.json` is now present, so the ⚙️ Config tab shows `✅ config.json present`.
- **Saving merges instead of overwriting** — `config:save` now merges the changed keys into
  `config.json` (new `config-loader.mergeConfig()`), so editing one field no longer wipes the rest
  of the file. Empty fields are dropped (revert to `.env`/default), mirroring `ai_transcription_agent`.
- **Usage-tracking keys restart the spawned services** — saving any `USAGE_TRACKING_*` / `DSMON_*`
  key now restarts the runner + webhook children so `shared/usage-tracker.mjs` picks up the change.

### Usage tracking (DS-mon) in config + UI

- New **Usage tracking** section in the ⚙️ Config tab: enable toggle, DS-mon push URL / token /
  interval / instance ID, optional AES-256 encryption key (+ key ID), and credit poll interval.
- New **📈 Usage** sidebar tab: DS-mon push status (enabled, buffer size, last push, instance ID),
  a provider-aware DeepSeek credit-balance card, and per-LLM-call token totals broken down by
  provider, source (flow) and model — read from `logs/dsmon_buffer.jsonl`. Includes a **Flush now**
  action and a persisted poll-interval selector.
- New IPC: `usage:aggregate`, `usage:credits`, `usage:flush`. New config key `CREDIT_POLL_INTERVAL`
  (default 60000).

### Docs

- New `electron/docs/usage.md`; `electron/docs/config.md` and the guide index updated.

## [0.2.6-1] — 2026-09-09

### WhatsApp (Meta Cloud API) MCP integration

- New `mcp/whatsapp/` MCP server (stdio) exposing `whatsapp_status`, `whatsapp_list_numbers`,
  `whatsapp_list_messages`, `whatsapp_send_text`, `whatsapp_send_template`, `whatsapp_mark_read`.
- Tool schemas added to `shared/tool-manifest.js` (`whatsappTools` appended to `allTools`).
- The shared tool executor now runs the WhatsApp tools; the Electron operator chat advertises
  them (reads auto-run, sends ask for operator approval).
- Electron UI: new WhatsApp Config section, a Tools manifest group with Status/Numbers quick
  actions, an MCP dashboard service card showing the active number/connection, and a new in-app
  WhatsApp guide covering both number setups (free Meta test number and real burner number).
- Inbound webhook route receives and sanitizes incoming WhatsApp messages, logs them, and adds
  them to the notification queue for agent processing.
- Version 0.2.6.

## [0.2.5-2] — 2026-09-09

### Electron dashboard

- Services started outside the dashboard (for example the webhook server run as a background
  daemon) are now correctly shown as **running (external)** instead of appearing stopped.
- External services can't be controlled from the dashboard, so their **Start / Restart / Stop**
  buttons are disabled; the webhook card switches to a **Re-register webhooks** action that updates
  the registration scripts without trying to restart a server the dashboard doesn't own.

### Seats & accounts vs the operator dashboard (clarity)

- Made explicit that the dashboard is **operator-only**: it lists every seat license and per-seat
  Google/Trello account binding at once. Seat licenses and bindings belong to the **public chat
  webapp** (collaborator login + which accounts the agent uses for that seat).
- Collaborators (seats) never see this app — each only uses their own webapp chat. This is now
  stated on the 📊 Dashboard, 🔑 Licenses, 👥 Sessions, 🔐 Accounts & Keys and ℹ️ About views and in
  the matching in-app guide pages.

## [0.2.5-1] — 2026-09-08

### Webhook server reliability

- The webhook server no longer drops offline when webhooks fire. Background auto-restart can no
  longer trigger on its own, and a single failing Trello/Gmail/Drive push can no longer crash the
  whole server — errors are logged and it keeps running.
- Calendar + Drive push handling fixed so stale sync tokens / an invalid field selection no
  longer make pushes silently report “0 files”.
- Logs always go to the repo `logs/` folder no matter where the server is started from.

### Electron dashboard

- **Dashboard**: every service card has a **Restart** button; the webhook service also has
  **Restart & re-register webhooks** (re-runs the Trello/Gmail/Calendar/Drive registration
  scripts and restarts the server, with per-step ✅/❌ results).
- **Logs tab**: browse a specific day’s logs, or switch back to live.
- **Queues**: clear an entire queue in one click.
- **Chat**: longer conversations now stay correct with DeepSeek’s “thinking” replies
  (reasoning is threaded through continued turns).

### Version

- App version bumped to 0.2.5.

## [0.2.4-3] — 2026-09-07

### Added

- **Scripts tab forms** — put a `<script>.params.json` next to a script and its card becomes a typed
  form (text, number, checkbox, dropdown, file picker with a Browse button). Scripts without one keep
  the plain raw-args box.
- **Agentic operator Chat** — operator chats can now chain tools to actually get things done. Read-only
  calls (Trello/Gmail reads, web search, plus local reads like today's task list and the pending
  queues) run automatically; anything that changes state shows an **Approve / Deny** card (with
  editable parameters) before it runs, and you can **Stop** at any time. Results from outside sources
  are sanitized before the model sees them.
- Chat stays read-only Q&A on the **frontdesk** channel and stays plain Q&A entirely if you set
  `OPERATOR_CHAT_TOOLS=false`.

## [0.2.4-2] — 2026-09-06

### Internal

- Private operator helper scripts were removed from the public repository. Local tooling — the
  `keys:*` npm commands and the Electron Scripts tab — now finds them in their private location
  automatically.

## [0.2.4-1] — 2026-09-03

### Added

- **Google Photos Picker MCP server** — pick a few photos straight from your library in your browser
  and save them locally via the new `photos_picker_*` tools (start / poll / list / download / delete).
  Picker-only by design: Google no longer lets third-party apps read a whole photo library, only what
  you explicitly select.

### Version

- Root + `electron/package.json` bumped `0.2.3` → `0.2.4`.

## [0.2.3-1] — 2026-09-03

### Added

- **Netlify MCP server** — manage the frontdesk Netlify site (sites, environment variables, deploys)
  via `netlify_*` tools, available to the operator in VS Code.
- **Electron Guide tab** — browse the included end-user documentation right inside the app (About →
  Guide).
- **Live LLM provider switching** — provider/model are read live from settings, so ⚙️ Config changes
  apply to the Chat tab and the agent stack immediately; saving a provider key restarts the
  runner/webhook automatically.

### Docs

- Refreshed `README.md` and `electron.md` (LLM providers, Netlify MCP server).

## [0.2.2-1] — 2026-08-29

### Added

- **Chat tab** in the Electron dashboard — chat directly with the configured LLM from the app; each
  conversation is saved to its own log file under `logs/electron_chat/`.
- **About tab** — app name/version plus a Guide sub-tab (placeholder for now).
- **Config editor upgrade** — the Config tab now shows config fields grouped by section with source badges
  (`config.json` / `.env` / default), secret show/hide, and saves only the keys you change. A **Raw JSON**
  toggle keeps the full-editor view.

### Fixed

- The Config tab could previously fail to load (a renderer/preload API name mismatch); it now renders
  correctly.

### Docs

- Refreshed `electron.md` and `ipcs.md`.

## [0.2.1-1] — 2026-08-27

### Added

- **Multi-provider LLM support** for the agent runner — switch between DeepSeek (default), OpenAI,
  Anthropic, or a local Ollama server via a single `LLM_PROVIDER` setting.
- **Config system** — a plain-JSON `config.json` at the repo root now takes precedence over `.env`.
  The Electron dashboard gains a **⚙️ Config** tab to view, edit, save, export, and import it.

### Changed

- All backend services (webhook server, agent runner, MCP servers) now load configuration from
  `config.json` first, falling back to `.env`.

### Docs

- Refreshed `ipcs.md` and `electron.md`.

## [0.2.0-2] — 2026-08-27

### Removed

- **Legacy Netlify build/edge/session-log helpers** — the site is now build-less; only the runtime-config and Trello-proxy functions remain. Session logs are written by the backend instead.

## [0.2.0-1] — 2026-08-24

### Fixed

- **Electron dashboard live-log crash**: the log tailer could crash when a new day's log file first appeared (invalid buffer size). The tailer now guards the start offset, and the tail loop is hardened so a bad tick logs an error instead of taking down the app.

## [0.2.0] — 2026-08-24

### Added

- **License-key login** for frontdesk seats — per-seat keys replace username/password.
- **End-to-end encrypted chat** between the frontdesk webapp and the agent (AES-256-GCM, key derived from a per-seat ECDH exchange).
- **Direct-to-tunnel chat** by default; Trello becomes an optional mirror with a degraded store-and-forward mode when the tunnel is down.
- **Per-seat Google/Trello account binding** via an in-app "Connect Google" flow; the agent runner uses a seat's own credentials when acting for it.
- **macOS Electron operator dashboard** — start/stop the whole backend stack, live log stream, queue, sessions, licenses, accounts & keys, tools, tray + priority notifications.
- **Named Cloudflare tunnel scripts** for a stable public endpoint.

### Changed

- **Unified logging**: all MCP servers and webhook handlers now route tool-call/webhook logging through a shared logger that emits a unified live stream while preserving the existing on-disk layouts.
- **Webapp rewrite** for license login, E2E encryption, Connect Google, and degraded mode; the Netlify config no longer serves secrets.

### Docs

- Added `docs/electron.md` (operator dashboard) and `docs/ipcs.md` (Electron IPC channels); refreshed `docs/push-notifications.md`.

## [main-3] — 2026-08-18

### Changed

- **Prompt-injection sanitization plumbing**: The sanitizer now loads via a tracked stub module backed by a local (untracked) implementation. All MCP servers and webhook handlers were updated to use the new module — no functional change.
- **Repository history**: Removed the original `scripts/sanitize.mjs` module from all commit history (history rewritten and force-pushed to `main`).

## [main-2] — 2026-07-26

### Added

- **Repo master list**: Created a comprehensive inventory of all 46 repos for account `afrogenesurvive` with license and visibility info.

### Changed

- **40 repo licenses updated** via GitHub API — 22 repos set to MIT, 17 to Apache-2.0, 1 changed from MIT→Apache-2.0, 1 changed from Apache-2.0→MIT.
- **Repo master list**: Updated to reflect current license states after all changes applied.

## [main-1] — 2026-07-24

### Added

- **Gmail multi-account support** (`mcp/gmail/index.js`): Added `userId` parameter to all Gmail tools (`gmail_list_messages`, `gmail_get_message`, `gmail_send_message`), supporting both the default account and `entclinicmobay@gmail.com` via `GMAIL_REFRESH_TOKEN_2`/`GMAIL_USER_2` env vars.
- **Sheets MCP Server** (`mcp/sheets/`): New MCP server with 5 tools — `sheets_get_metadata`, `sheets_get_values`, `sheets_update_values`, `sheets_insert_rows`, `sheets_copy_paste_format`. Provides per-cell Google Sheets editing for the Bills Check Master spreadsheet.
- **xlsx-to-Sheet conversion script** (`scripts/convert-xlsx-to-sheet.mjs`): One-time utility to convert the existing xlsx to a native Google Sheet.
- **`mcp:sheets` npm script** in `package.json` for running the Sheets MCP server directly.
- **`sheetsTools` export** in `shared/tool-manifest.js` — tool definitions shared with the agent runner and MCP servers.

### Changed

- **`shared/tool-manifest.js`**: All Gmail tool descriptions updated to document multi-account `userId` support. Added `sheetsTools` array with 5 Sheet tool definitions. `allTools` now includes `sheetsTools`.
- **Local config** (gitignored): VS Code MCP config updated with Sheets MCP server entry; the local extraction-agent doc updated with the Sheets API workflow replacing the xlsx download/upload pattern.
