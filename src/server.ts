#!/usr/bin/env node
/**
 * cloudflare-workers-mcp-server — read-only MCP server for Cloudflare Workers.
 *
 * Lets Claude, Cursor and other MCP clients inspect the Workers in a
 * Cloudflare account: list scripts, read one worker's settings, list its
 * versions and deployments, and check a worker URL's live HTTP status.
 * It only performs HTTP GET requests. It never uploads, deploys, edits or
 * deletes anything, and the API token comes from the CF_API_TOKEN
 * environment variable — it is never logged, stored or returned.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  listWorkers,
  getWorker,
  listVersions,
  listDeployments,
  checkWorkerStatus,
} from "./cloudflare.js";

const ACCOUNT_ID_PROP = {
  type: "string",
  pattern: "^[0-9a-fA-F]{32}$",
  description:
    "Cloudflare account ID (32 hex characters). Optional when CF_ACCOUNT_ID is set in the server environment.",
} as const;

const NAME_PROP = {
  type: "string",
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-z0-9][a-z0-9_-]*$",
  description: "Worker script name as shown in the Cloudflare dashboard, e.g. \"my-worker\".",
} as const;

const LIMIT_PROP = {
  type: "integer",
  minimum: 1,
  maximum: 50,
  description: "How many entries to return, newest first. Default 10, max 50.",
} as const;

const TOOLS = [
  {
    name: "list_workers",
    description:
      "List the Workers (scripts) in a Cloudflare account: name, created and " +
      "modified times, exported handlers, last deployed from, compatibility " +
      "date. Read-only; needs CF_API_TOKEN.",
    inputSchema: {
      type: "object",
      properties: { account_id: ACCOUNT_ID_PROP },
      additionalProperties: false,
    },
  },
  {
    name: "get_worker",
    description:
      "Read one Worker's settings: compatibility date and flags, usage " +
      "model, observability, and its bindings reduced to name and type " +
      "(binding values and secrets are never returned). Read-only; needs " +
      "CF_API_TOKEN.",
    inputSchema: {
      type: "object",
      properties: { name: NAME_PROP, account_id: ACCOUNT_ID_PROP },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "list_versions",
    description:
      "List a Worker's recent versions, newest first: version number and " +
      "ID, creation time, source, author and the version message/tag. " +
      "Read-only; needs CF_API_TOKEN.",
    inputSchema: {
      type: "object",
      properties: { name: NAME_PROP, account_id: ACCOUNT_ID_PROP, limit: LIMIT_PROP },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "list_deployments",
    description:
      "List a Worker's recent deployments, latest first (the first entry " +
      "is the deployment currently serving traffic): deployment ID, time, " +
      "source, traffic split across version IDs, message and author. " +
      "Read-only; needs CF_API_TOKEN.",
    inputSchema: {
      type: "object",
      properties: { name: NAME_PROP, account_id: ACCOUNT_ID_PROP, limit: LIMIT_PROP },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "check_worker_status",
    description:
      "Check a worker URL's live HTTP status: reachability, status code, " +
      "response time, final URL after redirects, content type and server " +
      "header. Needs no Cloudflare token — it fetches the URL like any " +
      "HTTP client. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          format: "uri",
          description: "The http(s) URL to check, e.g. https://my-worker.example.workers.dev/",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
];

const server = new Server(
  { name: "cloudflare-workers-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const a = (args ?? {}) as Record<string, unknown>;
  try {
    let result: Record<string, unknown>;
    if (name === "list_workers") result = await listWorkers(a);
    else if (name === "get_worker") result = await getWorker(a);
    else if (name === "list_versions") result = await listVersions(a);
    else if (name === "list_deployments") result = await listDeployments(a);
    else if (name === "check_worker_status") result = await checkWorkerStatus(a);
    else throw new Error(`Unknown tool "${name}".`);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return {
      content: [
        { type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` },
      ],
      isError: true,
    };
  }
});

await server.connect(new StdioServerTransport());
console.error("cloudflare-workers-mcp-server running on stdio (read-only)");
