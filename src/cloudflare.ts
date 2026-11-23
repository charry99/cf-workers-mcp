/**
 * Cloudflare API v4 client + response parsers for the read-only Workers
 * MCP server. Only HTTP GET is ever used. The API token comes from the
 * CF_API_TOKEN environment variable and is never logged or returned.
 *
 * The parse* functions are pure (parsed JSON in, compact shape out) so
 * they can be unit-tested against saved fixture responses.
 */

const API_BASE = (
  process.env.CF_API_BASE_URL || "https://api.cloudflare.com/client/v4"
).replace(/\/$/, "");

const USER_AGENT = "cloudflare-workers-mcp-server/1.0.0";

export const TOKEN_HELP =
  "CF_API_TOKEN is not set. Create a read-only API token in the Cloudflare " +
  "dashboard (My Profile -> API Tokens -> Create Token -> Custom token, " +
  "permission: Account -> Workers Scripts -> Read, scoped to your account), " +
  "then pass it to this server as the CF_API_TOKEN environment variable. " +
  "See README.md for the exact steps. The check_worker_status tool works " +
  "without a token.";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function isValidAccountId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-fA-F]{32}$/.test(value);
}

export function isValidScriptName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 64 &&
    /^[a-z0-9][a-z0-9_-]*$/.test(value)
  );
}

export function requireScriptName(value: unknown): string {
  if (!isValidScriptName(value)) {
    throw new Error(
      'A valid worker "name" is required: 1-64 characters, lowercase letters, ' +
        "digits, hyphens and underscores, starting with a letter or digit " +
        "(the name shown in the Cloudflare dashboard, e.g. \"my-worker\")."
    );
  }
  return value;
}

export function resolveAccountId(arg?: unknown): string {
  const candidate =
    typeof arg === "string" && arg.length > 0
      ? arg
      : process.env.CF_ACCOUNT_ID;
  if (candidate === undefined || candidate === "") {
    throw new Error(
      "No Cloudflare account ID. Pass \"account_id\" to the tool or set the " +
        "CF_ACCOUNT_ID environment variable (Dashboard -> Workers & Pages -> " +
        "Account ID in the right-hand panel)."
    );
  }
  if (!isValidAccountId(candidate)) {
    throw new Error(
      `"${candidate}" is not a valid Cloudflare account ID (expected 32 hex characters).`
    );
  }
  return candidate;
}

function requireToken(): string {
  const token = process.env.CF_API_TOKEN;
  if (!token) throw new Error(TOKEN_HELP);
  return token;
}

// ---------------------------------------------------------------------------
// API access (GET only)
// ---------------------------------------------------------------------------

interface CfError {
  code?: number;
  message?: string;
}

interface CfEnvelope {
  success?: boolean;
  errors?: CfError[];
  result?: unknown;
}

async function cfGet(path: string): Promise<unknown> {
  const token = requireToken();
  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "user-agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new Error(`Cloudflare API request failed for ${path}: ${errMessage(err)}`);
  }
  let body: CfEnvelope;
  try {
    body = (await res.json()) as CfEnvelope;
  } catch {
    throw new Error(`Cloudflare API returned a non-JSON response (${res.status}) for ${path}.`);
  }
  if (!res.ok || body.success !== true) {
    const detail =
      (body.errors || [])
        .map((e) => `${e.code ?? "?"}: ${e.message ?? "unknown error"}`)
        .join("; ") || `HTTP ${res.status}`;
    throw new Error(`Cloudflare API error for ${path}: ${detail}`);
  }
  return body.result;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Parsers (pure; input is the envelope's `result` value)
// ---------------------------------------------------------------------------

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Unexpected Cloudflare API shape: ${what} is not an object.`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Unexpected Cloudflare API shape: ${what} is not an array.`);
  }
  return value;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function strList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

/** One script entry from GET /accounts/{id}/workers/scripts. */
export function fmtScript(raw: unknown): Record<string, unknown> {
  const s = asRecord(raw, "script");
  const named = Array.isArray(s.named_handlers)
    ? (s.named_handlers as Record<string, unknown>[]).map((h) => ({
        name: str(h.name),
        handlers: strList(h.handlers),
      }))
    : [];
  return {
    name: str(s.id),
    created_on: str(s.created_on),
    modified_on: str(s.modified_on),
    etag: str(s.etag),
    handlers: strList(s.handlers),
    named_handlers: named,
    last_deployed_from: str(s.last_deployed_from),
    compatibility_date: str(s.compatibility_date),
  };
}

export function parseScriptsList(result: unknown): Record<string, unknown> {
  const scripts = asArray(result, "scripts list result").map(fmtScript);
  return { count: scripts.length, workers: scripts };
}

/**
 * Settings from GET /accounts/{id}/workers/scripts/{name}/settings.
 * Bindings are reduced to identifiers only (name, type, target ids) —
 * binding values (plain-text values, secrets) are never passed through.
 */
export function parseScriptSettings(result: unknown): Record<string, unknown> {
  const s = asRecord(result, "script settings");
  const bindings = Array.isArray(s.bindings)
    ? (s.bindings as Record<string, unknown>[]).map((b) => {
        const out: Record<string, unknown> = {
          name: str(b.name),
          type: str(b.type),
        };
        for (const key of [
          "namespace_id",
          "class_name",
          "script_name",
          "bucket_name",
          "database_name",
          "queue_name",
          "service",
          "dataset",
        ]) {
          if (typeof b[key] === "string") out[key] = b[key];
        }
        return out;
      })
    : [];
  const obs = asOptionalRecord(s.observability);
  return {
    compatibility_date: str(s.compatibility_date),
    compatibility_flags: strList(s.compatibility_flags),
    usage_model: str(s.usage_model),
    logpush: typeof s.logpush === "boolean" ? s.logpush : null,
    observability: obs
      ? {
          enabled: typeof obs.enabled === "boolean" ? obs.enabled : null,
          head_sampling_rate:
            typeof obs.head_sampling_rate === "number"
              ? obs.head_sampling_rate
              : null,
        }
      : null,
    bindings,
  };
}

function asOptionalRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** One version from GET /accounts/{id}/workers/scripts/{name}/versions. */
export function fmtVersion(raw: unknown): Record<string, unknown> {
  const v = asRecord(raw, "version");
  const meta = asOptionalRecord(v.metadata) || {};
  const ann = asOptionalRecord(v.annotations) || {};
  return {
    number: typeof v.number === "number" ? v.number : null,
    id: str(v.id),
    created_on: str(meta.created_on),
    source: str(meta.source),
    author_email: str(meta.author_email),
    message: str(ann["workers/message"]),
    tag: str(ann["workers/tag"]),
  };
}

export function parseVersionsList(result: unknown): Record<string, unknown> {
  const versions = asArray(result, "versions list result").map(fmtVersion);
  return { count: versions.length, versions };
}

/** One deployment from GET /accounts/{id}/workers/scripts/{name}/deployments. */
export function fmtDeployment(raw: unknown): Record<string, unknown> {
  const d = asRecord(raw, "deployment");
  const ann = asOptionalRecord(d.annotations) || {};
  const versions = Array.isArray(d.versions)
    ? (d.versions as Record<string, unknown>[]).map((v) => ({
        version_id: str(v.version_id),
        percentage: typeof v.percentage === "number" ? v.percentage : null,
      }))
    : [];
  return {
    id: str(d.id),
    created_on: str(d.created_on),
    source: str(d.source),
    strategy: str(d.strategy),
    versions,
    message: str(ann["workers/message"]),
    triggered_by: str(ann["workers/triggered_by"]),
    author_email: str(d.author_email),
  };
}

export function parseDeploymentsList(result: unknown): Record<string, unknown> {
  const obj = asRecord(result, "deployments result");
  const deployments = asArray(obj.deployments, "deployments").map(fmtDeployment);
  return { count: deployments.length, deployments };
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

export async function listWorkers(args: {
  account_id?: unknown;
}): Promise<Record<string, unknown>> {
  const accountId = resolveAccountId(args.account_id);
  const result = await cfGet(`/accounts/${accountId}/workers/scripts`);
  return { account_id: accountId, ...parseScriptsList(result) };
}

export async function getWorker(args: {
  name?: unknown;
  account_id?: unknown;
}): Promise<Record<string, unknown>> {
  const name = requireScriptName(args.name);
  const accountId = resolveAccountId(args.account_id);
  const result = await cfGet(
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(name)}/settings`
  );
  return { account_id: accountId, name, settings: parseScriptSettings(result) };
}

export async function listVersions(args: {
  name?: unknown;
  account_id?: unknown;
  limit?: unknown;
}): Promise<Record<string, unknown>> {
  const name = requireScriptName(args.name);
  const accountId = resolveAccountId(args.account_id);
  const limit = clampLimit(args.limit, 10, 50);
  const result = await cfGet(
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(name)}/versions?per_page=${limit}`
  );
  return { account_id: accountId, name, ...parseVersionsList(result) };
}

export async function listDeployments(args: {
  name?: unknown;
  account_id?: unknown;
  limit?: unknown;
}): Promise<Record<string, unknown>> {
  const name = requireScriptName(args.name);
  const accountId = resolveAccountId(args.account_id);
  const limit = clampLimit(args.limit, 10, 50);
  const result = await cfGet(
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(name)}/deployments?per_page=${limit}`
  );
  return { account_id: accountId, name, ...parseDeploymentsList(result) };
}

function clampLimit(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), max);
}

/**
 * Live HTTP status check. Needs no Cloudflare token: it fetches the URL
 * like any HTTP client and reports what came back. GET is used (some
 * hosts reject HEAD); the body is discarded unread.
 */
export async function checkWorkerStatus(args: {
  url?: unknown;
}): Promise<Record<string, unknown>> {
  const raw = args.url;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) {
    throw new Error('check_worker_status needs a "url" string (max 2048 characters).');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`"${raw}" is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Only http:// and https:// URLs can be checked (got ${url.protocol}).`);
  }
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: { "user-agent": USER_AGENT, accept: "*/*" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return {
      url: url.toString(),
      reachable: false,
      error: errMessage(err),
      response_time_ms: Date.now() - started,
    };
  }
  const elapsed = Date.now() - started;
  try {
    await res.body?.cancel();
  } catch {
    /* body already consumed or absent; status is what matters */
  }
  return {
    url: url.toString(),
    final_url: res.url,
    reachable: true,
    status: res.status,
    ok: res.ok,
    response_time_ms: elapsed,
    content_type: res.headers.get("content-type"),
    server: res.headers.get("server"),
  };
}
