import test from "node:test";
import assert from "node:assert/strict";
import { abortTimeout, withTimeout } from "../lib/abort-signals.ts";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Simulates an edge runtime without AbortSignal.timeout/any (e.g. EdgeOne edge functions). */
async function withoutNativeAbort(run) {
  const nativeTimeout = AbortSignal.timeout;
  const nativeAny = AbortSignal.any;
  AbortSignal.timeout = undefined;
  AbortSignal.any = undefined;
  try {
    return await run();
  } finally {
    AbortSignal.timeout = nativeTimeout;
    AbortSignal.any = nativeAny;
  }
}

test("native AbortSignal.timeout backs the deadline when available", async () => {
  const deadline = abortTimeout(20);
  assert.ok(deadline.signal instanceof AbortSignal);
  assert.equal(deadline.signal.aborted, false);
  await sleep(150);
  assert.equal(deadline.signal.aborted, true);
  deadline.dispose();
});

test("native AbortSignal.any composes the external signal when available", () => {
  const external = new AbortController();
  const deadline = abortTimeout(5000, external.signal);
  assert.equal(deadline.signal.aborted, false);
  external.abort();
  assert.equal(deadline.signal.aborted, true);
  deadline.dispose();
});

test("controller fallback aborts after the deadline without native APIs", async () => {
  await withoutNativeAbort(async () => {
    const deadline = abortTimeout(20);
    assert.ok(deadline.signal instanceof AbortSignal);
    assert.equal(deadline.signal.aborted, false);
    await sleep(150);
    assert.equal(deadline.signal.aborted, true);
    deadline.dispose();
  });
});

test("controller fallback dispose cancels the timer", async () => {
  await withoutNativeAbort(async () => {
    const deadline = abortTimeout(25);
    deadline.dispose();
    await sleep(150);
    assert.equal(deadline.signal.aborted, false);
  });
});

test("controller fallback follows an external abort", async () => {
  await withoutNativeAbort(async () => {
    const external = new AbortController();
    const deadline = abortTimeout(5000, external.signal);
    external.abort();
    assert.equal(deadline.signal.aborted, true);
    deadline.dispose();
  });
});

test("controller fallback reflects an already-aborted external signal", async () => {
  await withoutNativeAbort(async () => {
    const external = new AbortController();
    external.abort();
    const deadline = abortTimeout(5000, external.signal);
    assert.equal(deadline.signal.aborted, true);
    deadline.dispose();
  });
});

test("controller fallback dispose detaches the external listener", async () => {
  await withoutNativeAbort(async () => {
    const external = new AbortController();
    const deadline = abortTimeout(5000, external.signal);
    deadline.dispose();
    external.abort();
    assert.equal(deadline.signal.aborted, false);
  });
});

test("deadline degrades to no signal when abort APIs are unavailable", () => {
  const signalClass = globalThis.AbortSignal;
  const controllerClass = globalThis.AbortController;
  globalThis.AbortSignal = undefined;
  globalThis.AbortController = undefined;
  try {
    const deadline = abortTimeout(20);
    assert.equal(deadline.signal, undefined);
    deadline.dispose();
  } finally {
    globalThis.AbortSignal = signalClass;
    globalThis.AbortController = controllerClass;
  }
});

test("withTimeout returns the task result", async () => {
  assert.equal(await withTimeout(1000, () => Promise.resolve("ok")), "ok");
});

test("withTimeout propagates task failures unchanged", async () => {
  await assert.rejects(withTimeout(1000, () => Promise.reject(new Error("TASK_FAILED"))), /TASK_FAILED/);
});

test("withTimeout aborts the task after the deadline without native APIs", async () => {
  await withoutNativeAbort(async () => {
    await assert.rejects(withTimeout(20, (signal) => new Promise((_, reject) => {
      assert.ok(signal instanceof AbortSignal);
      signal.addEventListener("abort", () => reject(new Error("DEADLINE_ABORTED")), { once: true });
    })), /DEADLINE_ABORTED/);
  });
});

test("withTimeout passes an external signal through to the task", async () => {
  const external = new AbortController();
  const task = withTimeout(5000, (signal) => new Promise((_, reject) => {
    assert.ok(signal instanceof AbortSignal);
    signal.addEventListener("abort", () => reject(new Error("EXTERNAL_ABORTED")), { once: true });
  }), external.signal);
  external.abort();
  await assert.rejects(task, /EXTERNAL_ABORTED/);
});
