/**
 * crypto.js — client-side E2E crypto for Frontdesk v2.
 *
 * Pure WebCrypto (works in browsers and Node ≥19 via globalThis.crypto.subtle).
 * The math mirrors scripts/frontdesk-license.mjs exactly so the browser and the
 * webhook server derive the SAME AES-256-GCM key:
 *
 *   key = SHA-256("frontdesk-v1" ‖ ECDH(seat_x25519_priv, agent_x25519_pub))
 *
 * License key format:  TA1.<b64url(cert)>.<b64url(sig)>.<b64url(seatKeys)>
 *   cert     = { app, v, sub, exp, kid, pub(ed25519), enc(x25519) }
 *   seatKeys = 32-byte Ed25519 seed + 32-byte X25519 seed (64 bytes)
 *
 * Exposes a single global `FD` object.
 */
(function () {
  "use strict";

  const KEY_RE = /^TA1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

  // ── base64url helpers ────────────────────────────────────────────────────────
  function b64uEncode(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function b64uDecode(str) {
    let s = String(str).replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function utf8Decode(bytes) {
    return new TextDecoder().decode(bytes);
  }

  // ── License parsing ──────────────────────────────────────────────────────────
  function parseLicense(license) {
    const m = KEY_RE.exec(String(license).trim());
    if (!m) throw new Error("malformed license key");
    const cert = JSON.parse(utf8Decode(b64uDecode(m[1])));
    const seatKeys = b64uDecode(m[3]);
    if (seatKeys.length !== 64) throw new Error("license key has no X25519 seat key (cannot encrypt)");
    return {
      claims: cert,
      certB64u: m[1],
      sigB64u: m[2],
      seatXPriv: seatKeys.slice(32), // 32-byte X25519 private seed
    };
  }

  // ── Key derivation (ECDH → SHA-256 → AES-256-GCM) ───────────────────────────
  const DOMAIN = new TextEncoder().encode("frontdesk-v1");

  async function deriveKey(license, agentPubB64u) {
    const { seatXPriv, claims } = parseLicense(license);
    if (!claims.enc) throw new Error("cert has no enc key (cannot encrypt)");

    // Import the seat X25519 private key via JWK — raw private import is not
    // supported consistently across browsers (some reject "raw" + deriveBits).
    const seatJwk = { kty: "OKP", crv: "X25519", x: claims.enc, d: b64uEncode(seatXPriv), ext: false };
    const seatPriv = await crypto.subtle.importKey("jwk", seatJwk, { name: "X25519" }, false, ["deriveBits"]);
    const agentPub = await crypto.subtle.importKey("raw", b64uDecode(agentPubB64u), { name: "X25519" }, false, []);

    const shared = await crypto.subtle.deriveBits({ name: "X25519", public: agentPub }, seatPriv, 256);

    const input = new Uint8Array(DOMAIN.length + shared.byteLength);
    input.set(DOMAIN, 0);
    input.set(new Uint8Array(shared), DOMAIN.length);

    const keyBytes = await crypto.subtle.digest("SHA-256", input);
    return crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  }

  // ── Encrypt / decrypt (envelope shape { iv, tag, ct } — matches the server) ──
  async function encrypt(license, agentPubB64u, obj) {
    const key = await deriveKey(license, agentPubB64u);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const pt = new TextEncoder().encode(typeof obj === "string" ? obj : JSON.stringify(obj));
    const ctWithTag = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, pt));
    // WebCrypto GCM returns ciphertext || 16-byte tag.
    const data = ctWithTag.slice(0, ctWithTag.length - 16);
    const tag = ctWithTag.slice(ctWithTag.length - 16);
    return { iv: b64uEncode(iv), tag: b64uEncode(tag), ct: b64uEncode(data) };
  }

  async function decrypt(license, agentPubB64u, envelope) {
    const key = await deriveKey(license, agentPubB64u);
    const iv = b64uDecode(envelope.iv);
    const data = b64uDecode(envelope.ct);
    const tag = b64uDecode(envelope.tag);
    const combined = new Uint8Array(data.length + tag.length);
    combined.set(data, 0);
    combined.set(tag, data.length);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, combined);
    return utf8Decode(new Uint8Array(pt));
  }

  /** Build a `[fd1]` degraded-mode comment payload for Trello fallback. */
  function degradedEnvelope(license, agentPubB64u, obj) {
    return encrypt(license, agentPubB64u, obj).then((env) => {
      const parsed = parseLicense(license);
      return `[fd1] ${parsed.certB64u} ${parsed.sigB64u} ${env.iv} ${env.tag} ${env.ct}`;
    });
  }

  const FD = { parseLicense, deriveKey, encrypt, decrypt, degradedEnvelope, b64uEncode, b64uDecode };
  if (typeof module !== "undefined" && module.exports) module.exports = FD;
  else if (typeof window !== "undefined") window.FD = FD;
  else globalThis.FD = FD;
})();
