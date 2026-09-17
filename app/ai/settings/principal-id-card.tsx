"use client";

import { useEffect, useState } from "react";

type PrincipalState =
  | { status: "loading" }
  | { status: "unauthenticated" }
  | { status: "error" }
  | { status: "ready"; principalId: string };

export default function PrincipalIdCard() {
  const [state, setState] = useState<PrincipalState>({ status: "loading" });
  const [copyFeedback, setCopyFeedback] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/ai/principal", { cache: "no-store" });
        if (res.status === 401) {
          if (!cancelled) setState({ status: "unauthenticated" });
          return;
        }
        if (!res.ok) {
          if (!cancelled) setState({ status: "error" });
          return;
        }
        const data = await res.json();
        if (!cancelled && typeof data.principalId === "string" && data.principalId.startsWith("usr_")) {
          setState({ status: "ready", principalId: data.principalId });
          return;
        }
        if (!cancelled) setState({ status: "error" });
      } catch {
        if (!cancelled) setState({ status: "error" });
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleCopy() {
    if (state.status !== "ready") return;
    try {
      await navigator.clipboard.writeText(state.principalId);
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 3000);
    } catch {
      setCopyFeedback(false);
    }
  }

  return (
    <section className="ai-card" aria-live="polite">
      <div className="ai-status-row">
        <div>
          <div className="ai-chip">可信身份</div>
          <h2 style={{ marginTop: "10px" }}>我的 AI Principal</h2>
          <p>
            principalId 只由服务端登录态派生，用于 AI 配额与用量记录。它不包含小米账号原始 ID，轮换
            AI_PRINCIPAL_SECRET 后会重新生成。
          </p>
        </div>
      </div>

      {state.status === "loading" && (
        <p style={{ marginTop: "12px" }}>正在读取身份标识…</p>
      )}

      {state.status === "unauthenticated" && (
        <p style={{ marginTop: "12px" }}>登录米家账号后显示你的 principalId。</p>
      )}

      {state.status === "error" && (
        <p style={{ marginTop: "12px" }}>暂时无法读取身份标识，请稍后重试。</p>
      )}

      {state.status === "ready" && (
        <div className="ai-token" style={{ marginTop: "12px" }}>
          <output className="ai-token-output" style={{ minHeight: "auto", padding: "11px 12px" }}>
            {state.principalId}
          </output>
          <div className="ai-action-row">
            <button type="button" className="ai-button-secondary" onClick={handleCopy}>
              {copyFeedback ? "已复制" : "复制 principalId"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
