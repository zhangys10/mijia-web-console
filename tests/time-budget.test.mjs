import assert from "node:assert/strict";
import test from "node:test";

import { withTimeoutFallback } from "../lib/time-budget.ts";

test("returns completed work before the time budget", async () => {
  assert.equal(await withTimeoutFallback(Promise.resolve("complete"), 20, () => "fallback"), "complete");
});

test("returns a safe fallback when enrichment exceeds the time budget", async () => {
  const never = new Promise(() => {});
  assert.equal(await withTimeoutFallback(never, 5, () => "partial"), "partial");
});
