# 🔴 Queue

The Queue tab shows the two event queues that drive the agent, so you can see what is waiting for
attention and clear items that have been handled.

## The two panels

- **Priority queue** — items that need attention: tool-dispatch events that matched a rule and
  authorized frontdesk inputs awaiting an agent answer.
- **Misc notifications** — the raw stream of other Trello/Gmail/calendar notifications that did
  not match a dispatch rule (daily review fodder).

Each item shows:

- Its sequential **#** number (matching the webhook server's terminal numbering).
- A short **description** — the matched rule name, or `source/type`, plus a snippet of the
  related text or card name when available.
- The time it was **queued**.
- A **clear** button.

## Common actions

- **Clear an item** — press **clear** on a row. This soft-deletes the event (marks it `cleared`)
  so it no longer counts as pending, matching what `done <#>` does in the server terminal.
- **Watch counts** — the app shows a native notification when the pending priority count goes up
  while the app is running.

## States & quirks

- Already-cleared items are shown struck-through with their **clear** button disabled.
- If the webhook server is not reachable, the panel shows **Webhook server not reachable.** —
  start it from the 📊 Dashboard and the items reappear on the next refresh.
- Only the most recent items are rendered (up to 60 per panel); older backlog lives in the JSONL
  queue files on disk.

## Notes

- The underlying files are `logs/pending-tool-calls/priority.jsonl` and
  `logs/pending-tool-calls/misc_notifications.jsonl`.
- Clearing an item here only affects the local queue record — it does **not** delete the
  underlying Trello card, email, or notification log entry.
