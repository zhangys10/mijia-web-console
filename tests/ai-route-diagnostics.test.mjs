import assert from "node:assert/strict";
import test from "node:test";
import { withRouteDiagnostics } from "../lib/ai/api/diagnostics.ts";

test("route diagnostics log only request metadata and bounded public error codes", async (context) => {
  const errors = [];
  context.mock.method(console, "error", line => errors.push(line));
  const handler = withRouteDiagnostics("/api/ai/quota", async () => Response.json({
    code: "AI_AGENT_UNAVAILABLE", message: "sensitive exception details must not be logged",
  }, { status: 503, headers: { "Cache-Control": "no-store" } }));
  const response = await handler(new Request("https://console.test/api/ai/quota", {
    headers: { "x-request-id": "req_806b23a2f1334512aeb6c36fe0effabe" },
  }));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(JSON.parse(errors[0]), {
    event: "console_api_response_error", requestId: "req_806b23a2f1334512aeb6c36fe0effabe", route: "/api/ai/quota",
    stage: "ROUTE_HANDLER", httpStatus: 503, category: "AI_AGENT_UNAVAILABLE",
  });
  assert.equal(errors.join(" ").includes("sensitive exception"), false);
});

test("thrown route errors get a safe no-store response and no exception detail in logs", async context => {
  const errors = [];
  context.mock.method(console, "error", line => errors.push(line));
  const handler = withRouteDiagnostics("/api/ai/exposure", async () => { throw new Error("raw blob token or response"); });
  const response = await handler(new Request("https://console.test/api/ai/exposure"));
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { code: "AI_AGENT_UNAVAILABLE", message: "AI 助手暂时不可用" });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].includes("raw blob token or response"), false);
  const record = JSON.parse(errors[0]);
  assert.equal(record.requestId.length > 0, true);
  assert.equal(record.category, "UNEXPECTED_EXCEPTION");
});
