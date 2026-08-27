export type SceneCapabilityProperty = {
  name: string;
  format: string;
  readable: boolean;
  writable: boolean;
  choices?: Array<{ value: number | string | boolean; label: string }>;
  range?: { min: number; max: number; step: number };
};

const allowedProperties: Record<string, Set<string>> = {
  light: new Set(["on", "brightness", "color-temperature", "mode"]),
  "air-conditioner": new Set(["on", "mode", "target-temperature", "fan-level", "horizontal-swing", "vertical-swing"]),
  "air-purifier": new Set(["on", "mode", "fan-level"]),
  fan: new Set(["on", "mode", "fan-level", "horizontal-swing", "vertical-swing"]),
  humidifier: new Set(["on", "mode", "target-humidity", "fan-level"]),
  curtain: new Set(["motor-control", "target-position"]),
  "motor-controller": new Set(["motor-control", "target-position"]),
  outlet: new Set(["on"]),
  switch: new Set(["on"]),
};

function hasSafeEditor(property: SceneCapabilityProperty) {
  if (property.format === "bool") return true;
  if (property.choices?.length) return true;
  return Boolean(property.range && Number.isFinite(property.range.min) && Number.isFinite(property.range.max) && property.range.step > 0);
}

export function isSceneWritableProperty(serviceName: string, property: SceneCapabilityProperty) {
  return Boolean(property.readable && property.writable && allowedProperties[serviceName]?.has(property.name) && hasSafeEditor(property));
}
