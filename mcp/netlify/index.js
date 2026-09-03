#!/usr/bin/env node

/**
 * Netlify MCP Server
 *
 * Provides tools to inspect and manage a Netlify project: sites, build
 * settings, environment variables, and deploys. Uses the Model Context
 * Protocol (stdio transport) for Copilot integration.
 *
 * NOT wired into the Electron app / agent-runner yet — it is an opt-in,
 * operator-driven MCP server only (registered in .vscode/mcp.json so the
 * netlify_* tools are available to the agent).
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
import fetch from "node-fetch";
import config from "../../shared/config-loader.cjs";
config.loadEnvInto(process.env);
import { sanitizeObject } from "../../scripts/sanitize.stub.mjs";
import { toolCall } from "../../shared/logger.mjs";

const TOKEN = process.env.NETLIFY_AUTH_TOKEN || "";
const DEFAULT_SITE = process.env.NETLIFY_SITE_ID || "";
const DEFAULT_ACCOUNT = process.env.NETLIFY_ACCOUNT_ID || "";
const BASE = "https://api.netlify.com/api/v1";

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

async function netlifyFetch(pathname, { method = "GET", body, params = {} } = {}) {
  if (!TOKEN) throw new Error("NETLIFY_AUTH_TOKEN not set");
  const url = new URL(`${BASE}${pathname}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "frontdesk-netlify-mcp",
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
    throw new Error(`Netlify API ${resp.status} on ${method} ${pathname}${detail}`);
  }
  return json;
}

/* Resolve which site/account a call targets. A siteId may be the Project ID,
 * the site name, or the domain (mysite.netlify.app) — all are interchangeable
 * in API paths. */
function resolveSite(args) {
  return (args && args.siteId) || DEFAULT_SITE;
}
function resolveAccount(args) {
  return (args && args.accountId) || DEFAULT_ACCOUNT;
}

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
 * Site scope → /sites/{site_id}/env (mirrors "Site configuration → Env vars").
 * Team scope → /accounts/{account_id}/env (modern API; contexts + scopes). */
async function handleListEnv(args) {
  const siteId = resolveSite(args);
  const accountId = resolveAccount(args);
  if (siteId) {
    const data = await netlifyFetch(`/sites/${encodeURIComponent(siteId)}/env`);
    return { content: [safeJson(data)] };
  }
  if (!accountId) {
    return { content: [safeText("Pass siteId (site env) or accountId (team env) — none configured")], isError: true };
  }
  const data = await netlifyFetch(`/accounts/${encodeURIComponent(accountId)}/env`);
  return { content: [safeJson(data)] };
}

async function handleGetEnv(args) {
  const { key } = args || {};
  if (!key) return { content: [safeText("Missing required parameter: key")], isError: true };
  const siteId = resolveSite(args);
  if (siteId) {
    const data = await netlifyFetch(`/sites/${encodeURIComponent(siteId)}/env`);
    const entry = data && data[key] !== undefined ? data[key] : { notFound: true };
    return { content: [safeJson(entry)] };
  }
  const accountId = resolveAccount(args);
  if (!accountId) return { content: [safeText("No site or account target for env lookup")], isError: true };
  const data = await netlifyFetch(`/accounts/${encodeURIComponent(accountId)}/env/${encodeURIComponent(key)}`);
  return { content: [safeJson(data)] };
}

async function handleSetEnv(args) {
  const { key, value, context = "all", scopes = ["builds", "functions", "runtime"] } = args || {};
  if (!key || value === undefined) {
    return { content: [safeText("Missing required parameters: key, value")], isError: true };
  }
  const siteId = resolveSite(args);
  if (siteId) {
    await netlifyFetch(`/sites/${encodeURIComponent(siteId)}/env`, { method: "PUT", body: { [key]: value } });
    return { content: [safeJson({ ok: true, scope: "site", key })] };
  }
  const accountId = resolveAccount(args);
  if (!accountId) {
    return { content: [safeText("Pass siteId (site env) or accountId (team env) — none configured")], isError: true };
  }
  const data = await netlifyFetch(`/accounts/${encodeURIComponent(accountId)}/env/${encodeURIComponent(key)}`, {
    method: "PUT",
    body: { key, scopes, values: [{ context, value }] },
  });
  return { content: [safeJson({ ok: true, scope: "account", key, id: data.id })] };
}

async function handleDeleteEnv(args) {
  const { key } = args || {};
  if (!key) return { content: [safeText("Missing required parameter: key")], isError: true };
  const siteId = resolveSite(args);
  if (siteId) {
    await netlifyFetch(`/sites/${encodeURIComponent(siteId)}/env/${encodeURIComponent(key)}`, { method: "DELETE" });
    return { content: [safeJson({ ok: true, scope: "site", key, deleted: true })] };
  }
  const accountId = resolveAccount(args);
  if (!accountId) return { content: [safeText("No site or account target for env delete")], isError: true };
  await netlifyFetch(`/accounts/${encodeURIComponent(accountId)}/env/${encodeURIComponent(key)}`, { method: "DELETE" });
  return { content: [safeJson({ ok: true, scope: "account", key, deleted: true })] };
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

/* ── Tool definitions (inlined here — NOT in shared/tool-manifest.js yet) ── */

const netlifyTools = [
  {
    name: "netlify_list_sites",
    description:
      "List all Netlify sites the authenticated account can access. Returns id, name, url, and created date for each so you can identify the site to target.",
    inputSchema: {
      type: "object",
      properties: {
        perPage: { type: "number", description: "Max results (default 100)", default: 100 },
      },
    },
  },
  {
    name: "netlify_get_site",
    description:
      "Get full details (incl. build_settings) for a Netlify site. siteId may be the Project ID, site name, or domain (e.g. mysite.netlify.app). Defaults to NETLIFY_SITE_ID.",
    inputSchema: {
      type: "object",
      properties: {
        siteId: { type: "string", description: "Project ID, site name, or domain" },
      },
    },
  },
  {
    name: "netlify_update_site",
    description:
      "Update a Netlify site's settings via PATCH. Pass an 'updates' object, e.g. {\"build_settings\":{\"command\":\"npm run build\",\"publish\":\"public\",\"base\":\"webapp/\"}}. WARNING: a committed netlify.toml overrides these on git deploys.",
    inputSchema: {
      type: "object",
      properties: {
        siteId: { type: "string", description: "Project ID, site name, or domain" },
        updates: { type: "object", description: "JSON body to PATCH (site attributes, nested build_settings)" },
      },
      required: ["updates"],
    },
  },
  {
    name: "netlify_get_account",
    description: "Resolve a Netlify team (account) by id or slug, e.g. to find the account_id used for env-var operations.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Account/team id OR slug" },
      },
    },
  },
  {
    name: "netlify_list_env",
    description:
      "List environment variables. If siteId is given, returns that site's env vars (mirrors Site configuration → Env vars). Otherwise lists the team/account env vars (needs accountId).",
    inputSchema: {
      type: "object",
      properties: {
        siteId: { type: "string", description: "Site (Project ID/name/domain) to scope to" },
        accountId: { type: "string", description: "Team id/slug for team-level listing" },
      },
    },
  },
  {
    name: "netlify_get_env",
    description: "Get a single environment variable for a site (siteId) or team (accountId).",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Environment variable name, e.g. TRELLO_API_KEY" },
        siteId: { type: "string" },
        accountId: { type: "string" },
      },
      required: ["key"],
    },
  },
  {
    name: "netlify_set_env",
    description:
      "Create or update an environment variable. With siteId: sets it on that site. With accountId only: sets a team/shared variable for the given context (all/production/etc.) and scopes. IMPORTANT: env changes require a new deploy to take effect.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Variable name, e.g. TRELLO_API_KEY" },
        value: { type: "string", description: "Secret value" },
        siteId: { type: "string", description: "Target site (recommended for the frontdesk site)" },
        accountId: { type: "string", description: "Team id/slug (team-scoped var)" },
        context: { type: "string", description: "Deploy context for team vars: all, production, deploy-preview, branch-deploy (default all)" },
        scopes: {
          type: "array",
          items: { type: "string" },
          description: "Scopes for team vars: builds, functions, runtime (default all three)",
        },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "netlify_delete_env",
    description: "Delete an environment variable from a site (siteId) or team (accountId).",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        siteId: { type: "string" },
        accountId: { type: "string" },
      },
      required: ["key"],
    },
  },
  {
    name: "netlify_list_deploys",
    description: "List recent deploys for a site with state, branch, and commit.",
    inputSchema: {
      type: "object",
      properties: {
        siteId: { type: "string" },
        perPage: { type: "number", description: "Max results (default 20)" },
      },
    },
  },
  {
    name: "netlify_get_deploy",
    description: "Get a single deploy's full detail (incl. state) for a site.",
    inputSchema: {
      type: "object",
      properties: {
        siteId: { type: "string" },
        deployId: { type: "string" },
      },
      required: ["deployId"],
    },
  },
  {
    name: "netlify_trigger_build",
    description:
      "Trigger a new build+deploy of the site's linked repo (CI). Useful after changing env vars or to redeploy. Returns the new build id/state.",
    inputSchema: {
      type: "object",
      properties: {
        siteId: { type: "string" },
      },
    },
  },
  {
    name: "netlify_restore_deploy",
    description: "Roll back a site to a previous deploy by marking it as the live version.",
    inputSchema: {
      type: "object",
      properties: {
        siteId: { type: "string" },
        deployId: { type: "string" },
      },
      required: ["deployId"],
    },
  },
];

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
