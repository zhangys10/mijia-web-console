"use client";

import { useEffect, useRef, useState } from "react";
import AiAssistantPanel from "./ai-assistant-panel";

type Props = {
  connected: boolean;
  loading: boolean;
  homeId: string;
  homeName: string;
  onOpenLogin: () => void;
  onMessage: (text: string) => void;
};

export default function AiAssistantButton({ connected, loading, homeId, homeName, onOpenLogin, onMessage }: Props) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const wasOpen = useRef(false);
  const hasHome = Boolean(homeId && homeId !== "demo");

  useEffect(() => {
    if (wasOpen.current && !open) buttonRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  function toggle() {
    if (loading) return;
    if (!connected) {
      onOpenLogin();
      return;
    }
    if (!hasHome) {
      onMessage("正在同步家庭信息，请稍候再打开 AI 助手");
      return;
    }
    setOpen(current => !current);
  }

  return (
    <>
      {open && connected && hasHome && (
        <AiAssistantPanel key={homeId} homeId={homeId} homeName={homeName} onClose={() => setOpen(false)} onOpenLogin={onOpenLogin} onMessage={onMessage} />
      )}
      <button
        ref={buttonRef}
        type="button"
        className={`ai-assistant-button${open ? " is-open" : ""}`}
        aria-label="AI 助手"
        aria-expanded={open}
        aria-controls="ai-assistant-panel"
        disabled={loading}
        onClick={toggle}
      >
        ✦
      </button>
    </>
  );
}
