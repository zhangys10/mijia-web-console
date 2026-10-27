import type { SpatialPlacement } from "./spatial-layout.ts";

export function stripPoints(segments: NonNullable<SpatialPlacement["appearance"]>["segments"]) {
  const points = [{ x: 0, y: 0 }];
  for (const segment of segments) {
    const previous = points[points.length - 1], angle = segment.angle * Math.PI / 180;
    points.push({ x: previous.x + Math.cos(angle) * segment.length, y: previous.y + Math.sin(angle) * segment.length });
  }
  return points;
}

export type VisualProperty = { name: string; siid: number; piid: number; readable: boolean; range?: { min: number; max: number } };
export function visualProperties(properties: VisualProperty[]) {
  return properties.filter(property => property.readable && ["brightness", "current-position", "target-position", "target-temperature"].includes(property.name));
}
export function visualParameters(properties: VisualProperty[], values: Record<string, unknown>) {
  const result: { brightness?: number; temperature?: number; position?: number; positionIsTarget?: boolean; currentPosition?: number; targetPosition?: number } = {};
  for (const name of ["brightness", "target-temperature", "target-position", "current-position"]) {
    const property = properties.find(item => item.name === name);
    if (!property) continue;
    const value = values[`${property.siid}.${property.piid}`];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (name === "target-temperature") result.temperature = value;
    else if (property.range && property.range.max > property.range.min && value >= property.range.min && value <= property.range.max) {
      const normalized = (value - property.range.min) / (property.range.max - property.range.min);
      if (name === "brightness") result.brightness = normalized;
      else if (name === "target-position") result.targetPosition = normalized;
      else result.currentPosition = normalized;
    }
  }
  if (result.currentPosition !== undefined) {
    result.position = result.currentPosition;
    result.positionIsTarget = false;
  } else if (result.targetPosition !== undefined) {
    result.position = result.targetPosition;
    result.positionIsTarget = true;
  }
  return result;
}
