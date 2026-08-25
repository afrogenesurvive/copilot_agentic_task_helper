#!/usr/bin/env node
/**
 * Per-seat account gating for the frontdesk v2 stack.
 *
 * A license key is bound to a seat (`sub`). This module maps each seat to the
 * Google / Trello accounts that seat may use, so the agent's MCP tool access is
 * gated per seat:
 *
 *   - Google: a seat connects their own Google account via the frontdesk
 *     "Connect Google" OAuth flow (the consent is bound to the seat's sub) or
 *     via the Electron operator dashboard. The resulting refresh token is
 *     stored here under that seat.
 *   - Trello: a seat can optionally provide their own Trello key/token. If not
 *     set, the agent's default (.env) Trello is used.
 *
 * The agent runner reads this file when it acts ON BEHALF of a frontdesk seat,
 * and uses the seat's credentials instead of the default .env ones.
 *
 * Persisted to safe/frontdesk-accounts.json (gitignored via safe/).
 *
 * CLI:
 *   node scripts/frontdesk-accounts.mjs list
 *   node scripts/frontdesk-accounts.mjs get <sub>
 *   node scripts/frontdesk-accounts.mjs set-trello <sub> <key> <token>
 *   node scripts/frontdesk-accounts.mjs clear <sub>
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ACCOUNTS_FILE = path.resolve(__dirname, "..", "safe", "frontdesk-accounts.json");

export function loadAccounts() {
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      const d = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
      return { updatedAt: d.updatedAt || null, accounts: d.accounts || {} };
    }
  } catch {
    /* fall through to empty */
  }
  return { updatedAt: null, accounts: {} };
}

export function saveAccounts(acc) {
  fs.mkdirSync(path.dirname(ACCOUNTS_FILE), { recursive: true });
  acc.updatedAt = new Date().toISOString();
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(acc, null, 2) + "\n", "utf8");
}

/** Get the accounts bound to a seat: { google, trello } (both possibly null). */
export function getSeatAccounts(sub) {
  if (!sub) return { google: null, trello: null };
  const { accounts } = loadAccounts();
  return accounts[sub] || { google: null, trello: null };
}

/** Store/clear the Google account a seat connected via OAuth. */
export function setSeatGoogle(sub, google) {
  const acc = loadAccounts();
  acc.accounts[sub] = acc.accounts[sub] || {};
  acc.accounts[sub].google = google ? { ...google, connectedAt: new Date().toISOString() } : null;
  saveAccounts(acc);
  return acc.accounts[sub];
}

/** Store/clear the Trello key/token a seat may use. */
export function setSeatTrello(sub, trello) {
  const acc = loadAccounts();
  acc.accounts[sub] = acc.accounts[sub] || {};
  acc.accounts[sub].trello = trello ? { ...trello, configuredAt: new Date().toISOString() } : null;
  saveAccounts(acc);
  return acc.accounts[sub];
}

export function clearSeat(sub) {
  const acc = loadAccounts();
  delete acc.accounts[sub];
  saveAccounts(acc);
}

/** Structured list for dashboards: [{ sub, googleConnected, googleUser, trelloConfigured }] */
export function listAccounts() {
  const { accounts } = loadAccounts();
  return Object.entries(accounts)
    .map(([sub, a]) => ({
      sub,
      googleConnected: !!(a.google && a.google.refreshToken),
      googleUser: (a.google && a.google.user) || null,
      trelloConfigured: !!(a.trello && a.trello.token),
    }))
    .sort((x, y) => x.sub.localeCompare(y.sub));
}

/* ── CLI ── */
function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd === "list") {
    const rows = listAccounts();
    if (!rows.length) return console.log("No seat accounts configured.");
    for (const r of rows) {
      console.log(`  ${r.sub}  google=${r.googleUser || (r.googleConnected ? "connected" : "none")}  trello=${r.trelloConfigured ? "configured" : "default(.env)"}`);
    }
  } else if (cmd === "get") {
    const sub = argv[1];
    console.log(JSON.stringify(getSeatAccounts(sub), null, 2));
  } else if (cmd === "set-trello") {
    const [, sub, key, token] = argv;
    if (!sub || !key || !token) return console.error("usage: set-trello <sub> <key> <token>");
    setSeatTrello(sub, { key, token });
    console.log(`Trello creds stored for ${sub}.`);
  } else if (cmd === "clear") {
    clearSeat(argv[1]);
    console.log(`Cleared accounts for ${argv[1]}.`);
  } else {
    console.log(`Usage:
  node scripts/frontdesk-accounts.mjs list
  node scripts/frontdesk-accounts.mjs get <sub>
  node scripts/frontdesk-accounts.mjs set-trello <sub> <key> <token>
  node scripts/frontdesk-accounts.mjs clear <sub>`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
