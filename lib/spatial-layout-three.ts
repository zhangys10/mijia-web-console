import { createFurniture } from "./spatial-furniture.ts";
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { buildSpatialMeshPlan, pixelsPerMeter, pointInPolygon, type SpatialLayoutV1 } from "./spatial-layout.ts";
import { buildWallRenderPaths, miterPolylineOutline } from "./wall-editor-geometry.ts";

const floorColors = [0xf3eee7, 0xe8eef2, 0xeeeaf4, 0xe8f1ec, 0xf3eee0, 0xe9edf4];

function segmentPiecesAtPolygon(start: { x: number; y: number }, end: { x: number; y: number }, polygon: Array<{ x: number; y: number }>) {
  const dx = end.x - start.x, dy = end.y - start.y, values = [0, 1];
  for (let index = 0; index < polygon.length; index++) {
    const left = polygon[index], right = polygon[(index + 1) % polygon.length], ex = right.x - left.x, ey = right.y - left.y;
    const denominator = dx * ey - dy * ex;
    if (Math.abs(denominator) < 1e-9) continue;
    const t = ((left.x - start.x) * ey - (left.y - start.y) * ex) / denominator;
    const u = ((left.x - start.x) * dy - (left.y - start.y) * dx) / denominator;
    if (t > 1e-6 && t < 1 - 1e-6 && u >= 0 && u <= 1) values.push(t);
  }
  values.sort((a, b) => a - b);
  return values.slice(0, -1).map((from, index) => ({
    start: { x: start.x + dx * from, y: start.y + dy * from },
    end: { x: start.x + dx * values[index + 1], y: start.y + dy * values[index + 1] },
  }));
}

export function spatialPointToWorld(layout: Pick<SpatialLayoutV1, "calibration" | "imageWidth" | "imageHeight">, point: { x: number; y: number }, elevation = 0) {
  const scale = 1 / pixelsPerMeter(layout.calibration);
  return new THREE.Vector3((point.x - layout.imageWidth / 2) * scale, elevation, (point.y - layout.imageHeight / 2) * scale);
}

export function fadeSpatialObject(object: THREE.Object3D, opacity = .15) {
  object.traverse(child => {
    if (!(child instanceof THREE.Mesh)) return;
    const materials = (Array.isArray(child.material) ? child.material : [child.material]).map(material => {
      const faded = material.clone(); faded.transparent = true; faded.opacity *= opacity; faded.depthWrite = false;
      if (faded instanceof THREE.MeshStandardMaterial && faded.userData.luminous) faded.emissiveIntensity = 0;
      return faded;
    });
    child.userData.detachedMaterials = Array.isArray(child.material) ? child.material : [child.material];
    child.material = Array.isArray(child.material) ? materials : materials[0];
  });
  return object;
}

export function createSpatialScene(layout: Pick<SpatialLayoutV1, "calibration" | "defaults" | "zones" | "walls" | "openings" | "imageWidth" | "imageHeight" | "furniture">, focusZoneId = "") {
  const root = new THREE.Group(); root.name = "mijia-spatial-layout";
  const plan = buildSpatialMeshPlan(layout);
  const originX = layout.imageWidth * plan.scale / 2;
  const originZ = layout.imageHeight * plan.scale / 2;
  plan.floors.filter(floor => !floor.name.startsWith("CAD 墙体")).forEach((floor, index) => {
    const shape = new THREE.Shape(floor.points.map(([x, y]) => new THREE.Vector2(x - originX, y - originZ)));
    const geometry = new THREE.ShapeGeometry(shape);
    geometry.rotateX(Math.PI / 2);
    const material = new THREE.MeshStandardMaterial({ color: floorColors[index % floorColors.length], roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material); mesh.name = `zone:${floor.zoneId}:floor`; mesh.receiveShadow = true; if (focusZoneId && floor.zoneId !== focusZoneId) fadeSpatialObject(mesh); root.add(mesh);
  });
  const wallMaterial = new THREE.MeshStandardMaterial({ color: 0xf8f8f7, roughness: 0.82 });
  for (const wall of plan.walls) {
    const [sx, sz] = wall.start, [ex, ez] = wall.end;
    const focusedZone = layout.zones.find(zone => zone.id === focusZoneId);
    const pieces = focusedZone && wall.zoneId !== focusZoneId ? segmentPiecesAtPolygon({ x: sx / plan.scale, y: sz / plan.scale }, { x: ex / plan.scale, y: ez / plan.scale }, focusedZone.polygon) : [{ start: { x: sx / plan.scale, y: sz / plan.scale }, end: { x: ex / plan.scale, y: ez / plan.scale } }];
    pieces.forEach((piece, pieceIndex) => {
      const pieceSx = piece.start.x * plan.scale, pieceSz = piece.start.y * plan.scale, pieceEx = piece.end.x * plan.scale, pieceEz = piece.end.y * plan.scale;
      const dx = pieceEx - pieceSx, dz = pieceEz - pieceSz, length = Math.hypot(dx, dz);
      if (length < 0.02) return;
      const geometry = new THREE.BoxGeometry(length, wall.height, wall.thickness), mesh = new THREE.Mesh(geometry, wallMaterial);
      mesh.position.set((pieceSx + pieceEx) / 2 - originX, wall.base + wall.height / 2, (pieceSz + pieceEz) / 2 - originZ);
      mesh.rotation.y = -Math.atan2(dz, dx); mesh.name = `zone:${wall.zoneId}:wall:${wall.edge}${pieces.length > 1 ? `:${pieceIndex}` : ""}`; mesh.castShadow = true; mesh.receiveShadow = true;
      const midpoint = { x: (piece.start.x + piece.end.x) / 2, y: (piece.start.y + piece.end.y) / 2 };
      if (focusZoneId && wall.zoneId !== focusZoneId && (!focusedZone || !pointInPolygon(midpoint, focusedZone.polygon))) fadeSpatialObject(mesh);
      root.add(mesh);
    });
  }
  for (const path of buildWallRenderPaths((layout.walls ?? []).map(wall => ({ ...wall, thicknessPixels: layout.defaults.wallThickness / plan.scale })))) {
    if (path.points.length < 3) continue;
    const halfWidth = layout.defaults.wallThickness / 2;
    for (let index = 1; index < path.points.length - 1; index++) {
      const joint = path.points[index], before = path.points[index - 1], after = path.points[index + 1];
      const beforeLength = Math.hypot(joint.x - before.x, joint.y - before.y), afterLength = Math.hypot(after.x - joint.x, after.y - joint.y);
      if (beforeLength < 1 || afterLength < 1) continue;
      const reach = Math.max(path.thicknessPixels * 2, 8);
      const local = [{ x: joint.x + (before.x - joint.x) * Math.min(1, reach / beforeLength), y: joint.y + (before.y - joint.y) * Math.min(1, reach / beforeLength) }, joint, { x: joint.x + (after.x - joint.x) * Math.min(1, reach / afterLength), y: joint.y + (after.y - joint.y) * Math.min(1, reach / afterLength) }];
      const outline = miterPolylineOutline(local.map(point => ({ x: point.x * plan.scale, y: point.y * plan.scale })), halfWidth);
      if (outline.length < 3) continue;
      const shape = new THREE.Shape(outline.map(point => new THREE.Vector2(point.x - originX, -(point.y - originZ))));
      const geometry = new THREE.ExtrudeGeometry(shape, { depth: layout.defaults.wallHeight, bevelEnabled: false }); geometry.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geometry, wallMaterial); mesh.name = `wall-junction:${path.wallIds[index - 1]}:${path.wallIds[index]}`; mesh.castShadow = true; mesh.receiveShadow = true;
      const focusedZone = layout.zones.find(zone => zone.id === focusZoneId);
      if (focusZoneId && (!focusedZone || !pointInPolygon(joint, focusedZone.polygon))) fadeSpatialObject(mesh);
      root.add(mesh);
    }
  }
  for (const opening of layout.openings ?? []) {
    const wall = opening.wallId ? layout.walls?.find(item => item.id === opening.wallId) : undefined, zone = opening.zoneId ? layout.zones.find(item => item.id === opening.zoneId) : undefined;
    if (!wall && !zone) continue;
    const start = spatialPointToWorld(layout, wall?.start ?? zone!.polygon[opening.edge]), end = spatialPointToWorld(layout, wall?.end ?? zone!.polygon[(opening.edge + 1) % zone!.polygon.length]);
    const center = start.clone().lerp(end, opening.offset), direction = end.clone().sub(start), width = opening.width / pixelsPerMeter(layout.calibration);
    const geometry = new THREE.BoxGeometry(Math.max(.2, width), opening.height, opening.kind === "door" ? .08 : .04);
    const material = new THREE.MeshStandardMaterial({ color: opening.kind === "door" ? 0xa77a59 : 0x9ed8ef, transparent: opening.kind === "window", opacity: opening.kind === "window" ? .62 : 1, roughness: opening.kind === "window" ? .2 : .75, metalness: opening.kind === "window" ? .08 : 0 });
    const mesh = new THREE.Mesh(geometry, material); mesh.name = `opening:${opening.id}`; mesh.position.set(center.x, opening.sill + opening.height / 2, center.z); mesh.rotation.y = -Math.atan2(direction.z, direction.x);
    const focusedZone = layout.zones.find(item => item.id === focusZoneId), midpoint = wall ? { x: (wall.start.x + wall.end.x) / 2, y: (wall.start.y + wall.end.y) / 2 } : zone?.polygon[opening.edge];
    if (focusZoneId && opening.zoneId !== focusZoneId && (!focusedZone || !midpoint || !pointInPolygon(midpoint, focusedZone.polygon))) fadeSpatialObject(mesh);
    root.add(mesh);
  }
  for (const item of layout.furniture ?? []) { const mesh = createFurniture(item); mesh.position.copy(spatialPointToWorld(layout, item.point)); const focusedZone = layout.zones.find(zone => zone.id === focusZoneId); if (focusZoneId && (!focusedZone || !pointInPolygon(item.point, focusedZone.polygon))) fadeSpatialObject(mesh); root.add(mesh); }
  return root;
}

export async function exportSpatialGlb(layout: Pick<SpatialLayoutV1, "calibration" | "defaults" | "zones" | "walls" | "openings" | "imageWidth" | "imageHeight" | "furniture">) {
  const scene = new THREE.Scene(); scene.add(createSpatialScene(layout));
  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(scene, { binary: true, onlyVisible: true });
  if (!(result instanceof ArrayBuffer)) throw new Error("SPATIAL_GLB_EXPORT_FAILED");
  return new Blob([result], { type: "model/gltf-binary" });
}
