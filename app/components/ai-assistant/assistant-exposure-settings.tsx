"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Metric = "temperature" | "humidity" | "co2" | "formaldehyde" | "pm25" | "pm10" | "tvoc" | "pressure" | "battery";
type Inventory = {
  rooms: string[];
  metrics: Metric[];
  roomMetrics: Record<string, Metric[]>;
  devices: Array<{ ref: string; name: string; room: string; kind: string; enabled: boolean; eligible: boolean }>;
};
type Exposure = { enabled: boolean; roomMetrics: Record<string, Metric[]>; updatedAt: string | null; revision: string };
type PermissionRow = {
  id: string;
  name: string;
  kind: string;
  room: string;
  metric?: Metric;
  deviceRef?: string;
  selected: boolean;
};

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
  const [exposure, setExposure] = useState<Exposure>({ enabled: false, roomMetrics: {}, updatedAt: null, revision: "exp_default_deny" });
  const [inventory, setInventory] = useState<Inventory>({ rooms: [], metrics: [], roomMetrics: {}, devices: [] });
  const [selectedDevices, setSelectedDevices] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [scopeFilter, setScopeFilter] = useState("all");
  const [roomFilter, setRoomFilter] = useState("all");
  const [kindFilter, setKindFilter] = useState("all");
  const [search, setSearch] = useState("");
  const selectVisibleRef = useRef<HTMLInputElement>(null);
  const selectVisibleToolbarRef = useRef<HTMLInputElement>(null);

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
      } catch {
        if (!cancelled) setError("无法读取家庭暴露设置，请稍后重试。");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [homeId]);

  const selectedCount = selectedDevices.length;
  const permissionRows = useMemo<PermissionRow[]>(() => [
    ...Object.entries(inventory.roomMetrics).flatMap(([room, metrics]) => metrics.map(metric => ({
      id: `metric:${room}:${metric}`,
      name: `${metricLabels[metric]}读数`,
      kind: metricLabels[metric],
      room,
      metric,
      selected: (exposure.roomMetrics[room] ?? []).includes(metric),
    }))),
    ...inventory.devices.filter(device => device.eligible).map(device => ({
      id: `device:${device.ref}`,
      name: device.name,
      kind: deviceKindLabels[device.kind] ?? device.kind,
      room: device.room,
      deviceRef: device.ref,
      selected: selectedDevices.includes(device.ref),
    })),
  ], [exposure.roomMetrics, inventory, selectedDevices]);
  const filteredRows = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("zh-CN");
    return permissionRows.filter(row => {
      if (scopeFilter === "environment" && !row.metric) return false;
      if (scopeFilter === "devices" && !row.deviceRef) return false;
      if (roomFilter !== "all" && row.room !== roomFilter) return false;
      if (kindFilter !== "all" && row.kind !== kindFilter) return false;
      if (query && !`${row.name} ${row.kind} ${row.room}`.toLocaleLowerCase("zh-CN").includes(query)) return false;
      return true;
    });
  }, [kindFilter, permissionRows, roomFilter, scopeFilter, search]);
  const allVisibleSelected = filteredRows.length > 0 && filteredRows.every(row => row.selected);
  const someVisibleSelected = filteredRows.some(row => row.selected);
  const filterKinds = [...new Set(permissionRows.map(row => row.kind))].sort((left, right) => left.localeCompare(right, "zh-CN"));

  useEffect(() => {
    for (const input of [selectVisibleRef.current, selectVisibleToolbarRef.current]) {
      if (input) input.indeterminate = someVisibleSelected && !allVisibleSelected;
    }
  }, [allVisibleSelected, someVisibleSelected]);

  const unavailableApprovals = Object.entries(exposure.roomMetrics).flatMap(([room, metrics]) =>
    metrics.filter(metric => !inventory.roomMetrics[room]?.includes(metric)).map(metric => `${room} · ${metricLabels[metric]}`));
  const eligibleDevices = inventory.devices.filter(device => device.eligible);
  const allSelected = permissionRows.length > 0 && permissionRows.every(row => row.selected);

  function setAllEnvironment(next: boolean) {
    const roomMetrics = next
      ? Object.fromEntries(Object.entries(inventory.roomMetrics).filter(([, metrics]) => metrics.length).map(([room, metrics]) => [room, [...metrics]]))
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

  function setFilteredRows(next: boolean) {
    const metricRooms = new Map<Metric, Set<string>>();
    const refs = new Set<string>();
    for (const row of filteredRows) {
      if (row.metric) {
        const rooms = metricRooms.get(row.metric) ?? new Set<string>();
        rooms.add(row.room);
        metricRooms.set(row.metric, rooms);
      }
      if (row.deviceRef) refs.add(row.deviceRef);
    }
    setExposure(current => {
      const roomMetrics = { ...current.roomMetrics };
      for (const [metric, rooms] of metricRooms) {
        for (const room of rooms) {
          const metrics = new Set(roomMetrics[room] ?? []);
          if (next) metrics.add(metric); else metrics.delete(metric);
          if (metrics.size) roomMetrics[room] = [...metrics]; else delete roomMetrics[room];
        }
      }
      return { ...current, roomMetrics };
    });
    setSelectedDevices(current => next
      ? [...new Set([...current, ...refs])]
      : current.filter(ref => !refs.has(ref)));
    setSaved(false);
  }

  function togglePermission(row: PermissionRow) {
    const { metric, deviceRef } = row;
    if (metric) {
      setExposure(current => {
        const metrics = new Set(current.roomMetrics[row.room] ?? []);
        if (metrics.has(metric)) metrics.delete(metric); else metrics.add(metric);
        const roomMetrics = { ...current.roomMetrics };
        if (metrics.size) roomMetrics[row.room] = [...metrics]; else delete roomMetrics[row.room];
        return { ...current, roomMetrics };
      });
    } else if (deviceRef) {
      setSelectedDevices(current => current.includes(deviceRef) ? current.filter(ref => ref !== deviceRef) : [...current, deviceRef]);
    }
    setSaved(false);
  }

  async function save() {
    if (!homeId || saving || loading) return;
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const roomMetrics = Object.fromEntries(Object.entries(exposure.roomMetrics).flatMap(([room, metrics]) => {
        const available = metrics.filter(metric => inventory.roomMetrics[room]?.includes(metric));
        return available.length ? [[room, available]] : [];
      }));
      const response = await fetch("/api/ai/exposure", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ homeId, enabled: exposure.enabled, roomMetrics, deviceRefs: selectedDevices }),
      });
      const body = await response.json().catch(() => null) as { code?: string; exposure?: Exposure; inventory?: Inventory } | null;
      if (!response.ok || !body?.exposure || !body.inventory) throw new Error(body?.code ?? "AI_AGENT_UNAVAILABLE");
      setExposure(body.exposure);
      setInventory(body.inventory);
      setSelectedDevices(body.inventory.devices.filter(device => device.enabled).map(device => device.ref));
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
            <h3>读取权限 <small>已选 {permissionRows.filter(row => row.selected).length} 项</small></h3>
            {unavailableApprovals.length > 0 && <p className="assistant-exposure-note">以下已授权读数当前不可用，保存时会撤销这些授权：{unavailableApprovals.join("、")}</p>}
            {permissionRows.length ? <>
              <div className="assistant-exposure-filters" aria-label="读取权限筛选">
                <label>数据范围
                  <select value={scopeFilter} onChange={event => setScopeFilter(event.target.value)}>
                    <option value="all">全部</option>
                    <option value="environment">环境读数</option>
                    <option value="devices">设备状态</option>
                  </select>
                </label>
                <label>房间
                  <select value={roomFilter} onChange={event => setRoomFilter(event.target.value)}>
                    <option value="all">所有房间</option>
                    {inventory.rooms.map(room => <option key={room} value={room}>{room}</option>)}
                  </select>
                </label>
                <label>类型
                  <select value={kindFilter} onChange={event => setKindFilter(event.target.value)}>
                    <option value="all">所有类型</option>
                    {filterKinds.map(kind => <option key={kind} value={kind}>{kind}</option>)}
                  </select>
                </label>
                <label className="assistant-exposure-search">搜索
                  <input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索名称、类型或房间" />
                </label>
                <label className="assistant-exposure-select-visible">
                  <input
                    ref={selectVisibleToolbarRef}
                    type="checkbox"
                    checked={allVisibleSelected}
                    disabled={!exposure.enabled || filteredRows.length === 0}
                    aria-label={`全选筛选结果，共 ${filteredRows.length} 项`}
                    onChange={event => setFilteredRows(event.target.checked)}
                  />
                  全选当前筛选结果（{filteredRows.length}）
                </label>
              </div>
              <p className="assistant-exposure-result-count" aria-live="polite">
                筛选结果 {filteredRows.length} 项 / 共 {permissionRows.length} 项；设备已选 {selectedCount} 台
              </p>
              <div className="assistant-exposure-table-wrap">
                <table className="assistant-exposure-table">
                  <caption className="visually-hidden">AI 助手可读取的环境读数和设备状态</caption>
                  <thead>
                    <tr>
                      <th scope="col" className="assistant-exposure-check-column">
                        <input
                          ref={selectVisibleRef}
                          type="checkbox"
                          checked={allVisibleSelected}
                          disabled={!exposure.enabled || filteredRows.length === 0}
                          aria-label={`全选筛选结果，共 ${filteredRows.length} 项`}
                          onChange={event => setFilteredRows(event.target.checked)}
                        />
                      </th>
                      <th scope="col">读取项</th>
                      <th scope="col">类型</th>
                      <th scope="col">房间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRows.map(row => <tr key={row.id}>
                      <td data-label="选择">
                        <input
                          type="checkbox"
                          checked={row.selected}
                          disabled={!exposure.enabled}
                          aria-label={`允许 AI 读取：${row.name}，${row.room}`}
                          onChange={() => togglePermission(row)}
                        />
                      </td>
                      <th scope="row" data-label="读取项">{row.name}</th>
                      <td data-label="类型">{row.kind}</td>
                      <td data-label="房间">{row.room}</td>
                    </tr>)}
                  </tbody>
                </table>
                {filteredRows.length === 0 && <p className="assistant-exposure-empty">没有符合筛选条件的项目。调整或清除筛选即可查看其他权限。</p>}
              </div>
              <button type="button" className="assistant-exposure-clear-filters" onClick={() => { setScopeFilter("all"); setRoomFilter("all"); setKindFilter("all"); setSearch(""); }}>清除筛选</button>
            </> : <p className="assistant-exposure-note">没有找到可配置的环境读数或设备状态。</p>}
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
