#!/usr/bin/env node
/**
 * Frontdesk license key tooling (DEV-ONLY — private keys must NEVER be committed).
 *
 * Adapted from ai_transcription_agent/scripts/license.mjs for the frontdesk
 * system. Adds a per-seat X25519 key so the license key ALSO encrypts
 * frontdesk ↔ agent traffic (ECDH → AES-256-GCM), per the v2 plan.
 *
 * Usage:
 *   node scripts/frontdesk-license.mjs generate-master --kid mk-2026-08
 *   node scripts/frontdesk-license.mjs issue <sub> --exp 2027-12-31 [--kid mk-2026-08]
 *   node scripts/frontdesk-license.mjs verify "TA1...."
 *   node scripts/frontdesk-license.mjs challenge-test "TA1...."
 *   node scripts/frontdesk-license.mjs revoke <sub>
 *   node scripts/frontdesk-license.mjs archive-expired
 *
 * Key format (single string):
 *   TA1.<b64url(certJson)>.<b64url(sig)>.<b64url(seatKeys)>
 *     certJson = { app, v, sub, exp, kid, pub, enc }
 *       pub = seat Ed25519 public key (base64url)
 *       enc = seat X25519 public key (base64url)
 *     sig      = Ed25519 signature by the MASTER private key over the certJson bytes
 *     seatKeys = base64url raw 64 bytes: 32-byte Ed25519 private seed + 32-byte X25519 private seed
 *     exp      = 0 means UNLIMITED; otherwise unix seconds
 *
 * Trust chain:
 *   MASTER keypair (maintainer, kept offline in safe/frontdesk-keys, gitignored)
 *     └── signs each seat CERT (kid, sub, exp, pub, enc)
 *   SEAT keypair  (Ed25519 + X25519; private seeds embedded in the license key)
 *
 * Encryption (frontdesk ↔ agent):
 *   ECDH(seat_x25519_priv, agent_x25519_pub) == ECDH(agent_x25519_priv, seat_x25519_pub)
 *     → SHA-256("frontdesk-v1" ‖ shared) → 32-byte AES-256-GCM key, both directions.
 *   Agent X25519 keypair lives in safe/frontdesk-keys/agent/ (gitignored).
 *
 * Login handshake: client sends the FULL license (private seeds) once to prove
 * possession; the server verifies it and keeps only { sub, pub, enc } in the
 * session. Subsequent messages carry only public info + the AES-GCM envelope —
 * the seat private seeds never transit again.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEV_KEYS_DIR = path.resolve(__dirname, "..", "safe", "frontdesk-keys");
export const RING_FILE = path.join(DEV_KEYS_DIR, "ring.json");
export const REVOKED_SEATS_FILE = path.join(DEV_KEYS_DIR, "revoked-seats.json");

export const APP_ID = "frontdesk-agent";
export const VERSION = 1;

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const fromB64u = (s) => Buffer.from(s, "base64url");
const KEY_RE = /^TA1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

// ── Ring management ────────────────────────────────────────────────────────────

export function loadRing() {
  if (!fs.existsSync(RING_FILE)) return { keys: [] };
  try {
    return JSON.parse(fs.readFileSync(RING_FILE, "utf8"));
  } catch {
    return { keys: [] };
  }
}

export function saveRing(ring) {
  fs.mkdirSync(DEV_KEYS_DIR, { recursive: true });
  fs.writeFileSync(RING_FILE, JSON.stringify(ring, null, 2) + "\n", "utf8");
}

// ── Per-seat revocation ─────────────────────────────────────────────────────────

export function loadRevokedSeats() {
  if (!fs.existsSync(REVOKED_SEATS_FILE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(REVOKED_SEATS_FILE, "utf8"));
    return Array.isArray(data.seats) ? data.seats : [];
  } catch {
    return [];
  }
}

export function saveRevokedSeats(seats) {
  fs.mkdirSync(DEV_KEYS_DIR, { recursive: true });
  fs.writeFileSync(REVOKED_SEATS_FILE, JSON.stringify({ seats, updatedAt: new Date().toISOString() }, null, 2) + "\n", "utf8");
}

/**
 * Revoke a seat: adds `sub` to the per-seat blocklist (authoritative) and moves
 * the seat's ledger record + key file from safe/frontdesk-keys/<kid>/issued/
 * into <kid>/revoked/ (tombstoned: <sub>.json marked revoked + revokedAt;
 * <sub>.key ARCHIVED rather than deleted so the seat can be audited or
 * reinstated).
 *
 * NOTE: revocation is read live from revoked-seats.json by the webhook server
 * on every verify, so no source-file sync step is needed (unlike the
 * transcription agent, which embeds the blocklist into shipped binaries).
 */
export function revokeSeat(sub) {
  if (!sub) {
    console.error("revoke requires a seat id:  node scripts/frontdesk-license.mjs revoke <sub>");
    process.exit(1);
  }
  const seats = loadRevokedSeats();
  if (!seats.includes(sub)) seats.push(sub);
  saveRevokedSeats(seats);

  const revokedAt = new Date().toISOString();
  let revokedKid = null;
  for (const kid of fs
    .readdirSync(DEV_KEYS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)) {
    const revokedDir = path.join(DEV_KEYS_DIR, kid, "revoked");
    for (const dirName of ["issued", "expired"]) {
      const srcDir = path.join(DEV_KEYS_DIR, kid, dirName);
      if (!fs.existsSync(srcDir)) continue;
      for (const f of fs.readdirSync(srcDir)) {
        if (!f.startsWith(`${sub}.`)) continue;
        revokedKid = revokedKid || kid;
        const src = path.join(srcDir, f);
        const dst = path.join(revokedDir, f);
        try {
          if (f.endsWith(".json")) {
            const rec = JSON.parse(fs.readFileSync(src, "utf8"));
            rec.revoked = true;
            rec.revokedAt = rec.revokedAt || revokedAt;
            fs.writeFileSync(src, JSON.stringify(rec, null, 2) + "\n", "utf8");
          }
          fs.mkdirSync(revokedDir, { recursive: true });
          fs.renameSync(src, dst);
          console.log(`  archived safe/frontdesk-keys/${kid}/${f} → ${kid}/revoked/`);
        } catch (err) {
          console.log(`  ⚠️  could not archive safe/frontdesk-keys/${kid}/${f}: ${err.message}`);
        }
      }
    }
  }

  logAudit("revoke", {
    sub,
    kid: revokedKid ?? null,
    detail: `${seats.length} seat(s) blocked`,
  });
  exportSeats();

  console.log(`Revoked seat "${sub}". ${seats.length} seat(s) blocked.`);
  console.log("Record + key archived to safe/frontdesk-keys/<kid>/revoked/ (gitignored).");
  console.log("The webhook server reads revoked-seats.json live — no rebuild required.");
  console.log("NOTE: any config exported or stored under this seat's key becomes unreadable once revoked.");
}

/**
 * Archive every time-expired seat record still living in issued/ into <kid>/expired/
 * (tombstoned). Idempotent; per record; skips revoked. Returns count archived.
 */
export function archiveExpiredSeats() {
  const now = Date.now();
  const auditSeen = readExpiryAuditKeys();
  let moved = 0;
  if (!fs.existsSync(DEV_KEYS_DIR)) return 0;
  const kids = fs
    .readdirSync(DEV_KEYS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  for (const kid of kids) {
    const issuedDir = path.join(DEV_KEYS_DIR, kid, "issued");
    if (!fs.existsSync(issuedDir)) continue;
    const expiredDir = path.join(DEV_KEYS_DIR, kid, "expired");
    for (const f of fs.readdirSync(issuedDir)) {
      if (!f.endsWith(".json")) continue;
      const src = path.join(issuedDir, f);
      let rec;
      try {
        rec = JSON.parse(fs.readFileSync(src, "utf8"));
      } catch {
        continue;
      }
      if (rec.revoked === true) continue;
      if (typeof rec.exp !== "number" || rec.exp === 0 || now < rec.exp * 1000) continue;
      const dst = path.join(expiredDir, f);
      try {
        rec.expired = true;
        rec.expiredAt = rec.expiredAt || new Date().toISOString();
        fs.writeFileSync(src, JSON.stringify(rec, null, 2) + "\n", "utf8");
        fs.mkdirSync(expiredDir, { recursive: true });
        fs.renameSync(src, dst);
        const keySrc = src.slice(0, -".json".length) + ".key";
        const keyDst = dst.slice(0, -".json".length) + ".key";
        if (fs.existsSync(keySrc)) fs.renameSync(keySrc, keyDst);
        const auditKey = `${rec.sub}|${rec.exp}`;
        if (!auditSeen.has(auditKey)) {
          logAudit("expiry", {
            sub: rec.sub,
            kid: rec.kid ?? kid,
            exp: rec.exp,
            detail: `expired ${new Date(rec.exp * 1000).toISOString()}`,
          });
          auditSeen.add(auditKey);
        }
        console.log(`  archived safe/frontdesk-keys/${kid}/${f} → ${kid}/expired/`);
        moved++;
      } catch (err) {
        console.log(`  ⚠️  could not archive safe/frontdesk-keys/${kid}/${f}: ${err.message}`);
      }
    }
  }
  return moved;
}

export function resolveRingEntry(kid) {
  const ring = loadRing();
  return (ring.keys || []).find((k) => k.kid === kid) || null;
}

// ── Master key generation ─────────────────────────────────────────────────────

export function generateMaster(kid) {
  if (!kid) {
    console.error("generate-master requires --kid <id>  (e.g. mk-2026-08)");
    process.exit(1);
  }
  const dir = path.join(DEV_KEYS_DIR, kid);
  fs.mkdirSync(dir, { recursive: true });

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pubJwk = publicKey.export({ format: "jwk" });
  const privJwk = privateKey.export({ format: "jwk" });

  fs.writeFileSync(path.join(dir, "private.key"), privJwk.d + "\n", "utf8");
  fs.writeFileSync(path.join(dir, "public.key"), pubJwk.x + "\n", "utf8");
  fs.writeFileSync(
    path.join(dir, "key.json"),
    JSON.stringify({ kid, publicKey: pubJwk.x, createdAt: new Date().toISOString(), notAfter: null }, null, 2) + "\n",
    "utf8",
  );

  const ring = loadRing();
  ring.keys = ring.keys || [];
  const idx = ring.keys.findIndex((k) => k.kid === kid);
  const entry = { kid, publicKey: pubJwk.x, notAfter: null };
  if (idx >= 0) ring.keys[idx] = entry;
  else ring.keys.push(entry);
  saveRing(ring);

  console.log(`Master key generated for kid="${kid}"`);
  console.log(`  private : ${dir}/private.key   (NEVER COMMIT — safe/ is gitignored)`);
  console.log(`  public  : ${dir}/public.key`);
  console.log(`  ring    : ${RING_FILE}`);
}

export function loadMasterPrivKey(kid) {
  const file = path.join(DEV_KEYS_DIR, kid, "private.key");
  if (!fs.existsSync(file)) {
    console.error(`No master private key for kid="${kid}" (expected ${file}). Run generate-master first.`);
    process.exit(1);
  }
  const d = fs.readFileSync(file, "utf8").trim();
  const entry = resolveRingEntry(kid);
  const x = entry ? entry.publicKey : null;
  if (!x) {
    console.error(`Kid "${kid}" not present in ring — regenerate or fix ring.json.`);
    process.exit(1);
  }
  return crypto.createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", x, d }, format: "jwk" });
}

// ── Issue ─────────────────────────────────────────────────────────────────────

export function parseExp(value) {
  const v = String(value).trim().toLowerCase();
  if (v === "unlimited" || v === "0" || v === "none" || v === "never") return 0;
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) {
    console.error(`Cannot parse --exp "${value}" — use a date like 2027-12-31 or "unlimited".`);
    process.exit(1);
  }
  return Math.floor(ms / 1000);
}

export function issue(sub, { exp, kid }) {
  if (!sub) {
    console.error("issue requires a seat id:  node scripts/frontdesk-license.mjs issue <sub> --exp ...");
    process.exit(1);
  }
  const masterPriv = loadMasterPrivKey(kid);

  // Seat keypair #1: Ed25519 (license trust / challenge-response).
  const { publicKey: seatPub, privateKey: seatPriv } = crypto.generateKeyPairSync("ed25519");
  const seatPubX = seatPub.export({ format: "jwk" }).x;
  const seatPrivD = seatPriv.export({ format: "jwk" }).d;

  // Seat keypair #2: X25519 (frontdesk ↔ agent encryption via ECDH).
  const { publicKey: encPub, privateKey: encPriv } = crypto.generateKeyPairSync("x25519");
  const encPubX = encPub.export({ format: "jwk" }).x;
  const encPrivD = encPriv.export({ format: "jwk" }).d;

  const certJson = JSON.stringify({ app: APP_ID, v: VERSION, sub, exp, kid, pub: seatPubX, enc: encPubX });
  const sig = crypto.sign(null, fromB64u(b64u(certJson)), masterPriv);

  // seatKeys = 32-byte Ed25519 seed + 32-byte X25519 seed (64 raw bytes).
  const seatKeys = Buffer.concat([fromB64u(seatPrivD), fromB64u(encPrivD)]);
  const licenseKey = `TA1.${b64u(certJson)}.${b64u(sig)}.${b64u(seatKeys)}`;

  const dir = path.join(DEV_KEYS_DIR, kid, "issued");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sub}.key`), licenseKey + "\n", "utf8");
  const record = {
    sub,
    kid,
    exp,
    issuedAt: new Date().toISOString(),
    pub: seatPubX,
    enc: encPubX,
    ...(exp !== 0 ? { expUtc: new Date(exp * 1000).toISOString() } : {}),
  };
  fs.writeFileSync(path.join(dir, `${sub}.json`), JSON.stringify(record, null, 2) + "\n", "utf8");

  logAudit("issue", {
    sub,
    kid,
    exp,
    detail: exp === 0 ? "unlimited" : `expires ${new Date(exp * 1000).toISOString()}`,
  });
  exportSeats();

  const expLabel = exp === 0 ? "unlimited" : `${exp} = ${new Date(exp * 1000).toISOString()} UTC`;
  console.log(`Issued license for seat "${sub}" (kid=${kid}, exp=${expLabel}):`);
  console.log("");
  console.log(licenseKey);
  console.log("");
  console.log(`Record saved: ${dir}/${sub}.key`);
  return licenseKey;
}

// ── Verify ────────────────────────────────────────────────────────────────────

export function verifyLicenseKey(licenseKey, now = Date.now()) {
  const m = KEY_RE.exec(licenseKey);
  if (!m) return { ok: false, reason: "malformed" };
  const [, certB64, sigB64, seatKeysB64] = m;

  let cert;
  try {
    cert = JSON.parse(fromB64u(certB64).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed_cert" };
  }
  if (cert.app !== APP_ID || cert.v !== VERSION) return { ok: false, reason: "app_mismatch" };

  const entry = resolveRingEntry(cert.kid);
  if (!entry) return { ok: false, reason: "unknown_kid" };
  if (entry.notAfter && now >= entry.notAfter * 1000) return { ok: false, reason: "retired_kid" };
  if (loadRevokedSeats().includes(cert.sub)) return { ok: false, reason: "revoked_seat" };

  const masterPub = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: entry.publicKey }, format: "jwk" });
  const sigValid = crypto.verify(null, fromB64u(certB64), masterPub, fromB64u(sigB64));
  if (!sigValid) return { ok: false, reason: "bad_signature" };

  // Seat possession check: the Ed25519 private seed (first 32 bytes of seatKeys)
  // must derive the same public key as cert.pub.
  let seatKeys = null;
  try {
    seatKeys = fromB64u(seatKeysB64);
  } catch {
    return { ok: false, reason: "bad_seat_key" };
  }
  const edD = seatKeys.subarray(0, 32).toString("base64url");
  let derivedPub;
  try {
    const seatPriv = crypto.createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", x: cert.pub, d: edD }, format: "jwk" });
    derivedPub = seatPriv.export({ format: "jwk" }).x;
  } catch {
    return { ok: false, reason: "bad_seat_key" };
  }
  if (derivedPub !== cert.pub) return { ok: false, reason: "key_mismatch" };

  // Encryption readiness: seatKeys must contain the X25519 seed (64 bytes total).
  const encReady = seatKeys.length === 64 && typeof cert.enc === "string";

  if (cert.exp !== 0 && now >= cert.exp * 1000) return { ok: false, reason: "expired" };

  return {
    ok: true,
    claims: { app: cert.app, v: cert.v, sub: cert.sub, exp: cert.exp, kid: cert.kid, pub: cert.pub, enc: cert.enc ?? null },
    encReady,
  };
}

/**
 * Verify a bare cert + signature (no seat-possession check). Used by the
 * degraded `[fd1]` fallback path, where the client sends only the PUBLIC cert +
 * signature. Possession is proven separately by the fact that only the seat's
 * X25519 private key can produce a decryptable envelope. This only proves the
 * cert is genuinely issued by the master ring (and not revoked/expired).
 * Returns { ok, claims } or { ok: false, reason }.
 */
export function verifyCert(certB64, sigB64, now = Date.now()) {
  let cert;
  try {
    cert = JSON.parse(fromB64u(certB64).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed_cert" };
  }
  if (cert.app !== APP_ID || cert.v !== VERSION) return { ok: false, reason: "app_mismatch" };
  const entry = resolveRingEntry(cert.kid);
  if (!entry) return { ok: false, reason: "unknown_kid" };
  if (entry.notAfter && now >= entry.notAfter * 1000) return { ok: false, reason: "retired_kid" };
  if (loadRevokedSeats().includes(cert.sub)) return { ok: false, reason: "revoked_seat" };
  if (cert.exp !== 0 && now >= cert.exp * 1000) return { ok: false, reason: "expired" };
  if (!cert.enc) return { ok: false, reason: "no_enc_key" };
  const masterPub = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: entry.publicKey }, format: "jwk" });
  let sigValid = false;
  try {
    sigValid = crypto.verify(null, fromB64u(certB64), masterPub, fromB64u(sigB64));
  } catch {
    sigValid = false;
  }
  if (!sigValid) return { ok: false, reason: "bad_signature" };
  return { ok: true, claims: cert };
}

// ── Challenge / response (mirrors the handshake the webapp will use) ──────────

export function challengeTest(licenseKey) {
  const res = verifyLicenseKey(licenseKey);
  if (!res.ok) {
    console.log(JSON.stringify({ ok: false, reason: res.reason }, null, 2));
    process.exit(1);
  }
  const m = KEY_RE.exec(licenseKey);
  const seatPrivD = fromB64u(m[3]).subarray(0, 32).toString("base64url");
  const seatPriv = crypto.createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", x: res.claims.pub, d: seatPrivD }, format: "jwk" });
  const seatPub = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: res.claims.pub }, format: "jwk" });

  const nonce = crypto.randomBytes(32);
  const sig = crypto.sign(null, nonce, seatPriv);
  const ok = crypto.verify(null, nonce, seatPub, sig);

  console.log(JSON.stringify({ ok, challengeResponseVerified: ok, claims: res.claims, encReady: res.encReady }, null, 2));
  return ok;
}

// ── Seat ledger (track issued keys from safe/frontdesk-keys/<kid>/issued/*.json) ──

export function collectSeatRecords() {
  const revoked = loadRevokedSeats();
  const rows = [];
  if (!fs.existsSync(DEV_KEYS_DIR)) return rows;
  const kids = fs
    .readdirSync(DEV_KEYS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const seen = new Set();
  for (const kid of kids) {
    for (const dirName of ["issued", "revoked", "expired"]) {
      const dir = path.join(DEV_KEYS_DIR, kid, dirName);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".json")) continue;
        try {
          const rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
          if (!rec.sub || seen.has(rec.sub)) continue;
          seen.add(rec.sub);
          rows.push({
            sub: rec.sub,
            kid: rec.kid,
            exp: rec.exp,
            issuedAt: rec.issuedAt,
            pub: rec.pub,
            enc: rec.enc ?? null,
            revoked: rec.revoked === true || revoked.includes(rec.sub),
            revokedAt: rec.revokedAt ?? null,
            expired: rec.expired === true,
            expiredAt: rec.expiredAt ?? null,
            archived: dirName !== "issued",
          });
        } catch {
          // ignore unreadable records
        }
      }
    }
  }
  return rows;
}

export function listSeats() {
  const rows = collectSeatRecords();
  if (rows.length === 0) {
    console.log(fs.existsSync(DEV_KEYS_DIR) ? "No seats issued yet." : "No keys issued yet (safe/frontdesk-keys does not exist).");
    return;
  }
  rows.sort((a, b) => String(a.issuedAt || "").localeCompare(String(b.issuedAt || "")));

  const now = Date.now();
  const expFmt = (exp) => (exp === 0 ? "unlimited" : new Date(exp * 1000).toISOString().slice(0, 10));
  const statusOf = (r) => {
    if (r.revoked) return "revoked";
    if (r.exp === 0) return "valid";
    return now >= r.exp * 1000 ? "expired" : "valid";
  };
  const pad = (s, n) =>
    String(s ?? "")
      .padEnd(n)
      .slice(0, n);
  console.log("┌ seat ────────────────┬ kid ─────────┬ status ─────┬ expires ────┬ enc? ─┬ issuedAt ─────────────────");
  for (const r of rows) {
    console.log(
      `│ ${pad(r.sub, 20)}│ ${pad(r.kid, 12)}│ ${pad(statusOf(r), 11)}│ ${pad(expFmt(r.exp), 11)}│ ${pad(r.enc ? "yes" : "no", 5)}│ ${pad(r.issuedAt || "", 24)}`,
    );
  }
  const counts = rows.reduce((acc, r) => {
    acc[statusOf(r)] = (acc[statusOf(r)] || 0) + 1;
    return acc;
  }, {});
  console.log(
    `\n${rows.length} seat(s): ${counts.valid || 0} valid, ${counts.expired || 0} expired, ${counts.revoked || 0} revoked. Records: safe/frontdesk-keys/<kid>/issued/ (revoked → revoked/, expired → expired/)`,
  );
}

// ── Seat registry export + audit log ──────────────────────────────────────────

export const SEATS_FILE = path.join(DEV_KEYS_DIR, "seats.json");
export const AUDIT_FILE = path.join(DEV_KEYS_DIR, "audit.jsonl");

export function logAudit(action, fields, ts = new Date().toISOString()) {
  try {
    fs.mkdirSync(DEV_KEYS_DIR, { recursive: true });
    fs.appendFileSync(AUDIT_FILE, JSON.stringify({ ts, action, ...fields }) + "\n", "utf8");
  } catch {
    // non-fatal
  }
}

export function printAudit() {
  if (!fs.existsSync(AUDIT_FILE)) {
    console.log("No audit entries yet (safe/frontdesk-keys/audit.jsonl).");
    return;
  }
  const lines = fs
    .readFileSync(AUDIT_FILE, "utf8")
    .split("\n")
    .filter((l) => l.trim());
  if (lines.length === 0) {
    console.log("No audit entries yet (safe/frontdesk-keys/audit.jsonl).");
    return;
  }
  console.log(`${lines.length} audit entr${lines.length === 1 ? "y" : "ies"} in safe/frontdesk-keys/audit.jsonl:`);
  for (const l of lines) {
    try {
      const e = JSON.parse(l);
      console.log(
        `  ${e.ts}  ${String(e.action).padEnd(7)}  ${e.sub ?? ""}  kid=${e.kid ?? "?"}  exp=${e.exp ?? ""}${e.detail ? `  ${e.detail}` : ""}`,
      );
    } catch {
      /* skip malformed */
    }
  }
}

export function backfillAudit() {
  if (fs.existsSync(AUDIT_FILE)) return 0;
  const revokedBlock = loadRevokedSeats();
  const records = collectSeatRecords();
  const now = Date.now();
  let n = 0;
  const seenIssue = new Set();
  for (const r of records) {
    if (!seenIssue.has(r.sub)) {
      logAudit(
        "issue",
        { sub: r.sub, kid: r.kid ?? null, exp: r.exp ?? null, detail: r.exp === 0 ? "unlimited" : `expires ${new Date(r.exp * 1000).toISOString()}` },
        r.issuedAt ? new Date(r.issuedAt).toISOString() : new Date().toISOString(),
      );
      seenIssue.add(r.sub);
      n++;
    }
    if (r.revoked) {
      logAudit("revoke", { sub: r.sub, kid: r.kid ?? null }, r.revokedAt ? new Date(r.revokedAt).toISOString() : new Date().toISOString());
      n++;
    } else if (typeof r.exp === "number" && r.exp > 0 && r.exp * 1000 <= now) {
      logAudit(
        "expiry",
        { sub: r.sub, kid: r.kid ?? null, exp: r.exp, detail: `expired ${new Date(r.exp * 1000).toISOString()}` },
        new Date(r.exp * 1000).toISOString(),
      );
      n++;
    }
  }
  const seenSubs = new Set(records.map((r) => r.sub));
  for (const sub of revokedBlock) {
    if (seenSubs.has(sub)) continue;
    logAudit("revoke", { sub, kid: null }, new Date().toISOString());
    n++;
  }
  if (n > 0) console.log(`[audit] Backfilled ${n} historical seat action(s) into safe/frontdesk-keys/audit.jsonl.`);
  return n;
}

export function exportSeats() {
  backfillAudit();
  const revokedBlock = loadRevokedSeats();
  const records = collectSeatRecords();
  const seen = new Set();
  const now = Date.now();
  const seats = [];
  for (const r of records) {
    seen.add(r.sub);
    seats.push({
      sub: r.sub,
      kid: r.kid || null,
      exp: typeof r.exp === "number" ? r.exp : null,
      revoked: r.revoked === true || revokedBlock.includes(r.sub),
      expired: typeof r.exp === "number" && r.exp > 0 && r.exp * 1000 <= now,
    });
  }
  for (const sub of revokedBlock) {
    if (seen.has(sub)) continue;
    seats.push({ sub, kid: null, exp: null, revoked: true, expired: false });
  }
  seats.sort((a, b) => String(a.sub).localeCompare(String(b.sub)));

  const out = { seats, updatedAt: new Date().toISOString() };
  fs.mkdirSync(DEV_KEYS_DIR, { recursive: true });
  fs.writeFileSync(SEATS_FILE, JSON.stringify(out, null, 2) + "\n", "utf8");

  const revokedCount = seats.filter((s) => s.revoked).length;
  console.log(`[audit] Exported ${seats.length} seat(s) to safe/frontdesk-keys/seats.json (${revokedCount} revoked).`);
  return out;
}

export function readExpiryAuditKeys() {
  const seen = new Set();
  try {
    if (fs.existsSync(AUDIT_FILE)) {
      for (const l of fs.readFileSync(AUDIT_FILE, "utf8").split("\n")) {
        try {
          const e = JSON.parse(l);
          if (e.action === "expiry") seen.add(`${e.sub}|${e.exp}`);
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
  return seen;
}

export function auditExpiredSeats(rows) {
  const seen = readExpiryAuditKeys();
  let logged = 0;
  for (const r of rows) {
    if (r.status !== "expired") continue;
    const key = `${r.sub}|${r.exp}`;
    if (seen.has(key)) continue;
    logAudit("expiry", {
      sub: r.sub,
      kid: r.kid ?? null,
      exp: r.exp,
      detail: `expired ${new Date(r.exp * 1000).toISOString()}`,
    });
    seen.add(key);
    logged++;
  }
  exportSeats();
  return logged;
}

// ── Agent keypair (X25519 — used to encrypt frontdesk ↔ agent traffic) ────────

export const AGENT_KEYS_DIR = path.join(DEV_KEYS_DIR, "agent");

export function createAgentKey() {
  fs.mkdirSync(AGENT_KEYS_DIR, { recursive: true });
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  const pubX = publicKey.export({ format: "jwk" }).x;
  const privD = privateKey.export({ format: "jwk" }).d;
  fs.writeFileSync(path.join(AGENT_KEYS_DIR, "agent-public.key"), pubX + "\n", "utf8");
  fs.writeFileSync(path.join(AGENT_KEYS_DIR, "agent-private.key"), privD + "\n", "utf8");
  fs.writeFileSync(
    path.join(AGENT_KEYS_DIR, "agent.json"),
    JSON.stringify({ crv: "X25519", publicX: pubX, createdAt: new Date().toISOString() }, null, 2) + "\n",
    "utf8",
  );
  console.log(`Agent X25519 keypair created in ${AGENT_KEYS_DIR}/`);
  console.log(`  agent-public.key  = ${pubX}`);
  console.log(`  agent-private.key = ${privD}  (NEVER COMMIT)`);
  console.log("");
  console.log("Set FRONTDESK_AGENT_PUBKEY in .env (and the webapp config) to this public key:");
  console.log(`  FRONTDESK_AGENT_PUBKEY=${pubX}`);
  return { publicX: pubX, privateD: privD };
}

export function loadAgentKeys() {
  const pubFile = path.join(AGENT_KEYS_DIR, "agent-public.key");
  const privFile = path.join(AGENT_KEYS_DIR, "agent-private.key");
  if (!fs.existsSync(pubFile) || !fs.existsSync(privFile)) {
    throw new Error(`Agent keypair not found in ${AGENT_KEYS_DIR}/ — run "node scripts/keymanage.mjs create-agent-key" first.`);
  }
  return {
    publicX: fs.readFileSync(pubFile, "utf8").trim(),
    privateD: fs.readFileSync(privFile, "utf8").trim(),
  };
}

// ── ECDH → AES-256-GCM (frontdesk ↔ agent encryption) ─────────────────────────

const DOMAIN = Buffer.from("frontdesk-v1", "utf8");

/**
 * Server side: derive the AES key from a seat's PUBLIC enc key + the agent's
 * private key → ECDH(agent_priv, seat_pub). This is what the webhook server
 * uses to decrypt client messages and encrypt replies. Only the seat's PUBLIC
 * key is needed — the seat private seeds never reach the server after login.
 */
export function deriveAesKeyServer(seatEncPubX, agentPrivateD) {
  const agentPriv = crypto.createPrivateKey({ key: { kty: "OKP", crv: "X25519", x: seatEncPubX, d: agentPrivateD }, format: "jwk" });
  const seatPub = crypto.createPublicKey({ key: { kty: "OKP", crv: "X25519", x: seatEncPubX }, format: "jwk" });
  const shared = crypto.diffieHellman({ privateKey: agentPriv, publicKey: seatPub });
  return crypto.createHash("sha256").update(Buffer.concat([DOMAIN, shared])).digest();
}

/**
 * Client side: derive the AES key from the user's license (seat X25519 private
 * seed) + the agent's PUBLIC key → ECDH(seat_priv, agent_pub). Used by the
 * webapp to encrypt sends and decrypt agent replies.
 */
export function deriveAesKeyClient(licenseKey, agentPubX) {
  const m = KEY_RE.exec(licenseKey);
  if (!m) throw new Error("malformed license key");
  const seatKeys = fromB64u(m[3]);
  if (seatKeys.length !== 64) throw new Error("license key has no X25519 seat key (cannot encrypt)");
  const xPrivD = seatKeys.subarray(32, 64).toString("base64url");
  let cert;
  try {
    cert = JSON.parse(fromB64u(m[1]).toString("utf8"));
  } catch {
    throw new Error("malformed cert");
  }
  if (typeof cert.enc !== "string") throw new Error("cert has no enc key (cannot encrypt)");
  const seatPriv = crypto.createPrivateKey({ key: { kty: "OKP", crv: "X25519", x: cert.enc, d: xPrivD }, format: "jwk" });
  const agentPub = crypto.createPublicKey({ key: { kty: "OKP", crv: "X25519", x: agentPubX }, format: "jwk" });
  const shared = crypto.diffieHellman({ privateKey: seatPriv, publicKey: agentPub });
  return crypto.createHash("sha256").update(Buffer.concat([DOMAIN, shared])).digest();
}

export function encryptAes(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  return { iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ct: ct.toString("base64url") };
}

export function decryptAes(envelope, key) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, fromB64u(envelope.iv));
  decipher.setAuthTag(fromB64u(envelope.tag));
  const pt = Buffer.concat([decipher.update(fromB64u(envelope.ct)), decipher.final()]);
  return pt.toString("utf8");
}

/** Round-trip self-test: client-derived key === server-derived key; AES-GCM works. */
export function cryptoSelfTest(licenseKey) {
  const agent = loadAgentKeys();
  const clientKey = deriveAesKeyClient(licenseKey, agent.publicX);
  const m = KEY_RE.exec(licenseKey);
  const cert = JSON.parse(fromB64u(m[1]).toString("utf8"));
  const serverKey = deriveAesKeyServer(cert.enc, agent.privateD);

  const keysMatch = clientKey.equals(serverKey);

  // Client encrypts → server decrypts
  const env = encryptAes("hello from frontdesk 🔐", clientKey);
  const dec = decryptAes(env, serverKey);

  // Server encrypts → client decrypts
  const env2 = encryptAes("hello from agent 🤖", serverKey);
  const dec2 = decryptAes(env2, clientKey);

  const ok = keysMatch && dec === "hello from frontdesk 🔐" && dec2 === "hello from agent 🤖";
  console.log(JSON.stringify({ ok, keysMatch, clientToAgent: dec, agentToClient: dec2 }, null, 2));
  return ok;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function argValue(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  return argv[i + 1];
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (cmd === "generate-master") {
    generateMaster(argValue(argv, "--kid"));
  } else if (cmd === "issue") {
    const sub = argv[1];
    const kid = argValue(argv, "--kid") || (loadRing().keys[0] && loadRing().keys[0].kid);
    const expRaw = argValue(argv, "--exp");
    const exp = argv.includes("--unlimited") ? 0 : expRaw !== undefined ? parseExp(expRaw) : undefined;
    if (exp === undefined) {
      console.error("issue requires --exp <date> or --unlimited");
      process.exit(1);
    }
    issue(sub, { exp, kid });
  } else if (cmd === "verify") {
    const key = argv[1];
    if (!key) {
      console.error('verify requires a key:  node scripts/frontdesk-license.mjs verify "TA1...."');
      process.exit(1);
    }
    console.log(JSON.stringify(verifyLicenseKey(key), null, 2));
  } else if (cmd === "challenge-test") {
    const key = argv[1];
    if (!key) {
      console.error('challenge-test requires a key:  node scripts/frontdesk-license.mjs challenge-test "TA1...."');
      process.exit(1);
    }
    challengeTest(key);
  } else if (cmd === "crypto-self-test") {
    const key = argv[1];
    if (!key) {
      console.error('crypto-self-test requires a key:  node scripts/frontdesk-license.mjs crypto-self-test "TA1...."');
      process.exit(1);
    }
    cryptoSelfTest(key);
  } else if (cmd === "list") {
    listSeats();
  } else if (cmd === "export-seats") {
    exportSeats();
  } else if (cmd === "audit") {
    printAudit();
  } else if (cmd === "audit-backfill") {
    backfillAudit();
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
  } else {
    console.log(
      `Usage:
  node scripts/frontdesk-license.mjs generate-master --kid <id>
  node scripts/frontdesk-license.mjs issue <sub> --exp <date|unlimited> [--kid <id>]
  node scripts/frontdesk-license.mjs verify "TA1...."
  node scripts/frontdesk-license.mjs challenge-test "TA1...."
  node scripts/frontdesk-license.mjs crypto-self-test "TA1...."
  node scripts/frontdesk-license.mjs list
  node scripts/frontdesk-license.mjs export-seats
  node scripts/frontdesk-license.mjs audit
  node scripts/frontdesk-license.mjs audit-backfill
  node scripts/frontdesk-license.mjs revoke <sub>
  node scripts/frontdesk-license.mjs archive-expired`,
    );
    process.exit(cmd ? 1 : 0);
  }
}

// Run the CLI only when invoked directly; importing this module (e.g. from
// scripts/keymanage.mjs or the webhook server) must not have side effects.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
