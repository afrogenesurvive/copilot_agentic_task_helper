/**
 * Netlify environment-variable primitives, shared by the Netlify MCP server and
 * the config-sync scripts.
 *
 * Extracted verbatim from `mcp/netlify/index.js` so there is ONE implementation of
 * the env API contract. That file cannot be imported from a script (it connects a
 * stdio MCP transport at module top level), which is why these live here instead.
 *
 * The contract, as verified against the live API:
 *   - Site-scoped variables live under the ACCOUNT path:
 *       /accounts/{account}/env[/{key}]?site_id={site}
 *     `/sites/{id}/env` does not exist (it 404s) — that assumption is what used to
 *     make site-scoped env reads/writes fail. Only NETLIFY_SITE_ID is needed; the
 *     account is discovered from the site.
 *   - A variable holds ONE VALUE PER DEPLOY CONTEXT, so the body is
 *     `{key, scopes, is_secret, values:[{context, value}]}`. A flat `{value, context}`
 *     is rejected with "Invalid request structure".
 *   - Update (PUT) wants that object; create (POST) wants a top-level ARRAY of them.
 *   - ALWAYS read before writing: a blind PUT overwrites the contexts you did not
 *     name. These helpers preserve `is_secret`, `scopes` and unnamed contexts.
 */
import fetch from "node-fetch";

export const NETLIFY_BASE = "https://api.netlify.com/api/v1";

/** Deploy contexts the env API stores values for. "all" is NOT one of them: a
 *  variable holds one value PER context, and omitting a context leaves whatever
 *  that context already had untouched. */
export const DEPLOY_CONTEXTS = ["production", "deploy-preview", "branch-deploy", "dev", "dev-server"];

/** Default scopes for a freshly created variable. */
export const DEFAULT_SCOPES = ["builds", "functions", "runtime"];

/**
 * Netlify REST call. Throws on a non-2xx response with the API's own message, so
 * callers can distinguish a 404 ("variable does not exist yet") from a real failure.
 *
 * @param {string} pathname  e.g. `/accounts/team/env/MY_KEY`
 * @param {{method?:string, body?:any, params?:Object<string,string>, token?:string}} [opts]
 */
export async function netlifyFetch(pathname, { method = "GET", body, params = {}, token } = {}) {
  const auth = token === undefined ? process.env.NETLIFY_AUTH_TOKEN || "" : token;
  if (!auth) throw new Error("NETLIFY_AUTH_TOKEN not set");
  const url = new URL(`${NETLIFY_BASE}${pathname}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${auth}`,
      "Content-Type": "application/json",
      "User-Agent": "frontdesk-netlify-env",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }
  if (!resp.ok) {
    const detail = json && (json.message || json.error) ? `: ${json.message || json.error}` : "";
    const err = new Error(`Netlify API ${resp.status} on ${method} ${pathname}${detail}`);
    err.status = resp.status;
    throw err;
  }
  return json;
}

/**
 * Resolve the ACCOUNT (team) that owns a site. A siteId may be the project id, the
 * site name or the domain — all are interchangeable in API paths.
 *
 * @param {string} siteId
 * @param {string} [defaultAccount] short-circuit value (NETLIFY_ACCOUNT_ID)
 */
export async function resolveAccountForSite(siteId, defaultAccount = process.env.NETLIFY_ACCOUNT_ID || "") {
  if (!siteId) return defaultAccount || "";
  if (defaultAccount) return defaultAccount;
  const site = await netlifyFetch(`/sites/${encodeURIComponent(siteId)}`);
  return (site && (site.account_slug || site.account_id)) || "";
}

/** Account-scoped env path, with the key appended when one is given. */
export function envPath(accountId, key) {
  const base = `/accounts/${encodeURIComponent(accountId)}/env`;
  return key ? `${base}/${encodeURIComponent(key)}` : base;
}

/** "production", "production,dev" or ["production","dev"] → ["production","dev"].
 *  Empty / "all" / undefined → [] meaning "every deploy context". */
export function normalizeContexts(context) {
  if (context === undefined || context === null || context === "" || context === "all") return [];
  const list = Array.isArray(context) ? context : String(context).split(",");
  return list.map((c) => String(c).trim()).filter(Boolean);
}

/**
 * Read one site-scoped variable, or null when it does not exist (404).
 * Secret values come back masked by the API; the mask is enough to tell "set" from
 * "unset", which is why callers must judge presence by the mask rather than the text.
 */
export async function getSiteEnvVar({ siteId, key, accountId } = {}) {
  if (!key) throw new Error("key is required");
  const account = accountId || (await resolveAccountForSite(siteId));
  if (!account) throw new Error("No account — pass siteId or set NETLIFY_SITE_ID");
  try {
    return await netlifyFetch(envPath(account, key), { params: siteId ? { site_id: siteId } : {} });
  } catch (err) {
    if (err && err.status === 404) return null;
    throw err;
  }
}

/** List every variable for a site (or an account when no siteId is given). */
export async function listSiteEnvVars({ siteId, accountId } = {}) {
  const account = accountId || (await resolveAccountForSite(siteId));
  if (!account) throw new Error("No account — pass siteId or set NETLIFY_SITE_ID");
  const res = await netlifyFetch(envPath(account), { params: siteId ? { site_id: siteId } : {} });
  return res || [];
}

/**
 * Create or update one variable, preserving everything the caller did not name.
 * Mirrors `handleSetEnv` in mcp/netlify/index.js (see that file for the tool wrapper).
 *
 * @param {{siteId?:string, accountId?:string, key:string, value:string,
 *          context?:string|string[], scopes?:string[], is_secret?:boolean, dryRun?:boolean}} opts
 * @returns {Promise<{ok:boolean, key:string, created:boolean, contexts:string[], dryRun:boolean}>}
 */
export async function setSiteEnvVar(opts = {}) {
  const { siteId, accountId, key, value, context, scopes = DEFAULT_SCOPES, is_secret, dryRun = false } = opts;
  if (!key) throw new Error("key is required");
  if (value === undefined) throw new Error("value is required");
  const account = accountId || (await resolveAccountForSite(siteId));
  if (!account) throw new Error("No account — pass siteId or set NETLIFY_SITE_ID");
  const params = siteId ? { site_id: siteId } : {};

  // Read before writing — see the header note about blind PUTs.
  const existing = await getSiteEnvVar({ siteId, key, accountId: account }).catch(() => null);

  const merge = new Map(((existing && existing.values) || []).map((v) => [v.context, v.value]));
  const requested = normalizeContexts(context);
  for (const ctx of requested.length ? requested : DEPLOY_CONTEXTS) merge.set(ctx, value);

  const body = {
    key,
    scopes: (existing && existing.scopes) || scopes,
    is_secret: is_secret === undefined ? !!(existing && existing.is_secret) : !!is_secret,
    values: [...merge].map(([ctx, val]) => ({ context: ctx, value: val })),
  };

  const changed = !existing || [...merge].some(([ctx, val]) => ((existing.values || []).find((v) => v.context === ctx) || {}).value !== val);
  const contexts = body.values.map((v) => v.context);

  if (dryRun) return { ok: true, key, created: !existing, contexts, dryRun: true };

  if (existing) {
    await netlifyFetch(envPath(account, key), { method: "PUT", params, body });
  } else {
    // Create takes a top-level ARRAY of variable objects.
    await netlifyFetch(envPath(account), { method: "POST", params, body: [body] });
  }
  return { ok: true, key, created: !existing, contexts, dryRun: false, changed };
}
