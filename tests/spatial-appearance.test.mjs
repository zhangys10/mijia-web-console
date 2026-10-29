import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { stripPoints, visualParameters, visualProperties } from "../lib/spatial-appearance.ts";
import { createDeviceEffect } from "../lib/spatial-device-effects.ts";
import { createFurniture } from "../lib/spatial-furniture.ts";

test("strip segments share endpoints and preserve independent directions and lengths", () => {
  const points = stripPoints([{ length: 2, angle: 0 }, { length: 3, angle: 90 }, { length: 2, angle: 180 }]);
  assert.deepEqual(points[1], { x: 2, y: 0 });
  assert.ok(Math.abs(points[2].x - 2) < 1e-10);
  assert.ok(Math.abs(points[3].x) < 1e-10);
  assert.equal(points[3].y, 3.0000000000000004);
  const effect = createDeviceEffect({ kind: "light", on: true }, { type: "strip", fixture: "strip", length: 1, width: 1, segments: [{ length: 2, angle: 0 }, { length: 3, angle: 90 }] }, 2.4);
  const meshes = effect.children.filter(child => child instanceof THREE.Mesh);
  assert.equal(meshes[0].position.y, 2.4);
  assert.equal(meshes[1].geometry.parameters.width, 3);
  const lights = effect.children.filter(child => child instanceof THREE.RectAreaLight);
  assert.equal(lights.length, 2);
  assert.deepEqual(lights.map(light => light.width), [2, 3]);
  assert.ok(lights.some(light => light.position.x === 2 && light.position.z > 1));
});

test("area and curtain visuals respect configured dimensions", () => {
  const appearance = { type: "area", fixture: "panel", length: 4, width: 2, segments: [{ length: 1, angle: 0 }] };
  const area = createDeviceEffect({ kind: "light", on: true }, appearance);
  assert.equal(area.children[1].geometry.parameters.width, 4);
  assert.equal(area.children[1].geometry.parameters.depth, 2);
  const curtain = createDeviceEffect({ kind: "curtain", on: null, position: 0 }, appearance);
  assert.equal(curtain.children[0].scale.x, 2);
  assert.ok(createDeviceEffect({ kind: "light", on: null }, appearance).children.length > 0);
  assert.equal(createDeviceEffect({ kind: "light", on: true, online: false }, appearance).children.length, 0);
});

test("visual reads prefer measured curtain position; failed and missing values remain unknown", () => {
  const properties = visualProperties([
    { name: "target-position", siid: 2, piid: 1, readable: true, range: { min: 0, max: 100 } },
    { name: "current-position", siid: 2, piid: 2, readable: true, range: { min: 0, max: 100 } },
    { name: "brightness", siid: 3, piid: 1, readable: false },
  ]);
  assert.deepEqual(visualParameters(properties, { "2.1": 100, "2.2": 0 }), { currentPosition: 0, targetPosition: 1, position: 0, positionIsTarget: false });
  assert.deepEqual(visualParameters(properties, { "2.1": 50 }), { targetPosition: .5, position: .5, positionIsTarget: true });
  assert.deepEqual(visualParameters(properties, { "2.1": 101 }), {});
  assert.deepEqual(visualParameters(properties, {}), {});
});

test("visual reads preserve the reported light color temperature", () => {
  const properties = visualProperties([
    { name: "color-temperature", siid: 2, piid: 3, readable: true, range: { min: 2700, max: 6500 } },
  ]);
  assert.deepEqual(visualParameters(properties, { "2.3": 3200 }), { colorTemperature: 3200 });
  assert.deepEqual(visualParameters(properties, { "2.3": 7000 }), {});
});

test("wardrobe prefab has cabinet, two doors and handles", () => {
  const wardrobe = createFurniture({ id: "wardrobe", kind: "wardrobe", width: 2, depth: .6, height: 2.4, rotation: 90, point: { x: 0, y: 0 } });
  assert.equal(wardrobe.children.length, 5);
  assert.equal(wardrobe.rotation.y, -Math.PI / 2);
});
