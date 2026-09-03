# 🧰 Tools

The Tools tab shows the **shared tool manifest** and offers a few **quick actions** for trying the
underlying APIs without leaving the app.

## Shared tool manifest

A list of every tool the agent stack knows about (from the shared manifest). Each entry shows:

- The **tool name** (e.g. `trello_list_cards`, `gmail_send_message`).
- Its **description**.
- The **parameters** it accepts.

This is a read-only inventory — handy for checking what a tool expects before you script or
prompt for it.

## Quick actions

Two small experiment panels:

- **Trello**
  - **Boards** — list the boards on the account.
  - **Lists (of a board)** — prompts for a board ID, then lists its lists.
  - **Cards (of a list)** — prompts for a list ID, then lists its cards.
- **Gmail**
  - **Recent messages** — lists the 10 most recent message IDs.

Results print below the buttons (first ~20 items).

## Notes

- Quick actions use the **shared** credentials: Trello requires `TRELLO_KEY`/`TRELLO_TOKEN` in
  config; Gmail requires a connected Google account (client ID + refresh token). Missing
  credentials show an error instead of results.
- These actions are read-only conveniences — no destructive operations are exposed here.
