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
  executable), and a status (`idle` or `● running (pid N)`). Scripts with a UI manifest are
  tagged `form`.
- A short **usage** line pulled from the script's header comment (when present) — e.g. the
  purpose and flags.
- If the script has a **UI manifest** (`<name>.params.json` next to it), the card shows a
  **generated form** — one labeled field per declared param (text, number, flag/checkbox,
  dropdown, or a file/folder Browse button). See “UI manifests” below.
- Otherwise the card shows an **args** box. It accepts either a JSON array:

```
["--dry-run","-i","i-0abc123"]
```

  or plain space-separated / quoted values:

```
--dry-run -i i-0abc123
```

  In form mode the same box is still present as **extra args** — anything you type there is
  appended verbatim after the assembled flags.

- **▶ Run** and **■ Stop** buttons.
- An **output** pane below the controls (buffered, auto-scrolling) showing the script's stdout.

## UI manifests (`<name>.params.json`)

Drop a JSON file named exactly `<script>.params.json` in the same folder as a script
(`scripts/user/` or `scripts/user/safe/`) to give it a generated form. The sidecar is ignored
when scanning for runnable scripts (it only ever carries UI metadata).

Shape:

```jsonc
{
  "positionals": [ /* ordered positional args (e.g. a subcommand) — each is a field below */ ],
  "params": [ /* named options */ ]
}
```

Each field (in either array) supports:

| Key               | Meaning                                                        |
| ----------------- | -------------------------------------------------------------- |
| `key`             | stable id (`[A-Za-z0-9_-]`), also the form payload key         |
| `label`           | text shown next to the control (defaults to `key`)             |
| `type`            | `text` \| `number` \| `flag` \| `dropdown` \| `file`           |
| `arg`             | CLI token to emit (e.g. `--instance-id`); omit for positionals |
| `position`        | optional numeric ordering (positionals first, then params)     |
| `required`        | true → Run blocked until filled (flags: until checked)         |
| `default`         | prefill (flags: true/false → checked/unchecked)                |
| `placeholder`     | input placeholder                                              |
| `help`            | small hint under the control                                   |
| `options`         | `dropdown` only — allowed values                               |
| `browseFor`       | `file` only — `openFile` \| `openDirectory` \| `saveFile`      |
| `optionalValue`   | `flag` that may also take a value (e.g. `-o [PATH]`)           |
| `valueType`       | `optionalValue` only — `text` (default) or `file` (Browse)     |
| `valuePlaceholder`| `optionalValue` only — placeholder for the value box           |

How argv is assembled (in the main process, one source of truth):

- **Positionals** first, in declared order → each non-empty value pushed bare.
- **Params**: a checked `flag` pushes `arg` alone (plus its optional value if non-empty); a
  filled `text`/`number`/`dropdown`/`file` pushes `arg` then the value. Empty fields are
  skipped.
- Anything typed into the **extra args** box is tokenised and appended last.

Example for a flag with an optional value (`-o, --rdp [PATH]`):

```json
{ "key": "rdp", "arg": "--rdp", "type": "flag", "label": "Write .rdp file", "optionalValue": true, "valueType": "text" }
```

Checked with nothing typed → `--rdp`; with a value → `--rdp /path/to/file.rdp`.

## What counts as runnable

Any file under `scripts/user/` is listed if it has a known extension (`.sh`, `.command`, `.bash`,
`.mjs`, `.js`, `.cjs`, `.py`) or is directly executable (non-runnable files such as
`*.params.json` sidecars are skipped). Everything runs with the current config
environment (so AWS/API env vars are available).

## Notes

- This is a **trusted, allowlisted folder** — you only ever run scripts that live there; there is
  no free-form "run any command" box.
- Running scripts is manual and live only here — stopping the app (or this tab's refresh) does
  not stop an already-running script unless you press **■ Stop**.
