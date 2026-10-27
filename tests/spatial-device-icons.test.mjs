import test from "node:test";
import assert from "node:assert/strict";
import { spatialIconKind, spatialIconSvg } from "../lib/spatial-device-icons.ts";

test("spatial icons map device categories without using device names", () => {
  assert.equal(spatialIconKind("camera"), "camera");
  assert.equal(spatialIconKind("fan"), "fan");
  assert.equal(spatialIconKind("vacuum"), "vacuum");
  assert.equal(spatialIconKind("unknown"), "generic");
  assert.equal(spatialIconKind("unknown", true), "light");
  assert.match(spatialIconSvg("curtain"), /^<svg/);
  assert.doesNotMatch(spatialIconSvg("curtain"), /script|onload/i);
});
