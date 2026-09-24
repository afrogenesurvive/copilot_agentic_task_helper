# 📜 Scripts

The Scripts tab runs **vetted helper scripts** that live under `scripts/user/` in the repo. It is
**manual only** — nothing here is triggered by the agent; you click **▶ Run** yourself.

## Where the scripts live

Two folders are scanned, and **only these two** — there is no recursion into subfolders, so a
script in `scripts/user/safe/tools/` is invisible:

| Folder             | Committed?                        | For                             |
| ------------------ | --------------------------------- | ------------------------------- |
| `scripts/user/`     | yes (public repo)                 | shareable, credential-free tools |
| `scripts/user/safe/`| **no** — `.gitignore` rule `safe/` | personal/credentialed tools      |

Because `safe/` is ignored, **git does not track its executable bits**: a `git clean`, a fresh
clone or a `chmod`-losing copy turns every `.sh` into a non-executable file. `scanUserScripts()`
still lists them (it has an extension runner), and `master_cleanup.sh` no longer skips its
subscripts when the bit is missing — it falls back to `bash <script>`.

## Cards shipped today

**Daily workflow** — `rollover-daily-todo.mjs`, `convert-xlsx-to-sheet.mjs`,
`gmail-clear-labelled-updates.mjs`, `office_bills.py`, `update-rdp-sg.sh`.

**Backups**

| Card                    | Origin                                                       | Needs                                                                                                    |
| ----------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `trello-backup.mjs`     | Node port of the PHP `trello-backup`'s one-JSON-per-board layout | `TRELLO_KEY` / `TRELLO_TOKEN` (already in ⚙️ Config) — no new dependency                                  |
| `github_backup.py`      | copied from `github_total_export_python`                      | python3 (stdlib only) + `git`; `GITHUB_TOKEN` (+ `GITHUB_USER`, optional `GITHUB_REPOS`) in ⚙️ Config     |

**Disk cleanup** — `master_cleanup.sh` plus one card per subscript (`misc_cache_clear.sh`,
`runtime_cache_cleanup.sh`, `pkg_mgmt_cache_cleanup.sh`, `code_agent_chat_cache_cleanup.sh`,
`xcode_cache_cleanup.sh`, `app_cache_cleanup.sh`, `git-gc-all.sh`). Copied flat from
`disk_cleanup_scripts/cleanup_scripts/` — they must stay in the same folder, because
`master_cleanup.sh` resolves its subscripts relative to its own path (`BASH_SOURCE`).

`github_backup.py`'s repo list comes from the sidecar `github-backup.repos.json` (`--config`).
An **empty** list means *every* repo the token owns, and `GITHUB_REPOS` in ⚙️ Config
**overrides** that file whenever it is set — leave `GITHUB_REPOS` empty to drive it from the file.

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

Any file **directly inside** `scripts/user/` or `scripts/user/safe/` is listed if it has a known
extension (`.sh`, `.command`, `.bash`, `.mjs`, `.js`, `.cjs`, `.py`) or is directly executable
(non-runnable files such as `*.params.json` sidecars are skipped). Everything runs from the repo
root with the current config environment, so scripts should load credentials through
`shared/config-loader.cjs` (config.json first, `.env` fallback) rather than hard-coding a path.

## Notes

- This is a **trusted, allowlisted folder** — you only ever run scripts that live there; there is
  no free-form "run any command" box.
- Running scripts is manual and live only here — stopping the app (or this tab's refresh) does
  not stop an already-running script unless you press **■ Stop**.
- **Destructive cards ship with `--dry-run` pre-checked.** A real delete is therefore two
  deliberate actions: uncheck dry-run, then Run. `misc_cache_clear.sh` also pre-checks `--yes`,
  because the spawned process has **no stdin** — its `read` confirmation prompt would otherwise
  wait forever.
- Long runners: `git-gc-all.sh` can take hours across every repo, and the output pane keeps only
  the **last 1000 lines**. Write a log file (or `--heartbeat-file`) when you need the full record.
- `master_cleanup.sh` writes its default log to `scripts/user/safe/logs/` (inside the ignored
  folder) unless you set the **Log file** field.

### Keeping the rollover script and its prompt in sync

`scripts/user/safe/rollover-daily-todo.mjs` is the deterministic half of the `/rollover_daily_todo`
prompt (`~/Library/Application Support/Code/User/prompts/rollover_daily_todo.prompt.md`). The
prompt asserts **exact output markers**; treat these as the contract when either side changes:

| Marker in the script's output                | What the prompt concludes        |
| -------------------------------------------- | -------------------------------- |
| `Source card:  "DD_MM_YYYY"`                 | the source card it picked        |
| `Tiers carried over: N checklist(s)`         | tier count                       |
| `<name>   <- was checked`                    | a ticked item re-created unchecked |
| `Order verified` / `Order enforced`          | item order matches the source    |
| `Tier order verified` / `Tier order enforced`| tier order matches the source    |
| `Insert slot:  between "---" … above "Done:"` | the card landed in the active slot |

Flags the prompt relies on: `--date`, `--dry-run`, `--flatten-tiers`, `--strict-unchecked`,
`--force`. `--done-marker` / `--no-done-marker` are **accepted no-ops** — the `-done?` marker was
retired and must not come back.
