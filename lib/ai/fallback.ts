export type FallbackScene = { id: string; name: string; enabled?: boolean };

const fallbackPhrases = [
  "我回家了",
  "我到家了",
  "我回来了",
  "开启回家模式",
  "打开回家模式",
  "回家",
  "到家",
  "进门",
];

export const forbiddenMarkers = /不|别|没|未|如果|假如|假设|是否|吗|呢|什么|怎么|为什么|教程|密码|他说|她说|转述|刚才说|问到|听说/;

function normalize(text: string) {
  return text.trim().replace(/\s+/g, "");
}

export function findFallbackScene(text: string, scenes: readonly FallbackScene[]): FallbackScene | undefined {
  const normalized = normalize(text);
  if (!normalized || forbiddenMarkers.test(normalized)) return undefined;
  if (!fallbackPhrases.some(phrase => phrase === normalized || normalized.includes(phrase))) return undefined;
  return scenes.find(scene => scene.enabled !== false && fallbackPhrases.some(phrase => scene.name.includes(phrase)));
}

/**
 * 当 LLM 未触发 tool_call（返回 no_action），但在回复文本中声称执行了场景（例如“已经打开明亮模式”），
 * 或者用户的输入明确指明要执行某个具体场景（例如“打开明亮模式”、“明亮模式”）且无否定/条件/疑问词时，
 * 服务端兜底补全工具调用，避免用户听到“已经打开”而实际设备未执行（intent 仍为 none）的假执行漏洞。
 */
export function recoverIntentFromTextOrLlmOutput(
  userText: string,
  llmOutput: string | undefined,
  scenes: readonly FallbackScene[],
): { scene: FallbackScene; replyMessage: string } | undefined {
  const normUser = normalize(userText);
  if (!normUser || forbiddenMarkers.test(normUser)) return undefined;

  const normLlm = llmOutput ? normalize(llmOutput) : "";
  const claimExecutionPattern = /(已(经)?|好[的，, ]*已(经)?)(为?您?)?(打开|开启|启动|切换|执行)/;
  const isLlmClaimingExecution = claimExecutionPattern.test(normLlm);

  for (const scene of scenes) {
    if (scene.enabled === false || !scene.name) continue;
    const sceneNameNorm = normalize(scene.name);
    if (!sceneNameNorm) continue;

    // 情况 1: LLM 回复在声称已经执行，且文本中包含了场景名称
    if (isLlmClaimingExecution && (normLlm.includes(sceneNameNorm) || normUser.includes(sceneNameNorm))) {
      const isHome = /回家|到家|进门/.test(scene.name);
      return {
        scene,
        replyMessage: isHome ? "欢迎回家，已经开启回家模式。" : `已经开启「${scene.name}」。`,
      };
    }

    // 情况 2: 用户输入直接指明要执行该场景（例如“打开明亮模式”、“开启明亮模式”或直接说“明亮模式”）
    const isDirectMatch = normUser === sceneNameNorm ||
      normUser === `打开${sceneNameNorm}` ||
      normUser === `开启${sceneNameNorm}` ||
      normUser === `切换到${sceneNameNorm}` ||
      normUser === `执行${sceneNameNorm}` ||
      normUser === `启动${sceneNameNorm}` ||
      normUser === `运行${sceneNameNorm}` ||
      normUser === `帮我开${sceneNameNorm}` ||
      normUser === `帮我打开${sceneNameNorm}` ||
      normUser === `开一下${sceneNameNorm}`;

    if (isDirectMatch) {
      const isHome = /回家|到家|进门/.test(scene.name);
      return {
        scene,
        replyMessage: isHome ? "欢迎回家，已经开启回家模式。" : `已经开启「${scene.name}」。`,
      };
    }
  }

  return undefined;
}
