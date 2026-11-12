"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useClimateObserver } from "../../use-climate-observer";

type Option = { ref: string; name: string; room: string };
type Room = { roomRef: string; roomName: string; sensorRef: string; sensorName: string; actuators: Array<{ actuatorRef: string; actuatorName: string; actuatorRoom: string; capabilityRevision: string; lastSampleAt: string | null }> };
type Observation = { observationRef: string; roomRef: string; actuatorRef: string; ambientTemperature: number; targetTemperature: number; mode: string | null; powerOn: boolean | null; capturedAt: string; source: string; excluded: boolean; previous: { targetTemperature: number; mode: string | null } };
type Sample = { sampleRef: string; roomRef: string; actuatorRef: string; ambientTemperature: number; targetTemperature: number; mode: string | null; power: boolean | null; capturedAt: string };
type Cell = { timeWindow: string; ambientBand: string; status: string; derivedTargetTemperature: number | null; derivedMode: string | null; explicitTargetTemperature?: number; explicitMode?: string; confidence: number; supportCount: number; explanation: string };
type Profile = { revision: string; rooms: Array<{ roomRef: string; actuatorRef: string; cells: Cell[] }> };
type State = { enabled: boolean; updatedAt: string | null; rooms: Room[]; inventory?: { sensors: Option[]; actuators: Option[] }; observations: Observation[]; samples: Sample[]; draftProfile: Profile | null; reviewedProfile?: Profile | null; reviewedRevision: string | null };

function currentTimeWindow() { const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", hour: "numeric", hourCycle: "h23" }).format(new Date())); return (["00-06", "06-12", "12-18", "18-24"] as const)[Math.min(3, Math.floor(hour / 6))]; }
function ambientBand(value: number) { return value < 16 ? "below-16" : value < 20 ? "16-20" : value < 24 ? "20-24" : value < 28 ? "24-28" : "28-plus"; }
function powerLabel(value: boolean | null) { return value === true ? "已开启" : value === false ? "已关闭" : "开关状态未知"; }
function recommendation(profile: Profile["rooms"][number] | undefined, sample: Sample | undefined) {
  if (!profile || !sample) return null;
  const cell = profile.cells.find(item => item.timeWindow === currentTimeWindow() && item.ambientBand === ambientBand(sample.ambientTemperature));
  if (!cell) return null;
  const target = cell.explicitTargetTemperature ?? cell.derivedTargetTemperature;
  const mode = cell.explicitMode ?? cell.derivedMode;
  if (target === null || target === undefined) return null;
  return { cell, target, mode, targetDelta: Math.round((target - sample.targetTemperature) * 10) / 10 };
}

export default function AdaptiveClimateProfiles({ homeId, homeName }: { homeId?: string; homeName?: string }) {
  const [data, setData] = useState<State | null>(null), [busy, setBusy] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [mappings, setMappings] = useState<Array<{ roomName: string; sensorRef: string; actuatorRefs: string[] }>>([]);
  const load = useCallback(async () => {
    if (!homeId) return;
    setError("");
    try { const response = await fetch(`/api/ai/climate/v1/config?homeId=${encodeURIComponent(homeId)}`, { cache: "no-store" }); if (!response.ok) throw new Error("无法读取气候档案"); const value = await response.json() as State; setData(value); setMappings(value.rooms.map(room => ({ roomName: room.roomName, sensorRef: room.sensorRef, actuatorRefs: room.actuators.map(actuator => actuator.actuatorRef) }))); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "无法读取气候档案"); }
  }, [homeId]);
  const observer = useClimateObserver(homeId ?? "", Boolean(homeId), load);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  const roomNames = useMemo(() => Array.from(new Set((data?.inventory?.sensors ?? []).map(item => item.room))), [data]);
  const materialChanges = useMemo(() => { if (!data?.draftProfile || !data.reviewedProfile) return []; const before = new Map(data.reviewedProfile.rooms.flatMap(room => room.cells.map(cell => [`${room.roomRef}:${room.actuatorRef}:${cell.timeWindow}:${cell.ambientBand}`, cell]))); return data.draftProfile.rooms.flatMap(room => room.cells.filter(cell => { const old = before.get(`${room.roomRef}:${room.actuatorRef}:${cell.timeWindow}:${cell.ambientBand}`); return !old || old.derivedMode !== cell.derivedMode || (old.derivedTargetTemperature !== null && cell.derivedTargetTemperature !== null && Math.abs(old.derivedTargetTemperature - cell.derivedTargetTemperature) >= 1); }).map(cell => `${room.roomRef} ${cell.timeWindow}/${cell.ambientBand}`)); }, [data]);
  async function mutate(path: string, body: object, method = "POST", successMessage = "操作已完成") { if (!homeId) return; setBusy(path); setError(""); setNotice(""); try { const response = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ homeId, ...body }) }); const payload = await response.json().catch(() => null) as unknown; if (!response.ok) { const code = payload && typeof payload === "object" && "code" in payload && typeof payload.code === "string" ? payload.code : `HTTP_${response.status}`; throw new Error(`操作失败（${code}）`); } if (payload && typeof payload === "object" && "rooms" in payload && Array.isArray(payload.rooms)) { const value = payload as State; setData(value); setMappings(value.rooms.map(room => ({ roomName: room.roomName, sensorRef: room.sensorRef, actuatorRefs: room.actuators.map(actuator => actuator.actuatorRef) }))); } setNotice(successMessage); } catch (reason) { setError(reason instanceof Error ? reason.message : "操作失败"); } finally { setBusy(""); } }
  async function save() { await mutate("/api/ai/climate/v1/config", { enabled: data?.enabled ?? false, rooms: mappings }, "PUT", "配置已保存"); }
  function mapping(roomName: string) { return mappings.find(item => item.roomName === roomName) ?? { roomName, sensorRef: "", actuatorRefs: [] }; }
  function updateSensor(roomName: string, sensorRef: string) { setMappings(current => [...current.filter(item => item.roomName !== roomName), { ...mapping(roomName), sensorRef }].filter(item => item.sensorRef || item.actuatorRefs.length)); }
  function toggleActuator(roomName: string, actuatorRef: string) { const current = mapping(roomName), actuatorRefs = current.actuatorRefs.includes(actuatorRef) ? current.actuatorRefs.filter(ref => ref !== actuatorRef) : [...current.actuatorRefs, actuatorRef]; setMappings(values => [...values.filter(item => item.roomName !== roomName), { ...current, actuatorRefs }].filter(item => item.sensorRef || item.actuatorRefs.length)); }
  function exportJson() { if (!data) return; const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), profile: data.draftProfile, observations: data.observations, samples: data.samples }, null, 2)], { type: "application/json" })); link.download = "adaptive-climate-profile.json"; link.click(); URL.revokeObjectURL(link.href); }
  function editCell(roomRef: string, actuatorRef: string, cell: Cell) { const target = prompt("显式目标温度（5–80°C）", String(cell.explicitTargetTemperature ?? cell.derivedTargetTemperature ?? 24)); if (target === null) return; const value = Number(target); if (!Number.isFinite(value) || value < 5 || value > 80) { setError("目标温度必须在 5–80°C"); return; } const mode = prompt("显式模式（保留原始枚举文本）", cell.explicitMode ?? cell.derivedMode ?? ""); if (mode === null) return; void mutate("/api/ai/climate/v1/profiles:review", { revision: data?.draftProfile?.revision, edit: { roomRef, actuatorRef, timeWindow: cell.timeWindow, ambientBand: cell.ambientBand, targetTemperature: value, mode } }, "POST", "显式偏好已保存"); }
  if (!homeId) return <section className="climate-panel"><p>连接米家并选择家庭后可配置。</p></section>;
  return <section className="climate-panel" aria-labelledby="climate-title">
    <div className="climate-heading"><div><p className="eyebrow">AI · 只读学习</p><h2 id="climate-title">自适应气候档案</h2><p>{homeName ?? "当前家庭"} · 从手动调温中学习</p></div><label className="climate-toggle"><input type="checkbox" checked={data?.enabled ?? false} onChange={event => setData(current => current ? { ...current, enabled: event.target.checked } : current)} />启用采样</label></div>
    <p className="climate-notice" role="note">档案仅供查看，不会控制设备。</p>
    <p className={`climate-observer ${observer.state}`} role="status">周期采样：{observer.label}。有效状态即使没有手动调整也会保存为历史点。</p>
    {!!materialChanges.length && <p className="climate-notice" role="status">已审阅版本已过期：{materialChanges.length} 个档案单元发生实质变化。</p>}
    {error && <p className="climate-error" role="alert">{error}</p>}
    {notice && <p className="climate-success" role="status">{notice}</p>}
    <h3>房间传感器与设备</h3>
    <div className="climate-config-grid">{roomNames.map(roomName => <fieldset key={roomName}><legend>{roomName}</legend><label>温度传感器<select value={mapping(roomName).sensorRef} onChange={event => updateSensor(roomName, event.target.value)}><option value="">未配置</option>{data?.inventory?.sensors.filter(item => item.room === roomName).map(item => <option key={item.ref} value={item.ref}>{item.name}</option>)}</select></label><div className="climate-controller-list"><strong>气候控制器（可跨房间、多选）</strong>{data?.inventory?.actuators.map(item => <label key={item.ref}><input type="checkbox" checked={mapping(roomName).actuatorRefs.includes(item.ref)} onChange={() => toggleActuator(roomName, item.ref)} />{item.name}<small>{item.room}</small></label>)}</div></fieldset>)}</div>
    <div className="climate-actions"><button type="button" disabled={!!busy} onClick={save}>{busy === "/api/ai/climate/v1/config" ? "保存中…" : "保存配置"}</button><button type="button" disabled={!!busy || !(data?.observations.length || data?.samples.length)} onClick={() => mutate("/api/ai/climate/v1/profiles:derive", {}, "POST", "档案已重新推导")}>重新推导</button><button type="button" disabled={!!busy || !data?.draftProfile || data.reviewedRevision === data.draftProfile.revision} onClick={() => mutate("/api/ai/climate/v1/profiles:review", { revision: data?.draftProfile?.revision }, "POST", "版本已标记为已审阅")}>标记已审阅</button><button type="button" onClick={exportJson}>导出 JSON</button><button type="button" className="danger" disabled={!!busy} onClick={() => { if (confirm("删除当前家庭的全部气候记忆？")) void mutate("/api/ai/climate/v1/memory", {}, "DELETE", "气候记忆已删除"); }}>删除全部</button></div>
    {(data?.rooms ?? []).map(room => <RoomClimateReview key={room.roomRef} room={room} profile={data?.draftProfile ?? null} samples={data?.samples ?? []} onDelete={() => { if (confirm(`删除${room.roomName}的气候记忆？`)) void mutate("/api/ai/climate/v1/memory", { roomRef: room.roomRef }, "DELETE", "房间气候记忆已删除"); }} onEdit={editCell}/>)}
    <h3>手动调整时间线</h3><div className="climate-timeline">{data?.observations.length ? [...data.observations].reverse().map(item => { const actuator = data.rooms.flatMap(room => room.actuators).find(value => value.actuatorRef === item.actuatorRef); return <article key={item.observationRef}><div><strong>{new Date(item.capturedAt).toLocaleString()} · {item.ambientTemperature}°C · {actuator?.actuatorName ?? "气候设备"}</strong><p>{item.previous.targetTemperature}°C / {item.previous.mode ?? "无模式"} → {item.targetTemperature}°C / {item.mode ?? "无模式"}</p><small>{powerLabel(item.powerOn)} · {item.source === "console_override" ? "控制台操作" : "外部手动操作"} · {item.excluded ? "已排除" : "参与学习"}</small></div><button type="button" onClick={() => mutate("/api/ai/climate/v1/observations", { observationRef: item.observationRef, excluded: !item.excluded }, "PATCH", item.excluded ? "观察已恢复" : "观察已排除")}>{item.excluded ? "恢复" : "排除"}</button></article>; }) : <p>还没有稳定的手动调整记录；周期历史仍可生成临时建议。</p>}</div>
  </section>;
}

function RoomClimateReview({ room, profile, samples, onDelete, onEdit }: { room: Room; profile: Profile | null; samples: Sample[]; onDelete: () => void; onEdit: (roomRef: string, actuatorRef: string, cell: Cell) => void }) {
  const roomSamples = samples.filter(item => item.roomRef === room.roomRef).sort((left, right) => Date.parse(right.capturedAt) - Date.parse(left.capturedAt));
  return <article className="climate-room">
    <header><div><h3>{room.roomName}</h3><p>环境传感器：{room.sensorName} · {roomSamples.length} 个历史点</p></div><button type="button" className="climate-room-delete" onClick={onDelete}>删除房间档案</button></header>
    {room.actuators.map(actuator => {
      const controllerProfile = profile?.rooms.find(item => item.roomRef === room.roomRef && item.actuatorRef === actuator.actuatorRef);
      const controllerSamples = roomSamples.filter(item => item.actuatorRef === actuator.actuatorRef), latest = controllerSamples[0];
      const final = recommendation(controllerProfile, latest);
      return <section className="climate-controller" key={actuator.actuatorRef}>
        <h4>{actuator.actuatorName} <small>位于 {actuator.actuatorRoom}</small></h4>
        <div className={`climate-recommendation ${final ? "ready" : "insufficient"}`}><strong>Agent 当前建议 · {latest ? powerLabel(latest.power) : "等待设备状态"}</strong>{final ? <><span>目标 {final.target}°C · 模式 {final.mode ?? "保持当前模式"}</span><small>{final.cell.status === "suggested" ? "基于周期历史的临时建议" : "基于手动偏好的已学习建议"} · {final.targetDelta === 0 ? "当前设定温度无需调整" : `相对当前设定 ${final.targetDelta > 0 ? "+" : ""}${final.targetDelta}°C`} · 置信度 {Math.round(final.cell.confidence * 100)}% · {latest?.power === false ? "设备当前关闭，建议供下次开启参考" : "仅供审阅"}</small></> : <><span>证据不足，暂不建议调整</span><small>需要当前状态点及对应时段/温度区间的历史证据。</small></>}</div>
        <h5>历史状态</h5><div className="climate-samples">{controllerSamples.length ? controllerSamples.slice(0,24).map(point => <article key={point.sampleRef}><strong>{new Date(point.capturedAt).toLocaleString()}</strong><span>室温 {point.ambientTemperature}°C · {powerLabel(point.power)}</span><span>设定 {point.targetTemperature}°C · {point.mode ?? "无模式"}</span></article>) : <p>等待周期采样点。</p>}</div>
        <details><summary>查看完整学习矩阵</summary><div className="climate-matrix" role="table" aria-label={`${room.roomName} ${actuator.actuatorName}气候档案`}>{controllerProfile?.cells.map(cell => <div className="climate-cell" role="row" key={`${cell.timeWindow}-${cell.ambientBand}`}><strong>{cell.timeWindow} · {cell.ambientBand}</strong><span>{cell.status === "learned" ? `${cell.derivedTargetTemperature}°C · 模式 ${cell.derivedMode ?? "证据不足"}` : cell.status === "suggested" ? `临时建议 ${cell.derivedTargetTemperature}°C · 模式 ${cell.derivedMode ?? "证据不足"}` : "证据不足"}</span>{cell.explicitTargetTemperature !== undefined && <small>显式偏好：{cell.explicitTargetTemperature}°C · {cell.explicitMode || "未指定模式"}（推导值保留）</small>}<small>{cell.supportCount} 条 · 置信度 {Math.round(cell.confidence * 100)}%</small><button type="button" onClick={() => onEdit(room.roomRef, actuator.actuatorRef, cell)}>编辑偏好</button></div>) ?? <p>周期状态点可先生成临时建议，手动调整达到门槛后升级为已学习档案。</p>}</div></details>
      </section>;
    })}
  </article>;
}
