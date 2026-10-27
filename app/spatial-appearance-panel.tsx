"use client";
import { useState } from "react";
import type { SpatialPlacement } from "../lib/spatial-layout";

// Keep intermediate input (empty, minus sign, decimal point) until it can be committed.
export function DimensionInput({ label, value, min, max, step = .01, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => { const number = Number(draft); if (draft !== null && draft.trim() && Number.isFinite(number) && number >= min && number <= max) onChange(number); setDraft(null); };
  return <label>{label}<input type="number" min={min} max={max} step={step} value={draft ?? value} onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === "Enter") { commit(); event.currentTarget.blur(); } if (event.key === "Escape") setDraft(null); }} /></label>;
}

export const defaultAppearance = { type: "point" as const, length: 1.2, width: 1, segments: [{ length: 1.2, angle: 0 }] };
export function AppearancePanel({ placement, lighting, onChange }: { placement: SpatialPlacement; lighting: boolean; onChange: (placement: SpatialPlacement) => void }) {
  const appearance = placement.appearance ?? defaultAppearance;
  const update = (value: Partial<typeof appearance>) => onChange({ ...placement, appearance: { ...appearance, ...value } });
  return <fieldset className="spatial-furniture-panel"><legend>{placement.name} · 外观</legend>
    <DimensionInput label="方向（°）" value={Math.round(placement.rotationY * 180 / Math.PI)} min={-360} max={360} step={1} onChange={value => onChange({ ...placement, rotationY: value * Math.PI / 180 })} />
    {lighting && <label>灯光类型<select value={appearance.type} onChange={event => update({ type: event.target.value as typeof appearance.type })}><option value="point">点光源</option><option value="strip">灯带（多段）</option><option value="area">面光源</option></select></label>}
    {(!lighting || appearance.type !== "strip") && <DimensionInput label={lighting ? "长度 / 直径（m）" : "长度（m）"} value={appearance.length} min={.05} max={30} onChange={length => update({ length })} />}
    {lighting && appearance.type === "area" && <DimensionInput label="宽度（m）" value={appearance.width} min={.02} max={20} onChange={width => update({ width })} />}
    {lighting && appearance.type === "strip" && <><p>每段从上一段终点开始；角度相对整体方向，0° 向右、90° 向图纸下方。</p>{appearance.segments.map((segment, index) => <fieldset key={index}><legend>第 {index + 1} 段</legend>
      <DimensionInput label="段长（m）" value={segment.length} min={.05} max={30} onChange={length => update({ segments: appearance.segments.map((item, i) => i === index ? { ...item, length } : item) })} />
      <DimensionInput label="段方向（°）" value={segment.angle} min={-360} max={360} step={1} onChange={angle => update({ segments: appearance.segments.map((item, i) => i === index ? { ...item, angle } : item) })} />
      <button type="button" disabled={appearance.segments.length === 1} onClick={() => update({ segments: appearance.segments.filter((_, i) => i !== index) })}>移除第 {index + 1} 段</button>
    </fieldset>)}<button type="button" disabled={appearance.segments.length >= 32} onClick={() => update({ segments: [...appearance.segments, { length: 1, angle: 90 }] })}>添加灯带段</button></>}
    <small>仅改变空间示意，不更改设备能力。输入后按 Enter 或离开输入框应用。</small>
  </fieldset>;
}
