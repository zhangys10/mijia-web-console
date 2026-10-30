import type { ManualScene } from "./xiaomi-scenes.ts";

export function sceneGlyph(scene: Pick<ManualScene, "icon">) {
  return scene.icon && scene.icon.length <= 2 ? scene.icon : "✦";
}
