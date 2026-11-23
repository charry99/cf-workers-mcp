// Unit tests for the Cloudflare API response parsers, run against saved
// fixture JSON written to the documented API v4 response shapes.
// Run with: npm test   (builds first, then node --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  parseScriptsList,
  parseScriptSettings,
  parseVersionsList,
  parseDeploymentsList,
  isValidAccountId,
  isValidScriptName,
  requireScriptName,
  resolveAccountId,
} from "../dist/cloudflare.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) =>
  JSON.parse(readFileSync(join(here, "fixtures", name), "utf8"));

test("parseScriptsList maps the documented Script shape", () => {
  const out = parseScriptsList(fixture("list-scripts.json").result);
  assert.equal(out.count, 2);
  const [w] = out.workers;
  assert.equal(w.name, "api-gateway");
  assert.deepEqual(w.handlers, ["fetch", "scheduled"]);
  assert.equal(w.named_handlers.length, 1);
  assert.equal(w.named_handlers[0].name, "SessionStore");
  assert.equal(w.last_deployed_from, "wrangler");
  assert.equal(w.compatibility_date, "2026-06-01");
  // Internal fields (tag) are not passed through.
  assert.equal("tag" in w, false);
});

test("parseScriptSettings reduces bindings to identifiers, never values", () => {
  const out = parseScriptSettings(fixture("script-settings.json").result);
  assert.equal(out.compatibility_date, "2026-06-01");
  assert.deepEqual(out.compatibility_flags, ["nodejs_compat"]);
  assert.equal(out.bindings.length, 5);
  const kv = out.bindings.find((b) => b.name === "SESSIONS");
  assert.equal(kv.type, "kv_namespace");
  assert.equal(kv.namespace_id, "11112222333344445555666677778888");
  const plain = out.bindings.find((b) => b.name === "API_ORIGIN");
  assert.equal(plain.type, "plain_text");
  // The fixture deliberately contains a plain_text value; it must be dropped.
  assert.equal("text" in plain, false);
  const raw = JSON.stringify(out);
  assert.equal(raw.includes("origin.internal.example"), false);
  assert.equal(raw.includes("SIGNING_KEY") && raw.includes("secret"), true); // name+type ok
  assert.equal(out.observability.enabled, true);
});

test("parseVersionsList maps number/id/metadata/annotations", () => {
  const out = parseVersionsList(fixture("list-versions.json").result);
  assert.equal(out.count, 2);
  const [v] = out.versions;
  assert.equal(v.number, 42);
  assert.equal(v.id, "023e105f-2a42-4f8b-a1c1-73f6a2a30c0f");
  assert.equal(v.created_on, "2026-11-20T16:02:44.000Z");
  assert.equal(v.source, "wrangler");
  assert.equal(v.message, "Fix session TTL");
  assert.equal(v.tag, "v1.4.2");
  // The resources block (script internals) is not passed through.
  assert.equal("resources" in v, false);
});

test("parseDeploymentsList maps traffic splits and annotations", () => {
  const out = parseDeploymentsList(fixture("list-deployments.json").result);
  assert.equal(out.count, 2);
  const [d] = out.deployments;
  assert.equal(d.id, "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e");
  assert.equal(d.strategy, "percentage");
  assert.deepEqual(d.versions, [
    { version_id: "023e105f-2a42-4f8b-a1c1-73f6a2a30c0f", percentage: 100 },
  ]);
  assert.equal(d.message, "Deploy bug fix.");
  assert.equal(d.triggered_by, "deployment");
  const canary = out.deployments[1];
  assert.equal(canary.versions.length, 2);
  assert.equal(
    canary.versions.reduce((sum, v) => sum + v.percentage, 0),
    100
  );
});

test("parsers reject malformed shapes with a clear error", () => {
  assert.throws(() => parseScriptsList({ not: "an array" }), /not an array/);
  assert.throws(() => parseDeploymentsList([]), /not an object/);
  assert.throws(() => parseScriptSettings(null), /not an object/);
  const err = fixture("error-envelope.json");
  assert.equal(err.success, false);
  assert.equal(err.errors[0].code, 10000);
});

test("account ID validation accepts only 32 hex chars", () => {
  assert.equal(isValidAccountId("023e105f4ecef8ad9ca31a8372d0c353"), true);
  assert.equal(isValidAccountId("023e105f"), false);
  assert.equal(isValidAccountId("zz3e105f4ecef8ad9ca31a8372d0c353"), false);
  assert.equal(isValidAccountId(42), false);
  assert.equal(isValidAccountId(undefined), false);
});

test("script name validation follows Workers naming rules", () => {
  assert.equal(isValidScriptName("my-worker_2"), true);
  assert.equal(isValidScriptName("My Worker"), false);
  assert.equal(isValidScriptName("-leading-dash"), false);
  assert.equal(isValidScriptName(""), false);
  assert.equal(isValidScriptName("a".repeat(65)), false);
  assert.throws(() => requireScriptName("../etc/passwd"), /valid worker "name"/);
});

test("resolveAccountId: explicit arg wins, env is the fallback, junk fails", () => {
  const good = "023e105f4ecef8ad9ca31a8372d0c353";
  const other = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const saved = process.env.CF_ACCOUNT_ID;
  try {
    process.env.CF_ACCOUNT_ID = other;
    assert.equal(resolveAccountId(good), good);
    assert.equal(resolveAccountId(undefined), other);
    assert.throws(() => resolveAccountId("nope"), /not a valid Cloudflare account ID/);
    delete process.env.CF_ACCOUNT_ID;
    assert.throws(() => resolveAccountId(undefined), /No Cloudflare account ID/);
  } finally {
    if (saved === undefined) delete process.env.CF_ACCOUNT_ID;
    else process.env.CF_ACCOUNT_ID = saved;
  }
});
