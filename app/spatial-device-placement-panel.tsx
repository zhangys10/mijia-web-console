"use client";
import { AppearancePanel, DimensionInput } from "./spatial-appearance-panel";
import type { SpatialPlacement, SpatialZone } from "../lib/spatial-layout";
import type { Target } from "../lib/spatial-targets";

type PlacementLevel = "ground" | "middle" | "top";
const levels: Array<{ value: PlacementLevel; label: string; elevation: number }> = [
  { value: "ground", label: "地面", elevation: .2 },
  { value: "middle", label: "中部", elevation: 1.2 },
  { value: "top", label: "顶部", elevation: 2.35 },
];
const levelFor = (elevation: number) => levels.reduce((best, level) => Math.abs(level.elevation - elevation) < Math.abs(best.elevation - elevation) ? level : best, levels[1]);

export function DevicePlacementPanel({ groups, groupedTargets, targetMap, groupModes, targetKey, query, placements, zones, pixelsPerMeter, bounds, placementLevel, onGroupMode, onQuery, onSelect, onPlacementLevel, onPlacements }: {
  groups: Target[];
  groupedTargets: Array<[string, Target[]]>;
  targetMap: Map<string, Target>;
  groupModes: Record<string, "group" | "members">;
  targetKey: string;
  query: string;
  placements: SpatialPlacement[];
  zones: SpatialZone[];
  pixelsPerMeter: number | null;
  bounds: { width: number; height: number };
  placementLevel: PlacementLevel;
  onGroupMode: (id: string, mode: "group" | "members") => void;
  onQuery: (value: string) => void;
  onSelect: (key: string, level: PlacementLevel) => void;
  onPlacementLevel: (level: PlacementLevel) => void;
  onPlacements: (placements: SpatialPlacement[]) => void;
}) {
  const target = targetMap.get(targetKey);
  const placement = placements.find(item => `${item.targetKind}:${item.targetId}` === targetKey);
  const lighting = Boolean(target && (target.kind === "lighting" || ["light", "lamp"].includes(target.device?.kind ?? "") || target.groupMemberIds !== undefined));
  const update = (next: SpatialPlacement) => onPlacements(placements.map(item => item.id === next.id ? next : item));
  const select = (candidate: Target) => {
    const key = `${candidate.kind}:${candidate.id}`, existing = placements.find(item => item.targetKind === candidate.kind && item.targetId === candidate.id);
    onSelect(key, existing ? levelFor(existing.elevation).value : candidate.kind === "lighting" ? "top" : "middle");
  };
  return <section className="spatial-placement-editor">
    <section className="spatial-placement-layer spatial-placement-selector" aria-labelledby="spatial-device-selector-title">
      <header><b>1</b><div><h4 id="spatial-device-selector-title">选择设备</h4><p>从当前米家家庭选择一个目标。已放置设备仍在同一列表中编辑。</p></div></header>
      {groups.map(group => <fieldset key={group.id}><legend>{group.name} · 灯组</legend><label>放置方式<select aria-label={`${group.name} 放置方式`} value={groupModes[group.id] ?? "group"} onChange={event => onGroupMode(group.id, event.target.value as "group" | "members")}><option value="group">整个灯组</option><option value="members" disabled={!group.groupMemberIds?.length}>分别放置成员（{group.groupMemberIds?.length ?? 0}）</option></select></label></fieldset>)}
      <label className="spatial-device-search">搜索设备<input type="search" value={query} placeholder="名称、房间或类型" onChange={event => onQuery(event.target.value)} /></label>
      <div className="spatial-device-picker" role="listbox" aria-label="米家设备列表">{groupedTargets.map(([room, roomTargets]) => <section key={room}><h5>{room}</h5>{roomTargets.map(candidate => { const key = `${candidate.kind}:${candidate.id}`, existing = placements.some(item => item.targetKind === candidate.kind && item.targetId === candidate.id); return <button type="button" role="option" aria-selected={key === targetKey} className={key === targetKey ? "selected" : ""} key={key} onClick={() => select(candidate)}><span className="spatial-device-icon" aria-hidden="true">{candidate.icon}</span><span><strong>{candidate.name}</strong><small>{candidate.kind === "device" ? candidate.groupMemberIds !== undefined ? "灯组" : candidate.memberOf?.length ? "灯组成员" : candidate.device?.kind || "米家设备" : "照明回路"}</small></span>{existing && <b>已放置</b>}</button>; })}</section>)}</div>
      {groupedTargets.length === 0 && <p className="spatial-property-empty">{query ? "没有匹配的设备。" : "当前家庭没有可放置设备。"}</p>}
    </section>
    <section className="spatial-placement-layer spatial-placement-properties" aria-labelledby="spatial-device-properties-title">
      <header><b>2</b><div><h4 id="spatial-device-properties-title">设备属性</h4><p>{target ? placement ? `正在编辑“${placement.name}”` : `“${target.name}”尚未放置` : "先在上方选择一个设备"}</p></div></header>
      {!target && <div className="spatial-property-empty">选择设备后，这里会显示位置、高度、方向和视觉效果。</div>}
      {target && !placement && <><fieldset className="spatial-height-picker"><legend>初始高度</legend>{levels.map(level => <button type="button" key={level.value} className={placementLevel === level.value ? "active" : ""} aria-pressed={placementLevel === level.value} onClick={() => onPlacementLevel(level.value)}>{level.label}<small>{level.elevation.toFixed(2)} m</small></button>)}</fieldset><p className="spatial-placement-hint">现在点击右侧户型图放置“{target.name}”。</p></>}
      {target && placement && <div className="spatial-property-form">
        <fieldset><legend>位置</legend>
          {pixelsPerMeter ? <><DimensionInput label="X（m，距图纸左侧）" value={placement.point.x / pixelsPerMeter} min={0} max={bounds.width / pixelsPerMeter} onChange={x => update({ ...placement, point: { ...placement.point, x: x * pixelsPerMeter } })} /><DimensionInput label="Y（m，距图纸顶部）" value={placement.point.y / pixelsPerMeter} min={0} max={bounds.height / pixelsPerMeter} onChange={y => update({ ...placement, point: { ...placement.point, y: y * pixelsPerMeter } })} /></> : <p>完成比例校准后可精确编辑 X/Y。</p>}
          <DimensionInput label="Z 高度（m）" value={placement.elevation} min={0} max={20} onChange={elevation => update({ ...placement, elevation })} />
          <div className="spatial-level-shortcuts">{levels.map(level => <button type="button" key={level.value} aria-pressed={levelFor(placement.elevation).value === level.value} onClick={() => update({ ...placement, elevation: level.elevation })}>{level.label}</button>)}</div>
          <label>所属空间<select value={placement.zoneId ?? ""} onChange={event => { const zone = zones.find(item => item.id === event.target.value); update({ ...placement, zoneId: zone?.id ?? null }); }}><option value="">未分配区域</option>{zones.map(zone => <option key={zone.id} value={zone.id}>{zone.name}</option>)}</select></label>
        </fieldset>
        <AppearancePanel placement={placement} lighting={lighting} onChange={update} />
        <button type="button" className="danger spatial-remove-placement" onClick={() => { onPlacements(placements.filter(item => item.id !== placement.id)); onSelect("", "middle"); }}>移除“{placement.name}”</button>
        <small>也可以直接点击户型图移动当前设备。</small>
      </div>}
    </section>
  </section>;
}
