import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createDeviceEffect, createLightFixture, createTransitioningDeviceEffect, interpolateVisualState, resolveLightFixture } from "../lib/spatial-device-effects.ts";

test("floor status and activity rings are not rendered", () => {
  for (const state of [{ on: null }, { on: true, online: false }]) {
    assert.equal(createDeviceEffect({ kind: "other", ...state }).children.length, 0);
  }
  assert.equal(createDeviceEffect({ kind: "other", on: true }).children.length, 0);
});

test("curtain geometry follows position, including zero, independently of power", () => {
  const closed = createDeviceEffect({ kind: "curtain", on: null, position: 0 });
  const opened = createDeviceEffect({ kind: "curtain", on: null, position: 1 });
  assert.ok(closed.children[0].scale.x > opened.children[0].scale.x);
  assert.equal(createDeviceEffect({ kind: "curtain", on: null }).children.length, 0);
  assert.equal(createDeviceEffect({ kind: "curtain", on: true, online: false, position: .5 }).children.length, 0);
});

test("curtains interpolate position and lights glow or dim gradually", () => {
  const curtain = createTransitioningDeviceEffect({ kind: "curtain", on: null, position: 0 }, { kind: "curtain", on: null, position: 1 });
  curtain.apply(0); const closedWidth = curtain.group.children[0].scale.x;
  curtain.apply(.5); const halfWidth = curtain.group.children[0].scale.x;
  curtain.apply(1); const openedWidth = curtain.group.children[0].scale.x;
  assert.ok(closedWidth > halfWidth && halfWidth > openedWidth);
  const light = createTransitioningDeviceEffect({ kind: "light", on: false }, { kind: "light", on: true, brightness: .8 });
  const point = light.group.children.find(child => child instanceof THREE.PointLight);
  light.apply(0); const dark = point.intensity;
  light.apply(.5); const glowing = point.intensity;
  light.apply(1); const bright = point.intensity;
  assert.ok(dark < glowing && glowing < bright);
  assert.equal(interpolateVisualState({ kind: "curtain", on: null, position: .2 }, { kind: "curtain", on: null, position: .8 }, .5).position, .5);
  assert.equal(interpolateVisualState({ kind: "light", on: false }, { kind: "light", on: true }, .4).brightness, .4);
});

test("off and unknown lights retain fixture bodies without illumination", () => {
  for (const state of [{ on: false }, { on: null }]) {
    const fixture = createDeviceEffect({ kind: "light", ...state });
    assert.ok(fixture.children.length > 0);
    assert.equal(fixture.children.some(child => child instanceof THREE.Light), false);
  }
  assert.equal(createDeviceEffect({ kind: "light", on: true, online: false }).children.length, 0);
});
test("light brightness changes illumination and climate setpoint changes airflow footprint", () => {
  const dim = createDeviceEffect({ kind: "light", on: true, brightness: .2 });
  const bright = createDeviceEffect({ kind: "light", on: true, brightness: .8 });
  assert.ok(dim.children.find(child => child instanceof THREE.PointLight).intensity < bright.children.find(child => child instanceof THREE.PointLight).intensity);
  const cool = createDeviceEffect({ kind: "climate", on: true, temperature: 18 });
  const mild = createDeviceEffect({ kind: "climate", on: true, temperature: 26 });
  assert.ok(cool.children[1].scale.x > mild.children[1].scale.x);
});

test("five fixture models resolve compatibly and never add floor geometry", () => {
  assert.equal(resolveLightFixture(undefined), "ceiling");
  assert.equal(resolveLightFixture({ type: "strip", length: 1, width: 1, segments: [{ length: 1, angle: 0 }] }), "strip");
  for (const fixture of ["ceiling", "pendant", "spotlight", "strip", "panel"]) {
    const group = createLightFixture({ type: fixture === "strip" ? "strip" : fixture === "panel" ? "area" : "point", fixture, length: 1.2, width: .8, segments: [{ length: 1.2, angle: 0 }] }, 2.3, 1);
    assert.equal(group.userData.fixture, fixture);
    assert.equal(group.children.some(child => child.geometry instanceof THREE.CircleGeometry && child.rotation.x === -Math.PI / 2 && child.position.y < .1), false);
  }
});

test("strip illumination follows each configured segment as a continuous area light", () => {
  const group = createLightFixture({ type: "strip", fixture: "strip", length: 1, width: 1, segments: [{ length: 3, angle: 0 }, { length: 3, angle: 90 }] }, 2.3, .8);
  const lights = group.children.filter(child => child instanceof THREE.RectAreaLight);
  assert.equal(lights.length, 2);
  assert.ok(lights.every(light => light.name === "strip-illumination" && light.width === 3 && light.height === .08));
  assert.ok(lights.some(light => light.position.x === 1.5 && light.position.z === 0));
  assert.ok(lights.some(light => light.position.x === 3 && light.position.z === 1.5));
  const downward = new THREE.Vector3(0, 0, -1).applyQuaternion(lights[0].quaternion);
  assert.ok(downward.y < -.999);
});

test("spotlight has a visible articulated head with its lens attached", () => {
  const group = createLightFixture({ type: "point", fixture: "spotlight", length: 1.2, width: 1, segments: [{ length: 1, angle: 0 }] }, 2.3, 1);
  const head = group.getObjectByName("spotlight-head");
  assert.ok(head);
  assert.equal(head.children.length, 2);
  assert.ok(head.rotation.z < 0);
  const bounds = new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3());
  assert.ok(bounds.x >= .18 && bounds.x <= .4);
  assert.ok(bounds.y >= .25 && bounds.y <= .55);
});
