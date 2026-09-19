# 📈 Usage

The **Usage** tab shows LLM token usage recorded by the backend and the status of the
[DS-mon](https://dsmon.blackstonedsmon.uk) usage push. Use it to confirm usage tracking is
working and to see where tokens are being spent.

## What it shows

| Section | Meaning |
| --- | --- |
| **Status line** | Whether usage tracking is `enabled` / `disabled`, whether it is **paused** (and why), the DS-mon push URL, how many records are currently buffered, the instance ID, and the outcome of the last push. |
| **Credit card** | The active provider's credit balance. DeepSeek exposes a balance endpoint; OpenAI/Anthropic show "no public usage/balance endpoint"; Ollama shows "local LLM — no cost to track". |
| **Stat cards** | Calls, Total tokens, Input tokens and Output tokens across all buffered records. |
| **Breakdown tables** | Tokens grouped by provider, by **source** (the flow that made the call — `agent-runner`, `webhook-execute`, `electron-chat`, `operator-agent`), and by model. |

## How tracking works

Every cloud LLM call (DeepSeek / OpenAI / Anthropic) made through `shared/model-provider.mjs` is
recorded by `shared/usage-tracker.mjs`:

- The record is appended to `logs/dsmon_buffer.jsonl`.
- A periodic timer flushes the buffer to `DSMON_PUSH_URL` (`/sync/push`), with a 60 s retry on
  **transient** failure. Records survive restarts and offline periods.
- **A `401`/`403` is permanent, not transient.** DS-mon requires the bearer token on `/sync/push` and
  fails closed without it, so tracking **pauses** instead of retrying forever: the 60 s retry is not
  re-armed, no new records are buffered, and every buffered record is kept untouched. Correct the token
  and the backlog flushes on the next timer tick. **No record is ever dropped because of a bad token.**
- **Ollama (local) calls are never recorded** — they are free.

The Usage tab reads the *local buffer* directly, so it reflects calls that have not been pushed
yet. **Flush now** forces an immediate push.

## Configuration (⚙️ Config → Usage tracking)

| Key | Default | Purpose |
| --- | --- | --- |
| `USAGE_TRACKING_ENABLED` | `false` | Master switch — collection **and** push. |
| `DSMON_PUSH_URL` | — | DS-mon push base URL (a bare host gets `/sync/push` appended). |
| `DSMON_PUSH_TOKEN` | — | Bearer token required by the DS-mon endpoint (secret). **Required whenever `DSMON_PUSH_URL` is set** — DS-mon fails closed, so tracking refuses to start (and pauses once running) rather than pushing unauthenticated. |
| `DSMON_PUSH_INTERVAL` | `300000` | Flush interval in ms (5 min). |
| `DSMON_INSTANCE_ID` | auto | Instance identifier sent with each record. |
| `DSMON_ENCRYPTION_KEY` | — | Optional base64url 32-byte AES-256-GCM key; when set, each push batch is encrypted (secret). |
| `DSMON_ENCRYPTION_KEY_ID` | `dsmon` | Key id placed in the encryption envelope. |
| `CREDIT_POLL_INTERVAL` | `60000` | How often the Usage tab refreshes the credit balance (ms). |

Saving any of these restarts the runner and webhook services automatically so the change applies
immediately (the 💬 Chat tab reads them live). Fixing the token also clears a paused state.

## Privacy

- The **DeepSeek API key never leaves the main process** — the balance request is made by Electron
  main, not the renderer.
- Usage records contain token counts, model, provider, latency and the originating flow label —
  **not** prompts or completions.

## Troubleshooting

- **Status shows `disabled`** — set `USAGE_TRACKING_ENABLED` to `true` in ⚙️ Config and Save.
- **Status shows `⏸️ paused: unauthorized`** — `DSMON_PUSH_TOKEN` is missing or wrong. This is a
  **configuration error, not an outage**: nothing is retried (and nothing new is collected) until the
  token changes, and the buffered records are safe. Set the token and Save.
- **Status shows `⏸️ paused: token-missing`** — `USAGE_TRACKING_ENABLED` and `DSMON_PUSH_URL` are set
  but `DSMON_PUSH_TOKEN` is empty, so tracking never started. Set the token and Save.
- **Buffered records keep growing / "push failed"** — DS-mon is unreachable (a transient failure), so
  records are retained and retried; check `logs/dsmon.log`.
- **No data** — no cloud LLM calls have been made yet (Ollama calls are intentionally excluded).
