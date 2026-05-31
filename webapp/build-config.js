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

fs.writeFileSync(appJsPath, content, "utf8");
console.log(`[build-config] Injected USER_ADMIN_HASH into app.js`);
