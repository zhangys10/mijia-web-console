import type { XiaomiSession } from "../../xiaomi-cloud.ts";
import { runManualScene, type XiaomiRequester } from "../../xiaomi-scenes.ts";
import type { AiCommandConfig } from "../config.ts";
import type { SceneExecutionResult } from "../types.ts";

export interface SceneExecutor {
  readonly kind: "mi_cloud" | "home_assistant";
  execute(sceneId: string, requestId: string): Promise<SceneExecutionResult>;
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

  async execute(sceneId: string, requestId: string): Promise<SceneExecutionResult> {
    const targetSceneId = sceneId || this.config.sceneId;
    if (!this.config.homeId || !targetSceneId) {
      throw new Error("SCENE_NOT_CONFIGURED");
    }
    try {
      await this.request(this.session, targetSceneId, undefined);
      return {
        status: "success",
        succeeded: 1,
        failed: 0,
        message: "欢迎回来，已经开启回家模式。",
      };
    } catch (error) {
      console.error("MiCloudSceneExecutor Run Failed for sceneId:", targetSceneId, error instanceof Error ? error.message : error);
      const rawMessage = error instanceof Error ? error.message : "MI_CLOUD_ERROR";
      if (rawMessage.includes("TIMEOUT") || rawMessage.includes("timeout")) {
        throw new Error("DEVICE_TIMEOUT");
      }
      throw error instanceof Error ? error : new Error("MI_CLOUD_ERROR");
    } finally {
      void requestId;
    }
  }
}
