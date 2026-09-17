"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type ProviderOption = {
  id: string;
  name: string;
  defaultModel: string;
  allowedModels: string[];
};

type IssuedTokenResult = {
  token: string;
  provider: string;
  model: string;
  expiresAt: number;
  homeId?: string | null;
};

type HomeOption = {
  id: string;
  name: string;
};

export default function AutomationTokenForm({
  initialHomes,
  selectedHomeId,
  selectedHomeName,
  onOpenLogin,
}: {
  initialHomes?: HomeOption[];
  selectedHomeId?: string;
  selectedHomeName?: string;
  onOpenLogin?: () => void;
} = {}) {
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [homes, setHomes] = useState<HomeOption[]>(initialHomes ?? []);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [authenticated, setAuthenticated] = useState(true);

  const [provider, setProvider] = useState("qwen-cn");
  const [model, setModel] = useState("qwen3.7-flash-2026-07-15");
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [expiresInDays, setExpiresInDays] = useState(30);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [issuedResult, setIssuedResult] = useState<IssuedTokenResult | null>(null);

  useEffect(() => {
    async function init() {
      try {
        const [tokenInfoRes, statusRes] = await Promise.all([
          fetch("/api/ai/automation-token"),
          fetch("/api/xiaomi/status"),
        ]);

        if (tokenInfoRes.ok) {
          const data = await tokenInfoRes.json();
          if (Array.isArray(data.supportedProviders)) {
            setProviders(data.supportedProviders);
            if (data.supportedProviders[0]) {
              setProvider(data.supportedProviders[0].id);
              setModel(data.supportedProviders[0].defaultModel);
            }
          }
          if (data.authenticated === false) {
            setAuthenticated(false);
          }
        }

        if (statusRes.ok) {
          const statusData = await statusRes.json();
          if (statusData.connected) {
            setAuthenticated(true);
            const devRes = await fetch("/api/xiaomi/devices");
            if (devRes.ok) {
              const devData = await devRes.json();
              if (Array.isArray(devData.homes) && devData.homes.length > 0) {
                setHomes(devData.homes);
              }
            }
          } else {
            setAuthenticated(false);
          }
        }
      } catch (err) {
        console.error("Init AI settings form failed:", err);
      } finally {
        setLoadingInitial(false);
      }
    }

    void init();
  }, [selectedHomeId]);

  const currentProvider = providers.find((item) => item.id === provider);
  const availableModels = currentProvider?.allowedModels ?? [model];
  const effectiveHomeId = selectedHomeId || homes[0]?.id || "";
  const effectiveHomeName = selectedHomeName || homes.find((item) => item.id === effectiveHomeId)?.name || "当前家庭";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!apiKey.trim()) {
      setError("请输入模型 API Key");
      return;
    }

    setSubmitting(true);
    setError(null);
    setCopyFeedback(false);

    try {
      const res = await fetch("/api/ai/automation-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          model,
          apiKey: apiKey.trim(),
          homeId: effectiveHomeId || undefined,
          expiresInDays,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || "签发凭据失败");
      }

      setIssuedResult({
        token: data.token,
        provider: data.provider,
        model: data.model,
        expiresAt: data.expiresAt,
        homeId: data.homeId,
      });

      setApiKey("");
      setShowApiKey(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "生成凭据失败，请重试");
    } finally {
      setSubmitting(false);
    }
  }

  function handleCopy() {
    if (!issuedResult) return;
    navigator.clipboard.writeText(issuedResult.token).then(() => {
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 3000);
    });
  }

  function handleClearResult() {
    setIssuedResult(null);
    setError(null);
    setCopyFeedback(false);
  }

  if (loadingInitial) {
    return (
      <section className="ai-card">
        <div className="ai-chip">加载中</div>
        <h2 style={{ marginTop: "10px" }}>正在加载 AI 自动化配置信息…</h2>
        <p>正在读取米家登录状态、可用 provider 和家庭列表。</p>
      </section>
    );
  }

  if (!authenticated) {
    return (
      <section className="ai-card">
        <div className="ai-chip">需要登录</div>
        <h2 style={{ marginTop: "10px" }}>请先连接米家账号</h2>
        <p>AI 自动化凭据需要结合您的米家会话进行加密封装。</p>
        <div className="ai-action-row" style={{ marginTop: "14px" }}>
          {onOpenLogin ? (
            <button type="button" className="ai-button" onClick={onOpenLogin}>
              扫码连接米家
            </button>
          ) : (
            <Link href="/" className="ai-button" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center" }}>
              返回首页登录米家
            </Link>
          )}
        </div>
      </section>
    );
  }

  return (
    <div className="ai-stack">
      <section className="ai-card">
        <div className="ai-status-row">
          <div>
            <div className="ai-chip">Automation Token</div>
            <h2 style={{ marginTop: "10px" }}>生成当前账号专属的 LLM Token</h2>
            <p>
              为当前米家账号签发包含个人模型 Key 的自包含令牌。签发完成后，请把它粘贴到 iPhone 快捷指令的 Authorization 标头。
            </p>
          </div>
          <div className="ai-status" style={{ minWidth: "164px" }}>
            <strong>当前家庭</strong>
            <small>{effectiveHomeName}</small>
            <strong style={{ marginTop: "8px" }}>支持 provider</strong>
            <small>{currentProvider?.name || "通义千问（中国大陆）"}</small>
          </div>
        </div>
      </section>

      <form className="ai-card ai-form" onSubmit={handleSubmit}>
        <div className="ai-form-grid">
          <div className="ai-field">
            <label htmlFor="provider">模型服务商</label>
            <select
              id="provider"
              className="ai-select"
              value={provider}
              onChange={(event) => {
                const nextProvider = event.target.value;
                setProvider(nextProvider);
                const nextModels = providers.find((item) => item.id === nextProvider)?.allowedModels;
                if (nextModels?.length) {
                  setModel(nextModels[0]);
                }
              }}
            >
              {providers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <span className="ai-help">当前只允许中国大陆 provider，避免跨境 endpoint 和策略漂移。</span>
          </div>

          <div className="ai-field">
            <label htmlFor="model">模型</label>
            <select
              id="model"
              className="ai-select"
              value={model}
              onChange={(event) => setModel(event.target.value)}
            >
              {availableModels.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
            <span className="ai-help">建议使用 Flash 系列，响应快、超时低。</span>
          </div>

          <div className="ai-field">
            <label htmlFor="expiresInDays">有效期（天）</label>
            <select
              id="expiresInDays"
              className="ai-select"
              value={expiresInDays}
              onChange={(event) => setExpiresInDays(Number.parseInt(event.target.value, 10))}
            >
              {[7, 15, 30, 60, 90].map((item) => (
                <option key={item} value={item}>
                  {item} 天
                </option>
              ))}
            </select>
            <span className="ai-help">过期后需要重新签发，建议默认 30 天。</span>
          </div>

          <label className="ai-field full">
            <div className="ai-status-row">
              <label htmlFor="apiKey">个人模型 API Key</label>
              <button
                type="button"
                className="ai-button-secondary"
                onClick={() => setShowApiKey((value) => !value)}
              >
                {showApiKey ? "隐藏" : "显示"}
              </button>
            </div>
            <input
              id="apiKey"
              className="ai-input"
              type={showApiKey ? "text" : "password"}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="填写 DashScope / 通义千问 API Key"
              autoComplete="off"
              spellCheck={false}
            />
            <span className="ai-help">Key 只在签发时做最小验证并被加密密封，服务端不会持久化。</span>
          </label>
        </div>

        {error ? (
          <div
            style={{
              borderRadius: "12px",
              background: "#fff4f1",
              border: "1px solid #ffd5c7",
              color: "#b45309",
              padding: "12px 14px",
              fontSize: "12px",
            }}
          >
            {error}
          </div>
        ) : null}

        <div className="ai-action-row">
          <button type="submit" className="ai-button" disabled={submitting}>
            {submitting ? "正在验证并生成…" : "验证并签发自动化凭据"}
          </button>
          <button type="button" className="ai-button-secondary" onClick={() => {
            setApiKey("");
            setShowApiKey(false);
            setError(null);
          }}>
            清空输入
          </button>
        </div>
      </form>

      {issuedResult ? (
        <section className="ai-card ai-token">
          <div className="ai-status-row">
            <div>
              <div className="ai-chip">已签发</div>
              <h2 style={{ marginTop: "10px" }}>自动化凭据已生成</h2>
              <p>复制后粘贴到 Siri 快捷指令中。页面刷新不会恢复该 Token。</p>
            </div>
            <div style={{ textAlign: "right" }}>
              <strong>过期时间</strong>
              <small>{new Date(issuedResult.expiresAt).toLocaleString("zh-CN")}</small>
            </div>
          </div>

          <textarea
            readOnly
            rows={4}
            className="ai-token-output"
            value={issuedResult.token}
            onFocus={(event) => event.target.select()}
          />

          <div className="ai-action-row">
            <button type="button" className="ai-button" onClick={handleCopy}>
              {copyFeedback ? "✓ 已复制到剪贴板" : "复制令牌"}
            </button>
            <button type="button" className="ai-button-secondary" onClick={handleClearResult}>
              清除结果
            </button>
          </div>

          <p className="ai-help">
            该令牌已包含你的米家会话和个人模型 Key，适合直接放入 iPhone 快捷指令。请勿在日志、截图或群聊中传播。
          </p>
        </section>
      ) : null}
    </div>
  );
}
