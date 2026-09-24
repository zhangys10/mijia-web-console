"use client";

import { useEffect, useMemo, useState } from "react";

type Metric = "temperature" | "humidity" | "co2" | "formaldehyde" | "pm25" | "pm10" | "tvoc" | "pressure" | "battery";
type Inventory = {
  rooms: string[];
  metrics: Metric[];
  devices: Array<{ ref: string; name: string; room: string; kind: string; enabled: boolean; eligible: boolean }>;
  scenes: Array<{ ref: string; name: string; actionCount: number; risk: "low" | "blocked"; enabled: boolean; revision: string; actionSummaries: Array<{ room: string | null; device: string | null; actions: Array<{ label: string; value: string }> }> }>;
};
type Exposure = { enabled: boolean; sceneActionsEnabled: boolean; roomMetrics: Record<string, Metric[]>; updatedAt: string | null; revision: string };

const metricLabels: Record<Metric, string> = {
  temperature: "温度", humidity: "湿度", co2: "二氧化碳", formaldehyde: "甲醛",
  pm25: "PM2.5", pm10: "PM10", tvoc: "TVOC", pressure: "气压", battery: "电量",
};

const deviceKindLabels: Record<string, string> = {
  light: "灯具",
  switch: "开关",
  fan: "风扇",
  air_conditioner: "空调",
  purifier: "空气净化器",
  humidifier: "加湿器",
  heater: "取暖设备",
  sensor: "传感器",
  appliance: "家电",
  unknown: "其他设备",
};

export default function AssistantExposureSettings({ homeId, homeName }: { homeId?: string; homeName?: string }) {
  const [exposure, setExposure] = useState<Exposure>({ enabled: false, sceneActionsEnabled: false, roomMetrics: {}, updatedAt: null, revision: "exp_default_deny" });
  const [inventory, setInventory] = useState<Inventory>({ rooms: [], metrics: [], devices: [], scenes: [] });
  const [selectedDevices, setSelectedDevices] = useState<string[]>([]);
  const [selectedScenes, setSelectedScenes] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!homeId) return;
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      setLoading(true);
      setError("");
      try {
        const response = await fetch(`/api/ai/exposure?homeId=${encodeURIComponent(homeId)}`, { cache: "no-store" });
        const body = await response.json().catch(() => null) as { code?: string; exposure?: Exposure; inventory?: Inventory } | null;
        if (!response.ok || !body?.exposure || !body.inventory) throw new Error(body?.code ?? "AI_AGENT_UNAVAILABLE");
        if (cancelled) return;
        setExposure(body.exposure);
        setInventory(body.inventory);
        setSelectedDevices(body.inventory.devices.filter(device => device.enabled).map(device => device.ref));
        setSelectedScenes(body.inventory.scenes.filter(scene => scene.enabled).map(scene => scene.ref));
      } catch {
        if (!cancelled) setError("无法读取家庭暴露设置，请稍后重试。");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [homeId]);

  const selectedCount = selectedDevices.length;
  const groupedDevices = useMemo(() => {
    const byKind = new Map<string, Map<string, Inventory["devices"]>>();
    for (const device of inventory.devices) {
      if (!device.eligible) continue;
      const byRoom = byKind.get(device.kind) ?? new Map<string, Inventory["devices"]>();
      byRoom.set(device.room, [...(byRoom.get(device.room) ?? []), device]);
      byKind.set(device.kind, byRoom);
    }
    return [...byKind.entries()]
      .sort(([left], [right]) => (deviceKindLabels[left] ?? left).localeCompare(deviceKindLabels[right] ?? right, "zh-CN"))
      .map(([kind, rooms]) => ({ kind, rooms: [...rooms.entries()].sort(([left], [right]) => left.localeCompare(right, "zh-CN")) }));
  }, [inventory]);

  const allEnvironmentSelected = inventory.metrics.length > 0 && inventory.rooms.length > 0
    && inventory.metrics.every(metric => inventory.rooms.every(room => (exposure.roomMetrics[room] ?? []).includes(metric)));
  const eligibleDevices = inventory.devices.filter(device => device.eligible);
  const allDevicesSelected = eligibleDevices.length === 0 || eligibleDevices.every(device => selectedDevices.includes(device.ref));
  const allSelected = allEnvironmentSelected && allDevicesSelected;

  function setAllEnvironment(next: boolean) {
    const roomMetrics = next
      ? Object.fromEntries(inventory.rooms.map(room => [room, [...inventory.metrics]]))
      : {};
    setExposure(current => ({ ...current, roomMetrics }));
    setSaved(false);
  }

  function setAllDevices(next: boolean) {
    setSelectedDevices(next ? eligibleDevices.map(device => device.ref) : []);
    setSaved(false);
  }

  function setAllPermissions(next: boolean) {
    setAllEnvironment(next);
    setAllDevices(next);
  }

  function toggleMetricType(metric: Metric) {
    const selected = inventory.rooms.every(room => (exposure.roomMetrics[room] ?? []).includes(metric));
    setExposure(current => {
      const roomMetrics = { ...current.roomMetrics };
      for (const room of inventory.rooms) {
        const metrics = new Set(roomMetrics[room] ?? []);
        if (selected) metrics.delete(metric); else metrics.add(metric);
        if (metrics.size) roomMetrics[room] = [...metrics]; else delete roomMetrics[room];
      }
      return { ...current, roomMetrics };
    });
    setSaved(false);
  }

  function toggleDeviceGroup(devices: Inventory["devices"]) {
    const refs = devices.map(device => device.ref);
    const selected = refs.every(ref => selectedDevices.includes(ref));
    setSelectedDevices(current => selected ? current.filter(ref => !refs.includes(ref)) : [...new Set([...current, ...refs])]);
    setSaved(false);
  }

  function toggleMetric(room: string, metric: Metric) {
    setExposure(current => {
      const selected = new Set(current.roomMetrics[room] ?? []);
      if (selected.has(metric)) selected.delete(metric); else selected.add(metric);
      const roomMetrics = { ...current.roomMetrics };
      if (selected.size) roomMetrics[room] = [...selected]; else delete roomMetrics[room];
      return { ...current, roomMetrics };
    });
    setSaved(false);
  }

  function toggleDevice(ref: string) {
    setSelectedDevices(current => current.includes(ref) ? current.filter(item => item !== ref) : [...current, ref]);
    setSaved(false);
  }

  async function save() {
    if (!homeId || saving || loading) return;
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const response = await fetch("/api/ai/exposure", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ homeId, enabled: exposure.enabled, sceneActionsEnabled: exposure.sceneActionsEnabled, roomMetrics: exposure.roomMetrics, deviceRefs: selectedDevices, sceneRefs: selectedScenes }),
      });
      const body = await response.json().catch(() => null) as { code?: string; exposure?: Exposure; inventory?: Inventory } | null;
      if (!response.ok || !body?.exposure || !body.inventory) throw new Error(body?.code ?? "AI_AGENT_UNAVAILABLE");
      setExposure(body.exposure);
      setInventory(body.inventory);
      setSelectedDevices(body.inventory.devices.filter(device => device.enabled).map(device => device.ref));
      setSelectedScenes(body.inventory.scenes.filter(scene => scene.enabled).map(scene => scene.ref));
      setSaved(true);
    } catch {
      setError("保存失败，家庭数据未开放给 AI 助手。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="ai-card assistant-exposure-card" aria-labelledby="assistant-exposure-title">
      <div className="assistant-exposure-heading">
        <div>
          <div className="ai-chip">家庭共享 · 默认关闭</div>
          <h2 id="assistant-exposure-title">AI 助手访问权限</h2>
          <p>{homeName ? `${homeName} 的授权设置按家庭共享。` : "选择一个真实家庭后管理共享授权。"} 这些权限只控制 AI 助手读取，不会改变米家账号权限；未勾选的数据不会提供给 AI 助手。</p>
        </div>
        <div className="assistant-exposure-heading-actions">
          <label className="assistant-exposure-master">
            <input type="checkbox" checked={exposure.enabled} disabled={!homeId || loading} onChange={event => { setExposure(value => ({ ...value, enabled: event.target.checked })); setSaved(false); }} />
            <span>启用家庭读取</span>
          </label>
          <button type="button" className="assistant-exposure-select-all" disabled={!homeId || loading || !exposure.enabled} onClick={() => setAllPermissions(!allSelected)}>
            {allSelected ? "取消全选" : "一键全选"}
          </button>
        </div>
      </div>

      {!homeId && <p className="assistant-exposure-note">请先登录并选择真实家庭。</p>}
      {loading && <p className="assistant-exposure-note" role="status">正在读取家庭设备…</p>}
      {homeId && !loading && (
        <>
          <div className="assistant-exposure-section">
            <h3>环境读数</h3>
            {inventory.rooms.length && inventory.metrics.length ? <div className="assistant-exposure-groups">
              {inventory.metrics.map(metric => (
                <fieldset className="assistant-exposure-group" key={metric} disabled={!exposure.enabled}>
                  <legend>{metricLabels[metric]}</legend>
                  <button type="button" className="assistant-exposure-group-action" onClick={() => toggleMetricType(metric)}>
                    {inventory.rooms.every(room => (exposure.roomMetrics[room] ?? []).includes(metric)) ? "取消全选" : "全选此类型"}
                  </button>
                  <div className="assistant-exposure-options">
                    {inventory.rooms.map(room => (
                      <label key={`${metric}:${room}`}>
                        <input type="checkbox" checked={(exposure.roomMetrics[room] ?? []).includes(metric)} onChange={() => toggleMetric(room, metric)} />
                        <span>{room}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              ))}
              <button type="button" className="assistant-exposure-sub-all" disabled={!exposure.enabled} onClick={() => setAllEnvironment(!allEnvironmentSelected)}>
                {allEnvironmentSelected ? "取消环境全选" : "全选环境读数"}
              </button>
            </div> : <p className="assistant-exposure-note">没有找到可配置的环境读数。</p>}
          </div>

          <div className="assistant-exposure-section">
            <h3>设备状态 <small>已选 {selectedCount} 台</small></h3>
            {groupedDevices.length ? <div className="assistant-exposure-groups">
              {groupedDevices.map(group => {
                const devices = group.rooms.flatMap(([, items]) => items);
                return <fieldset className="assistant-exposure-group" key={group.kind} disabled={!exposure.enabled}>
                  <legend>{deviceKindLabels[group.kind] ?? group.kind}</legend>
                  <button type="button" className="assistant-exposure-group-action" onClick={() => toggleDeviceGroup(devices)}>
                    {devices.every(device => selectedDevices.includes(device.ref)) ? "取消全选" : "全选此类型"}
                  </button>
                  <div className="assistant-exposure-device-rooms">
                    {group.rooms.map(([room, roomDevices]) => <fieldset className="assistant-exposure-room assistant-exposure-devices" key={`${group.kind}:${room}`}>
                      <legend>{room}</legend>
                      <button type="button" className="assistant-exposure-room-action" onClick={() => toggleDeviceGroup(roomDevices)}>
                        {roomDevices.every(device => selectedDevices.includes(device.ref)) ? "取消全选" : "全选此房间"}
                      </button>
                      {roomDevices.map(device => (
                        <label key={device.ref}>
                          <input type="checkbox" checked={selectedDevices.includes(device.ref)} onChange={() => toggleDevice(device.ref)} />
                          <span>{device.name}</span><small>{deviceKindLabels[device.kind] ?? device.kind}</small>
                        </label>
                      ))}
                    </fieldset>)}
                  </div>
                </fieldset>;
              })}
              <button type="button" className="assistant-exposure-sub-all" disabled={!exposure.enabled} onClick={() => setAllDevices(!allDevicesSelected)}>
                {allDevicesSelected ? "取消设备全选" : "全选设备状态"}
              </button>
            </div> : <p className="assistant-exposure-note">没有可配置的设备。</p>}
          </div>
          <div className="assistant-exposure-section">
            <h3>场景操作权限 <small>仅限已识别的低风险灯光场景</small></h3>
            <label className="assistant-exposure-master">
              <input type="checkbox" checked={exposure.sceneActionsEnabled} disabled={!homeId || loading} onChange={event => { setExposure(value => ({ ...value, sceneActionsEnabled: event.target.checked })); setSaved(false); }} />
              <span>允许 AI 执行已选场景</span>
            </label>
            {inventory.scenes.length ? <fieldset className="assistant-exposure-group" disabled={!homeId || loading}>
              <legend>手动场景</legend>
              {inventory.scenes.map(scene => <label key={scene.ref}>
                <input
                  type="checkbox"
                  checked={selectedScenes.includes(scene.ref)}
                  disabled={scene.risk !== "low"}
                  onChange={() => {
                    setSelectedScenes(current => current.includes(scene.ref)
                      ? current.filter(ref => ref !== scene.ref)
                      : [...current, scene.ref]);
                    setSaved(false);
                  }}
                />
                <span>{scene.name}</span>
                <small>{scene.risk === "low" ? `${scene.actionCount} 个灯光动作` : "含未知或不支持动作"}</small>
              </label>)}
            </fieldset> : <p className="assistant-exposure-note">当前家庭没有可配置的手动场景。</p>}
            <p className="assistant-exposure-note">场景授权按当前内容版本保存；场景被编辑后需要重新开放。远程执行仍处于关闭状态。</p>
          </div>
          <div className="assistant-exposure-footer">
            <span>{exposure.updatedAt ? `上次更新 ${new Date(exposure.updatedAt).toLocaleString()}` : "当前未开放任何家庭数据"}</span>
            <button type="button" disabled={saving || loading} onClick={() => void save()}>{saving ? "保存中…" : "保存家庭授权"}</button>
          </div>
          {saved && <p className="assistant-exposure-success" role="status">家庭授权已保存。</p>}
        </>
      )}
      {error && <p className="assistant-exposure-error" role="alert">{error}</p>}
    </section>
  );
}
