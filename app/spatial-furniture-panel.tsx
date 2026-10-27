"use client";
import { DimensionInput } from "./spatial-appearance-panel";
import { furnitureCatalog, type FurnitureKind, type SpatialFurniture } from "../lib/spatial-furniture";

export function FurniturePanel({ items, selected, kind, bounds, onSelect, onKind, onChange }: {
  items: SpatialFurniture[]; selected: string; kind: FurnitureKind;
  bounds: { width: number; height: number };
  onSelect: (id: string) => void; onKind: (kind: FurnitureKind) => void; onChange: (items: SpatialFurniture[]) => void;
}) {
  const item = items.find(value => value.id === selected);
  return <section className="spatial-furniture-panel"><h4>家具与装饰</h4>
    <label>家具类型<select value={kind} onChange={event => onKind(event.target.value as FurnitureKind)}>{Object.entries(furnitureCatalog).map(([key, entry]) => <option key={key} value={key}>{entry.name}</option>)}</select></label>
    <button type="button" onClick={() => onSelect("")}>放置新家具</button>
    <p>{item ? "点击图纸移动选中家具，或调整下方尺寸与角度。" : "点击图纸放置家具。尺寸以米为单位，跟随校准比例。"}</p>
    <label>已放置家具<select value={selected} onChange={event => onSelect(event.target.value)}><option value="">新家具</option>{items.map((value, index) => <option key={value.id} value={value.id}>{index + 1} · {furnitureCatalog[value.kind].name}</option>)}</select></label>
    {item && <fieldset><legend>{furnitureCatalog[item.kind].name}</legend>
      {(["x", "y"] as const).map(axis => <label key={axis}>{axis.toUpperCase()} 位置（图纸 px）<input type="number" min={0} max={axis === "x" ? bounds.width : bounds.height} value={Math.round(item.point[axis])} onChange={event => { const value = Number(event.target.value); if (value < 0 || value > (axis === "x" ? bounds.width : bounds.height)) return; onChange(items.map(current => current.id === item.id ? { ...current, point: { ...current.point, [axis]: value } } : current)); }} /></label>)}
      {(["width", "depth", "height", "rotation"] as const).map(field => <DimensionInput key={field} label={{ width: "宽（m）", depth: "深（m）", height: "高（m）", rotation: "旋转（°）" }[field]} min={field === "rotation" ? -360 : .02} max={field === "rotation" ? 360 : 10} step={field === "rotation" ? 1 : .01} value={item[field]} onChange={value => onChange(items.map(current => current.id === item.id ? { ...current, [field]: value } : current))} />)}
      <button type="button" onClick={() => { onChange(items.filter(value => value.id !== item.id)); onSelect(""); }}>移除家具</button>
    </fieldset>}
  </section>;
}
