#!/usr/bin/env node
/**
 * Cross-check: the BROWSER crypto path (webapp/public/crypto.js, WebCrypto)
 * must derive the SAME AES-256-GCM key as the SERVER path
 * (scripts/frontdesk-license.mjs, Node crypto) and round-trip both directions.
 *
 * Runs in Node using globalThis.crypto = webcrypto, which is the identical API
 * a browser exposes. A green run proves the real webapp ⇄ server encryption
 * will work.
 *
 * Usage: node scripts/verify-webcrypto.mjs [seatSub]
 */
import { createRequire } from "node:module";
import { webcrypto } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Give crypto.js the browser-ish globals it expects.
globalThis.crypto = webcrypto;
globalThis.btoa = (s) => Buffer.from(s, "binary").toString("base64");
globalThis.atob = (s) => Buffer.from(s, "base64").toString("binary");

const require = createRequire(import.meta.url);
const FD = require("../webapp/public/crypto.js");

import { deriveAesKeyServer, encryptAes, decryptAes, loadAgentKeys } from "./frontdesk-license.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SUB = process.argv[2] || "test@example.com";

const license = fs.readFileSync(path.join(ROOT, "safe", "frontdesk-keys", "mk-2026-08", "issued", `${SUB}.key`), "utf8").trim();
const agent = loadAgentKeys();

async function main() {
  let passed = 0;
  let failed = 0;
  const check = (label, cond, detail) => {
    if (cond) {
      passed++;
      console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ""}`);
    } else {
      failed++;
      console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
    }
  };

  // 1. Key agreement proof: the client (WebCrypto) encrypts a known message and
  //    the server (Node) must decrypt it identically. (The derived AES key is
  //    non-extractable by design, so agreement is proven behaviorally.)
  const clientKey = await FD.deriveKey(license, agent.publicX);
  const cert = JSON.parse(Buffer.from(license.split(".")[1], "base64url").toString("utf8"));
  const serverKey = deriveAesKeyServer(cert.enc, agent.privateD);

  // 2. Client encrypts (WebCrypto) → server decrypts (Node)
  const env = await FD.encrypt(license, agent.publicX, { text: "hello from browser 🔐", ts: new Date().toISOString() });
  const serverDecrypted = decryptAes(env, serverKey);
  check("server decrypts client ciphertext", serverDecrypted.includes("hello from browser"), serverDecrypted.slice(0, 40));

  // 3. Server encrypts (Node) → client decrypts (WebCrypto)
  const env2 = encryptAes("hello from agent 🤖", serverKey);
  const clientDecrypted = await FD.decrypt(license, agent.publicX, env2);
  check("client decrypts server ciphertext", clientDecrypted === "hello from agent 🤖");

  // 4. Degraded-mode `[fd1]` comment payload builds correctly.
  const degraded = await FD.degradedEnvelope(license, agent.publicX, { text: "degraded msg", ts: new Date().toISOString() });
  const parts = degraded.split(" ");
  check("degraded envelope has [fd1] + cert + sig + iv + tag + ct", parts.length === 6 && parts[0] === "[fd1]");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`Cross-check crashed: ${err.message}`);
  process.exit(1);
});
