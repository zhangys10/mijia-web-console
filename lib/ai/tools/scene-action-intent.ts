import type { AgentSceneRecord } from "./agent-scene-catalog.ts";

/** Only an exact, present-tense command can receive a scene action grant. */
export function matchSceneActionIntent(message: string, scenes: readonly AgentSceneRecord[]) {
  const text = message.trim();
  const match = /^(?:执行|运行|启动)\s*(.+?)[!！。.]?$/u.exec(text)
    ?? /^(?:run|activate|execute)\s+(.+?)[!.]?$/iu.exec(text);
  if (!match) return null;
  const requested = match[1].trim().toLocaleLowerCase();
  if (!requested || /[“”"'‘’?？]/u.test(requested)) return null;
  const matches = scenes.filter(scene => scene.enabled && scene.name.trim().toLocaleLowerCase() === requested);
  return matches.length === 1 ? matches[0] : null;
}
