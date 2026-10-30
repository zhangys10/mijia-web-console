import assert from "node:assert/strict";
import test from "node:test";
import { createSpatialFrameScheduler, resolveSpatialRenderQuality, spatialPixelRatio } from "../lib/spatial-render-performance.ts";

test("render quality defaults to power saving for touch-first devices and honors a saved override", () => {
  assert.equal(resolveSpatialRenderQuality(null, true), "power");
  assert.equal(resolveSpatialRenderQuality(null, false), "standard");
  assert.equal(resolveSpatialRenderQuality("standard", true), "standard");
  assert.equal(resolveSpatialRenderQuality("smooth", true), "smooth");
  assert.equal(resolveSpatialRenderQuality("invalid", true), "power");
  assert.equal(spatialPixelRatio("power", 2, true), 1);
  assert.equal(spatialPixelRatio("power", 2, false), 1.5);
  assert.equal(spatialPixelRatio("standard", 3, true), 2);
  assert.equal(spatialPixelRatio("smooth", 3, true), 1);
  assert.equal(spatialPixelRatio("smooth", 3, false), 1.5);
  assert.equal(spatialPixelRatio("power", 2, true, true), .75);
  assert.equal(spatialPixelRatio("smooth", 2, true, true), .85);
  assert.equal(spatialPixelRatio("standard", 2, true, true), 1.25);
  assert.equal(spatialPixelRatio("standard", 2, false, true), 2);
});

test("frame scheduler becomes idle, throttles frames, and pauses while inactive", () => {
  const callbacks = new Map(); let nextFrame = 1, frames = 0, keepRunning = true;
  const scheduler = createSpatialFrameScheduler({
    requestFrame(callback) { const id = nextFrame++; callbacks.set(id, callback); return id; },
    cancelFrame(id) { callbacks.delete(id); },
    minFrameMs: 30,
    onFrame() { frames++; const keep = keepRunning; keepRunning = false; return keep; },
  });
  const flush = time => { const entries = [...callbacks.entries()]; callbacks.clear(); for (const [, callback] of entries) callback(time); };
  scheduler.invalidate(); flush(0);
  assert.equal(frames, 1); assert.equal(scheduler.isIdle(), false);
  flush(10); assert.equal(frames, 1);
  flush(31); assert.equal(frames, 2); assert.equal(scheduler.isIdle(), true);
  scheduler.setActive(false); scheduler.invalidate(); assert.equal(callbacks.size, 0);
  scheduler.setActive(true); flush(70); assert.equal(frames, 3);
  scheduler.dispose(); assert.equal(callbacks.size, 0);
});
