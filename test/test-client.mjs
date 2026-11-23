// Minimal MCP client harness: spawns the compiled server over stdio and
// runs a real session — initialize, tools/list, the no-auth
// check_worker_status tool against a live URL, and list_workers with no
// token configured (must fail with the set-CF_API_TOKEN guidance).
// Run with: npm run build && node test/test-client.mjs
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const env = { ...process.env };
delete env.CF_API_TOKEN; // prove the token gate and the no-auth tool
delete env.CF_ACCOUNT_ID;

const proc = spawn("node", ["dist/server.js"], {
  stdio: ["pipe", "pipe", "inherit"],
  env,
});
const rl = createInterface({ input: proc.stdout });
const pending = new Map();
let nextId = 1;
const log = [];
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
function send(obj) {
  const s = JSON.stringify(obj);
  log.push(">>> " + s);
  proc.stdin.write(s + "\n");
}
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, (m) => {
      log.push("<<< " + JSON.stringify(m));
      resolve(m);
    });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

await request("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "cf-workers-mcp-test-client", version: "1.0.0" },
});
send({ jsonrpc: "2.0", method: "notifications/initialized" });
await request("tools/list", {});
const call = async (name, args) =>
  request("tools/call", { name, arguments: args });

const status = await call("check_worker_status", { url: "https://example.com/" });
console.error("status check:", status.result.content[0].text.split("\n")[3]);

const noToken = await call("list_workers", {
  account_id: "023e105f4ecef8ad9ca31a8372d0c353",
});
console.error(
  "token gate isError:",
  noToken.result.isError === true,
  "| guidance present:",
  noToken.result.content[0].text.includes("CF_API_TOKEN is not set")
);

const badUrl = await call("check_worker_status", { url: "ftp://example.com/" });
console.error("non-http URL rejected:", badUrl.result.isError === true);

console.log(log.join("\n"));
proc.kill();
