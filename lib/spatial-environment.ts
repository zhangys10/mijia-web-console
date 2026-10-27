import * as THREE from "three";

export type SpatialEnvironmentMode = "day" | "night";

export const spatialEnvironmentSettings = {
  day: { background: 0xf4f0e9, sky: 0xffffff, ground: 0x8b92a0, hemisphereIntensity: 1.5, directional: 0xffffff, directionalIntensity: 2 },
  night: { background: 0x111827, sky: 0x7185ad, ground: 0x101522, hemisphereIntensity: .42, directional: 0x9bb7e8, directionalIntensity: .5 },
} as const;

export function applySpatialEnvironment(scene: THREE.Scene, mode: SpatialEnvironmentMode) {
  const settings = spatialEnvironmentSettings[mode];
  scene.background = new THREE.Color(settings.background);
  const hemisphere = scene.getObjectByName("spatial-environment-hemisphere");
  if (hemisphere instanceof THREE.HemisphereLight) {
    hemisphere.color.setHex(settings.sky); hemisphere.groundColor.setHex(settings.ground); hemisphere.intensity = settings.hemisphereIntensity;
  }
  const directional = scene.getObjectByName("spatial-environment-directional");
  if (directional instanceof THREE.DirectionalLight) {
    directional.color.setHex(settings.directional); directional.intensity = settings.directionalIntensity;
  }
}
