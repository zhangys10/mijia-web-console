import test from "node:test";
import assert from "node:assert/strict";
import { shouldExpandSpatialMarker } from "../lib/spatial-marker.ts";

test("marker detail uses separate zoom thresholds and forced selection", () => {
  assert.equal(shouldExpandSpatialMarker(2.2, false), false);
  assert.equal(shouldExpandSpatialMarker(2.2, true), true);
  assert.equal(shouldExpandSpatialMarker(2.5, false), true);
  assert.equal(shouldExpandSpatialMarker(1.9, true), false);
  assert.equal(shouldExpandSpatialMarker(.5, false, true), true);
});
