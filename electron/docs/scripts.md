# 📜 Scripts

The Scripts tab runs **vetted helper scripts** that live under `scripts/user/` in the repo. It is
**manual only** — nothing here is triggered by the agent; you click **▶ Run** yourself.

## Preflight

A bar at the top shows which tools are available on this machine and whether AWS is configured:

- `aws` (+ version), `node`, `python3` presence.
- **AWS creds ✓ / ✗** — whether AWS keys are set (in ⚙️ Config or `~/.aws`), plus the active
  region/profile.

## Each script card

- **Name**, a **runner tag** (`bash`, `node`, `python3`, or the script itself if it's
  executable), and a status (`idle` or `● running (pid N)`).
- A short **usage** line pulled from the script's header comment (when present) — e.g. the
  purpose and flags.
- An **args** box. It accepts either a JSON array:

```
["--dry-run","-i","i-0abc123"]
```

  or plain space-separated / quoted values:

```
--dry-run -i i-0abc123
```

- **▶ Run** and **■ Stop** buttons.
- An **output** pane below the controls (buffered, auto-scrolling) showing the script's stdout.

## What counts as runnable

Any file under `scripts/user/` is listed if it has a known extension (`.sh`, `.command`, `.bash`,
`.mjs`, `.js`, `.cjs`, `.py`) or is directly executable. Everything runs with the current config
environment (so AWS/API env vars are available).

## Notes

- This is a **trusted, allowlisted folder** — you only ever run scripts that live there; there is
  no free-form "run any command" box.
- Running scripts is manual and live only here — stopping the app (or this tab's refresh) does
  not stop an already-running script unless you press **■ Stop**.
