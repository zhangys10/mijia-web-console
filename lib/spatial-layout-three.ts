import { createFurniture } from "./spatial-furniture.ts";
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { buildSpatialMeshPlan, pixelsPerMeter, type SpatialLayoutV1 } from "./spatial-layout.ts";
import { buildWallRenderPaths, miterPolylineOutline } from "./wall-editor-geometry.ts";

const floorColors = [0xf3eee7, 0xe8eef2, 0xeeeaf4, 0xe8f1ec, 0xf3eee0, 0xe9edf4];

export function spatialPointToWorld(layout: Pick<SpatialLayoutV1, "calibration" | "imageWidth" | "imageHeight">, point: { x: number; y: number }, elevation = 0) {
  const scale = 1 / pixelsPerMeter(layout.calibration);
  return new THREE.Vector3((point.x - layout.imageWidth / 2) * scale, elevation, (point.y - layout.imageHeight / 2) * scale);
}

export function createSpatialScene(layout: Pick<SpatialLayoutV1, "calibration" | "defaults" | "zones" | "walls" | "openings" | "imageWidth" | "imageHeight" | "furniture">) {
  const root = new THREE.Group(); root.name = "mijia-spatial-layout";
  const plan = buildSpatialMeshPlan(layout);
  const originX = layout.imageWidth * plan.scale / 2;
  const originZ = layout.imageHeight * plan.scale / 2;
  plan.floors.filter(floor => !floor.name.startsWith("CAD 墙体")).forEach((floor, index) => {
    const shape = new THREE.Shape(floor.points.map(([x, y]) => new THREE.Vector2(x - originX, y - originZ)));
    const geometry = new THREE.ShapeGeometry(shape);
    geometry.rotateX(Math.PI / 2);
    const material = new THREE.MeshStandardMaterial({ color: floorColors[index % floorColors.length], roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material); mesh.name = `zone:${floor.zoneId}:floor`; mesh.receiveShadow = true; root.add(mesh);
  });
  const wallMaterial = new THREE.MeshStandardMaterial({ color: 0xf8f8f7, roughness: 0.82 });
  for (const wall of plan.walls) {
    const [sx, sz] = wall.start, [ex, ez] = wall.end;
    const dx = ex - sx, dz = ez - sz, length = Math.hypot(dx, dz);
    if (length < 0.02) continue;
    const geometry = new THREE.BoxGeometry(length, wall.height, wall.thickness);
    const mesh = new THREE.Mesh(geometry, wallMaterial);
    mesh.position.set((sx + ex) / 2 - originX, wall.base + wall.height / 2, (sz + ez) / 2 - originZ);
    mesh.rotation.y = -Math.atan2(dz, dx); mesh.name = `zone:${wall.zoneId}:wall:${wall.edge}`; mesh.castShadow = true; mesh.receiveShadow = true; root.add(mesh);
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
      const mesh = new THREE.Mesh(geometry, wallMaterial); mesh.name = `wall-junction:${path.wallIds[index - 1]}:${path.wallIds[index]}`; mesh.castShadow = true; mesh.receiveShadow = true; root.add(mesh);
    }
  }
  for (const opening of layout.openings ?? []) {
    const wall = opening.wallId ? layout.walls?.find(item => item.id === opening.wallId) : undefined, zone = opening.zoneId ? layout.zones.find(item => item.id === opening.zoneId) : undefined;
    if (!wall && !zone) continue;
    const start = spatialPointToWorld(layout, wall?.start ?? zone!.polygon[opening.edge]), end = spatialPointToWorld(layout, wall?.end ?? zone!.polygon[(opening.edge + 1) % zone!.polygon.length]);
    const center = start.clone().lerp(end, opening.offset), direction = end.clone().sub(start), width = opening.width / pixelsPerMeter(layout.calibration);
    const geometry = new THREE.BoxGeometry(Math.max(.2, width), opening.height, opening.kind === "door" ? .08 : .04);
    const material = new THREE.MeshStandardMaterial({ color: opening.kind === "door" ? 0xa77a59 : 0x9ed8ef, transparent: opening.kind === "window", opacity: opening.kind === "window" ? .62 : 1, roughness: opening.kind === "window" ? .2 : .75, metalness: opening.kind === "window" ? .08 : 0 });
    const mesh = new THREE.Mesh(geometry, material); mesh.name = `opening:${opening.id}`; mesh.position.set(center.x, opening.sill + opening.height / 2, center.z); mesh.rotation.y = -Math.atan2(direction.z, direction.x); root.add(mesh);
  }
  for (const item of layout.furniture ?? []) { const mesh = createFurniture(item); mesh.position.copy(spatialPointToWorld(layout, item.point)); root.add(mesh); }
  return root;
}

export async function exportSpatialGlb(layout: Pick<SpatialLayoutV1, "calibration" | "defaults" | "zones" | "walls" | "openings" | "imageWidth" | "imageHeight" | "furniture">) {
  const scene = new THREE.Scene(); scene.add(createSpatialScene(layout));
  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(scene, { binary: true, onlyVisible: true });
  if (!(result instanceof ArrayBuffer)) throw new Error("SPATIAL_GLB_EXPORT_FAILED");
  return new Blob([result], { type: "model/gltf-binary" });
}
