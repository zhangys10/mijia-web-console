import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";

import { seal } from "../lib/xiaomi-cloud.ts";
import { derivePrincipalId, PrincipalError } from "../lib/ai/security/principal.ts";

process.env.XIAOMI_SESSION_SECRET = "ai-principal-test-secret-at-least-32-characters";
process.env.AI_PRINCIPAL_SECRET = "ai-principal-hmac-secret-at-least-32-characters";
process.env.NODE_ENV = "test";
process.env.APP_ENV = "test";

const principalSecret = "ai-principal-hmac-secret-at-least-32-characters";
const fakeSession = {
  userId: "user-principal-test-1",
  cUserId: "c-user-principal-test-1",
  ssecurity: "mock-ssecurity",
  serviceToken: "mock-serviceToken",
  region: "cn",
  deviceId: "mock-device",
  userAgent: "mock-agent",
  createdAt: Date.now(),
};

async function getWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `ai-principal-${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  const env = {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    XIAOMI_SESSION_SECRET: process.env.XIAOMI_SESSION_SECRET,
    AI_PRINCIPAL_SECRET: process.env.AI_PRINCIPAL_SECRET,
    APP_ENV: "test",
  };
  const context = { waitUntil() {}, passThroughOnException() {} };
  return { worker, env, context };
}

async function createCookieHeader(session) {
  const sealed = await seal(session, process.env.XIAOMI_SESSION_SECRET);
  return `xiaomi_session=${sealed}`;
}

test("derivePrincipalId uses HMAC-SHA256 and returns a usr_ Base64URL ID", async () => {
  const expected =
    "usr_" + createHmac("sha256", principalSecret).update(`xiaomi:${fakeSession.userId}`).digest("base64url");
  const actual = await derivePrincipalId(fakeSession, { AI_PRINCIPAL_SECRET: principalSecret });

  assert.equal(actual, expected);
  assert.match(actual, /^usr_[A-Za-z0-9_-]{43}$/);
  assert.equal(actual.includes("="), false);
  assert.equal(actual.includes("+"), false);
  assert.equal(actual.includes("/"), false);
  assert.equal(actual.includes(fakeSession.userId), false);
});

test("derivePrincipalId is stable for the same environment and user", async () => {
  const first = await derivePrincipalId({ userId: "user-1" }, { AI_PRINCIPAL_SECRET: principalSecret });
  const second = await derivePrincipalId({ userId: "user-1" }, { AI_PRINCIPAL_SECRET: principalSecret });
  const otherUser = await derivePrincipalId({ userId: "user-2" }, { AI_PRINCIPAL_SECRET: principalSecret });

  assert.equal(first, second);
  assert.notEqual(first, otherUser);
});

test("different principal secrets produce different principalIds", async () => {
  const first = await derivePrincipalId(
    { userId: "user-1" },
    { AI_PRINCIPAL_SECRET: "principal-secret-alpha-at-least-32-characters" },
  );
  const second = await derivePrincipalId(
    { userId: "user-1" },
    { AI_PRINCIPAL_SECRET: "principal-secret-beta-at-least-32-characters!!" },
  );

  assert.notEqual(first, second);
});

test("derivePrincipalId rejects weak, missing, or invalid session inputs", async () => {
  await assert.rejects(
    () => derivePrincipalId({ userId: "user-1" }, {}),
    (error) => error instanceof PrincipalError && error.code === "AI_PRINCIPAL_SECRET_NOT_CONFIGURED",
  );
  await assert.rejects(
    () => derivePrincipalId({ userId: "user-1" }, { AI_PRINCIPAL_SECRET: "short-secret" }),
    (error) => error instanceof PrincipalError && error.code === "AI_PRINCIPAL_SECRET_WEAK",
  );
  await assert.rejects(
    () => derivePrincipalId({ userId: "   " }, { AI_PRINCIPAL_SECRET: principalSecret }),
    (error) => error instanceof PrincipalError && error.code === "AI_PRINCIPAL_SESSION_INVALID",
  );
});

test("principal API rejects missing Xiaomi session with 401", async () => {
  const { worker, env, context } = await getWorker();
  const res = await worker.fetch(new Request("http://localhost/api/ai/principal"), env, context);

  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.error, "AI_UNAUTHENTICATED");
  assert.equal(res.headers.get("Cache-Control"), "no-store");
});

test("principal API rejects invalid Xiaomi session with 401", async () => {
  const { worker, env, context } = await getWorker();
  const req = new Request("http://localhost/api/ai/principal", {
    headers: { Cookie: "xiaomi_session=invalid-value" },
  });
  const res = await worker.fetch(req, env, context);

  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.error, "AI_UNAUTHENTICATED");
  assert.equal(res.headers.get("Cache-Control"), "no-store");
});

test("principal API derives principalId from the server-side session only", async () => {
  const { worker, env, context } = await getWorker();
  const cookie = await createCookieHeader(fakeSession);
  const req = new Request(
    "http://localhost/api/ai/principal?principalId=usr_forged",
    {
      headers: {
        Cookie: cookie,
        "X-Principal-Id": "usr_forged",
      },
    },
  );
  const res = await worker.fetch(req, env, context);

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.principalId, await derivePrincipalId(fakeSession, { AI_PRINCIPAL_SECRET: principalSecret }));
  assert.notEqual(data.principalId, "usr_forged");
  assert.equal(JSON.stringify(data).includes(fakeSession.userId), false);
  assert.equal(JSON.stringify(data).includes(principalSecret), false);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
});

test("principal API fails closed when the principal secret is not configured", async () => {
  const previousSecret = process.env.AI_PRINCIPAL_SECRET;
  delete process.env.AI_PRINCIPAL_SECRET;
  const { worker, env, context } = await getWorker();
  const cookie = await createCookieHeader(fakeSession);
  const req = new Request("http://localhost/api/ai/principal", { headers: { Cookie: cookie } });
  const res = await worker.fetch(req, env, context);
  process.env.AI_PRINCIPAL_SECRET = previousSecret;

  assert.equal(res.status, 500);
  const data = await res.json();
  assert.equal(data.error, "AI_PRINCIPAL_SECRET_NOT_CONFIGURED");
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.equal(JSON.stringify(data).includes(principalSecret), false);
});
