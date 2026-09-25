/**
 * Trello board + list ID resolution — the single reader of `safe/trello-boards.json`.
 *
 * Why this exists: the board and list IDs used to be hand-copied into three places
 * (`TRELLO_WEBHOOK_MODEL_IDS`, `TRELLO_LIST_*` in `.env`/`config.json`, and the
 * Netlify env vars), and the one file that already held them — this repo's
 * `safe/trello-boards.json` — was read by a single gitignored user script. Every
 * consumer now resolves through here, and `scripts/trello-boards-sync.mjs` projects
 * the file back into the env keys so the hand-maintained copies cannot drift.
 *
 * File shape (top-level board names → board ids, plus a `lists` block keyed by BOARD name):
 *
 *   {
 *     "Smart Term Engineering": "64d52a0883ab5b468d946856",
 *     "Two Dew Liszt": "5dc8a5602bcdcc5465e46d95",
 *     "lists": {
 *       "Two Dew Liszt": { "frontdesk_input": "6a1c…", "frontdesk_output": "6a1c…" }
 *     }
 *   }
 *
 * `safe/` is gitignored, so the file is ABSENT on most checkouts and on any machine
 * that never ran the rollover script. Every function here therefore degrades to
 * `null`/`{}` and never throws — callers must fall back to their env keys, exactly
 * like `mcp/calendar/index.js` and `mcp/drive/index.js` do with their own safe files.
 *
 * Nothing here reads or returns credentials: `safe/frontdesk-accounts.json` holds the
 * tokens, and it is deliberately not touched by this module.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

/** The list names the frontdesk flow depends on, and the env key each one feeds. */
export const LIST_ENV_KEYS = {
  frontdesk_input: "TRELLO_LIST_FRONTEDESK_INPUT",
  frontdesk_output: "TRELLO_LIST_FRONTEDESK_OUTPUT",
  frontdesk_session_logs: "TRELLO_LIST_SESSION_LOGS",
};

/** The list whose board identifies the frontdesk board (the file has no "default"). */
const ANCHOR_LIST = "frontdesk_input";

/** A Trello id: 24 lowercase hex characters. */
const ID_RE = /^[0-9a-f]{24}$/i;

/**
 * Absolute path to the board map. `TRELLO_BOARDS_FILE` overrides it (absolute, or
 * relative to the repo root) so a relocated store needs no code change — the same
 * shape `scripts/pkm-paths.mjs` uses for the key manager.
 */
export function boardsFile() {
  const override = process.env.TRELLO_BOARDS_FILE;
  if (!override || !String(override).trim()) return path.join(REPO, "safe", "trello-boards.json");
  return path.isAbsolute(override) ? override : path.resolve(REPO, override);
}

/**
 * Parse the board map. Never throws; a missing or malformed file yields an empty map
 * with `present:false` (or `error`), so callers can distinguish "no file" from
 * "file says there is no such board".
 *
 * @returns {{present:boolean, file:string, error:string|null, boards:Object<string,string>, lists:Object<string,Object<string,string>>}}
 */
export function loadTrelloBoards() {
  const file = boardsFile();
  const empty = { present: false, file, error: null, boards: {}, lists: {} };
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return empty; // gitignored and absent on most checkouts — not an error
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...empty, present: true, error: "not_an_object" };
    }
    const boards = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (name === "lists") continue;
      // Only real ids — tolerates note/updatedAt siblings someone adds by hand.
      if (typeof value === "string" && ID_RE.test(value)) boards[name] = value;
    }
    const lists = {};
    for (const [board, entries] of Object.entries(parsed.lists || {})) {
      if (!entries || typeof entries !== "object") continue;
      const bucket = {};
      for (const [listName, id] of Object.entries(entries)) {
        if (typeof id === "string" && ID_RE.test(id)) bucket[listName] = id;
      }
      if (Object.keys(bucket).length) lists[board] = bucket;
    }
    return { present: true, file, error: null, boards, lists };
  } catch (err) {
    return { ...empty, present: true, error: `invalid_json: ${err.message}` };
  }
}

/** Board names the file knows, in file order. */
export function boardNames() {
  return Object.keys(loadTrelloBoards().boards);
}

/** Every list name mentioned by any board in the file (deduplicated). */
export function listNames() {
  const names = new Set();
  for (const entries of Object.values(loadTrelloBoards().lists)) {
    for (const name of Object.keys(entries)) names.add(name);
  }
  return [...names];
}

/** Board id for a board name, or null. */
export function boardId(name) {
  if (!name) return null;
  return loadTrelloBoards().boards[String(name)] || null;
}

/**
 * The board the frontdesk runs on: the one whose `lists` block holds the input list.
 * Derived rather than declared, because the file has no "default" field and the
 * `lists` block only ever covers one board.
 */
export function frontdeskBoard() {
  const { boards, lists } = loadTrelloBoards();
  for (const [board, entries] of Object.entries(lists)) {
    if (entries[ANCHOR_LIST] && boards[board]) return board;
  }
  // No anchor list: fall back to the only board, or the first one listed.
  const names = Object.keys(boards);
  return names.length === 1 ? names[0] : names[0] || null;
}

/**
 * List id by list name.
 *
 * @param {string} listName  e.g. `frontdesk_input`
 * @param {{board?:string}} [opts]  restrict the lookup to one board (by name);
 *   defaults to a search across every board, since callers usually know the list
 *   name and not which board it belongs to.
 */
export function listId(listName, opts = {}) {
  if (!listName) return null;
  const { lists } = loadTrelloBoards();
  const wanted = String(listName);
  if (opts.board) return lists[String(opts.board)]?.[wanted] || null;
  for (const entries of Object.values(lists)) {
    if (entries[wanted]) return entries[wanted];
  }
  return null;
}

/**
 * The three list ids the frontdesk flow needs, plus the board they live on.
 * Individual ids are null when the file does not define them.
 */
export function frontdeskLists() {
  const board = frontdeskBoard();
  const entries = board ? loadTrelloBoards().lists[board] || {} : {};
  return {
    board,
    boardId: board ? boardId(board) : null,
    input: entries.frontdesk_input || null,
    output: entries.frontdesk_output || null,
    sessionLogs: entries.frontdesk_session_logs || null,
    /** List names on that board that are NOT part of the frontdesk flow. */
    other: Object.keys(entries).filter((n) => !(n in LIST_ENV_KEYS)),
  };
}

/**
 * Every board id, comma-joined — the value `TRELLO_WEBHOOK_MODEL_IDS` holds. These are
 * exactly the boards a webhook is registered against.
 */
export function modelIds() {
  const ids = Object.values(loadTrelloBoards().boards);
  return ids.length ? ids.join(",") : null;
}

/**
 * The env keys this file can supply, resolved. Only keys with a value are included,
 * so a caller can spread this over `process.env` without blanking an existing value.
 *
 * @returns {Object<string,string>}
 */
export function envProjection() {
  const fd = frontdeskLists();
  const out = {};
  if (fd.boardId) out.TRELLO_BOARD_ID = fd.boardId;
  if (fd.board) out.TRELLO_BOARD_NAME = fd.board;
  if (fd.input) out.TRELLO_LIST_FRONTEDESK_INPUT = fd.input;
  if (fd.output) out.TRELLO_LIST_FRONTEDESK_OUTPUT = fd.output;
  if (fd.sessionLogs) out.TRELLO_LIST_SESSION_LOGS = fd.sessionLogs;
  const ids = modelIds();
  if (ids) out.TRELLO_WEBHOOK_MODEL_IDS = ids;
  return out;
}

/**
 * Resolve a value that may be a board NAME, a raw board id, or empty.
 * Empty means "the frontdesk board". Anything unrecognised is passed through
 * unchanged, so the Trello API produces the error rather than this module
 * inventing one.
 */
export function resolveBoardId(value) {
  const v = value == null ? "" : String(value).trim();
  if (!v) return boardId(frontdeskBoard()) || null;
  const { boards } = loadTrelloBoards();
  if (boards[v]) return boards[v];
  return v;
}

/**
 * Resolve a value that may be a list NAME, a raw list id, or empty.
 * Empty means "the frontdesk input list". Unrecognised values pass through.
 *
 * @param {string} value
 * @param {{board?:string}} [opts] board name to restrict a name lookup to
 */
export function resolveListId(value, opts = {}) {
  const v = value == null ? "" : String(value).trim();
  if (!v) return listId(ANCHOR_LIST, opts) || null;
  const mapped = listId(v, opts);
  if (mapped) return mapped;
  return v;
}

/**
 * Map names onto the id parameters the Trello handlers expect, so a caller can say
 * `listName: "frontdesk_input"` instead of pasting a 24-hex id.
 *
 * Returns `{args}` when everything resolved, or `{error}` when a name is neither an
 * id nor in the board map — a typo must not reach the Trello API as a bogus id
 * (which reached the agent as an opaque 404). Raw ids pass through unchanged, so this
 * is safe on a checkout without the (gitignored) board map.
 *
 * @param {object} input  tool arguments
 * @param {{defaultBoard?:boolean}} [opts] when true, a call with no board at all means
 *   the frontdesk board (used by the read-only `trello_get_lists`, which the agent
 *   otherwise could not call without already knowing an id).
 */
export function normalizeTrelloArgs(input = {}, opts = {}) {
  const args = { ...input };
  const unknown = [];

  const asId = (value, key, lookup, what) => {
    const v = String(value == null ? "" : value).trim();
    if (!v) return;
    if (ID_RE.test(v)) {
      args[key] = v;
      return;
    }
    const id = lookup(v);
    if (id) args[key] = id;
    else unknown.push(`${what} "${v}"`);
  };

  if (args.boardName && !args.boardId) asId(args.boardName, "boardId", boardId, "board");
  if (args.listName && !args.listId) asId(args.listName, "listId", (n) => listId(n), "list");
  if (args.idList && !ID_RE.test(String(args.idList))) asId(args.idList, "idList", (n) => listId(n), "list");

  if (opts.defaultBoard && !args.boardId && !args.boardName) {
    const id = boardId(frontdeskBoard());
    if (id) args.boardId = id;
  }

  if (unknown.length) {
    const boards = boardNames();
    const lists = listNames();
    const known = boards.length
      ? `Known boards: ${boards.join(", ")}. Known lists: ${lists.join(", ")}.`
      : "The board map (safe/trello-boards.json) is not on this machine, so pass raw Trello ids.";
    return { error: `Unknown ${unknown.join(" and ")} — ${known}` };
  }
  return { args };
}

/**
 * Everything the operator UI needs to show: whether the file is there, what it says,
 * and how it compares to the env keys currently in force. Used by the Electron Config
 * tab and available to any other caller.
 *
 * @param {Object<string,string>} [env] defaults to process.env
 */
export function snapshot(env = process.env) {
  const loaded = loadTrelloBoards();
  const projected = envProjection();
  const drift = Object.entries(projected)
    .filter(([key, value]) => String(env[key] || "") !== value)
    .map(([key, value]) => ({ key, file: value, current: String(env[key] || "") }));
  return {
    present: loaded.present,
    file: loaded.file,
    error: loaded.error,
    boards: loaded.boards,
    lists: loaded.lists,
    frontdesk: frontdeskLists(),
    projected,
    drift,
  };
}
