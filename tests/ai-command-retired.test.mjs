import assert from "node:assert/strict";
import test from "node:test";

// Phase 3: /api/ai/command 的嵌入式编排已移除，命令流量由 mijia-agent 的
// /ai/command 承接。console 路由只保留稳定的退役响应。

async function getWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `ai-command-retired-${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  const env = { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
  const context = { waitUntil() {}, passThroughOnException() {} };
  return { worker, env, context };
}

test("retired command route answers POST with 410 AI_COMMAND_RETIRED for any caller", async () => {
  const { worker, env, context } = await getWorker();
  const res = await worker.fetch(new Request("http://localhost/api/ai/command", {
    method: "POST",
    headers: {
      // 带与不带 automation token 都必须是同样的退役响应，不做任何处理。
      Authorization: "Bearer v1.some.legacy.token.value",
      "Idempotency-Key": "20260921000000-0000001",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: "我回家了" }),
  }), env, context);

  assert.equal(res.status, 410);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  const json = await res.json();
  assert.equal(json.code, "AI_COMMAND_RETIRED");
  assert.ok(json.requestId);
  assert.match(json.message, /ai\/command/);
});

test("retired command route GET reports the agent endpoint without auth", async () => {
  const { worker, env, context } = await getWorker();
  const res = await worker.fetch(new Request("http://localhost/api/ai/command"), env, context);

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  const json = await res.json();
  assert.equal(json.status, "retired");
  assert.equal(json.endpoint, "POST /ai/command (mijia-agent)");
});

test("retired command route OPTIONS still lists supported methods", async () => {
  const { worker, env, context } = await getWorker();
  const res = await worker.fetch(new Request("http://localhost/api/ai/command", { method: "OPTIONS" }), env, context);

  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Allow"), "GET, POST, OPTIONS");
});
