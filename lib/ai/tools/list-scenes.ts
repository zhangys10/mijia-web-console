import type { AgentSceneRecord, AgentSceneSummary } from "./agent-scene-catalog.ts";
import { sceneSummaries } from "./agent-scene-catalog.ts";

export function listScenes(scenes: readonly AgentSceneRecord[]): {
  scenes: AgentSceneSummary[];
} {
  return { scenes: sceneSummaries(scenes) };
}
