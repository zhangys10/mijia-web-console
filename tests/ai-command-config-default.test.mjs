import test from "node:test";
import assert from "node:assert/strict";
import { loadAiCommandConfig } from "../lib/ai/config.ts";

test("loadAiCommandConfig defaults AI_COMMAND_ENABLED to false (legacy command path stays off)", () => {
  const config = loadAiCommandConfig({});
  assert.equal(config.enabled, false);
});

test("loadAiCommandConfig still enables the legacy command path when explicitly requested", () => {
  const config = loadAiCommandConfig({ AI_COMMAND_ENABLED: "true" });
  assert.equal(config.enabled, true);
});
