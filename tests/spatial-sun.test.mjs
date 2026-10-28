import assert from "node:assert/strict";
import test from "node:test";
import { spatialEnvironmentAt, spatialLocalCoordinates, spatialSunEvent } from "../lib/spatial-sun.ts";

test("automatic environment follows local sunrise and sunset", () => {
  const shanghai = { latitude: 31.23, longitude: 121.47 };
  const date = new Date(2026, 2, 20, 12);
  const sunrise = spatialSunEvent(date, shanghai, true), sunset = spatialSunEvent(date, shanghai, false);
  assert.ok(sunrise); assert.ok(sunset);
  const hourInShanghai = (instant) => Number(new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(instant));
  assert.ok(hourInShanghai(sunrise) >= 5 && hourInShanghai(sunrise) <= 7);
  assert.ok(hourInShanghai(sunset) >= 17 && hourInShanghai(sunset) <= 19);
  assert.equal(spatialEnvironmentAt(new Date(2026, 2, 20, 12), shanghai), "day");
  assert.equal(spatialEnvironmentAt(new Date(2026, 2, 20, 2), shanghai), "night");
});

test("local solar coordinates use the browser timezone without requesting location", () => {
  assert.deepEqual(spatialLocalCoordinates(new Date(), "Asia/Shanghai"), { latitude: 31.23, longitude: 121.47 });
  assert.deepEqual(spatialLocalCoordinates(new Date("2026-01-01T00:00:00Z"), "Unknown/Zone").latitude, 35);
});
