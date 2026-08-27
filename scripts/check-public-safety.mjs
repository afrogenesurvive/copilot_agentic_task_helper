#!/usr/bin/env node
/**
 * check-public-safety.mjs — pre-commit secret + sensitive-path scanner.
 *
 * Scans exactly the files that WOULD be committed (tracked modified/added +
 * untracked non-ignored), plus a `git ls-files` sanity pass over the tracked
 * index. Exit codes: 0 = clean, 1 = [BLOCKER], 2 = [WARN]-only.
 *
 * Detects: GitHub/OpenAI/HuggingFace/Slack/AWS/Google secret prefixes, PEM
 * private keys, exact secret-storage paths, and known-bad paths in the commit
 * set. Placeholder/example values are reported as WARN for manual review.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO = process.cwd();
const SELF = "scripts/check-public-safety.mjs";

// Strong indicators of a real secret (BLOCKER).
const BLOCKER_RE = [
  [/gh[pousr]_[A-Za-z0-9]{30,}/, "GitHub token"],
  [/sk-[A-Za-z0-9]{20,}/, "OpenAI/DeepSeek-style API key"],
  [/hf_[A-Za-z0-9]{20,}/, "HuggingFace token"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/AKIA[0-9A-Z]{16}/, "AWS access key id"],
  [/AIza[0-9A-Za-z_-]{30,}/, "Google API key"],
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, "PEM private key"],
];

// Sensitive paths (BLOCKER if they appear in the would-be-committed set).
const BAD_PATH_RE = [
  [/docs\/safe\//, "docs/safe/ (internal docs)"],
  [/(^|\/)\.env(\.|$)/, ".env file"],
  [/(^|\/)logs\//, "logs/ dir"],
  [/(^|\/)safe\//, "safe/ dir"],
  [/storage\//, "storage/ dir"],
  [/node_modules\//, "node_modules"],
  [/\.venv\//, ".venv"],
  [/\/Library\/Application Support\//, "macOS app config path"],
  [/%APPDATA%/, "Windows appdata path"],
];

// Placeholders / likely-redacted or example values (WARN).
const WARN_RE = [
  [/sk-your-key-here|sk-xxxxx|your-api-key|your_token|REPLACE_ME|xxxxx/i, "placeholder key"],
  [/YOURDOMAIN|yourdomain|chat\.example\.com|example\.com/i, "example domain"],
  [/ghp_[A-Za-z0-9]{6,}\.{3}/, "truncated/placeholder GitHub token"],
  [/[A-Za-z0-9+/]{45,}={0,2}/, "long base64 blob"],
];

let blockers = [];
let warns = [];

function git(cmd) {
  return execSync(cmd, { cwd: REPO, encoding: "utf8" })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function scanFile(file) {
  if (file === SELF) return; // the scanner never flags its own pattern defs
  const isLockfile = /package-lock\.json$/.test(file);
  let content;
  try {
    content = fs.readFileSync(path.join(REPO, file), "utf8");
  } catch {
    return; // deleted or unreadable
  }
  content.split("\n").forEach((line, i) => {
    const n = i + 1;
    const snippet = line.trim().slice(0, 120);
    for (const [re, label] of BLOCKER_RE) if (re.test(line)) blockers.push({ file, line: n, label, snippet });
    // Lockfiles carry npm integrity hashes (sha512-… base64) — skip WARN noise there,
    // but always run BLOCKER patterns above.
    if (isLockfile) return;
    for (const [re, label] of WARN_RE) if (re.test(line)) warns.push({ file, line: n, label, snippet });
  });
}

function pathCheck(file) {
  for (const [re, label] of BAD_PATH_RE) {
    if (re.test(file)) blockers.push({ file, line: 1, label, snippet: file });
  }
}

const modified = git("git diff --name-only --diff-filter=ACM HEAD"); // tracked modified/added (content)
const untracked = git("git ls-files --others --exclude-standard"); // new non-ignored files
const tracked = git("git ls-files"); // sanity pass over the whole index

const commitSet = new Set([...modified, ...untracked]);
for (const file of commitSet) {
  pathCheck(file);
  scanFile(file);
}
// Sanity pass: also scan already-tracked files (catches previously-committed secrets).
for (const file of tracked) {
  if (!commitSet.has(file)) scanFile(file);
}

const dedupe = (arr) =>
  arr.filter((x, i) => arr.findIndex((y) => y.file === x.file && y.line === x.line && y.label === x.label) === i);
blockers = dedupe(blockers);
warns = dedupe(warns);

console.log(`\n🔍 Public-safety scan — ${commitSet.size} file(s) in commit set (${tracked.length} tracked total)`);
if (!blockers.length && !warns.length) {
  console.log("✅ Clean — no secret values or sensitive paths found.\n");
  process.exit(0);
}
if (blockers.length) {
  console.log(`\n⛔ [BLOCKER] ${blockers.length} finding(s):`);
  for (const b of blockers) console.log(`  ${b.file}:${b.line} — ${b.label}\n      ${b.snippet}`);
}
if (warns.length) {
  console.log(`\n⚠️  [WARN] ${warns.length} finding(s):`);
  for (const w of warns) console.log(`  ${w.file}:${w.line} — ${w.label}\n      ${w.snippet}`);
}
console.log();
process.exit(blockers.length ? 1 : 2);
