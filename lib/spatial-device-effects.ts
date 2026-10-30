import { stripPoints } from "./spatial-appearance.ts";
import type { SpatialPlacement } from "./spatial-layout.ts";
import * as THREE from "three";

export type SpatialVisualState = {
  on: boolean | null;
  online?: boolean | null;
  kind: "light" | "climate" | "curtain" | "other";
  brightness?: number;
  colorTemperature?: number;
  temperature?: number;
  position?: number;
  currentPosition?: number;
  targetPosition?: number;
  positionIsTarget?: boolean;
  pending?: boolean;
};

export type LightFixture = "ceiling" | "pendant" | "spotlight" | "strip" | "panel";
export function resolveLightFixture(appearance?: SpatialPlacement["appearance"]): LightFixture {
  return appearance?.fixture ?? (appearance?.type === "strip" ? "strip" : appearance?.type === "area" ? "panel" : "ceiling");
}

export function lightColorForTemperature(kelvin = 3000) {
  const temperature = Math.max(1000, Math.min(40000, kelvin)) / 100;
  const red = temperature <= 66 ? 255 : 329.698727446 * ((temperature - 60) ** -.1332047592);
  const green = temperature <= 66
    ? 99.4708025861 * Math.log(temperature) - 161.1195681661
    : 288.1221695283 * ((temperature - 60) ** -.0755148492);
  const blue = temperature >= 66 ? 255 : temperature <= 19 ? 0 : 138.5177312231 * Math.log(temperature - 10) - 305.044792731;
  const channel = (value: number) => Math.max(0, Math.min(255, value)) / 255;
  return new THREE.Color().setRGB(channel(red), channel(green), channel(blue), THREE.SRGBColorSpace);
}

function lightStrength(strength: number) {
  return Math.pow(Math.max(0, Math.min(1, strength)), 1.15);
}

function lightMaterial(strength: number, color: THREE.Color) {
  const level = lightStrength(strength);
  const material = new THREE.MeshStandardMaterial({ color: color.clone().lerp(new THREE.Color(0xffffff), .55), emissive: color, emissiveIntensity: level * .7, roughness: .5 });
  material.userData.luminous = true;
  return material;
}

export function createLightFixture(appearance: SpatialPlacement["appearance"] | undefined, elevation: number, strength: number, colorTemperature?: number) {
  const group = new THREE.Group(), fixture = resolveLightFixture(appearance), length = appearance?.length ?? 1.2, width = appearance?.width ?? 1;
  const lightColor = lightColorForTemperature(colorTemperature), level = lightStrength(strength);
  const shell = new THREE.MeshStandardMaterial({ color: 0xf2f3f4, roughness: .72, metalness: .08 });
  const luminous = lightMaterial(strength, lightColor);
  if (fixture === "strip") {
    const points = stripPoints(appearance?.segments ?? [{ length, angle: 0 }]);
    for (let index = 1; index < points.length; index++) {
      const start = points[index - 1], end = points[index], segmentLength = Math.hypot(end.x - start.x, end.y - start.y);
      const strip = new THREE.Mesh(new THREE.BoxGeometry(segmentLength, .04, .07), luminous.clone());
      strip.material.userData.luminous = true; strip.position.set((start.x + end.x) / 2, elevation, (start.y + end.y) / 2); strip.rotation.y = -Math.atan2(end.y - start.y, end.x - start.x); group.add(strip);
      if (strength > 0) {
        const dx = (end.x - start.x) / segmentLength, dz = (end.y - start.y) / segmentLength;
        const light = new THREE.RectAreaLight(lightColor, 2 * level, segmentLength, .08); light.name = "strip-illumination";
        light.position.set((start.x + end.x) / 2, elevation - .045, (start.y + end.y) / 2);
        light.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(dx, 0, dz), new THREE.Vector3(dz, 0, -dx), new THREE.Vector3(0, 1, 0)));
        group.add(light);
      }
    }
  } else if (fixture === "panel") {
    const frame = new THREE.Mesh(new THREE.BoxGeometry(length + .06, .07, width + .06), shell); frame.position.y = elevation; group.add(frame);
    const face = new THREE.Mesh(new THREE.BoxGeometry(length, .025, width), luminous); face.position.y = elevation - .045; group.add(face);
  } else if (fixture === "pendant") {
    const cord = new THREE.Mesh(new THREE.CylinderGeometry(.012, .012, .55, 8), new THREE.MeshStandardMaterial({ color: 0x596574 })); cord.position.y = elevation + .275; group.add(cord);
    const shade = new THREE.Mesh(new THREE.ConeGeometry(Math.max(.14, length * .18), .28, 24, 1, true), shell); shade.position.y = elevation; shade.rotation.x = Math.PI; group.add(shade);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(.09, 16, 10), luminous); bulb.position.y = elevation - .08; group.add(bulb);
  } else if (fixture === "spotlight") {
    const radius = Math.max(.09, Math.min(.16, length * .09)), depth = Math.max(.2, Math.min(.34, length * .24));
    const mount = new THREE.Mesh(new THREE.CylinderGeometry(radius * .8, radius * .8, .08, 24), shell); mount.position.y = elevation + .08; group.add(mount);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(.025, .025, .09, 12), new THREE.MeshStandardMaterial({ color: 0x65717b, roughness: .55 })); stem.position.y = elevation; group.add(stem);
    const head = new THREE.Group(); head.name = "spotlight-head"; head.position.set(0, elevation - .11, 0); head.rotation.z = -Math.PI / 4;
    const body = new THREE.Mesh(new THREE.CylinderGeometry(radius * .78, radius, depth, 24), new THREE.MeshStandardMaterial({ color: 0x65717b, roughness: .5, metalness: .12 })); head.add(body);
    const lens = new THREE.Mesh(new THREE.CircleGeometry(radius * .72, 24), luminous); lens.position.y = -depth / 2 - .003; lens.rotation.x = Math.PI / 2; head.add(lens); group.add(head);
  } else {
    const body = new THREE.Mesh(new THREE.CylinderGeometry(Math.max(.16, length / 2), Math.max(.16, length / 2), .08, 32), shell); body.position.y = elevation; group.add(body);
    const diffuser = new THREE.Mesh(new THREE.CylinderGeometry(Math.max(.13, length / 2 - .035), Math.max(.13, length / 2 - .035), .025, 32), luminous); diffuser.position.y = elevation - .052; group.add(diffuser);
  }
  if (strength > 0 && fixture !== "strip") { const light = new THREE.PointLight(lightColor, 3.5 * level, 4.5); light.position.y = elevation - .08; group.add(light); }
  group.userData.fixture = fixture; group.userData.colorTemperature = colorTemperature;
  return group;
}

export function createDeviceEffect(state: SpatialVisualState, appearance?: SpatialPlacement["appearance"], elevation = 1.8) {
  const group = new THREE.Group();
  if (state.online === false) return group;
  if (state.kind === "light") return createLightFixture(appearance, elevation, state.on === true ? Math.max(0, Math.min(1, state.brightness ?? 1)) : 0, state.colorTemperature);
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
  if (state.on !== true || state.kind === "other") return group;
  const color = 0x79c9ed;
  {
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
    if (start === undefined || end === undefined) return { group: new THREE.Group(), apply(progress: number) { void progress; } };
    const group = createDeviceEffect({ ...to, position: end }, appearance, elevation);
    return { group, apply(progress: number) { setCurtainPosition(group, start + (end - start) * Math.max(0, Math.min(1, progress))); } };
  }
  if (to.kind === "light") {
    const group = createDeviceEffect({ ...to, on: true, online: true, brightness: 1 }, appearance, elevation);
    const start = lightLevel(from), end = lightLevel(to);
    const materials: Array<{ material: THREE.MeshStandardMaterial; intensity: number }> = [];
    const lights: Array<{ light: THREE.Light; intensity: number }> = [];
    group.traverse(child => {
      if (child instanceof THREE.Mesh) for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
        if (!material.userData.luminous) continue;
        if (material instanceof THREE.MeshStandardMaterial) materials.push({ material, intensity: material.emissiveIntensity });
      }
      if (child instanceof THREE.Light) lights.push({ light: child, intensity: child.intensity });
    });
    return { group, apply(progress: number) {
      const amount = start + (end - start) * Math.max(0, Math.min(1, progress));
      for (const entry of materials) entry.material.emissiveIntensity = entry.intensity * amount;
      for (const entry of lights) entry.light.intensity = entry.intensity * amount;
    } };
  }
  const group = createDeviceEffect(to, appearance, elevation);
  return { group, apply(progress: number) { void progress; } };
}

export function disposeSpatialObject(object: THREE.Object3D) {
  object.traverse(child => {
    for (const material of (child.userData.detachedMaterials ?? []) as THREE.Material[]) material.dispose();
    if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
      child.geometry.dispose();
      for (const material of Array.isArray(child.material) ? child.material : [child.material]) material.dispose();
    }
  });
}
