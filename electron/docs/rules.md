# 🔗 Rules

The Rules tab authors the pipeline that turns an incoming **webhook event** into an action. A rule
matches an event, then either runs a tool, reroutes the event to a queue, or suppresses it. Rules are
stored in `safe/webhook-tool-rules.json` (gitignored — local, operator-only) and are read by
[`mcp/webhook-server/lib/tool-dispatch.js`](../../mcp/webhook-server/lib/tool-dispatch.js#L1) on every
webhook the server receives.

## What a rule is

| Field | Meaning |
| ----- | ------- |
| `name` | A label for the list |
| `enabled` | Off rules are skipped |
| `match.source` | One of `gmail`, `trello`, `drive`, `calendar`, `whatsapp` |
| `match.type` | The event type (e.g. `new_message`, `commentCard`, `change`, `sync`) |
| `match.conditions` | Field path → operator → value. Operators: `contains`, `equals`, `regex`, `exists`. All conditions must match (AND). Omit entirely to match **every** event of the rule's source/type |
| `action` | `tool` (default) · `route` · `suppress` |
| `queue` | For `route` only — `priority` or `misc_notifications` |
| `tool` / `params` | For `tool` only — the tool name and its parameters |

## Actions

- **Run a tool** (`action: "tool"`, the default) — enqueue a pending tool call to the **priority**
  queue. Param values may contain `{{event.<path>}}` placeholders, which are replaced with fields from
  the matched event before the call is enqueued (e.g. `{{event.data.subject}}`, `{{event.card.name}}`).
  The tool dropdown lists only the tools the autonomous runner can actually execute
  ([`shared/executable-tools.mjs`](../../shared/executable-tools.mjs#L1)) plus the `agent_log`
  pseudo-tool, which hands the model a free-text instruction instead of a specific tool call.
  A matched tool rule is executed **deterministically**: the agent runner calls the configured tool
  with the interpolated params directly, rather than asking the model to re-decide (the old behaviour
  let the model substitute a different tool, so the configured action could silently never run).
  `agent_log` is the one exception — it stays model-driven, with its message passed to the model as the
  instruction.
- **Route to queue** (`action: "route"`) — send the raw event to `priority` (auto-processed by the
  agent runner) or `misc_notifications` (the daily-review pile), with no tool attached.
- **Suppress** (`action: "suppress"`) — drop the event entirely. This is never silent: the dispatch
  engine writes an audit line (`subSource: tool-dispatch`) so a suppression can always be traced.

## Using the tab

- **+ New rule** opens a blank editor; **Edit** on a row re-opens that rule inline.
- The **Conditions** rows build the match — pick the field path from the suggestions, choose an
  operator, enter the value. Use **+ condition** to add more (all must match). Leave the list empty
  to match **every** event of the chosen source/type.
- The **Tool params** section is generated from the chosen tool's schema; required keys are marked.
  Type a literal value or `{{event.data.field}}` (the field suggestions are per-source). It renders
  only for the `tool` action — the Queue selector likewise appears only for `route`.
- **Save** writes the rule and applies it immediately — there is no restart. **Cancel** discards the
  editor. **Delete** removes the rule.
- **Test…** (top bar) runs *every* rule against a pasted event and shows which matched and what
  params they would send. **Test this rule…** (inside an editor) does the same for a single rule.
  Testing only previews matching — it never executes an action.

## Under the hood

- The UI talks to the operator-only `rules:*` IPC channels, which proxy to the webhook server's
  `/api/rules*` endpoints (`GET/PUT /api/rules`, `GET /api/rules/tools`, `POST/DELETE /api/rules/:index`,
  `POST /api/rules/reload`, `POST /api/rules/test`). All are token-gated (`WEBHOOK_API_TOKEN`).
- Writes are atomic (temp file + rename) and reload the in-memory rules immediately, so the running
  server never reads a half-written file and never needs a restart to pick up a change.
- Routing happens in the webhook handlers: each handler calls `dispatch(event)` first and enqueues the
  raw event according to the outcome (`suppress` → skip, `route` → the named queue, otherwise
  `misc_notifications`). Frontdesk messages and session-log cards are deliberately **not** routed
  through the rules — they are hardcoded invariants.
