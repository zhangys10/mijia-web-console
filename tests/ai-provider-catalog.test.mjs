import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveProvider,
  validateProviderKey,
  listSupportedProviders,
  ProviderCatalogError,
} from "../lib/ai/providers/provider-catalog.ts";

test("listSupportedProviders returns allowed providers and models", () => {
  const providers = listSupportedProviders();
  assert.equal(providers.length >= 1, true);
  const qwen = providers.find((p) => p.id === "qwen-cn");
  assert.ok(qwen);
  assert.equal(qwen.name, "通义千问（中国大陆）");
  assert.equal(qwen.allowedModels.includes("qwen3.7-flash-2026-07-15"), true);
});

test("resolveProvider returns mainland baseUrl and selected model", () => {
  const resolved = resolveProvider("qwen-cn", "qwen3.7-flash-2026-07-15");
  assert.equal(resolved.provider.id, "qwen-cn");
  assert.equal(resolved.model, "qwen3.7-flash-2026-07-15");
  assert.equal(resolved.baseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1");

  // Default model when omitted
  const def = resolveProvider("qwen-cn");
  assert.equal(def.model, "qwen3.7-flash-2026-07-15");
});

test("resolveProvider rejects unknown provider or model", () => {
  assert.throws(
    () => resolveProvider("openai"),
    (err) => err instanceof ProviderCatalogError && err.code === "LLM_PROVIDER_NOT_ALLOWED"
  );

  assert.throws(
    () => resolveProvider("qwen-cn", "gpt-4o"),
    (err) => err instanceof ProviderCatalogError && err.code === "LLM_MODEL_NOT_ALLOWED"
  );
});

test("validateProviderKey succeeds when upstream returns 200", async () => {
  const mockFetch = async (url, options) => {
    assert.match(url, /chat\/completions/);
    assert.equal(options.headers.Authorization, "Bearer sk-valid-key");
    return new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const res = await validateProviderKey("qwen-cn", "sk-valid-key", "qwen3.7-flash-2026-07-15", {
    customFetch: mockFetch,
  });
  assert.equal(res.valid, true);
});

test("validateProviderKey maps 401/403 to LLM_CREDENTIAL_INVALID", async () => {
  const mockFetch = async () => new Response("Unauthorized", { status: 401 });

  await assert.rejects(
    () => validateProviderKey("qwen-cn", "sk-bad-key", undefined, { customFetch: mockFetch }),
    (err) => err instanceof ProviderCatalogError && err.code === "LLM_CREDENTIAL_INVALID"
  );
});

test("validateProviderKey maps timeout to LLM_TIMEOUT", async () => {
  const mockFetch = async () => {
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    throw error;
  };

  await assert.rejects(
    () => validateProviderKey("qwen-cn", "sk-test", undefined, { customFetch: mockFetch }),
    (err) => err instanceof ProviderCatalogError && err.code === "LLM_TIMEOUT"
  );
});
