import { stripPoints } from "./spatial-appearance.ts";
import type { SpatialPlacement } from "./spatial-layout.ts";
import * as THREE from "three";

export type SpatialVisualState = {
  on: boolean | null;
  online?: boolean | null;
  kind: "light" | "climate" | "curtain" | "other";
  brightness?: number;
  temperature?: number;
  position?: number;
  currentPosition?: number;
  targetPosition?: number;
  positionIsTarget?: boolean;
  pending?: boolean;
};

// A separate neutral indicator means unknown/offline never look like active effects.
export function createDeviceIndicator(state: SpatialVisualState) {
  const group = new THREE.Group();
  const known = state.online !== false && state.on !== null;
  const color = !known ? 0x596574 : state.on ? 0x18794e : 0x7b8794;
  const mesh = new THREE.Mesh(new THREE.TorusGeometry(.22, .035, 8, 32), new THREE.MeshBasicMaterial({ color }));
  mesh.rotation.x = -Math.PI / 2; mesh.position.y = .05; group.add(mesh);
  if (!known) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(.28, .025, .035), new THREE.MeshBasicMaterial({ color }));
    bar.position.y = .05; group.add(bar);
  }
  return group;
}

export function createDeviceEffect(state: SpatialVisualState, appearance?: SpatialPlacement["appearance"], elevation = 1.8) {
  const group = new THREE.Group();
  if (state.online === false) return group;
  if (state.kind === "curtain") {
    if (state.position === undefined || !Number.isFinite(state.position)) return group;
    const halfLength = (appearance?.length ?? 1.2) / 2;
    const width = Math.max(.02, (1 - Math.max(0, Math.min(1, state.position))) * halfLength);
    for (const side of [-1, 1]) {
      const panel = new THREE.Mesh(new THREE.BoxGeometry(1, 1.5, .04), new THREE.MeshStandardMaterial({ color: 0x9db7c9, roughness: .9 }));
      panel.userData.curtainSide = side; panel.userData.curtainHalfLength = halfLength;
      panel.scale.x = width; panel.position.set(side * (halfLength - width / 2), 1.1, 0); group.add(panel);
    }
    return group;
  }
  if (state.on !== true) return group;
  if (state.kind === "other") {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(.4, .025, 8, 40), new THREE.MeshBasicMaterial({ color: 0x18794e }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = .06; group.add(ring);
    return group;
  }
  const color = state.kind === "light" ? 0xffd28a : 0x79c9ed;
  const strength = state.kind === "light" ? Math.max(0, Math.min(1, state.brightness ?? 1)) : .65;
  if (state.kind === "light" && appearance && appearance.type !== "point") {
    const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .25 + .75 * strength });
    if (appearance.type === "area") {
      const panel = new THREE.Mesh(new THREE.BoxGeometry(appearance.length, .035, appearance.width), material);
      panel.position.y = elevation; group.add(panel);
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(appearance.length, appearance.width), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .24 * strength, side: THREE.DoubleSide, depthWrite: false }));
      glow.rotation.x = -Math.PI / 2; glow.position.y = .03; group.add(glow);
    } else {
      const points = stripPoints(appearance.segments);
      for (let i = 1; i < points.length; i++) {
        const start = points[i - 1], end = points[i], length = Math.hypot(end.x - start.x, end.y - start.y);
        const strip = new THREE.Mesh(new THREE.BoxGeometry(length, .035, .06), material);
        strip.position.set((start.x + end.x) / 2, elevation, (start.y + end.y) / 2);
        strip.rotation.y = -Math.atan2(end.y - start.y, end.x - start.x); group.add(strip);
        const glow = new THREE.Mesh(new THREE.BoxGeometry(length, .01, .4), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .24 * strength, depthWrite: false }));
        glow.position.set(strip.position.x, .03, strip.position.z); glow.rotation.y = strip.rotation.y; group.add(glow);
      }
    }
    return group;
  }
  const halo = new THREE.Mesh(new THREE.CircleGeometry(state.kind === "light" ? (appearance?.length ?? 2.8) / 2 : 1, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .24 * strength, depthWrite: false, side: THREE.DoubleSide }));
  halo.rotation.x = -Math.PI / 2; halo.position.y = .03; group.add(halo);
  if (state.kind === "light") {
    const light = new THREE.PointLight(color, 12 * strength, 6); light.position.y = elevation; group.add(light);
  } else {
    for (let i = 0; i < 3; i++) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(.3 + i * .18, .018, 6, 40), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .65 - i * .13 }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = .15 + i * .18;
      ring.scale.setScalar(state.temperature === undefined ? 1 : Math.max(.7, Math.min(1.3, 1 + (24 - state.temperature) * .04)));
      group.add(ring);
    }
  }
  return group;
}

function lightLevel(state: SpatialVisualState) {
  return state.online === false || state.on !== true ? 0 : Math.max(0, Math.min(1, state.brightness ?? 1));
}

export function interpolateVisualState(from: SpatialVisualState, to: SpatialVisualState, progress: number): SpatialVisualState {
  const amount = Math.max(0, Math.min(1, progress));
  if (to.kind === "light") {
    const level = lightLevel(from) + (lightLevel(to) - lightLevel(from)) * amount;
    return { ...to, on: level > .001, brightness: level };
  }
  if (to.kind === "curtain" && (from.position !== undefined || to.position !== undefined)) {
    const start = from.position ?? to.position!, end = to.position ?? start;
    return { ...to, position: start + (end - start) * amount };
  }
  return amount < 1 ? from : to;
}

function setCurtainPosition(group: THREE.Group, position: number) {
  const normalized = Math.max(0, Math.min(1, position));
  for (const child of group.children) {
    if (!(child instanceof THREE.Mesh) || typeof child.userData.curtainSide !== "number") continue;
    const side = child.userData.curtainSide as number, halfLength = child.userData.curtainHalfLength as number;
    const width = Math.max(.02, (1 - normalized) * halfLength);
    child.scale.x = width;
    child.position.x = side * (halfLength - width / 2);
  }
}

export function createTransitioningDeviceEffect(from: SpatialVisualState, to: SpatialVisualState, appearance?: SpatialPlacement["appearance"], elevation = 1.8) {
  if (to.kind === "curtain") {
    const start = from.position ?? to.position, end = to.position ?? from.position;
    if (start === undefined || end === undefined) return { group: new THREE.Group(), apply: (_progress: number) => undefined };
    const group = createDeviceEffect({ ...to, position: end }, appearance, elevation);
    return { group, apply(progress: number) { setCurtainPosition(group, start + (end - start) * Math.max(0, Math.min(1, progress))); } };
  }
  if (to.kind === "light") {
    const group = createDeviceEffect({ ...to, on: true, online: true, brightness: 1 }, appearance, elevation);
    const start = lightLevel(from), end = lightLevel(to);
    const materials: Array<{ material: THREE.Material & { opacity: number; transparent: boolean }; opacity: number }> = [];
    const lights: Array<{ light: THREE.Light; intensity: number }> = [];
    group.traverse(child => {
      if (child instanceof THREE.Mesh) for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
        material.transparent = true;
        materials.push({ material, opacity: material.opacity });
      }
      if (child instanceof THREE.Light) lights.push({ light: child, intensity: child.intensity });
    });
    return { group, apply(progress: number) {
      const amount = start + (end - start) * Math.max(0, Math.min(1, progress));
      for (const entry of materials) entry.material.opacity = entry.opacity * amount;
      for (const entry of lights) entry.light.intensity = entry.intensity * amount;
      group.visible = amount > .001;
    } };
  }
  const group = createDeviceEffect(to, appearance, elevation);
  return { group, apply: (_progress: number) => undefined };
}

export function disposeSpatialObject(object: THREE.Object3D) {
  object.traverse(child => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      for (const material of Array.isArray(child.material) ? child.material : [child.material]) material.dispose();
    }
  });
}
