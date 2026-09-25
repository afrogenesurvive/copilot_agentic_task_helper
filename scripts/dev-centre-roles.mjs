#!/usr/bin/env node
/**
 * CLI for the Dev Centre role registry (`safe/dev-centre-roles.json`).
 *
 * The registry module itself is CommonJS (`electron/src/main/dev-centre-roles.js`)
 * because the Electron main process needs to read it synchronously while installing
 * the IPC gate. This wrapper is the operator-facing front door so nobody has to
 * hand-edit credentials JSON.
 *
 *   node scripts/dev-centre-roles.mjs path
 *   node scripts/dev-centre-roles.mjs list
 *   node scripts/dev-centre-roles.mjs get  someone@example.com
 *   node scripts/dev-centre-roles.mjs add  someone@example.com '<secret>' [tier_1|tier_2]
 *   node scripts/dev-centre-roles.mjs add  someone@example.com -          # secret on stdin
 *   node scripts/dev-centre-roles.mjs role someone@example.com tier_1
 *   node scripts/dev-centre-roles.mjs remove someone@example.com
 *
 * ADMINS DO NOT LIVE HERE. `.env` `DEV_CENTRE_ADMINS` holds the admins (always
 * tier_1); this registry holds everybody else (tier_2 by default). An email in
 * both is a conflict — `.env` wins, and the app reports it as a problem.
 *
 * The `<secret>` may be either a plaintext string or a `scrypt$…` verifier minted
 * by pkm (`pkm claims set <registry> <seat> --password-stdin`), which lets an
 * operator store no plaintext secret at all. Pass `-` to read it from stdin: an
 * argv secret lands in your shell history, and a verifier contains `$` characters
 * that zsh will try to expand.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// The app's own module, so there is exactly ONE implementation of the file
// format, the role list and the email normalisation.
const roles = require(path.resolve(__dirname, "..", "electron", "src", "main", "dev-centre-roles.js"));

/** Read the secret from stdin when the operator passed `-` (or nothing). */
function readSecret(token) {
  if (token && token !== "-") return token;
  const chunks = [];
  const fd = process.stdin.fd;
  const buf = Buffer.alloc(1024);
  for (;;) {
    let read;
    try {
      read = fs.readSync(fd, buf, 0, buf.length, null);
    } catch {
      break;
    }
    if (!read) break;
    chunks.push(Buffer.from(buf.subarray(0, read)));
  }
  const text = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  if (!text) {
    console.error("no secret provided (pass it as an argument or on stdin)");
    process.exit(1);
  }
  return text;
}

function usage() {
  console.log(`usage:
  dev-centre-roles.mjs path
  dev-centre-roles.mjs list
  dev-centre-roles.mjs get <email>
  dev-centre-roles.mjs add <email> <secret|-> [tier_1|tier_2]
  dev-centre-roles.mjs role <email> <tier_1|tier_2>
  dev-centre-roles.mjs remove <email>

  roles: ${roles.ROLES.join(", ")}  (tier_2 = everything except Key Manager and Accounts & Keys)`);
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") return usage();

  if (cmd === "path") return console.log(roles.rolesPath());

  if (cmd === "list") {
    const res = roles.listRoles();
    console.log(`Role registry: ${res.path}`);
    if (res.updatedAt) console.log(`Updated:       ${res.updatedAt}`);
    if (res.error) console.log(`⚠️  unreadable: ${res.error}`);
    if (!res.count) return console.log("(no users — only the .env admins can sign in)");
    for (const u of res.users) {
      const kind = u.verifier ? "scrypt verifier" : u.hasSecret ? "plaintext" : "NO SECRET";
      console.log(`  ${u.email.padEnd(34)} ${u.role.padEnd(7)} ${kind}`);
    }
    return;
  }

  if (cmd === "get") {
    const email = argv[1];
    if (!email) return console.error("usage: get <email>");
    const user = roles.getUser(email);
    if (!user) {
      console.log(`${email} is not in the role registry.`);
      return;
    }
    // Never echo the stored secret — only what kind it is.
    console.log(
      JSON.stringify({ email: user.email, role: user.role, addedAt: user.addedAt, secret: roles.describeSecret(user.key) }, null, 2),
    );
    return;
  }

  if (cmd === "add" || cmd === "set") {
    const email = argv[1];
    const secretToken = argv[2];
    const role = argv[3];
    if (!email || !secretToken) return console.error("usage: add <email> <secret|-> [tier_1|tier_2]");
    try {
      const res = roles.setUser(email, { key: readSecret(secretToken), ...(role ? { role } : {}) });
      console.log(`${res.email} → ${res.role} (${res.verifier ? "scrypt verifier" : "plaintext"})`);
      console.log(`Written to ${res.path} (${res.count} user(s)).`);
    } catch (err) {
      console.error(`error: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  if (cmd === "role") {
    const [, email, role] = argv;
    if (!email || !role) return console.error("usage: role <email> <tier_1|tier_2>");
    try {
      const res = roles.setUser(email, { role });
      console.log(`${res.email} → ${res.role}`);
    } catch (err) {
      console.error(`error: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  if (cmd === "remove" || cmd === "rm") {
    const email = argv[1];
    if (!email) return console.error("usage: remove <email>");
    try {
      const res = roles.removeUser(email);
      console.log(res.removed ? `Removed ${res.email}.` : `${res.email} was not in the registry.`);
    } catch (err) {
      console.error(`error: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  console.error(`unknown command "${cmd}"`);
  usage();
  process.exit(1);
}

main();
