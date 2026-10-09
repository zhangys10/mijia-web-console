import assert from "node:assert/strict";
import test from "node:test";

import { interpretPropertyWriteResponse } from "../lib/xiaomi-control-result.ts";

test("property write code zero is a submitted request", () => {
  const outcome = interpretPropertyWriteResponse({ result: [{ code: 0 }] });
  assert.equal(outcome.status, "submitted");
});

test("property write code one is also a submitted request", () => {
  const outcome = interpretPropertyWriteResponse({ result: [{ code: 1 }] });
  assert.equal(outcome.status, "submitted");
});

test("other property write codes remain unknown after dispatch", () => {
  const outcome = interpretPropertyWriteResponse({ result: [{ code: -704220025 }] });
  assert.equal(outcome.status, "outcome_unknown");
});

test("malformed property write responses still fail closed", () => {
  assert.throws(() => interpretPropertyWriteResponse({ result: [] }), /XIAOMI_DEVICE_RESPONSE_INVALID/);
  assert.throws(() => interpretPropertyWriteResponse({ result: [{}] }), /XIAOMI_DEVICE_RESPONSE_INVALID/);
});
