#!/usr/bin/env node
/**
 * dev-centre-admins.mjs — manage the REPO-PROVISIONED tier_1 admin list.
 *
 * Writes `electron/src/main/dev-centre-admins.json`, which is compiled into the app and is
 * therefore the only admin source a BUILD has (`.env` is gitignored and is not packaged).
 * The loader — `electron/src/main/dev-centre-admins.js` — validates the same file at startup,
 * and this CLI validates through that module so the two can never disagree about what is
 * acceptable.
 *
 * NOTHING SECRET IS EVER STORED OR PRINTED. A password is hashed to a `scrypt$…` verifier
 * here and only the verifier is written; a `TA1…` licence is refused outright, because a
 * licence is the seat's private key and this file is committed AND shipped. For a
 * licence-based admin, add the address with `--licence-only`: it becomes tier_1, and the
 * licence is verified against the key store on every sign-in (so revocation and expiry
 * apply, which a stored licence in `.env` never did).
 *
 * Usage:
 *   node scripts/dev-centre-admins.mjs list
 *   node scripts/dev-centre-admins.mjs add <email> --password-stdin
 *   node scripts/dev-centre-admins.mjs add <email> --verifier '<scrypt$…>'
 *   node scripts/dev-centre-admins.mjs add <email> --licence-only
 *   node scripts/dev-centre-admins.mjs remove <email>
 *   node scripts/dev-centre-admins.mjs check
 *
 * `--file <path>` retargets the list (for a test run); the default is the real one.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");

const admins = require(path.join(REPO, "electron", "src", "main", "dev-centre-admins.js"));
const pwdv = require(path.join(REPO, "electron", "src", "main", "password-verifier.js"));

const argv = process.argv.slice(2);
const value = (name, fallback = null) => {
  const at = argv.indexOf(name);
  return at !== -1 && argv[at + 1] ? argv[at + 1] : fallback;
};
const FILE = path.resolve(value("--file", admins.ADMINS_FILE));

// Flag VALUES are not positional arguments, so walk with the index rather than using
// indexOf() — a repeated value would otherwise resolve to its first occurrence.
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--file" || arg === "--verifier") {
    i += 1;
    continue;
  }
  if (arg.startsWith("--")) continue;
  positional.push(arg);
}
const command = positional[0] || "list";
const target = positional[1] || null;

const USAGE = `usage: dev-centre-admins.mjs list | add <email> (--password-stdin | --verifier <scrypt$…> | --licence-only) | remove <email> | check`;

/** A path that reads well in output — relative when it is inside the repo, absolute otherwise. */
const label = (file) => {
  const relative = path.relative(REPO, file);
  return relative && !relative.startsWith("..") ? relative : file;
};

function readFile() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch (err) {
    const absent = err && err.code === "ENOENT";
    console.error(absent ? `❌ ${FILE} does not exist.` : `❌ ${FILE} is unreadable: ${err.message}`);
    process.exit(1);
  }
  const { admins: valid, problems } = admins.validate(parsed.admins);
  return { parsed, entries: valid, problems };
}

/** Write the file, validating FIRST so an unacceptable entry can never land on disk. */
function writeFile(parsed, entries) {
  const { problems } = admins.validate(entries);
  if (problems.length) {
    console.error("❌ Refusing to write — the loader would reject it:");
    for (const p of problems) console.error(`   • ${p}`);
    process.exit(1);
  }
  const next = { ...parsed, stamp: new Date().toISOString().slice(0, 10), admins: entries };
  fs.writeFileSync(FILE, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  console.log(`✅ Wrote ${label(FILE)} — ${entries.length} admin(s), stamp ${next.stamp}.`);
  console.log("   Rebuild the app for it to take effect (electron/src/** is what ships).");
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8").replace(/\r?\n$/, "");
  } catch {
    return "";
  }
}

function describe(entry) {
  if (!entry.verifier) return "licence-only (verified against the key store on every sign-in)";
  return `scrypt verifier (${pwdv.passwordVerifierInfo(entry.verifier)?.algo || "scrypt"})`;
}

if (command === "list") {
  const { entries, parsed } = readFile();
  console.log(`${label(FILE)} — stamp ${parsed.stamp || "unknown"}, ${entries.length} admin(s)`);
  for (const entry of entries) console.log(`  ${entry.email}  —  ${describe(entry)}`);
  if (!entries.length) console.log("  (none — a build with no .env admins would be un-sign-in-able)");
  process.exit(0);
}

if (command === "check") {
  const { entries, problems, parsed } = readFile();
  console.log(`${label(FILE)} — stamp ${parsed.stamp || "unknown"}, ${entries.length} admin(s)`);
  if (problems.length) {
    console.error(`❌ ${problems.length} problem(s):`);
    for (const p of problems) console.error(`   • ${p}`);
    process.exit(1);
  }
  const licenceOnly = entries.filter((e) => !e.verifier).length;
  console.log(`  ok   every entry is a valid address with a scrypt verifier or licence-only`);
  console.log(`  ok   ${licenceOnly} licence-only, ${entries.length - licenceOnly} with a stored verifier`);
  console.log("  note  no plaintext secret and no TA1 licence is storable here by construction");
  process.exit(0);
}

if (command === "add") {
  if (!target) {
    console.error(USAGE);
    process.exit(1);
  }
  const email = pwdv.tryNormalizeEmail(target);
  if (!email) {
    console.error(`❌ ${target} is not a valid email address.`);
    process.exit(1);
  }
  const { parsed, entries } = readFile();

  let verifier = null;
  if (argv.includes("--licence-only")) {
    verifier = null;
  } else if (argv.includes("--password-stdin")) {
    if (process.stdin.isTTY) {
      console.error("❌ --password-stdin expects the password on stdin, not a terminal. Try:");
      console.error(`   printf '%s' 'the-password' | node scripts/dev-centre-admins.mjs add ${email} --password-stdin`);
      process.exit(1);
    }
    const password = readStdin();
    try {
      verifier = pwdv.makePasswordVerifier(password);
    } catch (err) {
      console.error(`❌ ${err.message}`);
      process.exit(1);
    }
    console.log("   hashed the password to a scrypt verifier — the password itself is not stored anywhere");
  } else if (value("--verifier")) {
    verifier = value("--verifier");
  } else {
    console.error(USAGE);
    process.exit(1);
  }

  const without = entries.filter((e) => e.email !== email);
  const next = [...without, { email, verifier }].sort((a, b) => a.email.localeCompare(b.email));
  writeFile(parsed, next);
  process.exit(0);
}

if (command === "remove") {
  if (!target) {
    console.error(USAGE);
    process.exit(1);
  }
  const email = pwdv.tryNormalizeEmail(target);
  const { parsed, entries } = readFile();
  const next = entries.filter((e) => e.email !== email);
  if (next.length === entries.length) {
    console.error(`❌ ${target} is not in the list.`);
    process.exit(1);
  }
  writeFile(parsed, next);
  process.exit(0);
}

console.error(USAGE);
process.exit(1);
