import assert from "node:assert/strict";
import test from "node:test";
import { analyzeFloorPlanPixels } from "../lib/floor-plan-analysis.ts";

function syntheticPlan() {
  const width = 240, height = 200, pixels = new Uint8ClampedArray(width * height * 4).fill(255);
  const paint = (x, y) => { const index = (y * width + x) * 4; pixels[index] = 15; pixels[index + 1] = 15; pixels[index + 2] = 15; pixels[index + 3] = 255; };
  const fill = (x1, y1, x2, y2) => { for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) paint(x, y); };
  fill(20, 20, 85, 31); fill(116, 20, 220, 31); fill(20, 168, 220, 179); fill(20, 20, 31, 179); fill(209, 20, 220, 179);
  for (const y of [20, 25, 27, 31]) for (let x = 86; x <= 115; x++) paint(x, y); // four-rail window, with a close middle pair
  for (const y of [95, 106]) for (let x = 20; x <= 220; x++) paint(x, y); // white-core outlined wall
  for (let x = 55; x <= 185; x++) paint(x, 130); // long furniture/annotation stroke
  fill(90, 80, 110, 90); // solid but too short to be a wall
  return { pixels, width, height };
}

test("CAD analysis traces solid and white-core walls, and requires the four-rail window signature", () => {
  const { pixels, width, height } = syntheticPlan(); const result = analyzeFloorPlanPixels(pixels, width, height, { minWallThicknessPixels: 8, minWallLengthRatio: .1, mergeDistancePixels: 4, detectOpenings: true });
  assert.equal(result.zones.length, 0); assert.ok(result.walls.length >= 3);
  assert.ok(result.walls.every(wall => wall.thicknessPixels >= 8));
  assert.ok(result.walls.some(wall => Math.abs(wall.start.y - 100.5) < 2 && Math.abs(wall.end.y - 100.5) < 2));
  assert.equal(result.walls.some(wall => Math.abs(wall.start.y - 130) < 2 && Math.abs(wall.end.y - 130) < 2), false);
  assert.ok(result.openings.length > 0);
  assert.ok(result.openings.some(opening => opening.kind === "window"));
  assert.ok(result.openings.every(opening => opening.zoneId === null && result.walls.some(wall => wall.id === opening.wallId)));
  const top = result.walls.find(wall => Math.abs(wall.start.y - 25.5) < 2 && Math.abs(wall.end.y - 25.5) < 2);
  const left = result.walls.find(wall => Math.abs(wall.start.x - 25.5) < 2 && Math.abs(wall.end.x - 25.5) < 2);
  assert.ok(top && left); assert.ok(Math.abs(top.start.x - left.start.x) < 1); assert.ok(Math.abs(top.start.y - left.start.y) < 1);
  assert.ok(result.confidence > .35); assert.match(result.notes.join(" "), /手动修正/);
  const wallsOnly = analyzeFloorPlanPixels(pixels, width, height, { minWallThicknessPixels: 8, minWallLengthRatio: .1, mergeDistancePixels: 4, detectOpenings: false });
  assert.equal(wallsOnly.openings.length, 0);
  assert.ok(wallsOnly.walls.some(wall => Math.abs(wall.start.y - 25.5) < 2 && wall.start.x <= 26 && wall.end.x >= 214));
});

test("floor plan analysis rejects malformed pixel buffers", () => {
  assert.throws(() => analyzeFloorPlanPixels(new Uint8ClampedArray(4), 100, 100), /SPATIAL_ANALYSIS_IMAGE_INVALID/);
});

test("tuned CAD tracing can suppress thin annotation lines and openings", () => {
  const { pixels, width, height } = syntheticPlan();
  const result = analyzeFloorPlanPixels(pixels, width, height, { minWallThicknessPixels: 8, minWallLengthRatio: .3, mergeDistancePixels: 6, detectOpenings: false });
  assert.ok(result.walls.length >= 1);
  assert.equal(result.openings.length, 0);
  assert.ok(result.walls.every(wall => wall.thicknessPixels >= 8));
});
