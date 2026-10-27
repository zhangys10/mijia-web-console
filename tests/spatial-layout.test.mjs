import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildSpatialMeshPlan, parseSpatialLayout, parseSpatialLayoutSaveEnvelope, pixelsPerMeter, pointInPolygon, SpatialLayoutError } from "../lib/spatial-layout.ts";
import { deleteSpatialLayout, readSpatialLayout, saveSpatialLayout, shouldUseLocalSpatialLayoutStore, spatialHomePrefix } from "../lib/spatial-layout-store.ts";
import { localSpatialLayoutStore } from "../lib/local-spatial-layout-store.ts";
import { createSpatialScene, exportSpatialGlb, spatialPointToWorld } from "../lib/spatial-layout-three.ts";

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("placement appearance round-trips and rejects invalid segment geometry", async () => {
  const appearance = { type: "strip", length: 2, width: .1, segments: [{ length: 2, angle: 0 }, { length: 1, angle: 90 }] };
  const placement = { id: "strip", targetKind: "lighting", targetId: "fake-light", name: "Test strip", room: "", zoneId: null, point: { x: 10, y: 10 }, elevation: 2.3, rotationY: Math.PI / 2, appearance };
  const layout = await fixture("home-a", { placements: [placement] });
  assert.deepEqual(parseSpatialLayout(layout).placements[0].appearance, appearance);
  for (const invalid of [{ type: "unknown" }, { segments: [] }, { segments: [{ length: 0, angle: 0 }] }, { segments: [{ length: 2, angle: Infinity }] }]) {
    assert.throws(() => parseSpatialLayout({ ...layout, placements: [{ ...placement, appearance: { ...appearance, ...invalid } }] }), /SPATIAL_APPEARANCE_INVALID/);
  }
});

test("furniture survives layout validation and renders in calibrated coordinates", async () => {
  const item = { id: "bed", kind: "king-bed", point: { x: 400, y: 300 }, width: 2, depth: 2.1, height: .6, rotation: 90 };
  const layout = parseSpatialLayout(await fixture("home-a", { furniture: [item] }));
  assert.deepEqual(layout.furniture, [item]);
  const mesh = createSpatialScene(layout).getObjectByName("furniture:bed");
  assert.ok(mesh);
  assert.equal(mesh.rotation.y, -Math.PI / 2);
  assert.equal(mesh.children[0].geometry.parameters.width, 2);
  assert.equal(mesh.position.x, -2);
  assert.equal(mesh.position.z, -2);
  for (const invalid of [{ width: 0 }, { height: Infinity }, { kind: "remote-url" }, { rotation: 361 }, { point: { x: -1, y: 0 } }, { extra: "ignored" }]) {
    assert.throws(() => parseSpatialLayout({ ...layout, furniture: [{ ...item, ...invalid }] }), /SPATIAL_FURNITURE_INVALID/);
  }
  assert.throws(() => parseSpatialLayout({ ...layout, furniture: [item, item] }), /SPATIAL_FURNITURE_INVALID/);
});
const glb = (() => { const value = new Uint8Array(12); value.set([0x67, 0x6c, 0x54, 0x46]); new DataView(value.buffer).setUint32(4, 2, true); new DataView(value.buffer).setUint32(8, 12, true); return value; })();

test("local spatial storage follows either the app development mode or the local Node server", () => {
  assert.equal(shouldUseLocalSpatialLayoutStore({ AI_ENVIRONMENT: "development", NODE_ENV: "production" }), true);
  assert.equal(shouldUseLocalSpatialLayoutStore({ AI_ENVIRONMENT: "preview", NODE_ENV: "development" }), true);
  assert.equal(shouldUseLocalSpatialLayoutStore({ AI_ENVIRONMENT: "preview", NODE_ENV: "production" }), false);
  assert.equal(shouldUseLocalSpatialLayoutStore({ NODE_ENV: "production" }), false);
});

test("save request envelope passes only its nested layout to strict layout validation", async () => {
  const layout = await fixture();
  const envelope = parseSpatialLayoutSaveEnvelope({ homeId: "home-a", layout });
  assert.equal(envelope.homeId, "home-a");
  assert.equal(parseSpatialLayout(envelope.layout).revision, layout.revision);
  assert.throws(() => parseSpatialLayoutSaveEnvelope({ homeId: "home-a", ...layout }), /SPATIAL_REQUEST_INVALID/);
  assert.throws(() => parseSpatialLayoutSaveEnvelope({ homeId: "home-a", layout, surprise: true }), /SPATIAL_REQUEST_INVALID/);
});

async function fixture(homeId = "home-a", overrides = {}) {
  const prefix = await spatialHomePrefix(homeId);
  return { version: 1, revision: "layout_11111111-1111-4111-8111-111111111111", baseRevision: null,
    image: { key: `${prefix}uploads/11111111-1111-4111-8111-111111111111.png`, contentType: "image/png", byteLength: png.byteLength },
    model: { key: `${prefix}uploads/22222222-2222-4222-8222-222222222222.glb`, contentType: "model/gltf-binary", byteLength: glb.byteLength },
    imageWidth: 1000, imageHeight: 800, calibration: { start: { x: 0, y: 0 }, end: { x: 200, y: 0 }, meters: 4 }, defaults: { wallHeight: 2.7, wallThickness: .12 },
    zones: [{ id: "room_1", name: "客厅", kind: "room", roomName: "客厅", polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }], wallEdges: [true, false, true, false] }, { id: "area_1", name: "无墙区域", kind: "area", roomName: null, polygon: [{ x: 450, y: 0 }, { x: 700, y: 0 }, { x: 700, y: 250 }], wallEdges: [false, false, false] }],
    openings: [{ id: "door_1", zoneId: "room_1", edge: 0, kind: "door", offset: .5, width: 45, height: 2.1, sill: 0, confidence: .8 }],
    placements: [{ id: "place_1", targetKind: "device", targetId: "did-stable-1", name: "设备", room: "客厅", zoneId: "room_1", point: { x: 100, y: 100 }, elevation: .9, rotationY: 0 }], updatedAt: new Date(0).toISOString(), ...overrides };
}

test("scale conversion, polygon containment, wall-free areas and enabled wall mesh are deterministic", async () => {
  const layout = parseSpatialLayout(await fixture());
  assert.equal(pixelsPerMeter(layout.calibration), 50);
  assert.equal(pointInPolygon({ x: 20, y: 20 }, layout.zones[0].polygon), true);
  assert.equal(pointInPolygon({ x: 900, y: 700 }, layout.zones[0].polygon), false);
  const mesh = buildSpatialMeshPlan(layout);
  assert.equal(mesh.scale, .02);
  assert.equal(mesh.walls.length, 2);
  assert.equal(mesh.walls.some(wall => wall.zoneId === "area_1"), false);
  const placed = spatialPointToWorld(layout, { x: 100, y: 100 }, 2.35);
  assert.deepEqual(placed.toArray(), [-8, 2.35, -6]);
});

test("first-class wall centerlines keep measured thickness and windows cut sill/header geometry", async () => {
  const wall = { id: "wall_1", start: { x: 100, y: 500 }, end: { x: 500, y: 500 }, thicknessPixels: 15, confidence: .9 };
  const opening = { id: "window_1", zoneId: null, wallId: wall.id, edge: 0, kind: "window", offset: .5, width: 50, height: 1.2, sill: .9, confidence: .85 };
  const layout = parseSpatialLayout(await fixture(undefined, { walls: [wall], openings: [opening] }));
  const pieces = buildSpatialMeshPlan(layout).walls.filter(piece => piece.zoneId === wall.id);
  assert.equal(pieces.length, 4);
  assert.ok(pieces.every(piece => piece.thickness === layout.defaults.wallThickness));
  assert.ok(pieces.some(piece => piece.base === 0 && piece.height === .9));
  assert.ok(pieces.some(piece => piece.base === 2.1 && Math.abs(piece.height - .6) < 1e-9));
});

test("Three scene creates named floor/wall meshes and exports a binary GLB", async () => {
  const layout = parseSpatialLayout(await fixture()); const scene = createSpatialScene(layout);
  assert.ok(scene.getObjectByName("zone:room_1:floor")); assert.ok(scene.getObjectByName("zone:room_1:wall:0")); assert.ok(scene.getObjectByName("opening:door_1")); assert.equal(scene.getObjectByName("zone:area_1:wall:0"), undefined);
  if (!("FileReader" in globalThis)) globalThis.FileReader = class { result = null; onloadend = null; readAsArrayBuffer(blob) { blob.arrayBuffer().then(value => { this.result = value; this.onloadend?.(); }); } };
  const exported = new Uint8Array(await (await exportSpatialGlb(layout)).arrayBuffer());
  assert.equal(new TextDecoder().decode(exported.slice(0, 4)), "glTF"); assert.equal(new DataView(exported.buffer).getUint32(4, true), 2);
});

test("Three scene closes connected wall corners with a mitered junction mesh", async () => {
  const walls = [
    { id: "wall_a", start: { x: 100, y: 100 }, end: { x: 400, y: 100 }, thicknessPixels: 20, confidence: 1 },
    { id: "wall_b", start: { x: 400, y: 100 }, end: { x: 400, y: 400 }, thicknessPixels: 20, confidence: 1 },
  ];
  const layout = parseSpatialLayout(await fixture(undefined, { walls, openings: [] }));
  const scene = createSpatialScene(layout);
  const junction = scene.getObjectByName("wall-junction:wall_a:wall_b");
  assert.ok(junction); assert.ok(junction.geometry.attributes.position.count > 0);
});

test("strict schema rejects extra fields, bad placement bindings and cross-home assets", async () => {
  const valid = await fixture();
  assert.throws(() => parseSpatialLayout({ ...valid, surprise: true }), error => error instanceof SpatialLayoutError && error.code === "SPATIAL_LAYOUT_INVALID");
  const badZone = await fixture(undefined, { placements: [{ id: "place_1", targetKind: "device", targetId: "did", name: "x", room: "x", zoneId: "missing", point: { x: 1, y: 1 }, elevation: 1, rotationY: 0 }] });
  assert.throws(() => parseSpatialLayout(badZone), /SPATIAL_PLACEMENT_INVALID/);
  const otherPrefix = await spatialHomePrefix("other-home");
  assert.throws(() => parseSpatialLayout(valid, `${otherPrefix}uploads/`), /SPATIAL_ASSET_FORBIDDEN/);
  assert.throws(() => parseSpatialLayout({ ...valid, openings: [{ ...valid.openings[0], edge: 9 }] }), /SPATIAL_OPENING_INVALID/);
  assert.throws(() => parseSpatialLayout({ ...valid, openings: [{ ...valid.openings[0], zoneId: null, wallId: "missing", edge: 0 }] }), /SPATIAL_OPENING_INVALID/);
  assert.throws(() => parseSpatialLayout({ ...valid, walls: [{ id: "wall_1", start: { x: 1, y: 1 }, end: { x: 40, y: 1 }, thicknessPixels: 0, confidence: .9 }] }), /SPATIAL_WALL_INVALID/);
});

test("schema accepts stress fixture with 20 rooms, 100 placements, long names and unassigned targets", async () => {
  const zones = Array.from({ length: 20 }, (_, index) => ({ id: `room_${index}`, name: `房间 ${index} ${"长".repeat(60)}`, kind: index === 19 ? "area" : "room", roomName: index === 19 ? null : `房间 ${index}`, polygon: [{ x: index * 50, y: 0 }, { x: index * 50 + 40, y: 0 }, { x: index * 50 + 40, y: 40 }], wallEdges: index === 19 ? [false, false, false] : [true, true, true] }));
  const placements = Array.from({ length: 100 }, (_, index) => ({ id: `place_${index}`, targetKind: index % 2 ? "lighting" : "device", targetId: `stable:${index}`, name: `设备 ${index} ${"名".repeat(80)}`, room: `房间 ${index % 20}`, zoneId: index === 99 ? null : `room_${index % 20}`, point: { x: index * 3, y: 5 }, elevation: 1, rotationY: 0 }));
  const parsed = parseSpatialLayout(await fixture(undefined, { zones, placements }));
  assert.equal(parsed.zones.length, 20); assert.equal(parsed.placements.length, 100); assert.equal(parsed.placements.at(-1).zoneId, null);
});

test("local store validates assets, activates atomically, rejects stale revisions and deletes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mijia-spatial-")); const store = localSpatialLayoutStore(directory); const home = "shared-home"; const layout = await fixture(home);
  await store.set(layout.image.key, png.buffer); await store.set(layout.model.key, glb.buffer);
  const saved = await saveSpatialLayout(home, layout, store); assert.equal((await readSpatialLayout(home, store)).revision, saved.revision);
  const stale = { ...layout, revision: "layout_33333333-3333-4333-8333-333333333333", baseRevision: null };
  await assert.rejects(() => saveSpatialLayout(home, stale, store), error => error instanceof SpatialLayoutError && error.status === 409);
  await assert.rejects(() => deleteSpatialLayout(home, "layout_stale-stale-stale", store), error => error instanceof SpatialLayoutError && error.status === 409);
  await deleteSpatialLayout(home, saved.revision, store); assert.equal(await readSpatialLayout(home, store), null);
});

test("hashed home prefixes isolate layouts while members of the same home read one active revision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mijia-spatial-isolation-")); const store = localSpatialLayoutStore(directory); const shared = await fixture("shared-home");
  await store.set(shared.image.key, png.buffer); await store.set(shared.model.key, glb.buffer); await saveSpatialLayout("shared-home", shared, store);
  assert.equal((await readSpatialLayout("shared-home", store)).revision, shared.revision); assert.equal(await readSpatialLayout("different-home", store), null);
  const invalid = { ...shared, revision: "layout_55555555-5555-4555-8555-555555555555", baseRevision: shared.revision, image: { ...shared.image, byteLength: shared.image.byteLength + 1 } };
  await assert.rejects(() => saveSpatialLayout("shared-home", invalid, store), error => error instanceof SpatialLayoutError && error.code === "SPATIAL_IMAGE_INVALID");
});

test("failed pointer activation leaves the previous active revision readable", async () => {
  const memory = new Map(); const home = "rollback-home"; const first = await fixture(home); memory.set(first.image.key, png.buffer); memory.set(first.model.key, glb.buffer); let failPointer = false;
  const store = { async get(key) { return memory.get(key) ?? null; }, async setJSON(key, value) { if (failPointer && key.endsWith("current.json")) throw new Error("write failed"); memory.set(key, structuredClone(value)); }, async delete(key) { memory.delete(key); }, async list({ prefix } = {}) { return { blobs: [...memory.keys()].filter(key => !prefix || key.startsWith(prefix)).map(key => ({ key })) }; } };
  await saveSpatialLayout(home, first, store); failPointer = true; const second = { ...first, revision: "layout_44444444-4444-4444-8444-444444444444", baseRevision: first.revision };
  await assert.rejects(() => saveSpatialLayout(home, second, store), /SPATIAL_STORE_UNAVAILABLE/); assert.equal((await readSpatialLayout(home, store)).revision, first.revision);
});
