# 🔐 Accounts & Keys

The Accounts tab manages **seat → account bindings**: which Google account and/or Trello
credentials the agent should use when acting **on behalf of a specific seat**.

## What you'll see

One row per seat. Each row shows:

- The **seat** identifier.
- **Google** — the connected Google account email, or `—` if none.
- **Trello** — `configured` (a per-seat key/token is set) or `default (.env)` (falls back to the
  shared credentials from config).

Per-row buttons:

- **Connect Google** — starts the OAuth flow to bind a Google account to this seat.
- **Set Trello** — prompts for a Trello API key + token to store for this seat.
- **Clear** — removes the seat's bindings.
- **▶ Spawn MCP** — launches dedicated MCP instances bound to this seat's accounts (instead of
  the shared instances the agent normally uses).
- **■ Stop MCP** — stops that seat's dedicated MCP instances.

## What it's for

The frontdesk agent uses the seat's accounts when it acts on that seat's behalf (reading mail,
posting to boards, etc.). Binding a Google account or setting a Trello key per seat lets each
seat act with its own identity rather than the shared `.env` credentials.

## Notes

- **Connect Google** opens a browser flow and records the resulting token for that seat.
- Spawned per-seat MCP instances appear on the 📊 Dashboard so you can watch their output.
- Clearing a binding does not revoke the underlying Google/Trello access globally — it only
  removes the seat's stored association here.
