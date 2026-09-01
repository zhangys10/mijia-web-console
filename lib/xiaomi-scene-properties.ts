export type SceneCapabilityProperty = {
  name: string;
  format: string;
  readable: boolean;
  writable: boolean;
  unit?: string;
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
  kind: "enum" | "boolean" | "number" | "string";
  value: ScenePropertyValue;
  choice?: { key: string; label: string };
  source?: { did?: string; siid: number; piid: number; value: ScenePropertyValue };
};

export type ScenePropertyMappingFailure =
  | "property-unavailable"
  | "property-not-writable"
  | "choice-label-missing"
  | "choice-label-ambiguous"
  | "value-unsupported";

export type ScenePropertyMappingResult =
  | { ok: true; properties: Array<{ siid: number; piid: number; value: ScenePropertyValue; label: string }> }
  | { ok: false; reason: ScenePropertyMappingFailure; semantic: ScenePropertySemantic };

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

export function normalizeSceneChoiceLabel(label: string) {
  return label.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function semanticKind(property: SceneCapabilityProperty): ScenePropertySemantic["kind"] {
  if (property.choices?.length) return "enum";
  if (property.format === "bool") return "boolean";
  if (["float", "int8", "int16", "int32", "uint8", "uint16", "uint32"].includes(property.format)) return "number";
  return "string";
}

export function scenePropertySemantic(
  serviceName: string,
  property: SceneMappableProperty,
  value: ScenePropertyValue,
  sourceDid?: string,
): ScenePropertySemantic | undefined {
  if (!isScenePropertyValueSupported(property, value)) return undefined;
  const matchingChoices = property.choices?.filter(choice => typeof choice.value === typeof value && choice.value === value) ?? [];
  if (property.choices?.length && matchingChoices.length !== 1) return undefined;
  const choice = matchingChoices[0];
  return {
    serviceName,
    propertyName: property.name,
    label: property.label,
    kind: semanticKind(property),
    value,
    ...(choice ? { choice: { key: normalizeSceneChoiceLabel(choice.label), label: choice.label } } : {}),
    source: { ...(sourceDid ? { did: sourceDid } : {}), siid: property.siid, piid: property.piid, value },
  };
}

export function scenePropertySemantics(
  properties: Array<{ siid: number; piid: number; value: ScenePropertyValue }>,
  groups: SceneMappableGroup[],
  sourceDid?: string,
) {
  const semantics: ScenePropertySemantic[] = [];
  for (const requested of properties) {
    const group = groups.find(item => item.properties.some(property => property.siid === requested.siid && property.piid === requested.piid));
    const property = group?.properties.find(item => item.siid === requested.siid && item.piid === requested.piid);
    if (!group || !property) return undefined;
    const semantic = scenePropertySemantic(group.name, property, requested.value, sourceDid);
    if (!semantic) return undefined;
    semantics.push(semantic);
  }
  return semantics;
}

export function mapScenePropertySemanticsResult(
  semantics: ScenePropertySemantic[],
  groups: SceneMappableGroup[],
  preferredService?: { name: string; siid: number },
  targetDid?: string,
): ScenePropertyMappingResult {
  const mapped: Array<{ siid: number; piid: number; value: ScenePropertyValue; label: string }> = [];
  for (const semantic of semantics) {
    const group = groups.find(item => item.name === semantic.serviceName && item.properties.some(property => property.name === semantic.propertyName) && (preferredService?.name !== semantic.serviceName || item.properties.some(property => property.siid === preferredService.siid)));
    const property = group?.properties.find(item => item.name === semantic.propertyName);
    if (!group || !property) return { ok: false, reason: "property-unavailable", semantic };
    if (!isSceneWritableProperty(group.name, property)) return { ok: false, reason: "property-not-writable", semantic };
    let value = semantic.value;
    if (semantic.kind === "enum") {
      const sameSource = Boolean(targetDid && semantic.source?.did === targetDid && semantic.source.siid === property.siid && semantic.source.piid === property.piid);
      if (sameSource && semantic.source && isScenePropertyValueSupported(property, semantic.source.value)) {
        value = semantic.source.value;
      } else {
        if (!semantic.choice) return { ok: false, reason: "choice-label-missing", semantic };
        const choices = property.choices?.filter(choice => normalizeSceneChoiceLabel(choice.label) === semantic.choice?.key) ?? [];
        if (!choices.length) return { ok: false, reason: "choice-label-missing", semantic };
        if (choices.length !== 1) return { ok: false, reason: "choice-label-ambiguous", semantic };
        value = choices[0].value;
      }
    }
    if (!isScenePropertyValueSupported(property, value)) return { ok: false, reason: "value-unsupported", semantic };
    mapped.push({ siid: property.siid, piid: property.piid, value, label: property.label });
  }
  return { ok: true, properties: mapped };
}

export function mapScenePropertySemantics(
  semantics: ScenePropertySemantic[],
  groups: SceneMappableGroup[],
  preferredService?: { name: string; siid: number },
  targetDid?: string,
) {
  const result = mapScenePropertySemanticsResult(semantics, groups, preferredService, targetDid);
  return result.ok ? result.properties : undefined;
}
