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

## The frontdesk crypto audit trail

Logging in and encrypting a message are the two moments where a silent failure looks exactly like
nothing happening, so both are recorded. Every licence verification, envelope decrypt, reply
encryption, degraded (`[fd1]`) verification and **rejected session** writes a row to
`logs/frontdesk/crypto/YYYY-MM-DD.jsonl` and a `frontdesk/crypto` line to the unified live log —
visible in **Logs → Live** (filter sub-source `crypto`) and browsable as a file under **Logs → Files**.

| Outcome | Level | Example message |
| ------- | ----- | --------------- |
| Success | `info` | `inbound_decrypt ok — <seat>` |
| Rejected licence / session | `warn` | `login_verify FAILED (bad_signature) @ /api/license/verify` |
| Decrypt or encrypt failure | `error` | `outbound_encrypt FAILED — <seat> (unknown_seat)` |

Rows carry `{ts, event, ok, sub, reason, direction, route}` and never the licence key, the seat keys,
the agent private key or message plaintext.

Failures also raise a **`security` notification** (see
[`notifications.md`](notifications.md)) — including the case that used to be completely invisible: a
reply that cannot be encrypted because the seat has no registered key, which means the collaborator is
waiting for an answer that will never arrive.

## Notes

- This is a read-only, tail-style view of the most recent records — older entries are kept in
  the files but not all are shown here.
- These are **webapp visitor sessions, seen by the operator**. The visitors (seats) never see
  this view — they only use their own webapp chat.
- Session data (and the accounts that map to them) is separate from the operator dashboard
  itself; for per-seat Google/Trello bindings see the 🔐 Accounts & Keys tab.
