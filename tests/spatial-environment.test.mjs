import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { applySpatialEnvironment, spatialEnvironmentSettings } from "../lib/spatial-environment.ts";

test("day and night modes update only named environment lights", () => {
  const scene = new THREE.Scene(), hemisphere = new THREE.HemisphereLight(), directional = new THREE.DirectionalLight(), deviceLight = new THREE.PointLight(0xffaa00, 3);
  hemisphere.name = "spatial-environment-hemisphere"; directional.name = "spatial-environment-directional"; scene.add(hemisphere, directional, deviceLight);
  applySpatialEnvironment(scene, "night");
  assert.equal(scene.background.getHex(), spatialEnvironmentSettings.night.background);
  assert.equal(hemisphere.intensity, spatialEnvironmentSettings.night.hemisphereIntensity);
  assert.equal(directional.intensity, spatialEnvironmentSettings.night.directionalIntensity);
  assert.equal(deviceLight.intensity, 3);
  applySpatialEnvironment(scene, "day");
  assert.equal(scene.background.getHex(), spatialEnvironmentSettings.day.background);
});
