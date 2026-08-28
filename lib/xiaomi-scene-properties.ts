export type SceneCapabilityProperty = {
  name: string;
  format: string;
  readable: boolean;
  writable: boolean;
  choices?: Array<{ value: number | string | boolean; label: string }>;
  range?: { min: number; max: number; step: number };
};

export type ScenePropertyValue = boolean | number | string;

export type SceneMappableProperty = SceneCapabilityProperty & {
  siid: number;
  piid: number;
  label: string;
};

export type SceneMappableGroup = {
  name: string;
  properties: SceneMappableProperty[];
};

export type ScenePropertySemantic = {
  serviceName: string;
  propertyName: string;
  label: string;
  value: ScenePropertyValue;
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

export function isScenePropertyValueSupported(property: SceneCapabilityProperty, value: ScenePropertyValue) {
  if (property.format === "bool" && typeof value !== "boolean") return false;
  if (["float", "int8", "int16", "int32", "uint8", "uint16", "uint32"].includes(property.format) && typeof value !== "number") return false;
  if (property.format === "string" && typeof value !== "string") return false;
  if (property.choices?.length && !property.choices.some(choice => choice.value === value)) return false;
  if (property.range) {
    if (typeof value !== "number" || value < property.range.min || value > property.range.max) return false;
    const steps = (value - property.range.min) / property.range.step;
    if (Math.abs(steps - Math.round(steps)) > 1e-7) return false;
  }
  return true;
}

export function scenePropertySemantics(
  properties: Array<{ siid: number; piid: number; value: ScenePropertyValue }>,
  groups: SceneMappableGroup[],
) {
  const semantics: ScenePropertySemantic[] = [];
  for (const requested of properties) {
    const group = groups.find(item => item.properties.some(property => property.siid === requested.siid && property.piid === requested.piid));
    const property = group?.properties.find(item => item.siid === requested.siid && item.piid === requested.piid);
    if (!group || !property) return undefined;
    semantics.push({ serviceName: group.name, propertyName: property.name, label: property.label, value: requested.value });
  }
  return semantics;
}

export function mapScenePropertySemantics(semantics: ScenePropertySemantic[], groups: SceneMappableGroup[], preferredService?: { name: string; siid: number }) {
  const mapped: Array<{ siid: number; piid: number; value: ScenePropertyValue; label: string }> = [];
  for (const semantic of semantics) {
    const group = groups.find(item => item.name === semantic.serviceName && item.properties.some(property => property.name === semantic.propertyName) && (preferredService?.name !== semantic.serviceName || item.properties.some(property => property.siid === preferredService.siid)));
    const property = group?.properties.find(item => item.name === semantic.propertyName);
    if (!group || !property || !isSceneWritableProperty(group.name, property) || !isScenePropertyValueSupported(property, semantic.value)) return undefined;
    mapped.push({ siid: property.siid, piid: property.piid, value: semantic.value, label: property.label });
  }
  return mapped;
}
