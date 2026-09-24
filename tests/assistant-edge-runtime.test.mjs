import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("assistant Edge entrypoints load and reject unauthenticated requests without Node process", () => {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    // Initialize Node's Web API shims before simulating the Edge global scope.
    new Request("https://console.test");
    new Response();
    delete globalThis.process;
    globalThis.fetch = () => { throw new Error("Unexpected network access before authorization"); };

    for (const endpoint of ["capabilities", "tools:invoke"]) {
      const { onRequest } = await import("./edge-functions/api/internal/assistant/v1/" + endpoint + ".ts");
      for (const method of ["GET", "POST"]) {
        const response = await onRequest({
          request: new Request("https://console.test/api/internal/assistant/v1/" + endpoint, { method }),
          env: { AI_TOOLS_INTERNAL_SECRET: "fake-tools-secret-at-least-32-characters" },
        });
        assert.equal(response.status, method === "POST" ? 401 : 405);
        assert.equal(response.headers.get("Cache-Control"), "no-store");
        assert.deepEqual(await response.json(), {
          code: method === "POST" ? "AI_UNAUTHENTICATED" : "AI_INVALID_REQUEST",
        });
      }
    }
  `], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {},
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
});
