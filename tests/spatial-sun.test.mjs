import assert from "node:assert/strict";
import test from "node:test";
import { spatialEnvironmentAt, spatialLocalCoordinates, spatialSunEvent } from "../lib/spatial-sun.ts";

test("automatic environment follows local sunrise and sunset", () => {
  const shanghai = { latitude: 31.23, longitude: 121.47 };
  const date = new Date(2026, 2, 20, 12);
  const sunrise = spatialSunEvent(date, shanghai, true), sunset = spatialSunEvent(date, shanghai, false);
  assert.ok(sunrise); assert.ok(sunset);
  assert.ok(sunrise.getHours() >= 5 && sunrise.getHours() <= 7);
  assert.ok(sunset.getHours() >= 17 && sunset.getHours() <= 19);
  assert.equal(spatialEnvironmentAt(new Date(2026, 2, 20, 12), shanghai), "day");
  assert.equal(spatialEnvironmentAt(new Date(2026, 2, 20, 2), shanghai), "night");
});

test("local solar coordinates use the browser timezone without requesting location", () => {
  assert.deepEqual(spatialLocalCoordinates(new Date(), "Asia/Shanghai"), { latitude: 31.23, longitude: 121.47 });
  assert.deepEqual(spatialLocalCoordinates(new Date("2026-01-01T00:00:00Z"), "Unknown/Zone").latitude, 35);
});
