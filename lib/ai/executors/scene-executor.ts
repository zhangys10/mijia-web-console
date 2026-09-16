import type { XiaomiSession } from "../../xiaomi-cloud.ts";
import { runManualScene, type XiaomiRequester } from "../../xiaomi-scenes.ts";
import type { AiCommandConfig } from "../config.ts";
import type { SceneExecutionResult } from "../types.ts";

export interface SceneExecutor {
  readonly kind: "mi_cloud" | "home_assistant";
  execute(sceneId: "home", requestId: string): Promise<SceneExecutionResult>;
}

type RunScene = (session: XiaomiSession, sceneId: string, request?: XiaomiRequester) => Promise<void>;

export class MiCloudSceneExecutor implements SceneExecutor {
  readonly kind = "mi_cloud" as const;
  private readonly session: XiaomiSession;
  private readonly config: AiCommandConfig;
  private readonly request: RunScene;

  constructor(
    session: XiaomiSession,
    config: AiCommandConfig,
    request: RunScene = runManualScene,
  ) {
    this.session = session;
    this.config = config;
    this.request = request;
  }

  async execute(sceneId: "home", requestId: string): Promise<SceneExecutionResult> {
    if (sceneId !== "home" || !this.config.homeId || !this.config.sceneId) {
      throw new Error("SCENE_NOT_CONFIGURED");
    }
    try {
      await this.request(this.session, this.config.sceneId, undefined);
      return {
        status: "success",
        succeeded: 1,
        failed: 0,
        message: "欢迎回来，已经开启回家模式。",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "MI_CLOUD_ERROR";
      if (message.includes("TIMEOUT") || message.includes("timeout")) throw new Error("DEVICE_TIMEOUT");
      throw new Error("MI_CLOUD_ERROR");
    } finally {
      void requestId;
    }
  }
}
