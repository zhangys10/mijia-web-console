import assert from "node:assert/strict";
import test from "node:test";

import { AiGatewayConfigError, loadAiGatewayConfig } from "../lib/ai/config.ts";
import {
  MakersGatewayError,
  MakersGatewayProvider,
} from "../lib/ai/providers/makers-gateway-provider.ts";

const gatewayKey = "test-gateway-key-value";
const gatewayEnv = {
  AI_GATEWAY_API_KEY: gatewayKey,
  AI_GATEWAY_BASE_URL: "https://gateway.example.test/v1",
  AI_GATEWAY_MODEL: "approved-fast-model",
  AI_GATEWAY_ALLOWED_MODELS: "approved-fast-model,approved-backup-model",
};

function createConfig(overrides = {}) {
  return loadAiGatewayConfig({ ...gatewayEnv, ...overrides });
}

const scenes = [
  { id: "scene-home", name: "回家模式", description: "用户已经回到家后激活" },
  { id: "scene-movie", name: "观影模式", description: "用户想观看影片时激活" },
];

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function toolCallResponse(overrides = {}) {
  return jsonResponse({
    choices: [{
      message: {
        content: "欢迎回家",
        tool_calls: [{
          function: {
            name: "activate_scene",
            arguments: JSON.stringify({ sceneId: "scene-home", replyMessage: "欢迎回家" }),
          },
        }],
      },
    }],
    usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 },
    ...overrides,
  });
}

async function runWithFetch(mock, callback) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return mock(input, init);
  };
  try {
    return await callback(calls);
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("Gateway config requires server-side model, key, and base URL", () => {
  for (const name of ["AI_GATEWAY_MODEL", "AI_GATEWAY_API_KEY", "AI_GATEWAY_BASE_URL"]) {
    const env = { ...gatewayEnv };
    delete env[name];
    assert.throws(
      () => loadAiGatewayConfig(env),
      (error) =>
        error instanceof AiGatewayConfigError
        && error.code === "AI_GATEWAY_NOT_CONFIGURED"
        && error.message.includes(name),
    );
    assert.throws(
      () => loadAiGatewayConfig({ ...env, [name]: "   " }),
      (error) => error instanceof AiGatewayConfigError && error.code === "AI_GATEWAY_NOT_CONFIGURED",
    );
  }
});

test("Gateway config rejects invalid base URLs and numeric limits", () => {
  const invalidUrls = [
    "not a url",
    "ftp://gateway.example.test/v1",
    "https://user:pass@gateway.example.test/v1",
    "https://gateway.example.test/v1?token=abc",
    "https://gateway.example.test/v1#fragment",
  ];
  for (const baseUrl of invalidUrls) {
    assert.throws(
      () => createConfig({ AI_GATEWAY_BASE_URL: baseUrl }),
      (error) => error instanceof AiGatewayConfigError && error.code === "AI_GATEWAY_CONFIG_INVALID",
    );
  }

  const invalidNumbers = [
    { AI_GATEWAY_TIMEOUT_MS: "abc" },
    { AI_GATEWAY_TIMEOUT_MS: "0" },
    { AI_GATEWAY_TIMEOUT_MS: "60001" },
    { AI_GATEWAY_MAX_OUTPUT_TOKENS: "-1" },
    { AI_GATEWAY_MAX_OUTPUT_TOKENS: "4097" },
  ];
  for (const overrides of invalidNumbers) {
    assert.throws(
      () => createConfig(overrides),
      (error) => error instanceof AiGatewayConfigError && error.code === "AI_GATEWAY_CONFIG_INVALID",
    );
  }
});

test("Gateway config applies safe defaults, trimming, and model allowlist", () => {
  const config = createConfig({
    AI_GATEWAY_API_KEY: `  ${gatewayKey}  `,
    AI_GATEWAY_BASE_URL: "https://gateway.example.test/v1/",
    AI_GATEWAY_ALLOWED_MODELS: " approved-fast-model , approved-backup-model ,, approved-fast-model ",
  });
  assert.equal(config.apiKey, gatewayKey);
  assert.equal(config.baseUrl, "https://gateway.example.test/v1");
  assert.equal(config.enableThinking, false);
  assert.equal(config.timeoutMs, 5000);
  assert.equal(config.maxOutputTokens, 256);
  assert.deepEqual(config.allowedModels, ["approved-fast-model", "approved-backup-model"]);

  const defaultAllowlist = createConfig({ AI_GATEWAY_ALLOWED_MODELS: "" });
  assert.deepEqual(defaultAllowlist.allowedModels, ["approved-fast-model"]);
});

test("Gateway request targets the configured URL with capped non-thinking settings", async () => {
  await runWithFetch(
    () => toolCallResponse(),
    async (calls) => {
      const history = [
        { role: "user", content: "家里有点暗" },
        { role: "assistant", content: "要试试观影模式吗？" },
      ];
      const decision = await new MakersGatewayProvider(createConfig()).decide("开一下吧", scenes, "zh-CN", "Asia/Shanghai", history);

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "https://gateway.example.test/v1/chat/completions");
      assert.equal(calls[0].init.method, "POST");

      const body = JSON.parse(calls[0].init.body);
      assert.equal(body.model, "approved-fast-model");
      assert.equal(body.max_tokens, 256);
      assert.equal(body.enable_thinking, false);
      assert.equal(body.temperature, 0);
      assert.equal(body.tool_choice, "auto");
      assert.equal(body.messages[0].role, "system");
      assert.equal(body.messages[1].content, "家里有点暗");
      assert.equal(body.messages[2].content, "要试试观影模式吗？");
      const payload = JSON.parse(body.messages.at(-1).content);
      assert.equal(payload.text, "开一下吧");
      assert.deepEqual(payload.availableScenes.map((scene) => scene.id), ["scene-home", "scene-movie"]);
      assert.deepEqual(body.tools[0].function.parameters.properties.sceneId.enum, ["scene-home", "scene-movie"]);
      assert.equal(decision.type, "tool_call");
      assert.equal(decision.tool, "activate_scene");
    },
  );
});

test("Gateway key only travels in the upstream Authorization header", async () => {
  await runWithFetch(
    () => toolCallResponse(),
    async (calls) => {
      await new MakersGatewayProvider(createConfig()).decide("我回家了", scenes);
      assert.equal(calls[0].init.headers.Authorization, `Bearer ${gatewayKey}`);
      assert.equal(calls[0].url.includes(gatewayKey), false);
      assert.equal(calls[0].init.body.includes(gatewayKey), false);
    },
  );
});

test("Gateway rejects a model outside the allowlist before any request", async () => {
  let called = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("unexpected fetch");
  };
  try {
    await assert.rejects(
      () => new MakersGatewayProvider(createConfig({ AI_GATEWAY_MODEL: "unapproved-model" })).decide("我回家了", scenes),
      (error) => error instanceof MakersGatewayError && error.code === "AI_GATEWAY_MODEL_NOT_ALLOWED",
    );
    assert.equal(called, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Gateway parses upstream token usage from a tool call", async () => {
  await runWithFetch(
    () => toolCallResponse(),
    async () => {
      const decision = await new MakersGatewayProvider(createConfig()).decide("我回家了", scenes);
      assert.equal(decision.type, "tool_call");
      assert.equal(decision.arguments.sceneId, "scene-home");
      assert.equal(decision.arguments.replyMessage, "欢迎回家");
      assert.deepEqual(decision.usage, {
        promptTokens: 30,
        completionTokens: 8,
        totalTokens: 38,
        estimated: false,
      });
    },
  );
});

test("Gateway estimates usage conservatively when upstream usage is missing", async () => {
  await runWithFetch(
    () => jsonResponse({ choices: [{ message: { content: "请明确要执行的场景" } }] }),
    async () => {
      const decision = await new MakersGatewayProvider(createConfig()).decide("帮我处理一下", scenes);
      assert.equal(decision.type, "no_action");
      assert.equal(decision.llmOutput, "请明确要执行的场景");
      assert.equal(decision.usage?.estimated, true);
      assert.ok(decision.usage.promptTokens >= 1);
      assert.ok(decision.usage.completionTokens >= 1);
      assert.equal(decision.usage.totalTokens, decision.usage.promptTokens + decision.usage.completionTokens);
    },
  );
});

test("Gateway maps upstream failures to stable codes without leaking the key", async () => {
  const cases = [
    { status: 400, code: "AI_GATEWAY_REQUEST_REJECTED" },
    { status: 401, code: "AI_GATEWAY_AUTH_FAILED" },
    { status: 403, code: "AI_GATEWAY_AUTH_FAILED" },
    { status: 429, code: "AI_GATEWAY_RATE_LIMITED", retryAfterSeconds: 17 },
    { status: 500, code: "AI_GATEWAY_UNAVAILABLE" },
    { status: 503, code: "AI_GATEWAY_UNAVAILABLE" },
  ];

  for (const item of cases) {
    await runWithFetch(
      () => new Response(`upstream body containing ${gatewayKey}`, {
        status: item.status,
        headers: { "Retry-After": item.retryAfterSeconds === undefined ? "" : String(item.retryAfterSeconds) },
      }),
      async () => {
        await assert.rejects(
          () => new MakersGatewayProvider(createConfig()).decide("我回家了", scenes),
          (error) => {
            assert.equal(error instanceof MakersGatewayError, true);
            assert.equal(error.code, item.code);
            assert.equal(error.retryAfterSeconds, item.retryAfterSeconds);
            assert.equal(String(error).includes(gatewayKey), false);
            assert.equal(String(error).includes("upstream body"), false);
            assert.equal(error.stack.includes(gatewayKey), false);
            return true;
          },
        );
      },
    );
  }
});

test("Gateway maps timeouts and network failures without leaking the key", async () => {
  await runWithFetch(
    (_input, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }),
    async () => {
      await assert.rejects(
        () => new MakersGatewayProvider(createConfig({ AI_GATEWAY_TIMEOUT_MS: "1" })).decide("我回家了", scenes),
        (error) => error instanceof MakersGatewayError && error.code === "AI_GATEWAY_TIMEOUT",
      );
    },
  );

  await runWithFetch(
    () => {
      throw new TypeError(`fetch failed with ${gatewayKey}`);
    },
    async () => {
      await assert.rejects(
        () => new MakersGatewayProvider(createConfig()).decide("我回家了", scenes),
        (error) => {
          assert.equal(error instanceof MakersGatewayError, true);
          assert.equal(error.code, "AI_GATEWAY_UNAVAILABLE");
          assert.equal(String(error).includes(gatewayKey), false);
          return true;
        },
      );
    },
  );
});

test("Gateway rejects invalid or incomplete upstream payloads", async () => {
  const payloads = [
    () => new Response("not-json", { status: 200, headers: { "Content-Type": "application/json" } }),
    () => jsonResponse({ choices: [] }),
    () => jsonResponse({ choices: [{ message: { tool_calls: [{ function: { name: "activate_scene", arguments: "no-json" } }] } }] }),
  ];

  for (const payload of payloads) {
    await runWithFetch(payload, async () => {
      await assert.rejects(
        () => new MakersGatewayProvider(createConfig()).decide("我回家了", scenes),
        (error) => error instanceof MakersGatewayError && error.code === "AI_GATEWAY_RESPONSE_INVALID",
      );
    });
  }
});
