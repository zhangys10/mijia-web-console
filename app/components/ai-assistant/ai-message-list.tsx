"use client";

import { useEffect, useRef } from "react";

export type AssistantSceneSummary = {
  name: string;
  description: string;
  actionCount: number;
};

export type AssistantToolResult = {
  name: "list_scenes" | "activate_scene";
  status: "success" | "partial_success";
  sceneName?: string;
};

export type AssistantMessage = {
  role: "user" | "assistant" | "system";
  text: string;
  tool?: AssistantToolResult;
  scenes?: AssistantSceneSummary[];
};

const toolStatusLabel: Record<string, string> = {
  success: "成功",
  partial_success: "部分成功",
};

function toolSummary(tool: AssistantToolResult) {
  if (tool.name === "list_scenes") return `已查询场景列表 · ${toolStatusLabel[tool.status] ?? tool.status}`;
  const sceneName = tool.sceneName ?? "未命名场景";
  return `已执行场景「${sceneName}」 · ${toolStatusLabel[tool.status] ?? tool.status}`;
}

export default function AiMessageList({ messages, sending }: { messages: AssistantMessage[]; sending: boolean }) {
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, sending]);

  return (
    <div className="ai-message-list" aria-live="polite">
      {messages.map((message, index) =>
        message.role === "system" ? (
          <p key={index} className="ai-message-system">{message.text}</p>
        ) : (
          <div key={index} className={`ai-message ${message.role}`}>
            <div className="ai-message-bubble">
              <p>{message.text}</p>
              {message.tool && <span className="ai-message-tool">⌁ {toolSummary(message.tool)}</span>}
              {message.scenes && message.scenes.length > 0 && (
                <div className="ai-message-scenes">
                  {message.scenes.map((scene) => (
                    <div key={scene.name} className="ai-message-scene">
                      <strong>{scene.name}</strong>
                      <small>{scene.description || "暂无描述"}</small>
                      <span>{scene.actionCount} 个动作</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ),
      )}
      {sending && (
        <div className="ai-message assistant">
          <div className="ai-message-bubble ai-message-pending"><span />正在思考…</div>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
