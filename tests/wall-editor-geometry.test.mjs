import assert from "node:assert/strict";
import test from "node:test";
import { alignWallGraphNode, buildWallGraphNodes, buildWallRenderPaths, findEnclosedWallFace, materializeWallJunctions, miterPolylineOutline, moveWallGraphNode, projectPointToWall, snapWallPoint, weldWallEndpoints } from "../lib/wall-editor-geometry.ts";

const wall = (id, start, end, thicknessPixels = 20) => ({ id, start, end, thicknessPixels, confidence: 1 });

test("a two-wall corner becomes one miterable visual path", () => {
  const paths = buildWallRenderPaths([
    wall("horizontal", { x: 10, y: 10 }, { x: 100, y: 10 }),
    wall("vertical", { x: 100, y: 10 }, { x: 100, y: 90 }),
  ]);
  assert.equal(paths.length, 1);
  assert.deepEqual(paths[0].points, [{ x: 10, y: 10 }, { x: 100, y: 10 }, { x: 100, y: 90 }]);
  assert.deepEqual(paths[0].wallIds, ["horizontal", "vertical"]);
  const outline = miterPolylineOutline(paths[0].points, 10);
  assert.ok(outline.some(point => point.x === 110 && point.y === 0));
  assert.ok(outline.some(point => point.x === 90 && point.y === 20));
});

test("branch junctions remain separate selectable wall paths", () => {
  const paths = buildWallRenderPaths([
    wall("left", { x: 10, y: 50 }, { x: 100, y: 50 }),
    wall("right", { x: 100, y: 50 }, { x: 190, y: 50 }),
    wall("down", { x: 100, y: 50 }, { x: 100, y: 130 }),
  ]);
  assert.equal(paths.length, 3);
  assert.deepEqual(new Set(paths.flatMap(path => path.wallIds)), new Set(["left", "right", "down"]));
});

test("wall edits project split points and snap endpoints", () => {
  const selected = wall("selected", { x: 0, y: 0 }, { x: 100, y: 0 });
  assert.deepEqual(projectPointToWall({ x: 72, y: 19 }, selected), { x: 72, y: 0 });
  assert.deepEqual(snapWallPoint({ x: 102, y: 13 }, { x: 0, y: 13 }, [selected, wall("other", { x: 100, y: 10 }, { x: 100, y: 80 })], "selected", 8), { x: 100, y: 10 });
});

test("nearby corner endpoints become one shared movable graph node", () => {
  const walls = [
    wall("horizontal", { x: 10, y: 10 }, { x: 99.4, y: 10 }),
    wall("vertical", { x: 100.2, y: 10.3 }, { x: 100.2, y: 90 }),
  ];
  const welded = weldWallEndpoints(walls, 1.5);
  assert.deepEqual(welded[0].end, welded[1].start);
  const shared = buildWallGraphNodes(welded).find(node => node.wallIds.length === 2);
  assert.ok(shared);
  const moved = moveWallGraphNode(welded, shared.point, { x: 120, y: 20 });
  assert.deepEqual(moved[0].end, { x: 120, y: 20 });
  assert.deepEqual(moved[1].start, { x: 120, y: 20 });
});

test("node clustering uses real distance across quantization boundaries", () => {
  const nodes = buildWallGraphNodes([
    wall("horizontal", { x: 0, y: 0 }, { x: 10.7, y: 10 }),
    wall("vertical", { x: 11.8, y: 10 }, { x: 11.8, y: 30 }),
  ], 1.5);
  assert.equal(nodes.filter(node => node.wallIds.length === 2).length, 1);
});

test("a T junction is materialized as three edges sharing one point", () => {
  const connected = materializeWallJunctions([
    wall("host", { x: 0, y: 50 }, { x: 100, y: 50 }),
    wall("stem", { x: 49.4, y: 10 }, { x: 50.8, y: 51 }),
  ], 2);
  assert.equal(connected.length, 3);
  const shared = buildWallGraphNodes(connected).find(node => node.wallIds.length === 3);
  assert.ok(shared);
  assert.deepEqual(new Set(shared.wallIds), new Set(connected.map(item => item.id)));
});

test("node dragging aligns incident edges unless alignment is bypassed", () => {
  const walls = [
    wall("left", { x: 0, y: 20 }, { x: 50, y: 20 }),
    wall("down", { x: 50, y: 20 }, { x: 50, y: 80 }),
  ];
  assert.deepEqual(alignWallGraphNode({ x: 47, y: 24 }, { x: 50, y: 20 }, walls, ["left", "down"], 6), { x: 50, y: 20 });
  assert.deepEqual(alignWallGraphNode({ x: 58, y: 28 }, { x: 50, y: 20 }, walls, ["left", "down"], 6), { x: 58, y: 28 });
});

test("wall endpoints form reusable nodes and a bounded room face", () => {
  const walls = [
    wall("top", { x: 10, y: 10 }, { x: 110, y: 10 }),
    wall("right", { x: 110, y: 10 }, { x: 110, y: 90 }),
    wall("bottom", { x: 110, y: 90 }, { x: 10, y: 90 }),
    wall("left", { x: 10, y: 90 }, { x: 10, y: 10 }),
  ];
  assert.equal(buildWallGraphNodes(walls).length, 4);
  assert.deepEqual(findEnclosedWallFace(walls, { x: 50, y: 50 }), [{ x: 10, y: 10 }, { x: 110, y: 10 }, { x: 110, y: 90 }, { x: 10, y: 90 }]);
  assert.equal(findEnclosedWallFace(walls, { x: 150, y: 50 }), null);
});

test("room faces split a continuous wall at T-junction endpoints", () => {
  const walls = [
    wall("top", { x: 10, y: 10 }, { x: 110, y: 10 }), wall("right", { x: 110, y: 10 }, { x: 110, y: 90 }),
    wall("bottom", { x: 110, y: 90 }, { x: 10, y: 90 }), wall("left", { x: 10, y: 90 }, { x: 10, y: 10 }),
    wall("divider", { x: 10, y: 50 }, { x: 110, y: 50 }),
  ];
  assert.equal(buildWallGraphNodes(walls).length, 6);
  assert.deepEqual(findEnclosedWallFace(walls, { x: 50, y: 30 }), [{ x: 10, y: 10 }, { x: 110, y: 10 }, { x: 110, y: 50 }, { x: 10, y: 50 }]);
  assert.deepEqual(findEnclosedWallFace(walls, { x: 50, y: 70 }), [{ x: 110, y: 50 }, { x: 110, y: 90 }, { x: 10, y: 90 }, { x: 10, y: 50 }]);
});
