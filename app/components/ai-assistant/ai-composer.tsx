"use client";

import { useEffect, useRef } from "react";

type Props = {
  value: string;
  sending: boolean;
  disabled: boolean;
  disabledReason?: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
};

const MAX_MESSAGE_LENGTH = 500;

export default function AiComposer({ value, sending, disabled, disabledReason, onChange, onSend, onStop }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 132)}px`;
  }, [value]);

  return (
    <div className="ai-composer">
      <div className="ai-composer-field">
        <textarea
          ref={textareaRef}
          value={value}
          rows={1}
          maxLength={MAX_MESSAGE_LENGTH}
          placeholder={disabled ? disabledReason ?? "暂时无法发送" : "向 AI 助手描述你想要的场景…"}
          aria-label="AI 助手消息输入"
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !sending && !disabled && value.trim()) {
              event.preventDefault();
              onSend();
            }
          }}
        />
        <small className="ai-composer-count" aria-live="off">{value.length}/{MAX_MESSAGE_LENGTH}</small>
      </div>
      <div className="ai-composer-actions">
        <button type="button" className="ai-composer-stop" onClick={onStop} disabled={!sending} aria-label="停止本轮请求">停止</button>
        <button
          type="button"
          className="ai-composer-send"
          onClick={onSend}
          disabled={sending || disabled || !value.trim()}
        >
          {sending ? "发送中…" : "发送"}
        </button>
      </div>
      {sending && <p className="ai-composer-stop-note">停止仅中断本轮请求，服务端可能仍在处理。</p>}
    </div>
  );
}
