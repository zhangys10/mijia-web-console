import type { SceneExecutor } from "../executors/scene-executor.ts";
import { type AllowedScene } from "./catalog.ts";

export class SceneService {
  private readonly executor: SceneExecutor;
  private readonly scenes: AllowedScene[];

  constructor(executor: SceneExecutor, scenes: AllowedScene[]) {
    this.executor = executor;
    this.scenes = scenes;
  }

  activate(sceneId: string, requestId: string) {
    const scene = this.scenes.find(entry => entry.id === sceneId && entry.enabledForAi);
    if (!scene) return Promise.resolve({
      status: "success" as const,
      succeeded: 0,
      failed: 0,
      message: "场景不支持",
    });
    return this.executor.execute(scene.id, requestId);
  }
}
