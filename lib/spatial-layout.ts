import type { SpatialFurniture } from "./spatial-furniture.ts";

export type SpatialPoint = { x: number; y: number };

export type SpatialCalibration = {
  start: SpatialPoint;
  end: SpatialPoint;
  meters: number;
};

export type SpatialZone = {
  id: string;
  name: string;
  kind: "room" | "area";
  roomName: string | null;
  polygon: SpatialPoint[];
  wallEdges: boolean[];
  wallThicknessPixels?: number;
};

export type SpatialPlacement = {
  id: string;
  targetKind: "device" | "lighting";
  targetId: string;
  name: string;
  room: string;
  zoneId: string | null;
  point: SpatialPoint;
  elevation: number;
  rotationY: number;
  appearance?: { type: "point" | "strip" | "area"; fixture?: "ceiling" | "pendant" | "spotlight" | "strip" | "panel"; length: number; width: number; segments: Array<{ length: number; angle: number }> };
};

export type SpatialOpening = {
  id: string;
  zoneId: string | null;
  wallId?: string | null;
  edge: number;
  kind: "door" | "window";
  offset: number;
  width: number;
  height: number;
  sill: number;
  confidence: number;
};

export type SpatialWall = {
  id: string;
  start: SpatialPoint;
  end: SpatialPoint;
  thicknessPixels: number;
  height?: number;
  confidence: number;
};

export type SpatialAsset = {
  key: string;
  contentType: string;
  byteLength: number;
};

export type SpatialLayoutV1 = {
  version: 1;
  revision: string;
  baseRevision: string | null;
  image: SpatialAsset;
  model: SpatialAsset;
  imageWidth: number;
  imageHeight: number;
  calibration: SpatialCalibration;
  defaults: { wallHeight: number; wallThickness: number };
  zones: SpatialZone[];
  walls?: SpatialWall[];
  openings: SpatialOpening[];
  placements: SpatialPlacement[];
  furniture?: SpatialFurniture[];
  updatedAt: string;
};

export type SpatialMeshPlan = {
  scale: number;
  floors: Array<{ zoneId: string; name: string; points: Array<[number, number]> }>;
  walls: Array<{ zoneId: string; edge: number; start: [number, number]; end: [number, number]; base: number; height: number; thickness: number }>;
};

export class SpatialLayoutError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) { super(code); this.code = code; this.status = status; }
}

export function parseSpatialLayoutSaveEnvelope(input: unknown): { homeId: unknown; layout: unknown } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new SpatialLayoutError("SPATIAL_REQUEST_INVALID", 400);
  const value = input as Record<string, unknown>;
  if (!("homeId" in value) || !("layout" in value) || Object.keys(value).some(key => key !== "homeId" && key !== "layout")) {
    throw new SpatialLayoutError("SPATIAL_REQUEST_INVALID", 400);
  }
  return { homeId: value.homeId, layout: value.layout };
}

const idPattern = /^[A-Za-z0-9_-]{1,80}$/;
const uploadKeyPattern = /^homes\/[a-f0-9]{64}\/uploads\/[a-f0-9-]{36}\.(?:png|jpg|webp|glb)$/;

function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function point(value: unknown): value is SpatialPoint {
  return Boolean(value && typeof value === "object" && finite((value as SpatialPoint).x) && finite((value as SpatialPoint).y));
}

export function pixelsPerMeter(calibration: SpatialCalibration) {
  const pixels = Math.hypot(calibration.end.x - calibration.start.x, calibration.end.y - calibration.start.y);
  if (!Number.isFinite(pixels) || pixels < 5 || !Number.isFinite(calibration.meters) || calibration.meters <= 0 || calibration.meters > 1_000) {
    throw new SpatialLayoutError("SPATIAL_CALIBRATION_INVALID", 400);
  }
  return pixels / calibration.meters;
}

export function polygonArea(points: SpatialPoint[]) {
  return Math.abs(points.reduce((sum, current, index) => {
    const next = points[(index + 1) % points.length];
    return sum + current.x * next.y - next.x * current.y;
  }, 0) / 2);
}

export function pointInPolygon(value: SpatialPoint, polygon: SpatialPoint[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const left = polygon[i], right = polygon[j];
    const crosses = (left.y > value.y) !== (right.y > value.y)
      && value.x < (right.x - left.x) * (value.y - left.y) / ((right.y - left.y) || Number.EPSILON) + left.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

export function buildSpatialMeshPlan(layout: Pick<SpatialLayoutV1, "calibration" | "defaults" | "zones" | "walls" | "openings">): SpatialMeshPlan {
  const scale = 1 / pixelsPerMeter(layout.calibration);
  const explicitWalls = (layout.walls ?? []).flatMap(wall => {
    const dx = wall.end.x - wall.start.x, dy = wall.end.y - wall.start.y, length = Math.hypot(dx, dy), height = wall.height ?? layout.defaults.wallHeight;
    if (length < 1) return [];
    const thickness = layout.defaults.wallThickness;
    const openings = layout.openings.filter(opening => opening.wallId === wall.id).map(opening => ({ opening, from: Math.max(0, opening.offset * length - opening.width / 2), to: Math.min(length, opening.offset * length + opening.width / 2) })).filter(interval => interval.to - interval.from >= 1).sort((a, b) => a.from - b.from);
    const pieces: SpatialMeshPlan["walls"] = [];
    const add = (from: number, to: number, base: number, pieceHeight: number) => {
      if (to - from < 1 || pieceHeight < .02) return;
      const startRatio = from / length, endRatio = to / length;
      pieces.push({ zoneId: wall.id, edge: pieces.length, start: [(wall.start.x + dx * startRatio) * scale, (wall.start.y + dy * startRatio) * scale], end: [(wall.start.x + dx * endRatio) * scale, (wall.start.y + dy * endRatio) * scale], base, height: pieceHeight, thickness });
    };
    let cursor = 0;
    for (const interval of openings) {
      const from = Math.max(cursor, interval.from), to = Math.max(from, interval.to);
      add(cursor, from, 0, height);
      add(from, to, 0, Math.min(height, interval.opening.sill));
      const headerBase = Math.min(height, interval.opening.sill + interval.opening.height);
      add(from, to, headerBase, height - headerBase);
      cursor = Math.max(cursor, to);
    }
    add(cursor, length, 0, height);
    return pieces;
  });
  return {
    scale,
    floors: layout.zones.map(zone => ({ zoneId: zone.id, name: zone.name, points: zone.polygon.map(value => [value.x * scale, value.y * scale]) })),
    walls: [...layout.zones.flatMap(zone => zone.polygon.flatMap((start, edge) => {
      if (!zone.wallEdges[edge]) return [];
      const end = zone.polygon[(edge + 1) % zone.polygon.length];
      return [{ zoneId: zone.id, edge, start: [start.x * scale, start.y * scale] as [number, number], end: [end.x * scale, end.y * scale] as [number, number], base: 0, height: layout.defaults.wallHeight, thickness: layout.defaults.wallThickness }];
    })), ...explicitWalls],
  };
}

function validateAsset(value: unknown, kind: "image" | "model"): value is SpatialAsset {
  if (!value || typeof value !== "object") return false;
  const asset = value as SpatialAsset;
  const allowed = kind === "image" ? ["image/png", "image/jpeg", "image/webp"] : ["model/gltf-binary", "application/octet-stream"];
  const limit = kind === "image" ? 10 * 1024 * 1024 : 20 * 1024 * 1024;
  return uploadKeyPattern.test(asset.key) && allowed.includes(asset.contentType) && Number.isInteger(asset.byteLength) && asset.byteLength > 0 && asset.byteLength <= limit;
}

export function parseSpatialLayout(input: unknown, expectedHomePrefix?: string): SpatialLayoutV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new SpatialLayoutError("SPATIAL_LAYOUT_INVALID", 400);
  const value = input as Record<string, unknown>;
  const allowed = new Set(["version", "revision", "baseRevision", "image", "model", "imageWidth", "imageHeight", "calibration", "defaults", "zones", "walls", "openings", "placements", "furniture", "updatedAt"]);
  if (Object.keys(value).some(key => !allowed.has(key)) || value.version !== 1) throw new SpatialLayoutError("SPATIAL_LAYOUT_INVALID", 400);
  if (typeof value.revision !== "string" || !/^layout_[a-f0-9-]{16,64}$/.test(value.revision)) throw new SpatialLayoutError("SPATIAL_LAYOUT_INVALID", 400);
  if (value.baseRevision !== null && (typeof value.baseRevision !== "string" || !/^layout_[a-f0-9-]{16,64}$/.test(value.baseRevision))) throw new SpatialLayoutError("SPATIAL_LAYOUT_INVALID", 400);
  if (!validateAsset(value.image, "image") || !validateAsset(value.model, "model")) throw new SpatialLayoutError("SPATIAL_ASSET_INVALID", 400);
  if (expectedHomePrefix && (!(value.image as SpatialAsset).key.startsWith(expectedHomePrefix) || !(value.model as SpatialAsset).key.startsWith(expectedHomePrefix))) throw new SpatialLayoutError("SPATIAL_ASSET_FORBIDDEN", 403);
  if (!Number.isInteger(value.imageWidth) || !Number.isInteger(value.imageHeight) || (value.imageWidth as number) < 1 || (value.imageHeight as number) < 1 || (value.imageWidth as number) > 8192 || (value.imageHeight as number) > 8192) throw new SpatialLayoutError("SPATIAL_IMAGE_DIMENSIONS_INVALID", 400);
  const calibration = value.calibration as SpatialCalibration;
  if (!calibration || !point(calibration.start) || !point(calibration.end) || !finite(calibration.meters)) throw new SpatialLayoutError("SPATIAL_CALIBRATION_INVALID", 400);
  pixelsPerMeter(calibration);
  const defaults = value.defaults as SpatialLayoutV1["defaults"];
  if (!defaults || !finite(defaults.wallHeight) || defaults.wallHeight < 1 || defaults.wallHeight > 10 || !finite(defaults.wallThickness) || defaults.wallThickness < 0.02 || defaults.wallThickness > 1) throw new SpatialLayoutError("SPATIAL_DEFAULTS_INVALID", 400);
  if (!Array.isArray(value.zones) || value.zones.length > 64) throw new SpatialLayoutError("SPATIAL_ZONES_INVALID", 400);
  const zoneIds = new Set<string>();
  const zones = value.zones.map(raw => {
    if (!raw || typeof raw !== "object") throw new SpatialLayoutError("SPATIAL_ZONE_INVALID", 400);
    const zone = raw as SpatialZone;
    if (!idPattern.test(zone.id) || zoneIds.has(zone.id) || typeof zone.name !== "string" || !zone.name.trim() || zone.name.length > 100 || !["room", "area"].includes(zone.kind) || zone.roomName !== null && (typeof zone.roomName !== "string" || zone.roomName.length > 100) || !Array.isArray(zone.polygon) || zone.polygon.length < 3 || zone.polygon.length > 256 || zone.polygon.some(value => !point(value)) || polygonArea(zone.polygon) < 25 || !Array.isArray(zone.wallEdges) || zone.wallEdges.length !== zone.polygon.length || zone.wallEdges.some(flag => typeof flag !== "boolean") || zone.wallThicknessPixels !== undefined && (!finite(zone.wallThicknessPixels) || zone.wallThicknessPixels <= 0 || zone.wallThicknessPixels > Math.max(value.imageWidth as number, value.imageHeight as number))) throw new SpatialLayoutError("SPATIAL_ZONE_INVALID", 400);
    zoneIds.add(zone.id);
    return { ...zone, name: zone.name.trim(), polygon: zone.polygon.map(value => ({ x: value.x, y: value.y })), wallEdges: [...zone.wallEdges] };
  });
  if (value.walls !== undefined && !Array.isArray(value.walls)) throw new SpatialLayoutError("SPATIAL_WALLS_INVALID", 400);
  const wallIds = new Set<string>();
  const walls = (value.walls === undefined ? [] : value.walls as unknown[]).map(raw => {
    if (!raw || typeof raw !== "object") throw new SpatialLayoutError("SPATIAL_WALL_INVALID", 400);
    const wall = raw as SpatialWall;
    if (!idPattern.test(wall.id) || wallIds.has(wall.id) || !point(wall.start) || !point(wall.end) || Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y) < 3 || !finite(wall.thicknessPixels) || wall.thicknessPixels <= 0 || wall.thicknessPixels > Math.max(value.imageWidth as number, value.imageHeight as number) || wall.height !== undefined && (!finite(wall.height) || wall.height < 1 || wall.height > 10) || !finite(wall.confidence) || wall.confidence < 0 || wall.confidence > 1) throw new SpatialLayoutError("SPATIAL_WALL_INVALID", 400);
    wallIds.add(wall.id); return { ...wall, start: { ...wall.start }, end: { ...wall.end } };
  });
  if (!Array.isArray(value.openings)) throw new SpatialLayoutError("SPATIAL_OPENINGS_INVALID", 400);
  const openingIds = new Set<string>();
  const openings = (value.openings === undefined ? [] : value.openings as unknown[]).map(raw => {
    if (!raw || typeof raw !== "object") throw new SpatialLayoutError("SPATIAL_OPENING_INVALID", 400);
    const opening = raw as SpatialOpening;
    const zone = opening.zoneId === null ? null : zones.find(item => item.id === opening.zoneId), wall = opening.wallId ? walls.find(item => item.id === opening.wallId) : null;
    const validBinding = wall ? opening.zoneId === null : Boolean(zone && Number.isInteger(opening.edge) && opening.edge >= 0 && opening.edge < zone.polygon.length);
    if (!idPattern.test(opening.id) || openingIds.has(opening.id) || !validBinding || !Number.isInteger(opening.edge) || !["door", "window"].includes(opening.kind) || !finite(opening.offset) || opening.offset < 0.05 || opening.offset > 0.95 || !finite(opening.width) || opening.width < 3 || opening.width > Math.max(value.imageWidth as number, value.imageHeight as number) || !finite(opening.height) || opening.height < .3 || opening.height > 4 || !finite(opening.sill) || opening.sill < 0 || opening.sill > 2 || !finite(opening.confidence) || opening.confidence < 0 || opening.confidence > 1) throw new SpatialLayoutError("SPATIAL_OPENING_INVALID", 400);
    openingIds.add(opening.id); return { ...opening };
  });
  if (!Array.isArray(value.placements) || value.placements.length > 500) throw new SpatialLayoutError("SPATIAL_PLACEMENTS_INVALID", 400);
  const placementIds = new Set<string>();
  const placements = value.placements.map(raw => {
    if (!raw || typeof raw !== "object") throw new SpatialLayoutError("SPATIAL_PLACEMENT_INVALID", 400);
    const placement = raw as SpatialPlacement;
    if (!idPattern.test(placement.id) || placementIds.has(placement.id) || !["device", "lighting"].includes(placement.targetKind) || typeof placement.targetId !== "string" || !placement.targetId || placement.targetId.length > 220 || typeof placement.name !== "string" || placement.name.length > 200 || typeof placement.room !== "string" || placement.room.length > 100 || placement.zoneId !== null && !zoneIds.has(placement.zoneId) || !point(placement.point) || !finite(placement.elevation) || placement.elevation < 0 || placement.elevation > 20 || !finite(placement.rotationY)) throw new SpatialLayoutError("SPATIAL_PLACEMENT_INVALID", 400);
    const appearance = placement.appearance;
    if (appearance !== undefined && (!appearance || typeof appearance !== "object" || Object.keys(appearance).some(key => !["type", "fixture", "length", "width", "segments"].includes(key)) || !["point", "strip", "area"].includes(appearance.type) || appearance.fixture !== undefined && !["ceiling", "pendant", "spotlight", "strip", "panel"].includes(appearance.fixture) || !finite(appearance.length) || appearance.length < .05 || appearance.length > 30 || !finite(appearance.width) || appearance.width < .02 || appearance.width > 20 || !Array.isArray(appearance.segments) || appearance.segments.length < 1 || appearance.segments.length > 32 || appearance.segments.some(segment => !segment || Object.keys(segment).some(key => !["length", "angle"].includes(key)) || !finite(segment.length) || segment.length < .05 || segment.length > 30 || !finite(segment.angle) || Math.abs(segment.angle) > 360))) throw new SpatialLayoutError("SPATIAL_APPEARANCE_INVALID", 400);
    placementIds.add(placement.id);
    return { ...placement, point: { ...placement.point } };
  });
  if (value.furniture !== undefined && (!Array.isArray(value.furniture) || value.furniture.length > 200)) throw new SpatialLayoutError("SPATIAL_FURNITURE_INVALID", 400);
  const furnitureIds = new Set<string>();
  const furniture = ((value.furniture ?? []) as unknown[]).map(raw => {
    if (!raw || typeof raw !== "object") throw new SpatialLayoutError("SPATIAL_FURNITURE_INVALID", 400);
    const item = raw as SpatialFurniture;
    if (Object.keys(item).some(key => !["id", "kind", "point", "width", "depth", "height", "rotation"].includes(key)) || !idPattern.test(item.id) || furnitureIds.has(item.id) || !["king-bed", "wallboard", "sofa", "table", "wardrobe"].includes(item.kind) || !point(item.point) || item.point.x < 0 || item.point.y < 0 || item.point.x > (value.imageWidth as number) || item.point.y > (value.imageHeight as number) || [item.width, item.depth, item.height].some(size => !finite(size) || size < .02 || size > 10) || !finite(item.rotation) || Math.abs(item.rotation) > 360) throw new SpatialLayoutError("SPATIAL_FURNITURE_INVALID", 400);
    furnitureIds.add(item.id);
    return { ...item, point: { x: item.point.x, y: item.point.y } };
  });
  return { version: 1, revision: value.revision, baseRevision: value.baseRevision, image: value.image as SpatialAsset, model: value.model as SpatialAsset, imageWidth: value.imageWidth as number, imageHeight: value.imageHeight as number, calibration, defaults, zones, walls, openings, placements, furniture, updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString() };
}

export function imageMagic(bytes: Uint8Array) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

export function isGlb(bytes: Uint8Array) {
  return bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "glTF" && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true) === 2;
}
