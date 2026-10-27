import * as THREE from "three";
import type { SpatialPoint } from "./spatial-layout.ts";

export const furnitureCatalog = {
  "king-bed": { name: "双人大床", width: 2, depth: 2.1, height: .6 },
  wardrobe: { name: "衣柜", width: 2, depth: .6, height: 2.4 },
  wallboard: { name: "墙板", width: 1.2, depth: .08, height: 2.4 },
  sofa: { name: "沙发", width: 2.2, depth: .9, height: .8 },
  table: { name: "桌子", width: 1.4, depth: .8, height: .75 },
};
export type FurnitureKind = keyof typeof furnitureCatalog;
export type SpatialFurniture = { id: string; kind: FurnitureKind; point: SpatialPoint; width: number; depth: number; height: number; rotation: number };

export function createFurniture(item: SpatialFurniture) {
  const group = new THREE.Group(); group.name = `furniture:${item.id}`;
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, color: number) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color, roughness: .9 }));
    mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh);
  };
  const { width: w, depth: d, height: h } = item;
  if (item.kind === "king-bed") {
    box(w, h * .45, d, 0, h * .225, 0, 0x9b8065);
    box(w * .98, h * .55, d * .96, 0, h * .725, 0, 0xe4e8ed);
    for (const side of [-1, 1]) box(w * .36, h * .15, d * .22, side * w * .24, h * 1.075, -d * .31, 0xfafafa);
  } else if (item.kind === "sofa") {
    box(w, h * .55, d, 0, h * .275, 0, 0xa2b1b9);
    box(w, h * .45, d * .2, 0, h * .775, -d * .4, 0x899ca8);
    for (const side of [-1, 1]) box(w * .09, h * .3, d, side * w * .455, h * .7, 0, 0x899ca8);
  } else if (item.kind === "table") {
    box(w, h * .1, d, 0, h * .95, 0, 0xc5aa89);
    for (const x of [-1, 1]) for (const z of [-1, 1]) box(w * .06, h * .9, d * .08, x * w * .43, h * .45, z * d * .4, 0x7d6a55);
  } else if (item.kind === "wardrobe") {
    box(w, h, d, 0, h / 2, 0, 0xb7a38b);
    for (const side of [-1, 1]) {
      box(w * .48, h * .96, .025, side * w * .25, h / 2, d / 2, 0xd2c3b0);
      box(.025, h * .12, .03, side * w * .055, h * .5, d / 2 + .025, 0x596574);
    }
  } else box(w, h, d, 0, h / 2, 0, 0xd2c3b0);
  group.rotation.y = -item.rotation * Math.PI / 180;
  return group;
}
