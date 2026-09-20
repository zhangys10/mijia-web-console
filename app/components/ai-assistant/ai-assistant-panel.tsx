"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import AiComposer from "./ai-composer";
import AiMessageList, { type AssistantMessage } from "./ai-message-list";

type AssistantQuota = {
  mode: "default" | "override" | "unlimited" | "disabled";
  remainingRequestsToday: number | null;
  remainingTokensThisMonth: number | null;
  resetAt: string | null;
};

type AssistantHomeStatus = {
  capturedAt: string;
  completeness: "complete" | "partial" | "empty";
  groups: Array<{
    metric: "temperature" | "humidity" | "co2" | "formaldehyde" | "pm25" | "pm10" | "tvoc" | "pressure" | "battery";
    label: string;
    unit: string;
    latest: { value: number; unit: string; sourceLabel: string; roomName: string | null } | null;
    readings: Array<{ value: number; unit: string; sourceLabel: string; roomName: string | null }>;
  }>;
  warnings: string[];
};

type ChatResponse = {
  requestId: string;
  conversationId: string;
  message: string;
  intent: "none" | "list_scenes" | "get_home_status" | "activate_scene";
  tool?: { name: "list_scenes" | "get_home_status" | "activate_scene"; status: "success" | "partial_success"; sceneName?: string };
  scenes?: Array<{ name: string; description: string; actionCount: number }>;
  homeStatus?: AssistantHomeStatus;
  quota: AssistantQuota;
};

type PanelError = {
  text: string;
  retry: boolean;
  login: boolean;
};

type Props = {
  homeId: string;
  homeName: string;
  onClose: () => void;
  onOpenLogin: () => void;
  onMessage: (text: string) => void;
};

const SUGGESTIONS = ["查看可用场景", "家里环境怎么样", "我回家了"];

function assistantErrorText(code: string, fallback: string) {
  switch (code) {
    case "AI_UNAUTHENTICATED": return "登录状态已失效，请重新扫码登录";
    case "AI_INVALID_REQUEST": return "请求无效，请调整输入后重试";
    case "AI_HOME_FORBIDDEN": return "当前账号无权访问所选家庭";
    case "AI_SCENE_EXECUTION_DISABLED": return "场景执行尚未开放，AI 助手目前仅支持查询场景";
    case "AI_PREVIEW_READ_ONLY": return "预览模式为只读，不会控制真实设备";
    case "AI_QUOTA_STORE_UNAVAILABLE": return "配额服务暂时不可用，请稍后重试";
    case "AI_QUOTA_CONFIG_INVALID": return "配额配置无效，请联系管理员";
    case "AI_AGENT_CANCELLED": return "本轮请求已被取消";
    case "AI_AGENT_UNAVAILABLE": return "AI 助手暂时不可用，请稍后重试";
    default: return fallback || "请求失败，请稍后重试";
  }
}

function waitLabel(milliseconds: number) {
  if (milliseconds <= 0) return "即将恢复";
  const minutes = Math.ceil(milliseconds / 60000);
  if (minutes < 60) return `约 ${minutes} 分钟后恢复`;
  return `约 ${Math.ceil(minutes / 60)} 小时后恢复`;
}

function quotaFooterText(quota: AssistantQuota | null) {
  if (!quota) return "配额信息不可用";
  if (quota.mode === "disabled") return "配额已停用/不可用";
  if (quota.mode === "unlimited") return "配额不限";
  return `今日剩余 ${quota.remainingRequestsToday ?? "—"} 次 · 本月剩余 ${quota.remainingTokensThisMonth ?? "—"} tokens`;
}

function errorFields(data: unknown) {
  if (!data || typeof data !== "object") return { code: "", message: "", payload: null as Record<string, unknown> | null };
  const record = data as Record<string, unknown>;
  return {
    code: typeof record.code === "string" ? record.code : "",
    message: typeof record.message === "string" ? record.message : "",
    payload: record,
  };
}

export default function AiAssistantPanel({ homeId, homeName, onClose, onOpenLogin, onMessage }: Props) {
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [quota, setQuota] = useState<AssistantQuota | null>(null);
  const [error, setError] = useState<PanelError | null>(null);
  const [failedText, setFailedText] = useState<string | null>(null);
  const [retryAfterAt, setRetryAfterAt] = useState<number | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    panelRef.current?.focus();
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/ai/quota");
        const data = await response.json().catch(() => null);
        if (!response.ok || !data || typeof data !== "object" || !(data as Record<string, unknown>).quota) throw new Error("quota unavailable");
        if (!cancelled) setQuota((data as { quota: AssistantQuota }).quota);
      } catch {
        if (!cancelled) setQuota(null);
      }
    })();
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (retryAfterAt === undefined) return;
    const timer = window.setTimeout(() => setRetryAfterAt(undefined), Math.max(0, retryAfterAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [retryAfterAt]);

  const send = useCallback(async (text: string) => {
    const message = text.trim();
    if (!message || sending || resetting || !homeId) return;
    setError(null);
    setFailedText(null);
    setMessages(list => [...list, { role: "user", text: message }]);
    setInput("");
    setSending(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId,
          homeId,
          message,
          idempotencyKey: crypto.randomUUID(),
        }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || typeof data !== "object") {
        const { code, message: fallback, payload } = errorFields(data);
        throw Object.assign(new Error(code || fallback || "AI_AGENT_UNAVAILABLE"), { payload });
      }
      const result = data as ChatResponse;
      if (typeof result.conversationId !== "string" || typeof result.message !== "string" || !result.quota) {
        throw Object.assign(new Error("AI_AGENT_UNAVAILABLE"), { payload: null });
      }
      setConversationId(result.conversationId);
      setQuota(result.quota);
      setMessages(list => [...list, {
        role: "assistant",
        text: result.message,
        tool: result.tool,
        scenes: result.scenes && result.scenes.length > 0 ? result.scenes : undefined,
        homeStatus: result.homeStatus,
      }]);
    } catch (caught) {
      setMessages(list => {
        const last = list[list.length - 1];
        return last && last.role === "user" && last.text === message ? list.slice(0, -1) : list;
      });
      if (caught instanceof DOMException && caught.name === "AbortError") {
        setError({ text: "已停止本轮请求。服务端可能仍在处理，请勿立即重发同一指令。", retry: false, login: false });
        setFailedText(null);
        return;
      }
      const payload = (caught as { payload?: Record<string, unknown> | null }).payload;
      const code = typeof payload?.code === "string" ? payload.code : "";
      const fallback = typeof payload?.message === "string" ? payload.message : "";
      if (code === "AI_QUOTA_EXCEEDED" || code === "AI_GATEWAY_RATE_LIMITED") {
        const retryAfter = payload?.quota && typeof payload.quota === "object" && typeof (payload.quota as Record<string, unknown>).retryAfter === "string"
          ? (payload.quota as Record<string, unknown>).retryAfter as string
          : undefined;
        const retryAfterSeconds = typeof payload?.retryAfterSeconds === "number" ? payload.retryAfterSeconds : undefined;
        let waitText = "稍后恢复";
        if (typeof retryAfterSeconds === "number" && retryAfterSeconds > 0) {
          setRetryAfterAt(Date.now() + retryAfterSeconds * 1000);
          waitText = waitLabel(retryAfterSeconds * 1000);
        } else if (retryAfter) {
          const at = Date.parse(retryAfter);
          if (Number.isFinite(at)) {
            setRetryAfterAt(at);
            waitText = waitLabel(at - Date.now());
          }
        }
        setError({
          text: code === "AI_QUOTA_EXCEEDED" ? `当前 AI 助手额度已用完，${waitText}。恢复前不会自动重试。` : `请求过于频繁，${waitText}。恢复前不会自动重试。`,
          retry: true,
          login: false,
        });
        setFailedText(message);
        return;
      }
      setError({ text: assistantErrorText(code, fallback), retry: code !== "AI_UNAUTHENTICATED", login: code === "AI_UNAUTHENTICATED" });
      setFailedText(message);
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  }, [conversationId, homeId, resetting, sending]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const startNewConversation = useCallback(async () => {
    if (sending || resetting || !homeId) return;
    setResetting(true);
    setError(null);
    setFailedText(null);
    try {
      if (conversationId) {
        try {
          await deleteConversation(conversationId);
        } catch {
          onMessage("旧会话清理失败，已直接开启新会话");
        }
      }
      const response = await fetch("/api/ai/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ homeId }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || typeof (data as Record<string, unknown>).conversationId !== "string") {
        const { code, message: fallback } = errorFields(data);
        throw new Error(assistantErrorText(code, fallback));
      }
      setConversationId((data as { conversationId: string }).conversationId);
      setMessages([]);
      setInput("");
    } catch (caught) {
      setError({ text: caught instanceof Error ? caught.message : "新会话创建失败，请稍后重试", retry: true, login: false });
    } finally {
      setResetting(false);
    }
  }, [conversationId, homeId, onMessage, resetting, sending]);

  const clearConversation = useCallback(async () => {
    if (sending || resetting || !conversationId) return;
    setResetting(true);
    setError(null);
    try {
      await deleteConversation(conversationId);
      setMessages(list => [...list, { role: "system", text: "已清除会话记忆。之后的对话不会记得之前的内容；仅清除对话记忆，不影响设备与场景。" }]);
    } catch (caught) {
      setError({ text: caught instanceof Error ? caught.message : "清除会话失败，请稍后重试", retry: true, login: false });
    } finally {
      setResetting(false);
    }
  }, [conversationId, resetting, sending]);

  const empty = messages.length === 0;

  return (
    <section
      ref={panelRef}
      tabIndex={-1}
      id="ai-assistant-panel"
      className="ai-assistant-panel"
      role="dialog"
      aria-modal="true"
      aria-label="AI 助手对话"
    >
      <header className="ai-assistant-header">
        <div className="ai-assistant-title">
          <span aria-hidden="true">✦</span>
          <div>
            <strong>AI 助手</strong>
            <small>{homeName || "当前家庭"}</small>
          </div>
        </div>
        <div className="ai-assistant-header-actions">
          <button type="button" onClick={() => void startNewConversation()} disabled={sending || resetting}>
            {resetting ? "处理中…" : "＋ 新会话"}
          </button>
          {conversationId && <button type="button" onClick={() => void clearConversation()} disabled={sending || resetting}>清除会话</button>}
          <button type="button" className="ai-assistant-close" onClick={onClose} aria-label="关闭 AI 助手">×</button>
        </div>
      </header>
      {empty ? (
        <div className="ai-assistant-intro">
          <p>可以让我查看当前家庭的场景，或描述你想要的家居状态。</p>
          <div className="ai-assistant-suggestions">
            {SUGGESTIONS.map(suggestion => (
              <button key={suggestion} type="button" onClick={() => void send(suggestion)} disabled={sending || resetting}>{suggestion}</button>
            ))}
          </div>
        </div>
      ) : (
        <AiMessageList messages={messages} sending={sending} />
      )}
      {error && (
        <div className="ai-assistant-error" role="alert">
          <span>{error.text}</span>
          <div className="ai-assistant-error-actions">
            {error.login && <button type="button" onClick={onOpenLogin}>重新登录</button>}
            {error.retry && failedText && (
              <button
                type="button"
                onClick={() => void send(failedText)}
                disabled={sending || resetting || retryAfterAt !== undefined}
              >
                重试
              </button>
            )}
          </div>
        </div>
      )}
      <AiComposer
        value={input}
        sending={sending}
        disabled={resetting}
        onChange={setInput}
        onSend={() => void send(input)}
        onStop={stop}
      />
      <footer className="ai-assistant-quota" aria-label="AI 配额信息">{quotaFooterText(quota)}</footer>
    </section>
  );
}

async function deleteConversation(conversationId: string) {
  const response = await fetch(`/api/ai/conversations/${encodeURIComponent(conversationId)}`, { method: "DELETE" });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || typeof data !== "object" || (data as Record<string, unknown>).deleted !== true) {
    const { code, message } = errorFields(data);
    throw new Error(assistantErrorText(code, message));
  }
}
