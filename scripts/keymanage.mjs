#!/usr/bin/env node
/**
 * Unified license key management CLI for the Frontdesk system.
 *
 * Wraps the license engine (scripts/frontdesk-license.mjs) into one tool, so
 * you can create master keys, issue/revoke/validate seats, check expiry, and
 * keep the revocation blocklist in sync with the verifier.
 *
 * Unlike the transcription agent, the webhook server reads ring.json +
 * revoked-seats.json LIVE from safe/frontdesk-keys/ on every verify — there is
 * no embedded/bundled verifier to sync, so `sync-revocation` is intentionally
 * absent here (`check-revocation` still runs a reject test against the files).
 *
 * Subcommands:
 *   create-master --kid <id>             generate a new master keypair + ring entry (alias: generate-master)
 *   create-agent-key                     generate the agent X25519 keypair (encryption peer)
 *   issue <sub> --exp <date|unlimited> [--kid <id>]   issue a new seat license
 *   list                                 archive expired keys, then list all issued seats (incl. revoked/expired)
 *   export-seats                         write safe/frontdesk-keys/seats.json (seat registry)
 *   audit                                show seat issue/expiry/revoke history
 *   validate "<TA1....>"                 verify a license key (alias: verify)
 *   challenge-test "<TA1....>"           simulate the login challenge/response handshake
 *   crypto-self-test "<TA1....>"         verify ECDH → AES-GCM round-trip (client ↔ agent)
 *   check-exp [--days <N>]               report valid / expiring / expired / revoked seats
 *   archive-expired                      archive expired seat keys to <kid>/expired/
 *   revoke <sub>                         revoke a seat (archives record + key to revoked/)
 *   check-revocation                     revoked-seat reject test (live files)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadRing,
  loadRevokedSeats,
  generateMaster,
  issue,
  loadMasterPrivKey,
  verifyLicenseKey,
  challengeTest,
  cryptoSelfTest,
  createAgentKey,
  parseExp,
  revokeSeat,
  listSeats,
  exportSeats,
  printAudit,
  auditExpiredSeats,
  archiveExpiredSeats,
  backfillAudit,
  collectSeatRecords,
} from "./frontdesk-license.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

/** Default kid: the first ring key, falling back to "mk-dev". */
function defaultKid(argv) {
  const explicit = argValue(argv, "--kid");
  if (explicit) return explicit;
  const ring = loadRing();
  if (ring.keys && ring.keys.length > 0) return ring.keys[0].kid;
  return "mk-dev";
}

/** Read-only revocation reject test against the live safe/frontdesk-keys files. */
export function checkRevocation() {
  const seats = loadRevokedSeats();
  let ok = true;

  if (seats.length > 0) {
    const sub = seats[0];
    const kid = defaultKid([]);
    try {
      const masterPriv = loadMasterPrivKey(kid);
      const seat = crypto.generateKeyPairSync("ed25519");
      const pubX = seat.publicKey.export({ format: "jwk" }).x;
      const privD = seat.privateKey.export({ format: "jwk" }).d;
      const enc = crypto.generateKeyPairSync("x25519").publicKey.export({ format: "jwk" }).x;
      const cert = JSON.stringify({ app: "frontdesk-agent", v: 1, sub, exp: 0, kid, pub: pubX, enc });
      const sig = crypto.sign(null, Buffer.from(cert, "utf8"), masterPriv);
      const seatKeys = Buffer.concat([Buffer.from(privD, "base64url"), Buffer.from(crypto.generateKeyPairSync("x25519").privateKey.export({ format: "jwk" }).d, "base64url")]);
      const key = `TA1.${Buffer.from(cert).toString("base64url")}.${sig.toString("base64url")}.${seatKeys.toString("base64url")}`;
      const res = verifyLicenseKey(key);
      if (res.ok || res.reason !== "revoked_seat") {
        console.error(`[check] Revoked seat "${sub}" did NOT verify as revoked_seat (got ${JSON.stringify(res)})`);
        ok = false;
      } else {
        console.log(`[check] Revoked seat "${sub}" correctly rejected (revoked_seat)`);
      }
    } catch (e) {
      console.error(`[check] Reject test failed: ${e.message}`);
      ok = false;
    }
  } else {
    console.log("[check] No revoked seats — reject test skipped.");
  }

  if (ok) console.log("[check] OK — revocation blocklist is live and enforced.");
  else console.error("[check] FAILED — the webhook server reads safe/frontdesk-keys/revoked-seats.json directly.");
  return ok;
}

/** Report every seat's status: valid / expiring / expired / revoked, with days left. */
function checkExp(days) {
  const rows = collectSeatRecords();
  if (rows.length === 0) {
    console.log("No seats issued yet.");
    return;
  }
  const now = Date.now();
  const windowMs = days * 86400000;

  const statuses = rows.map((r) => {
    if (r.revoked) return { ...r, status: "revoked", daysLeft: null };
    if (r.exp === 0) return { ...r, status: "valid", daysLeft: null };
    const daysLeft = Math.ceil((r.exp * 1000 - now) / 86400000);
    if (daysLeft < 0) return { ...r, status: "expired", daysLeft };
    if (daysLeft <= days) return { ...r, status: "expiring", daysLeft };
    return { ...r, status: "valid", daysLeft };
  });

  const order = { revoked: 0, expired: 1, expiring: 2, valid: 3 };
  statuses.sort((a, b) => {
    const d = order[a.status] - order[b.status];
    if (d !== 0) return d;
    return (a.exp || Number.MAX_SAFE_INTEGER) - (b.exp || Number.MAX_SAFE_INTEGER);
  });

  const pad = (s, n) =>
    String(s ?? "")
      .padEnd(n)
      .slice(0, n);
  console.log("┌ seat ────────────────┬ kid ─────────┬ status ─────┬ expires ────┬ days left");
  for (const r of statuses) {
    const expLabel = r.exp === 0 ? "unlimited" : new Date(r.exp * 1000).toISOString().slice(0, 10);
    const daysLeft = r.daysLeft === null ? "—" : r.daysLeft < 0 ? `${r.daysLeft} (past)` : String(r.daysLeft);
    console.log(`│ ${pad(r.sub, 20)}│ ${pad(r.kid, 12)}│ ${pad(r.status, 11)}│ ${pad(expLabel, 11)}│ ${daysLeft}`);
  }

  const counts = statuses.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});
  console.log(
    `\n${statuses.length} seat(s): ${counts.valid || 0} valid, ${counts.expiring || 0} expiring (≤${days}d), ${counts.expired || 0} expired, ${counts.revoked || 0} revoked.`,
  );

  auditExpiredSeats(statuses);
  const archived = archiveExpiredSeats();
  if (archived > 0) {
    console.log(`Archived ${archived} expired seat record(s) to safe/frontdesk-keys/<kid>/expired/.`);
  }
}

const USAGE = `Usage:
  node scripts/keymanage.mjs create-master --kid <id>        (alias: generate-master)
  node scripts/keymanage.mjs create-agent-key                (agent X25519 keypair for encryption)
  node scripts/keymanage.mjs issue <sub> --exp <date|unlimited> [--kid <id>]
  node scripts/keymanage.mjs list                      (archive expired keys, then list seats)
  node scripts/keymanage.mjs export-seats                (write safe/frontdesk-keys/seats.json)
  node scripts/keymanage.mjs audit                       (show seat issue/expiry/revoke history)
  node scripts/keymanage.mjs audit-backfill              (seed audit.jsonl from the ledger if empty)
  node scripts/keymanage.mjs validate "<TA1....>"            (alias: verify)
  node scripts/keymanage.mjs challenge-test "<TA1....>"
  node scripts/keymanage.mjs crypto-self-test "<TA1....>"
  node scripts/keymanage.mjs check-exp [--days <N>]
  node scripts/keymanage.mjs archive-expired            (archive expired keys to <kid>/expired/)
  node scripts/keymanage.mjs revoke <sub>
  node scripts/keymanage.mjs check-revocation               (revoked-seat reject test)`;

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || "help";
  const kid = defaultKid(argv);

  if (cmd === "create-master" || cmd === "generate-master") {
    generateMaster(argValue(argv, "--kid"));
  } else if (cmd === "create-agent-key") {
    createAgentKey();
  } else if (cmd === "issue") {
    const sub = argv[1];
    const expRaw = argValue(argv, "--exp");
    const exp = argv.includes("--unlimited") ? 0 : expRaw !== undefined ? parseExp(expRaw) : undefined;
    if (exp === undefined) {
      console.error("issue requires --exp <date> or --unlimited");
      process.exit(1);
    }
    issue(sub, { exp, kid });
  } else if (cmd === "list") {
    const archived = archiveExpiredSeats();
    if (archived > 0) exportSeats();
    listSeats();
  } else if (cmd === "export-seats") {
    exportSeats();
  } else if (cmd === "audit") {
    printAudit();
  } else if (cmd === "audit-backfill") {
    backfillAudit();
  } else if (cmd === "validate" || cmd === "verify") {
    const key = argv[1];
    if (!key) {
      console.error('validate requires a key:  node scripts/keymanage.mjs validate "TA1...."');
      process.exit(1);
    }
    console.log(JSON.stringify(verifyLicenseKey(key), null, 2));
  } else if (cmd === "challenge-test") {
    const key = argv[1];
    if (!key) {
      console.error('challenge-test requires a key:  node scripts/keymanage.mjs challenge-test "TA1...."');
      process.exit(1);
    }
    challengeTest(key);
  } else if (cmd === "crypto-self-test") {
    const key = argv[1];
    if (!key) {
      console.error('crypto-self-test requires a key:  node scripts/keymanage.mjs crypto-self-test "TA1...."');
      process.exit(1);
    }
    cryptoSelfTest(key);
  } else if (cmd === "check-exp") {
    const days = Number(argValue(argv, "--days")) || 30;
    checkExp(days);
  } else if (cmd === "revoke") {
    revokeSeat(argv[1]);
  } else if (cmd === "archive-expired") {
    const archived = archiveExpiredSeats();
    if (archived > 0) exportSeats();
    console.log(
      archived > 0
        ? `Archived ${archived} expired seat record(s) to safe/frontdesk-keys/<kid>/expired/.`
        : "No expired seats to archive (all live records valid/unlimited).",
    );
  } else if (cmd === "check-revocation") {
    if (!checkRevocation()) process.exit(1);
  } else {
    console.log(USAGE);
    process.exit(cmd && cmd !== "help" ? 1 : 0);
  }
}

main();
