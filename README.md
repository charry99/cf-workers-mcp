# cloudflare-workers-mcp-server

A read-only MCP server for Cloudflare Workers. Add one entry to your MCP
client config and ask your assistant "what Workers do I have, what
changed last, and is this one up?" — it lists the Workers in your
account, reads one Worker's settings, lists its recent versions and
deployments, and checks a worker URL's live HTTP status.

It is read-only by construction: the code only sends HTTP GET requests
(Cloudflare API v4, plus the status-check fetch). There is no upload,
deploy, edit or delete code path anywhere in the project.

## 1. Create a read-only Cloudflare API token

The four account tools need a token. Create the narrowest one:

1. Cloudflare dashboard → **My Profile** (top-right avatar) → **API Tokens**.
2. **Create Token** → **Create Custom Token**.
3. Permissions: **Account** → **Workers Scripts** → **Read**. (That one
   permission covers scripts, settings, versions and deployments.)
4. Account Resources: **Include** → your account only.
5. Create, copy the token once, and put it in the `env` block of your
   MCP client config (below). Never paste it into a chat, a repo or a
   screenshot — the server reads it from the environment only.

Also copy your **Account ID**: dashboard → **Workers & Pages** → the
right-hand panel shows it. You can set it as `CF_ACCOUNT_ID` or pass
`account_id` per tool call.

## 2. Install

```bash
npm install
npm run build
```

Node 20+ is the only requirement. The server is TypeScript compiled to
`dist/`; your MCP client starts it with `node dist/server.js`.

## Tools

- `list_workers` — Workers in the account: name, created/modified
  times, exported handlers, last deployed from, compatibility date.
- `get_worker` — one Worker's settings: compatibility date and flags,
  usage model, observability, and bindings reduced to **name and type
  only** (binding values and secrets are never returned).
- `list_versions` — recent versions, newest first: number, ID, time,
  source, author, version message/tag. `limit` 1–50, default 10.
- `list_deployments` — recent deployments, latest first; the first
  entry is what is serving traffic now: deployment ID, time, source,
  traffic split across version IDs, message, author.
- `check_worker_status` — live HTTP status of any worker URL:
  reachability, status code, response time, final URL after redirects,
  content type, server header. **Needs no token.**

If `CF_API_TOKEN` is missing, the four account tools return the token
setup instructions as the error — nothing is sent to Cloudflare.

## Config: Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cloudflare-workers": {
      "command": "node",
      "args": ["/absolute/path/to/cloudflare-workers-mcp-server/dist/server.js"],
      "env": {
        "CF_API_TOKEN": "your-read-only-token",
        "CF_ACCOUNT_ID": "your-32-hex-account-id"
      }
    }
  }
}
```

## Config: Cursor

`.cursor/mcp.json` in your project, or `~/.cursor/mcp.json` globally —
same shape as the Claude Desktop block above.

## Config: Claude Code

```bash
claude mcp add cloudflare-workers \
  -e CF_API_TOKEN=your-read-only-token \
  -e CF_ACCOUNT_ID=your-32-hex-account-id \
  -- node /absolute/path/to/cloudflare-workers-mcp-server/dist/server.js
```

Then ask, in plain words: "List my Cloudflare Workers", "What bindings
does api-gateway have?", "Show the last 5 deployments of image-resizer",
"Is https://api-gateway.example.workers.dev up?"

## Safety: why read-only is the point

- GET-only: every Cloudflare call in `src/cloudflare.ts` is a GET; the
  status check is a plain fetch whose body is discarded.
- The token is read from `CF_API_TOKEN` at call time, is only ever sent
  as the `Authorization` header to `api.cloudflare.com`, and is never
  logged or included in any tool result.
- Settings parsing whitelists fields: a `plain_text` binding's value
  and any secret material cannot reach the client (there is a unit
  test that feeds a value through the parser and asserts it is gone).
- Inputs are validated strictly: account IDs must be 32 hex chars,
  worker names must match Workers naming rules, status-check URLs must
  be http(s).

## Optional environment variables

- `CF_API_TOKEN` — required for the four account tools.
- `CF_ACCOUNT_ID` — default account ID.
- `CF_API_BASE_URL` — override the API base (testing). Default
  `https://api.cloudflare.com/client/v4`.

## Tests

```bash
npm test                    # parser + validation unit tests vs fixtures
node test/test-client.mjs   # live stdio session (see transcript.md)
```

Fixtures in `test/fixtures/` are labeled as fixtures, hand-written to
the documented API v4 response shapes — they are not captured account
data.

## Files

- `src/server.ts` — MCP wiring (tool schemas + handlers)
- `src/cloudflare.ts` — API client, parsers, validation, status check
- `test/` — unit tests, fixtures, stdio test client
- `transcript.md` — a real session: initialize, tools/list, a live
  status check, and the token gate firing with no token configured

License: MIT (see `LICENSE`).
