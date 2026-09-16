import { seal, unseal, type XiaomiQrState, type XiaomiSession } from "../../xiaomi-cloud.ts";
import type { ChatMessage } from "../types.ts";

export type ConversationTurn = ChatMessage & { timestamp: number };

export type ConversationSession = {
  version: 1;
  kind: "conversation_context";
  conversationId: string;
  userId?: string;
  homeId?: string;
  turns: ConversationTurn[];
  updatedAt: number;
};

/** 默认最多保留 5 轮交互（5 条 user + 5 条 assistant = 10 turns）。 */
export const DEFAULT_MAX_CONVERSATION_ROUNDS = 5;
/** 单条历史文本上限，超出部分截断，避免上下文被用于放大 Token 消耗。 */
export const MAX_CONVERSATION_CONTENT_LENGTH = 300;
/** 请求体 history 允许的最大条目数；超过即判定为畸形请求。 */
export const MAX_HISTORY_MESSAGES = 32;
/** 上下文密封令牌有效期。 */
export const CONVERSATION_TTL_MS = 600_000;

export function isChatRole(value: unknown): value is ChatMessage["role"] {
  return value === "user" || value === "assistant";
}

function sanitizeContent(value: string) {
  return value.trim().slice(0, MAX_CONVERSATION_CONTENT_LENGTH);
}

/**
 * 校验并归一化客户端显式传入的 history。
 * - `undefined`：未提供；
 * - `null`：结构畸形，调用方应返回 400；
 * - 数组：已裁剪的合法历史。
 */
export function normalizeHistory(value: unknown, maxRounds = DEFAULT_MAX_CONVERSATION_ROUNDS): ChatMessage[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_HISTORY_MESSAGES) return null;
  const messages: ChatMessage[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const { role, content } = item as Record<string, unknown>;
    if (!isChatRole(role) || typeof content !== "string") return null;
    const sanitized = sanitizeContent(content);
    if (!sanitized) return null;
    messages.push({ role, content: sanitized });
  }
  return messages.slice(-(maxRounds * 2));
}

/**
 * 评估当前对话状态，判断是否达到或超过轮数上限需要重置会话。
 * 一轮（round）定义为 1 条 user 提问 + 1 条 assistant 回复。
 */
export function evaluateConversationState(
  priorTurns: readonly ConversationTurn[],
  maxRounds = DEFAULT_MAX_CONVERSATION_ROUNDS,
): { isReset: boolean; effectivePriorTurns: ConversationTurn[]; currentTurnIndex: number } {
  const priorCompletedRounds = Math.floor(priorTurns.length / 2);
  if (priorCompletedRounds >= maxRounds) {
    // 达到或超过最大轮数，强制开启新会话
    return {
      isReset: true,
      effectivePriorTurns: [],
      currentTurnIndex: 1,
    };
  }
  return {
    isReset: false,
    effectivePriorTurns: [...priorTurns],
    currentTurnIndex: priorCompletedRounds + 1,
  };
}

/**
 * 将最近若干轮对话密封为不透明上下文令牌，供 Siri 快捷指令在下一轮原样带回。
 * 未配置 XIAOMI_SESSION_SECRET 等密封条件时返回 undefined，由调用方降级为明文 history。
 */
export async function sealConversationContext(
  conversationId: string,
  turns: ConversationTurn[],
  userId?: string,
  homeId?: string,
  maxRounds = DEFAULT_MAX_CONVERSATION_ROUNDS,
): Promise<string | undefined> {
  const maxTurns = maxRounds * 2;
  const sanitizedTurns = turns
    .filter(turn => isChatRole(turn.role) && typeof turn.content === "string" && sanitizeContent(turn.content))
    .slice(-maxTurns)
    .map(turn => ({
      role: turn.role,
      content: sanitizeContent(turn.content),
      timestamp: typeof turn.timestamp === "number" ? turn.timestamp : Date.now(),
    }));

  const payload: ConversationSession = {
    version: 1,
    kind: "conversation_context",
    conversationId,
    userId,
    homeId,
    turns: sanitizedTurns,
    updatedAt: Date.now(),
  };

  try {
    return await seal(payload as unknown as XiaomiSession);
  } catch (error) {
    console.warn("[ai-conversation] Failed to seal conversation context:", error instanceof Error ? error.message : error);
    return undefined;
  }
}

/** 解封上下文令牌；过期、被篡改或结构不合法时返回 null。 */
export async function unsealConversationContext(
  token: string,
  maxRounds = DEFAULT_MAX_CONVERSATION_ROUNDS,
): Promise<ConversationSession | null> {
  try {
    const data = await unseal<XiaomiSession | XiaomiQrState>(token);
    if (typeof data !== "object" || data === null) return null;
    const payload = data as Partial<ConversationSession>;
    if (
      payload.kind !== "conversation_context" ||
      payload.version !== 1 ||
      typeof payload.conversationId !== "string" ||
      !Array.isArray(payload.turns) ||
      typeof payload.updatedAt !== "number"
    ) {
      return null;
    }
    if (Date.now() - payload.updatedAt > CONVERSATION_TTL_MS) return null;

    const maxTurns = maxRounds * 2;
    const turns: ConversationTurn[] = [];
    for (const turn of payload.turns.slice(-maxTurns)) {
      if (typeof turn !== "object" || turn === null) return null;
      const { role, content, timestamp } = turn as Record<string, unknown>;
      if (!isChatRole(role) || typeof content !== "string") return null;
      const sanitized = sanitizeContent(content);
      if (!sanitized) continue;
      turns.push({
        role,
        content: sanitized,
        timestamp: typeof timestamp === "number" ? timestamp : payload.updatedAt,
      });
    }

    return {
      version: 1,
      kind: "conversation_context",
      conversationId: payload.conversationId,
      userId: typeof payload.userId === "string" ? payload.userId : undefined,
      homeId: typeof payload.homeId === "string" ? payload.homeId : undefined,
      turns,
      updatedAt: payload.updatedAt,
    };
  } catch {
    return null;
  }
}

/** 追加本轮问答并限制窗口长度，得到下一轮要密封的上下文。 */
export function appendConversationTurns(
  priorTurns: readonly ConversationTurn[],
  userText: string,
  assistantText: string,
  maxRounds = DEFAULT_MAX_CONVERSATION_ROUNDS,
  timestamp = Date.now(),
): ConversationTurn[] {
  const maxTurns = maxRounds * 2;
  const userContent = sanitizeContent(userText);
  const assistantContent = sanitizeContent(assistantText);
  const appended: ConversationTurn[] = [];
  if (userContent) appended.push({ role: "user", content: userContent, timestamp });
  if (assistantContent) appended.push({ role: "assistant", content: assistantContent, timestamp });
  return [...priorTurns, ...appended].slice(-maxTurns);
}

/** 去掉时间戳，得到可发送给模型的对话消息。 */
export function toChatMessages(turns: readonly ConversationTurn[]): ChatMessage[] {
  return turns.map(turn => ({ role: turn.role, content: turn.content }));
}
