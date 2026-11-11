"use client";

import { useEffect, useState } from "react";

export function useClimateObserver(homeId: string, enabled: boolean, onSample?: () => void) {
  const [status, setStatus] = useState<{ state: "active" | "suspended" | "error"; label: string }>({ state: "suspended", label: "已暂停" });
  useEffect(() => {
    if (!enabled) return;
    let timer = 0, stopped = false, failures = 0, inFlight = false; let controller: AbortController | null = null;
    const schedule = (milliseconds: number) => { window.clearTimeout(timer); timer = window.setTimeout(sample, milliseconds + Math.round(Math.random() * 12000)); };
    const sample = async () => {
      if (stopped || inFlight) return;
      if (document.visibilityState !== "visible" || !navigator.onLine) { setStatus({ state: "suspended", label: document.visibilityState !== "visible" ? "页面不可见" : "网络离线" }); return; }
      controller = new AbortController(); inFlight = true;
      try {
        const response = await fetch("/api/ai/climate/v1/sample", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ homeId }), signal: controller.signal });
        if (response.status === 401) { setStatus({ state: "suspended", label: "登录已过期" }); return; }
        if (!response.ok) throw new Error(String(response.status));
        const value = await response.json() as { sampled?: boolean; updatedAt?: string | null };
        onSample?.();
        failures = 0; setStatus({ state: "active", label: value.sampled ? `正常 · ${value.updatedAt ? new Date(value.updatedAt).toLocaleTimeString() : "刚刚"}` : "尚未启用" }); schedule(120000);
      } catch (reason) {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        failures++; setStatus({ state: "error", label: "暂时失败，自动退避" }); schedule(failures >= 3 ? 900000 : 300000);
      } finally { inFlight = false; }
    };
    const resume = () => { if (document.visibilityState === "visible" && navigator.onLine) void sample(); else setStatus({ state: "suspended", label: "已暂停" }); };
    document.addEventListener("visibilitychange", resume); window.addEventListener("online", resume); window.addEventListener("offline", resume); void sample();
    return () => { stopped = true; window.clearTimeout(timer); controller?.abort(); document.removeEventListener("visibilitychange", resume); window.removeEventListener("online", resume); window.removeEventListener("offline", resume); };
  }, [homeId, enabled, onSample]);
  return enabled ? status : { state: "suspended" as const, label: "未连接" };
}
