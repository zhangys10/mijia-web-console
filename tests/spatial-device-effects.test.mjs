import test from "node:test";
import assert from "node:assert/strict";
import { createDeviceEffect, createDeviceIndicator, createTransitioningDeviceEffect, interpolateVisualState } from "../lib/spatial-device-effects.ts";

test("all device types have distinct known, unknown and active indicators", () => {
  const active = createDeviceIndicator({ kind: "other", on: true });
  const off = createDeviceIndicator({ kind: "other", on: false });
  assert.notEqual(active.children[0].material.color.getHex(), off.children[0].material.color.getHex());
  for (const state of [{ on: null }, { on: true, online: false }]) {
    assert.equal(createDeviceIndicator({ kind: "other", ...state }).children.length, 2);
    assert.equal(createDeviceEffect({ kind: "other", ...state }).children.length, 0);
  }
  assert.equal(createDeviceEffect({ kind: "other", on: true }).children.length, 1);
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
  light.apply(0); const dark = light.group.children[1].intensity;
  light.apply(.5); const glowing = light.group.children[1].intensity;
  light.apply(1); const bright = light.group.children[1].intensity;
  assert.ok(dark < glowing && glowing < bright);
  assert.equal(interpolateVisualState({ kind: "curtain", on: null, position: .2 }, { kind: "curtain", on: null, position: .8 }, .5).position, .5);
  assert.equal(interpolateVisualState({ kind: "light", on: false }, { kind: "light", on: true }, .4).brightness, .4);
});

test("offline, off and unknown lights never illuminate", () => {
  for (const state of [{ on: false }, { on: null }, { on: true, online: false }]) {
    assert.equal(createDeviceEffect({ kind: "light", ...state }).children.length, 0);
  }
});
test("light brightness changes illumination and climate setpoint changes airflow footprint", () => {
  const dim = createDeviceEffect({ kind: "light", on: true, brightness: .2 });
  const bright = createDeviceEffect({ kind: "light", on: true, brightness: .8 });
  assert.ok(dim.children[1].intensity < bright.children[1].intensity);
  const cool = createDeviceEffect({ kind: "climate", on: true, temperature: 18 });
  const mild = createDeviceEffect({ kind: "climate", on: true, temperature: 26 });
  assert.ok(cool.children[1].scale.x > mild.children[1].scale.x);
});
