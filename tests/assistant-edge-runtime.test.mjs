import assert from "node:assert/strict";
import test from "node:test";
import { POST as capabilities } from "../app/api/internal/assistant/v1/capabilities/route.ts";
import { POST as invoke } from "../app/api/internal/assistant/v1/tools:invoke/route.ts";

test("Next assistant routes reject unauthenticated requests without side effects", async () => {
  const original = process.env.AI_TOOLS_INTERNAL_SECRET;
  delete process.env.AI_TOOLS_INTERNAL_SECRET;
  try {
    for (const route of [capabilities, invoke]) {
      const response = await route(new Request("https://console.test/api/internal/assistant/v1", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      }));
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.deepEqual(await response.json(), { code: "AI_UNAUTHENTICATED" });
    }
  } finally {
    if (original === undefined) delete process.env.AI_TOOLS_INTERNAL_SECRET;
    else process.env.AI_TOOLS_INTERNAL_SECRET = original;
  }
});

test("unexpected assistant failures log only bounded, sanitized metadata", async () => {
  const { createAssistantV1Handler } = await import("../lib/ai/tools/assistant-v1-service.ts");
  const logs = [];
  const env = {};
  Object.defineProperty(env, "AI_TOOLS_INTERNAL_SECRET", { get() { throw new Error("secret runtime value"); } });
  const response = await createAssistantV1Handler("invoke", { diagnosticLogger: record => logs.push(record) })({
    request: new Request("https://console.test/api/internal/assistant/v1/tools:invoke", {
      method: "POST", headers: { Authorization: "Bearer fake-token" }, body: JSON.stringify({ requestId: "req_safe_test", operation: "get_home_environment" }),
    }),
    env,
  });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { code: "AI_AGENT_UNAVAILABLE", diagnosticCode: "ASSISTANT_AUTHORIZATION_EXCEPTION" });
  assert.equal(logs.length, 1);
  assert.match(logs[0].requestId, /^[0-9a-f-]{36}$/);
  assert.deepEqual({ ...logs[0], requestId: undefined }, {
    event: "assistant_api_exception", requestId: undefined,
    route: "/api/internal/assistant/v1/tools:invoke", stage: "AUTHORIZATION", httpStatus: 502, category: "UNEXPECTED_EXCEPTION",
  });
  assert.equal(JSON.stringify(logs).includes("secret runtime value"), false);
});
