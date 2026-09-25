#!/usr/bin/env node

/**
 * Netlify MCP Server
 *
 * Provides tools to inspect and manage a Netlify project: sites, build
 * settings, environment variables, and deploys. Uses the Model Context
 * Protocol (stdio transport) for Copilot integration.
 *
 * Wired into the Electron app as of 2026-09-24: it is a managed service
 * (`mcp:netlify` in electron/src/main.js, startable from the Dashboard rail) and
 * the operator chat reaches its tools through the in-process MCP client
 * (electron/src/main/mcp-client.mjs). The agent-runner still has no netlify
 * handlers — see `HANDLERS` in mcp/agent-runner/tool-executor.js — so this server
 * is not reachable from frontdesk events or the autonomous runner.
 *
 * The tool schemas live in shared/tool-manifest.js (`netlifyTools`), not here:
 * the Tools-tab manifest and the MCP client's advertised list read the same array,
 * so the two cannot drift.
 *
 * Environment variables (from .env via shared/config-loader.cjs):
 *   NETLIFY_AUTH_TOKEN   (required) — personal access token (PAT) from
 *                        app.netlify.com/user/applications#personal-access-tokens
 *   NETLIFY_SITE_ID      (optional) — default site target (Project ID or domain)
 *   NETLIFY_ACCOUNT_ID   (optional) — default team id OR slug for env operations
 *
 * API base: https://api.netlify.com/api/v1
 * Docs: https://docs.netlify.com/api/get-started/
 *       https://open-api.netlify.com
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import config from "../../shared/config-loader.cjs";
config.loadEnvInto(process.env);
import { sanitizeObject } from "../../scripts/sanitize.stub.mjs";
import { toolCall } from "../../shared/logger.mjs";
import { netlifyTools } from "../../shared/tool-manifest.js";
// The env primitives live in shared/ so scripts can reuse them without importing
// this file (which connects a stdio transport at module top level).
import {
  netlifyFetch,
  envPath,
  normalizeContexts,
  resolveAccountForSite,
  DEPLOY_CONTEXTS,
} from "../../shared/netlify-env.mjs";

const DEFAULT_SITE = process.env.NETLIFY_SITE_ID || "";
const DEFAULT_ACCOUNT = process.env.NETLIFY_ACCOUNT_ID || "";
/* The PAT is read per call inside shared/netlify-env.mjs, so there is no module-level
   token constant here — a long-lived server picks up a rotated token on the next call. */

/* ── Response helpers (sanitized) ── */

function safeText(text) {
  return { type: "text", text };
}

function safeJson(data) {
  const sanitized = sanitizeObject(data, { auditSource: "mcp/netlify" });
  return { type: "text", text: JSON.stringify(sanitized, null, 2) };
}

function logToolCall(name, args, summary) {
  toolCall("mcp", "netlify", { name, args, response: summary });
  console.error(`[mcp] netlify/${name} → ${String(summary).slice(0, 80)}`);
}

/* ── Netlify REST client ── */

/* netlifyFetch() is imported from shared/netlify-env.mjs (it throws on a non-2xx
   response with the API's own message, and carries `.status` so a 404 is
distinguishable from a real failure). */

/* Resolve which site/account a call targets. A siteId may be the Project ID,
 * the site name, or the domain (mysite.netlify.app) — all are interchangeable
 * in API paths. */
function resolveSite(args) {
  return (args && args.siteId) || DEFAULT_SITE;
}
function resolveAccount(args) {
  return (args && args.accountId) || DEFAULT_ACCOUNT;
}

/* DEPLOY_CONTEXTS, resolveAccountForSite() and envPath() are imported from
   shared/netlify-env.mjs. Note the account indirection: site-scoped env vars do NOT
   live under /sites/{id}/env (that path 404s); they live under the ACCOUNT path with
   a site_id query parameter, and the account is discovered from the site. */

/* normalizeContexts() is imported from shared/netlify-env.mjs. */

function siteRequired(args) {
  return resolveSite(args)
    ? null
    : { content: [safeText("No site target — pass siteId or set NETLIFY_SITE_ID in .env")], isError: true };
}

/* ── Tool implementations ── */

async function handleListSites(args) {
  const perPage = (args && args.perPage) || 100;
  const data = await netlifyFetch("/sites", { params: { per_page: perPage } });
  const trimmed = (data || []).map((s) => ({
    id: s.id,
    name: s.name,
    url: s.ssl_url || s.url || null,
    created_at: s.created_at,
  }));
  return { content: [safeJson(trimmed)] };
}

async function handleGetSite(args) {
  const bad = siteRequired(args);
  if (bad) return bad;
  const data = await netlifyFetch(`/sites/${encodeURIComponent(resolveSite(args))}`);
  return { content: [safeJson(data)] };
}

async function handleUpdateSite(args) {
  const bad = siteRequired(args);
  if (bad) return bad;
  const updates = (args && args.updates) || {};
  if (!updates || typeof updates !== "object" || Object.keys(updates).length === 0) {
    return {
      content: [safeText("Provide an 'updates' object, e.g. {\"build_settings\":{\"command\":\"npm run build\",\"publish\":\"public\"}}")],
      isError: true,
    };
  }
  const data = await netlifyFetch(`/sites/${encodeURIComponent(resolveSite(args))}`, { method: "PATCH", body: updates });
  return {
    content: [safeJson({ id: data.id, name: data.name, ssl_url: data.ssl_url, build_settings: data.build_settings })],
  };
}

async function handleGetAccount(args) {
  const accountId = resolveAccount(args);
  if (!accountId) {
    return { content: [safeText("No account target — pass accountId (id or team slug) or set NETLIFY_ACCOUNT_ID in .env")], isError: true };
  }
  const data = await netlifyFetch(`/accounts/${encodeURIComponent(accountId)}`);
  return { content: [safeJson(data)] };
}

/* Environment variables.
 * Site scope → GET/PUT/POST/DELETE /accounts/{account}/env[/{key}]?site_id={site}
 * Team scope → the same paths without site_id
 * (`/sites/{id}/env` does not exist on the API — it 404s.)
 *
 * A variable stores one entry per deploy CONTEXT, so the body is
 * `{key, scopes, is_secret, values:[{context, value}]}`. Verified against the live
 * API: a flat `{value, context}` body is rejected with "Invalid request structure",
 * and a JSON OBJECT body with `param is missing or the value is empty: _json`
 * (the create endpoint wants a top-level ARRAY). */
async function handleListEnv(args) {
  const siteId = resolveSite(args);
  const accountId = siteId ? await resolveAccountForSite(siteId) : resolveAccount(args);
  if (!accountId) {
    return { content: [safeText("Pass siteId (site env) or accountId (team env) — none configured")], isError: true };
  }
  const data = await netlifyFetch(envPath(accountId), { params: siteId ? { site_id: siteId } : {} });
  const trimmed = (Array.isArray(data) ? data : []).map((v) => ({
    key: v.key,
    scopes: v.scopes || [],
    is_secret: !!v.is_secret,
    updated_at: v.updated_at || null,
    // Secret values are masked by the API; report the per-context entries as-is
    // rather than pretending a masked value is the real one.
    values: (v.values || []).map((x) => ({ context: x.context, value: x.value })),
  }));
  return { content: [safeJson(trimmed)] };
}

async function handleGetEnv(args) {
  const { key } = args || {};
  if (!key) return { content: [safeText("Missing required parameter: key")], isError: true };
  const siteId = resolveSite(args);
  const accountId = siteId ? await resolveAccountForSite(siteId) : resolveAccount(args);
  if (!accountId) return { content: [safeText("No site or account target for env lookup")], isError: true };
  const data = await netlifyFetch(envPath(accountId, key), { params: siteId ? { site_id: siteId } : {} });
  return { content: [safeJson(data)] };
}

async function handleSetEnv(args) {
  const { key, value, context, scopes = ["builds", "functions", "runtime"], is_secret } = args || {};
  if (!key || value === undefined) {
    return { content: [safeText("Missing required parameters: key, value")], isError: true };
  }
  const siteId = resolveSite(args);
  const accountId = siteId ? await resolveAccountForSite(siteId) : resolveAccount(args);
  if (!accountId) {
    return { content: [safeText("Pass siteId (site env) or accountId (team env) — none configured")], isError: true };
  }
  const params = siteId ? { site_id: siteId } : {};

  // Read before writing: the update endpoint takes the whole object, and reading
  // lets us preserve is_secret, the scopes, and every context the caller did not
  // name (a blind PUT would wipe the others).
  let existing = null;
  try {
    existing = await netlifyFetch(envPath(accountId, key), { params });
  } catch {
    existing = null;
  }

  const merge = new Map(((existing && existing.values) || []).map((v) => [v.context, v.value]));
  const requested = normalizeContexts(context);
  for (const ctx of requested.length ? requested : DEPLOY_CONTEXTS) merge.set(ctx, value);

  const body = {
    key,
    scopes: (existing && existing.scopes) || scopes,
    is_secret: is_secret === undefined ? !!(existing && existing.is_secret) : !!is_secret,
    values: [...merge].map(([ctx, val]) => ({ context: ctx, value: val })),
  };

  if (existing) {
    await netlifyFetch(envPath(accountId, key), { method: "PUT", params, body });
  } else {
    // Create takes a top-level ARRAY of variable objects.
    await netlifyFetch(envPath(accountId), { method: "POST", params, body: [body] });
  }
  return {
    content: [
      safeJson({
        ok: true,
        scope: siteId ? "site" : "account",
        key,
        contexts: body.values.map((v) => v.context),
        redeployRequired: true,
      }),
    ],
  };
}

async function handleDeleteEnv(args) {
  const { key } = args || {};
  if (!key) return { content: [safeText("Missing required parameter: key")], isError: true };
  const siteId = resolveSite(args);
  const accountId = siteId ? await resolveAccountForSite(siteId) : resolveAccount(args);
  if (!accountId) return { content: [safeText("No site or account target for env delete")], isError: true };
  await netlifyFetch(envPath(accountId, key), { method: "DELETE", params: siteId ? { site_id: siteId } : {} });
  return { content: [safeJson({ ok: true, scope: siteId ? "site" : "account", key, deleted: true })] };
}

/* Deploys / builds */

async function handleListDeploys(args) {
  const bad = siteRequired(args);
  if (bad) return bad;
  const perPage = (args && args.perPage) || 20;
  const data = await netlifyFetch(`/sites/${encodeURIComponent(resolveSite(args))}/deploys`, { params: { per_page: perPage } });
  const trimmed = (data || []).map((d) => ({
    id: d.id,
    state: d.state,
    context: d.context,
    branch: d.branch || null,
    commit_ref: d.commit_ref || null,
    created_at: d.created_at,
    deploy_url: d.deploy_url || null,
  }));
  return { content: [safeJson(trimmed)] };
}

async function handleGetDeploy(args) {
  const bad = siteRequired(args);
  if (bad) return bad;
  const deployId = args && args.deployId;
  if (!deployId) return { content: [safeText("Missing required parameter: deployId")], isError: true };
  const data = await netlifyFetch(`/sites/${encodeURIComponent(resolveSite(args))}/deploys/${encodeURIComponent(deployId)}`);
  return { content: [safeJson(data)] };
}

async function handleTriggerBuild(args) {
  const bad = siteRequired(args);
  if (bad) return bad;
  const data = await netlifyFetch(`/sites/${encodeURIComponent(resolveSite(args))}/builds`, { method: "POST", body: {} });
  return { content: [safeJson({ ok: true, buildId: data.id, state: data.state, deploy_id: data.deploy_id || null })] };
}

async function handleRestoreDeploy(args) {
  const bad = siteRequired(args);
  if (bad) return bad;
  const deployId = args && args.deployId;
  if (!deployId) return { content: [safeText("Missing required parameter: deployId")], isError: true };
  const data = await netlifyFetch(`/sites/${encodeURIComponent(resolveSite(args))}/deploys/${encodeURIComponent(deployId)}/restore`, {
    method: "POST",
  });
  return { content: [safeJson({ ok: true, state: data.state, id: data.id })] };
}

/* ── MCP Server ── */

const server = new Server({ name: "netlify-mcp-server", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: netlifyTools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  let result;
  let summary;
  try {
    switch (name) {
      case "netlify_list_sites":
        result = await handleListSites(args);
        summary = "sites listed";
        break;
      case "netlify_get_site":
        result = await handleGetSite(args);
        summary = "site fetched";
        break;
      case "netlify_update_site":
        result = await handleUpdateSite(args);
        summary = "site updated";
        break;
      case "netlify_get_account":
        result = await handleGetAccount(args);
        summary = "account fetched";
        break;
      case "netlify_list_env":
        result = await handleListEnv(args);
        summary = "env listed";
        break;
      case "netlify_get_env":
        result = await handleGetEnv(args);
        summary = "env fetched";
        break;
      case "netlify_set_env":
        result = await handleSetEnv(args);
        summary = "env set";
        break;
      case "netlify_delete_env":
        result = await handleDeleteEnv(args);
        summary = "env deleted";
        break;
      case "netlify_list_deploys":
        result = await handleListDeploys(args);
        summary = "deploys listed";
        break;
      case "netlify_get_deploy":
        result = await handleGetDeploy(args);
        summary = "deploy fetched";
        break;
      case "netlify_trigger_build":
        result = await handleTriggerBuild(args);
        summary = "build triggered";
        break;
      case "netlify_restore_deploy":
        result = await handleRestoreDeploy(args);
        summary = "deploy restored";
        break;
      default:
        result = { content: [safeText(`Unknown tool: ${name}`)], isError: true };
        summary = "unknown tool";
    }
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    const friendly =
      msg.startsWith("NETLIFY_AUTH_TOKEN")
        ? "NETLIFY_AUTH_TOKEN is not set. Add your PAT to the repo-root .env (create it at app.netlify.com/user/applications#personal-access-tokens), then reload the MCP server."
        : `Error: ${msg}`;
    result = { content: [safeText(friendly)], isError: true };
    summary = "error";
  }
  logToolCall(name, args, summary);
  return result;
});

/* ── Start ── */

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("✅ Netlify MCP Server running on stdio");
