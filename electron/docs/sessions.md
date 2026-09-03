# 👥 Sessions

The Sessions tab shows recent **frontdesk visitor sessions** — who opened the webapp chat, when,
and roughly what they did.

## What you'll see

A table of the most recent sessions (last 50) with:

- **Time** — when the session happened.
- **User** — the user/seat identifier.
- **Action** — the action recorded for that session.
- **IP** — the visitor's address.

When no sessions exist yet the panel shows **No frontdesk sessions yet.**

## Where the data comes from

Session entries are read from the dated JSONL files under
`logs/frontdesk/sessions/` (recorded by the backend when visitors use the webapp).

## Notes

- This is a read-only, tail-style view of the most recent records — older entries are kept in
  the files but not all are shown here.
- Frontdesk session data (and the accounts that map to them) is separate from the operator
  dashboard itself; for per-seat Google/Trello bindings see the 🔐 Accounts & Keys tab.
