import type { SceneExecutor } from "../executors/scene-executor.ts";
import { allowedScenes, type AllowedScene } from "./catalog.ts";

export class SceneService {
  private readonly executor: SceneExecutor;

  constructor(executor: SceneExecutor) {
    this.executor = executor;
  }

  activate(sceneId: "home", requestId: string) {
    const scene = allowedScenes.find(entry => entry.id === sceneId && entry.enabledForAi);
    if (!scene) return Promise.resolve({
      status: "success" as const,
      succeeded: 0,
      failed: 0,
      message: "场景不支持",
    });
    return this.executor.execute(scene.id, requestId);
  }

  public static catalog(): AllowedScene[] {
    return allowedScenes;
  }
}
