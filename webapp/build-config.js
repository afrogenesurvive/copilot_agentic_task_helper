/**
 * build-config.js — Netlify build-time token replacer
 *
 * Replaces __ADMIN_HASH__ in public/app.js with the value of the
 * USER_ADMIN_HASH environment variable at deploy time.
 *
 * Run by Netlify during deploy (configured in netlify.toml [build] command).
 */

const fs = require("fs");
const path = require("path");

const appJsPath = path.join(__dirname, "public", "app.js");
let content = fs.readFileSync(appJsPath, "utf8");

const adminHash = process.env.USER_ADMIN_HASH || "";
content = content.replace("__ADMIN_HASH__", adminHash);

const webhookToken = process.env.WEBHOOK_API_TOKEN || "";
content = content.replace("__WEBHOOK_API_TOKEN__", webhookToken);

const webhookUrl = process.env.WEBHOOK_BASE_URL || "";
content = content.replace("__WEBHOOK_BASE_URL__", webhookUrl);

fs.writeFileSync(appJsPath, content, "utf8");
console.log(`[build-config] Injected USER_ADMIN_HASH, WEBHOOK_API_TOKEN, WEBHOOK_BASE_URL into app.js`);
