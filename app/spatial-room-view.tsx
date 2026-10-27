"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { createTransitioningDeviceEffect, disposeSpatialObject, interpolateVisualState, type SpatialVisualState } from "../lib/spatial-device-effects";
import { spatialIconKind, spatialIconSvg } from "../lib/spatial-device-icons";
import { shouldExpandSpatialMarker } from "../lib/spatial-marker";
import { applySpatialEnvironment, type SpatialEnvironmentMode } from "../lib/spatial-environment";
import { spatialMotorActions, type SpatialMotorAction } from "../lib/spatial-motor-control";
import { useSpatialFullscreen } from "./use-spatial-fullscreen";
import { DevicePlacementPanel } from "./spatial-device-placement-panel";
import { stripPoints, visualProperties, visualParameters, type VisualProperty } from "../lib/spatial-appearance";
import { FurniturePanel } from "./spatial-furniture-panel";
import { furnitureCatalog, type FurnitureKind, type SpatialFurniture } from "../lib/spatial-furniture";
import type { ManagedDevice } from "../lib/device-management";
import { targetsFor, type Target } from "../lib/spatial-targets";
import { createSpatialScene, exportSpatialGlb, fadeSpatialObject, spatialPointToWorld } from "../lib/spatial-layout-three";
import { analyzeFloorPlanImage, type FloorPlanAnalysisOptions } from "../lib/floor-plan-analysis";
import { pixelsPerMeter, pointInPolygon, type SpatialAsset, type SpatialLayoutV1, type SpatialOpening, type SpatialPlacement, type SpatialPoint, type SpatialWall, type SpatialZone } from "../lib/spatial-layout";
import { alignWallGraphNode, buildWallGraphNodes, buildWallRenderPaths, findEnclosedWallFace, materializeWallJunctions, moveWallGraphNode, projectPointToWall, snapWallPoint } from "../lib/wall-editor-geometry";

export type SpatialControlInput = { did: string; siid: number; piid: number; value: boolean | number | string; label: string; propertyKey: string; isPower?: boolean };
type Props = { devices: ManagedDevice[]; homeId: string; connected: boolean; onOpenDevice: (device: ManagedDevice) => void; onQuickControl: (device: ManagedDevice, input: SpatialControlInput) => Promise<"confirmed" | "pending"> };
type QuickProperty = { key: string; name: string; label: string; siid: number; piid: number; min: number; max: number; step: number; unit?: string; value: number };
type PlacementLevel = "ground" | "middle" | "top";

const placementLevels: Array<{ value: PlacementLevel; label: string; elevation: number }> = [{ value: "ground", label: "地面", elevation: .2 }, { value: "middle", label: "中部", elevation: 1.2 }, { value: "top", label: "顶部", elevation: 2.35 }];
function placementLevelFor(elevation: number): PlacementLevel { return placementLevels.reduce((best, level) => Math.abs(level.elevation - elevation) < Math.abs(placementLevels.find(item => item.value === best)!.elevation - elevation) ? level.value : best, "middle" as PlacementLevel); }
function elevationForPlacementLevel(level: PlacementLevel) { return placementLevels.find(item => item.value === level)!.elevation; }
function placementLevelLabel(elevation: number) { return placementLevels.find(item => item.value === placementLevelFor(elevation))!.label; }

function responseError(data: unknown, fallback: string) { return data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : fallback; }
function id(prefix: string) { return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`; }
function assetUrl(homeId: string, kind: "image" | "model", download = false) { return `/api/xiaomi/spatial-layout?homeId=${encodeURIComponent(homeId)}&asset=${kind}${download ? "&download=1" : ""}`; }
function wallSegment(start: SpatialPoint, end: SpatialPoint, thicknessPixels: number, confidence = 1): SpatialWall { return { id: id("wall"), start, end, thicknessPixels, confidence }; }
function visibleWallThickness(zone: SpatialZone) { return Math.min(12, Math.max(4, zone.wallThicknessPixels ?? 8)); }
function visibleSegmentThickness(wall: SpatialWall) { return Math.min(12, Math.max(4, wall.thicknessPixels)); }

function demoLayout(targets: Target[] = []): SpatialLayoutV1 {
  const image: SpatialAsset = { key: `homes/${"0".repeat(64)}/uploads/00000000-0000-0000-0000-000000000000.png`, contentType: "image/png", byteLength: 1 };
  return { version: 1, revision: "layout_00000000-0000-0000-0000-000000000000", baseRevision: null, image, model: { ...image, key: image.key.replace(".png", ".glb"), contentType: "model/gltf-binary" }, imageWidth: 900, imageHeight: 600, calibration: { start: { x: 100, y: 530 }, end: { x: 300, y: 530 }, meters: 4 }, defaults: { wallHeight: 2.7, wallThickness: .12 }, zones: [
    { id: "living", name: "客厅", kind: "room", roomName: "客厅", polygon: [{ x: 70, y: 70 }, { x: 520, y: 70 }, { x: 520, y: 380 }, { x: 70, y: 380 }], wallEdges: [true, true, false, true] },
    { id: "bedroom", name: "主卧", kind: "room", roomName: "主卧", polygon: [{ x: 520, y: 70 }, { x: 830, y: 70 }, { x: 830, y: 380 }, { x: 520, y: 380 }], wallEdges: [true, true, true, false] },
    { id: "balcony", name: "阳台活动区", kind: "area", roomName: null, polygon: [{ x: 180, y: 380 }, { x: 650, y: 380 }, { x: 650, y: 540 }, { x: 180, y: 540 }], wallEdges: [false, false, false, false] },
  ], openings: [{ id: "demo_door", zoneId: "living", edge: 2, kind: "door", offset: .52, width: 48, height: 2.1, sill: 0, confidence: 1 }, { id: "demo_window", zoneId: "bedroom", edge: 1, kind: "window", offset: .5, width: 95, height: 1.2, sill: .9, confidence: 1 }], placements: targets.slice(0, 10).map((target, index) => { const bedroom = target.room === "主卧", entry = bedroom ? { x: 610 + index % 3 * 70, y: 170 + index % 2 * 90, zoneId: "bedroom" } : target.room === "客厅" ? { x: 160 + index % 4 * 90, y: 160 + index % 2 * 120, zoneId: "living" } : { x: 250 + index % 4 * 95, y: 450, zoneId: "balcony" }; return { id: `demo_place_${index}`, targetKind: target.kind, targetId: target.id, name: target.name, room: target.room, zoneId: entry.zoneId, point: { x: entry.x, y: entry.y }, elevation: target.kind === "lighting" ? 2.25 : .9, rotationY: 0 }; }), updatedAt: new Date(0).toISOString() };
}


export default function SpatialRoomView(props: Props) {
  const { devices, homeId, connected } = props;
  const targets = useMemo(() => targetsFor(devices), [devices]);
  const [layout, setLayout] = useState<SpatialLayoutV1 | null>(() => homeId === "demo" ? demoLayout(targets) : null);
  const [loading, setLoading] = useState(homeId !== "demo"), [error, setError] = useState(""), [editing, setEditing] = useState(false);
  useEffect(() => {
    let current = true; const controller = new AbortController();
    if (homeId === "demo") return () => controller.abort();
    fetch(`/api/xiaomi/spatial-layout?homeId=${encodeURIComponent(homeId)}`, { signal: controller.signal }).then(async response => {
      const data = await response.json(); if (!response.ok) throw new Error(responseError(data, "SPATIAL_LAYOUT_LOAD_FAILED"));
      if (current) setLayout(data.layout ?? null);
    }).catch(reason => { if (current && reason.name !== "AbortError") setError(reason.message); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; controller.abort(); };
  }, [homeId]);
  if (loading) return <div className="spatial-empty" role="status">正在读取 3D 空间…</div>;
  if (editing) return <SpatialEditor {...props} targets={targets} initial={layout} onCancel={() => setEditing(false)} onSaved={next => { setLayout(next); setError(""); setEditing(false); }} />;
  return <div className="spatial-shell">
    <div className="spatial-toolbar"><div><strong>3D 空间</strong><small>{layout ? `${layout.walls?.length ?? 0} 面墙 · ${layout.zones.length} 个空间 · ${layout.placements.filter(item => targets.some(target => target.kind === item.targetKind && target.id === item.targetId)).length} 个标记` : "尚未创建空间模型"}</small></div><div>{layout && homeId !== "demo" && <a className="spatial-button secondary" href={assetUrl(homeId, "model", true)}>下载 GLB</a>}<button type="button" className="spatial-button" disabled={homeId === "demo" || !connected} onClick={() => setEditing(true)}>{layout ? "编辑空间" : "开始绘制"}</button></div></div>
    {error && <p className="spatial-alert" role="alert">读取失败：{error}</p>}
    {layout ? <SpatialViewer {...props} layout={layout} targets={targets} /> : <div className="spatial-empty"><span aria-hidden="true">◇</span><h3>从户型图建立空间</h3><p>上传平面图，校准一段实际长度，再勾画房间或无墙区域并放置设备。</p><button type="button" disabled={!connected} onClick={() => setEditing(true)}>创建 3D 空间</button></div>}
    {homeId === "demo" && <p className="spatial-demo-note">演示空间使用虚构数据，设备控制为只读。</p>}
  </div>;
}

function SpatialEditor({ homeId, initial, targets, onCancel, onSaved }: Props & { initial: SpatialLayoutV1 | null; targets: Target[]; onCancel: () => void; onSaved: (layout: SpatialLayoutV1 | null) => void }) {
  const analysisRequest = useRef(0);
  const [furniture, setFurniture] = useState<SpatialFurniture[]>(initial?.furniture ?? []);
  const [furnitureKind, setFurnitureKind] = useState<FurnitureKind>("king-bed"), [selectedFurniture, setSelectedFurniture] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null), [imageUrl, setImageUrl] = useState(initial ? assetUrl(homeId, "image") : "");
  const [size, setSize] = useState({ width: initial?.imageWidth ?? 0, height: initial?.imageHeight ?? 0 });
  const [calibration, setCalibration] = useState(initial?.calibration ?? { start: { x: 0, y: 0 }, end: { x: 0, y: 0 }, meters: 1 });
  const [zones, setZones] = useState<SpatialZone[]>(initial?.zones ?? []), [walls, setWalls] = useState<SpatialWall[]>(() => materializeWallJunctions(initial?.walls ?? [])), [openings, setOpenings] = useState<SpatialOpening[]>(initial?.openings ?? []), [placements, setPlacements] = useState<SpatialPlacement[]>(initial?.placements ?? []);
  const [mode, setMode] = useState<"calibrate" | "zone" | "place" | "furniture">("calibrate"), [draft, setDraft] = useState<SpatialPoint[]>([]), [zoneName, setZoneName] = useState(""), [zoneKind, setZoneKind] = useState<"room" | "area">("room"), [roomName, setRoomName] = useState("");
  const [tool, setTool] = useState<"select" | "wall" | "split" | "zone" | "erase">("select"), [selectedWallId, setSelectedWallId] = useState<string | null>(null), [selectedZoneId, setSelectedZoneId] = useState<string | null>(null), [selectedEdge, setSelectedEdge] = useState<{ zoneId: string; edge: number } | null>(null);
  const [analysisOptions, setAnalysisOptions] = useState<FloorPlanAnalysisOptions>({ minWallThicknessPixels: 12, minWallLengthRatio: .035, mergeDistancePixels: 8, detectOpenings: false });
  const [targetKey, setTargetKey] = useState(""), [targetQuery, setTargetQuery] = useState(""), [placementLevel, setPlacementLevel] = useState<PlacementLevel>("middle"), [busy, setBusy] = useState(false), [analyzing, setAnalyzing] = useState(false), [message, setMessage] = useState("");
  const drag = useRef<({ kind: "wall"; wallId: string; part: "start" | "end" | "wall"; pointer: SpatialPoint; start: SpatialPoint; end: SpatialPoint } | { kind: "node"; pointer: SpatialPoint; origin: SpatialPoint; wallIds: string[] }) | null>(null);
  const calibrated = Math.hypot(calibration.end.x - calibration.start.x, calibration.end.y - calibration.start.y) >= 5 && calibration.meters > 0;
  const renderPaths = useMemo(() => buildWallRenderPaths(walls), [walls]);
  const graphNodes = useMemo(() => buildWallGraphNodes(walls), [walls]);
  const placementTargets = useMemo<Target[]>(() => Array.from(new Map<string, Target>([...placements.map(placement => ({ kind: placement.targetKind, id: placement.targetId, name: placement.name, room: placement.room, icon: "◇", on: null, status: "设备暂不可用" } satisfies Target)), ...targets].map(target => [`${target.kind}:${target.id}`, target])).values()), [placements, targets]);
  const placementTargetMap = useMemo(() => new Map(placementTargets.map(target => [`${target.kind}:${target.id}`, target])), [placementTargets]);
  const [groupPlacementModes, setGroupPlacementModes] = useState<Record<string, "group" | "members">>({});
  const groupTargets = targets.filter(target => target.groupMemberIds !== undefined);
  const pickerTargets = useMemo(() => targets.filter(target => {
    if (target.groupMemberIds !== undefined) return groupPlacementModes[target.id] !== "members";
    if (target.memberOf?.length) return target.memberOf.some(groupId => groupPlacementModes[groupId] === "members");
    return true;
  }), [targets, groupPlacementModes]);
  const placementTargetsByRoom = useMemo(() => { const query = targetQuery.trim().toLocaleLowerCase("zh-CN"), groups = new Map<string, Target[]>(); for (const target of [...pickerTargets].filter(target => !query || `${target.room} ${target.name} ${target.device?.kind ?? ""}`.toLocaleLowerCase("zh-CN").includes(query)).sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))) { const room = target.room || "未分配房间", roomTargets = groups.get(room) ?? []; roomTargets.push(target); groups.set(room, roomTargets); } return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right, "zh-CN")); }, [pickerTargets, targetQuery]);
  const roomOptions = useMemo(() => Array.from(new Set([...targets.map(target => target.room), ...zones.map(zone => zone.roomName), ...placements.map(placement => placement.room)].filter((room): room is string => Boolean(room && room !== "未分配房间")))).sort((left, right) => left.localeCompare(right, "zh-CN")), [targets, zones, placements]);
  const scaleSummary = useMemo(() => { if (!calibrated) return null; const value = pixelsPerMeter(calibration); return { pixelsPerMeter: value, planWidth: size.width / value, planHeight: size.height / value }; }, [calibrated, calibration, size]);
  useEffect(() => () => { if (imageFile && imageUrl.startsWith("blob:")) URL.revokeObjectURL(imageUrl); }, [imageFile, imageUrl]);
  useEffect(() => () => { analysisRequest.current++; }, []);
  async function analyzeImage(image: HTMLImageElement) { const request = ++analysisRequest.current; setAnalyzing(true); setMessage("已完成比例校准，正在提取实心黑墙和双边白芯墙图…"); try { const result = await analyzeFloorPlanImage(image, 1600, { ...analysisOptions, detectOpenings: false }); if (request !== analysisRequest.current) return; const connected = materializeWallJunctions(result.walls, Math.max(1.5, analysisOptions.mergeDistancePixels ?? 8)); setZones([]); setWalls(connected); setOpenings([]); setPlacements([]); setSelectedWallId(null); setTool("select"); setMode("zone"); setMessage(`已生成 ${connected.length} 条墙边和 ${buildWallGraphNodes(connected).length} 个共享节点。T 形交点已拆成共享节点；门窗仍由墙边转换。`); } catch { if (request === analysisRequest.current) setMessage("按当前图像未找到可靠墙线，请提高最小厚度或手动勾画。"); } finally { if (request === analysisRequest.current) setAnalyzing(false); } }
  function loadCurrentImage() { return new Promise<HTMLImageElement>((resolve, reject) => { if (!imageUrl) { reject(new Error("SPATIAL_IMAGE_REQUIRED")); return; } const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error("SPATIAL_IMAGE_LOAD_FAILED")); image.src = imageUrl; }); }
  function chooseImage(file?: File) { if (!file || !["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 10 * 1024 * 1024) { setMessage("请选择 10 MB 以内的 PNG、JPEG 或 WebP。"); return; } const url = URL.createObjectURL(file); const image = new Image(); image.onload = () => { setImageFile(file); setImageUrl(url); setSize({ width: image.naturalWidth, height: image.naturalHeight }); setCalibration({ start: { x: 0, y: 0 }, end: { x: 0, y: 0 }, meters: 1 }); setZones([]); setWalls([]); setOpenings([]); setPlacements([]); setFurniture([]); setSelectedFurniture(""); setDraft([]); setMode("calibrate"); setMessage("图片已载入。请先在图上点击一段已知长度并完成比例校准，再开始墙体分析。"); }; image.src = url; }
  function clientPoint(clientX: number, clientY: number, element: SVGSVGElement): SpatialPoint { const rect = element.getBoundingClientRect(); return { x: (clientX - rect.left) * size.width / rect.width, y: (clientY - rect.top) * size.height / rect.height }; }
  function canvasPoint(event: React.MouseEvent<SVGSVGElement> | React.PointerEvent<SVGSVGElement>): SpatialPoint { return clientPoint(event.clientX, event.clientY, event.currentTarget); }
  function appendWallPoint(value: SpatialPoint) { const tolerance = Math.max(8, size.width * .008); if (draft.length === 0) { setDraft([snapWallPoint(value, value, walls, "", tolerance)]); setMessage("已设置墙体起点。继续左键绘制，右键结束。"); return; } const start = draft.at(-1)!, end = snapWallPoint(value, start, walls, "", tolerance); if (Math.hypot(end.x - start.x, end.y - start.y) < 3) return; const added = wallSegment(start, end, 10), connected = materializeWallJunctions([...walls, added], tolerance), canonicalEnd = connected.filter(wall => wall.id === added.id || wall.id.startsWith(`${added.id}_j`)).flatMap(wall => [wall.start, wall.end]).sort((left, right) => Math.hypot(left.x - end.x, left.y - end.y) - Math.hypot(right.x - end.x, right.y - end.y))[0] ?? end; setWalls(connected); setDraft([canonicalEnd]); setMessage("墙边已添加。继续左键绘制，右键结束。"); }
  function endWallDrawing(event: React.MouseEvent<SVGSVGElement>) { if (tool !== "wall") return; event.preventDefault(); setDraft([]); setMessage("连续画墙已结束。"); }
  function clickPlan(event: React.MouseEvent<SVGSVGElement>) { const value = canvasPoint(event); if (mode === "furniture") { if (!calibrated) { setMessage("请先校准比例。"); return; } if (selectedFurniture) setFurniture(current => current.map(item => item.id === selectedFurniture ? { ...item, point: value } : item)); else { const entry = furnitureCatalog[furnitureKind], nextId = id("furniture"); setFurniture(current => [...current, { id: nextId, kind: furnitureKind, point: value, width: entry.width, depth: entry.depth, height: entry.height, rotation: 0 }]); setSelectedFurniture(nextId); } return; } if (mode === "calibrate") setDraft(current => current.length >= 2 ? [value] : [...current, value]); else if (mode === "zone") { if (tool === "wall") appendWallPoint(value); else if (tool === "zone") { const nearest = graphNodes.map(node => ({ node, distance: Math.hypot(node.point.x - value.x, node.point.y - value.y) })).sort((left, right) => left.distance - right.distance)[0]; if (!nearest || nearest.distance > Math.max(12, size.width * .012)) { setMessage("房间边界必须使用墙图节点；请点击可见节点，或双击封闭区域自动创建。"); return; } setDraft(current => [...current, nearest.node.point]); } else { setSelectedWallId(null); setSelectedZoneId(null); } } else { const target = placementTargetMap.get(targetKey); if (!target) { setMessage(placementTargets.length ? "请先选择要放置的设备或照明目标。" : "当前家庭没有可放置设备，请先同步米家设备。"); return; } const existing = placements.find(item => item.targetKind === target.kind && item.targetId === target.id); const zone = [...zones].reverse().find(item => pointInPolygon(value, item.polygon)); setPlacements(current => [...current.filter(item => !(item.targetKind === target.kind && item.targetId === target.id)), { ...existing, id: existing?.id ?? id("place"), targetKind: target.kind, targetId: target.id, name: target.name, room: target.room, zoneId: zone?.id ?? null, point: value, elevation: elevationForPlacementLevel(placementLevel), rotationY: existing?.rotationY ?? 0 }]); setMessage(`已放置“${target.name}”${zone ? `到“${zone.name}”` : "到未分配区域"}，高度为${placementLevels.find(item => item.value === placementLevel)!.label}。`); } }
  function doubleClickPlan(event: React.MouseEvent<SVGSVGElement>) { if (mode !== "zone" || !["select", "zone"].includes(tool)) return; const face = findEnclosedWallFace(walls, canvasPoint(event)); if (!face) { setMessage("这里还不是由墙边完全闭合的区域；请先补墙或连接节点。"); return; } const name = zoneName.trim() || `空间 ${zones.length + 1}`; setZones(current => [...current, { id: id("zone"), name, kind: zoneKind, roomName: roomName || null, polygon: face, wallEdges: face.map(() => false) }]); setDraft([]); setZoneName(""); setRoomName(""); setTool("select"); setMessage(`已从封闭墙图创建“${name}”。`); }
  function deleteZone(zoneId: string) { setZones(current => current.filter(zone => zone.id !== zoneId)); setOpenings(current => current.filter(opening => opening.zoneId !== zoneId)); setPlacements(current => current.map(item => item.zoneId === zoneId ? { ...item, zoneId: null } : item)); setSelectedZoneId(current => current === zoneId ? null : current); setSelectedEdge(current => current?.zoneId === zoneId ? null : current); setMessage("区域已删除；其中的设备标记已改为未分配。"); }
  function clickZone(zoneId: string) { if (tool === "erase") { deleteZone(zoneId); return; } if (tool === "select") { setSelectedZoneId(zoneId); setSelectedEdge(null); setSelectedWallId(null); } }
  function clickWall(zoneId: string, edge: number) { if (tool === "erase") { deleteZone(zoneId); return; } if (tool === "select") { setSelectedZoneId(zoneId); setSelectedEdge({ zoneId, edge }); setSelectedWallId(null); } }
  function clickSegment(wallId: string) { if (tool === "erase") { setWalls(current => current.filter(wall => wall.id !== wallId)); setOpenings(current => current.filter(opening => opening.wallId !== wallId)); return; } if (tool === "select") { setSelectedWallId(wallId); setSelectedEdge(null); setSelectedZoneId(null); } }
  function selectedSegment() { return selectedWallId ? walls.find(item => item.id === selectedWallId) ?? null : null; }
  function splitWallAt(wallId: string, point?: SpatialPoint) { const selected = walls.find(item => item.id === wallId); if (!selected) return; const middle = point ? projectPointToWall(point, selected) : { x: (selected.start.x + selected.end.x) / 2, y: (selected.start.y + selected.end.y) / 2 }; if (Math.min(Math.hypot(middle.x - selected.start.x, middle.y - selected.start.y), Math.hypot(middle.x - selected.end.x, middle.y - selected.end.y)) < 4) return; const first = { ...selected, end: middle }, second = { ...selected, id: id("wall"), start: middle }; setWalls(current => [...current.filter(wall => wall.id !== selected.id), first, second]); setOpenings(current => current.filter(opening => opening.wallId !== selected.id)); setSelectedWallId(first.id); setMessage("墙体已在指定位置拆分；门窗候选已清除，请重新确认。"); }
  function splitSelectedWall() { const selected = selectedSegment(); if (!selected) { setMessage("请先点击一面墙。"); return; } const middle = { x: (selected.start.x + selected.end.x) / 2, y: (selected.start.y + selected.end.y) / 2 }, first = { ...selected, end: middle }, second = { ...selected, id: id("wall"), start: middle }; setWalls(current => [...current.filter(wall => wall.id !== selected.id), first, second]); setOpenings(current => current.filter(opening => opening.wallId !== selected.id)); setSelectedWallId(first.id); setMessage("墙体已从中心点拆分为两段。"); }
  function mergeSelectedWall() { const selected = selectedSegment(); if (!selected) { setMessage("请先点击一面墙。"); return; } const horizontal = Math.abs(selected.end.x - selected.start.x) >= Math.abs(selected.end.y - selected.start.y), tolerance = Math.max(6, selected.thicknessPixels * 2), candidate = walls.find(wall => { if (wall.id === selected.id) return false; const candidateHorizontal = Math.abs(wall.end.x - wall.start.x) >= Math.abs(wall.end.y - wall.start.y); if (candidateHorizontal !== horizontal) return false; const sameAxis = horizontal ? Math.abs((wall.start.y + wall.end.y) / 2 - (selected.start.y + selected.end.y) / 2) <= tolerance : Math.abs((wall.start.x + wall.end.x) / 2 - (selected.start.x + selected.end.x) / 2) <= tolerance; const gap = Math.min(Math.hypot(wall.start.x - selected.end.x, wall.start.y - selected.end.y), Math.hypot(wall.end.x - selected.end.x, wall.end.y - selected.end.y), Math.hypot(wall.start.x - selected.start.x, wall.start.y - selected.start.y), Math.hypot(wall.end.x - selected.start.x, wall.end.y - selected.start.y)); return sameAxis && gap <= tolerance * 2; }); if (!candidate) { setMessage("没有找到可合并的相邻同轴墙体。"); return; } const points = [selected.start, selected.end, candidate.start, candidate.end], sorted = points.sort((left, right) => horizontal ? left.x - right.x : left.y - right.y), merged = { ...selected, start: sorted[0], end: sorted[sorted.length - 1], thicknessPixels: Math.max(selected.thicknessPixels, candidate.thicknessPixels), confidence: Math.min(selected.confidence, candidate.confidence) }; setWalls(current => [...current.filter(wall => wall.id !== selected.id && wall.id !== candidate.id), merged]); setOpenings(current => current.filter(opening => opening.wallId !== candidate.id)); setSelectedWallId(merged.id); setMessage("相邻同轴中心线已合并。"); }
  function deleteSelectedWall() { const selected = selectedSegment(); if (!selected) { setMessage("请先点击一面墙。"); return; } setWalls(current => current.filter(wall => wall.id !== selected.id)); setOpenings(current => current.filter(opening => opening.wallId !== selected.id)); setSelectedWallId(null); setMessage("墙体候选已删除。"); }
  function deleteSelectedZone() { if (!selectedZoneId) { setMessage("请先点击一个房间或区域。"); return; } deleteZone(selectedZoneId); }
  function convertSelectedWall(kind: "door" | "window") { const selected = selectedSegment(); if (!selected) { setMessage("请先点击一条墙边。"); return; } const length = Math.max(3, Math.hypot(selected.end.x - selected.start.x, selected.end.y - selected.start.y)); setOpenings(current => [...current.filter(opening => opening.wallId !== selected.id), { id: id("opening"), zoneId: null, wallId: selected.id, edge: 0, kind, offset: .5, width: length, height: kind === "door" ? 2.1 : 1.2, sill: kind === "door" ? 0 : .9, confidence: 1 }]); setMessage(kind === "door" ? "整条选中边已转换为门；如范围过大，请先用“加节点”拆分。" : "整条选中边已转换为窗；如范围过大，请先用“加节点”拆分。"); }
  function beginWallDrag(event: React.PointerEvent<SVGElement>, wall: SpatialWall, part: "start" | "end" | "wall") { if (mode !== "zone" || tool !== "select") return; const svg = event.currentTarget.ownerSVGElement; if (!svg) return; event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); setSelectedWallId(wall.id); setSelectedZoneId(null); drag.current = { kind: "wall", wallId: wall.id, part, pointer: clientPoint(event.clientX, event.clientY, svg), start: { ...wall.start }, end: { ...wall.end } }; }
  function beginNodeDrag(event: React.PointerEvent<SVGCircleElement>, node: { point: SpatialPoint; wallIds: string[] }) { if (mode !== "zone" || tool !== "select") return; const svg = event.currentTarget.ownerSVGElement; if (!svg) return; event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); setSelectedWallId(node.wallIds[0] ?? null); setSelectedZoneId(null); drag.current = { kind: "node", pointer: clientPoint(event.clientX, event.clientY, svg), origin: { ...node.point }, wallIds: node.wallIds }; }
  function dragWall(event: React.PointerEvent<SVGSVGElement>) { const active = drag.current; if (!active) return; const point = canvasPoint(event), tolerance = Math.max(8, size.width * .008); setWalls(current => { if (active.kind === "node") { const aligned = event.altKey ? point : alignWallGraphNode(point, active.origin, current, active.wallIds, tolerance), next = event.altKey ? aligned : snapWallPoint(aligned, active.origin, current.filter(wall => !active.wallIds.includes(wall.id)), "", tolerance); return moveWallGraphNode(current, active.origin, next); } const selected = current.find(wall => wall.id === active.wallId); if (!selected) return current; if (active.part === "wall") { const dx = point.x - active.pointer.x, dy = point.y - active.pointer.y, nextStart = { x: active.start.x + dx, y: active.start.y + dy }, nextEnd = { x: active.end.x + dx, y: active.end.y + dy }; return current.map(wall => { if (wall.id === active.wallId) return { ...wall, start: nextStart, end: nextEnd }; const startAtStart = Math.hypot(wall.start.x - active.start.x, wall.start.y - active.start.y) <= 1.5, startAtEnd = Math.hypot(wall.start.x - active.end.x, wall.start.y - active.end.y) <= 1.5, endAtStart = Math.hypot(wall.end.x - active.start.x, wall.end.y - active.start.y) <= 1.5, endAtEnd = Math.hypot(wall.end.x - active.end.x, wall.end.y - active.end.y) <= 1.5; return { ...wall, start: startAtStart ? nextStart : startAtEnd ? nextEnd : wall.start, end: endAtStart ? nextStart : endAtEnd ? nextEnd : wall.end }; }); } const anchor = active.part === "start" ? selected.end : selected.start, original = active.part === "start" ? active.start : active.end, next = event.altKey ? point : snapWallPoint(point, anchor, current, selected.id, tolerance); return current.map(wall => { if (wall.id === selected.id) return { ...wall, [active.part]: next }; const joinsStart = Math.hypot(wall.start.x - original.x, wall.start.y - original.y) <= 1.5, joinsEnd = Math.hypot(wall.end.x - original.x, wall.end.y - original.y) <= 1.5; return joinsStart ? { ...wall, start: next } : joinsEnd ? { ...wall, end: next } : wall; }); }); }
  function finishWallDrag() { if (!drag.current) return; drag.current = null; setWalls(current => materializeWallJunctions(current, Math.max(8, size.width * .008))); }
  useEffect(() => { const onKeyDown = (event: KeyboardEvent) => { if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement) return; if ((event.key === "Delete" || event.key === "Backspace") && selectedWallId) { event.preventDefault(); deleteSelectedWall(); } else if ((event.key === "Delete" || event.key === "Backspace") && selectedZoneId) { event.preventDefault(); deleteSelectedZone(); } else if (event.key.toLowerCase() === "v") { setTool("select"); setDraft([]); } else if (event.key.toLowerCase() === "w") { setTool("wall"); setMode("zone"); setDraft([]); } else if (event.key === "Escape") { setTool("select"); setDraft([]); drag.current = null; } }; window.addEventListener("keydown", onKeyDown); return () => window.removeEventListener("keydown", onKeyDown); });
  function finishCalibration() { if (draft.length !== 2 || !Number.isFinite(calibration.meters) || calibration.meters <= 0) { setMessage("请在图上选择两个端点并输入实际长度。"); return; } setCalibration({ ...calibration, start: draft[0], end: draft[1] }); setDraft([]); void loadCurrentImage().then(image => analyzeImage(image)).catch(reason => setMessage(reason instanceof Error ? reason.message : "图片读取失败")); }
  function finishZone() { if (draft.length < 3 || !zoneName.trim()) { setMessage("空间至少需要三个点和一个名称。"); return; } setZones(current => [...current, { id: id("zone"), name: zoneName.trim(), kind: zoneKind, roomName: roomName || null, polygon: draft, wallEdges: draft.map(() => true) }]); setDraft([]); setZoneName(""); setRoomName(""); setMessage(""); }
  async function upload(kind: "image" | "model", blob: Blob) { const create = await fetch("/api/xiaomi/spatial-layout/uploads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ homeId, kind, contentType: blob.type, byteLength: blob.size }) }); const ticket = await create.json(); if (!create.ok) throw new Error(responseError(ticket, "SPATIAL_UPLOAD_FAILED")); const sent = await fetch(ticket.uploadUrl, { method: "PUT", headers: { "Content-Type": blob.type }, body: blob }); if (!sent.ok) throw new Error("SPATIAL_UPLOAD_FAILED"); return { key: ticket.key, contentType: blob.type, byteLength: blob.size } as SpatialAsset; }
  async function save() { if ((!initial && !imageFile) || !size.width || zones.length === 0 && walls.length === 0 || calibration.start.x === calibration.end.x && calibration.start.y === calibration.end.y) { setMessage("请完成上传、比例校准和至少一面墙或一个空间。"); return; } setBusy(true); setMessage("正在从中心线墙体生成 GLB…"); try { const image = imageFile ? await upload("image", imageFile) : initial!.image; const base = { version: 1 as const, revision: `layout_${crypto.randomUUID()}`, baseRevision: initial?.revision ?? null, image, model: initial?.model ?? { key: image.key.replace(/\.(png|jpg|webp)$/, ".glb"), contentType: "model/gltf-binary", byteLength: 1 }, imageWidth: size.width, imageHeight: size.height, calibration, defaults: initial?.defaults ?? { wallHeight: 2.7, wallThickness: .12 }, zones, walls, openings, placements, furniture, updatedAt: new Date().toISOString() }; const glb = await exportSpatialGlb(base); const model = await upload("model", new Blob([glb], { type: "model/gltf-binary" })); const next = { ...base, model }; const response = await fetch("/api/xiaomi/spatial-layout", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ homeId, layout: next }) }); const data = await response.json(); if (!response.ok) throw new Error(response.status === 409 ? "空间已被其他家庭成员更新，请刷新后再编辑。" : responseError(data, "SPATIAL_LAYOUT_SAVE_FAILED")); onSaved(data.layout); } catch (reason) { setMessage(reason instanceof Error ? reason.message : "保存失败"); } finally { setBusy(false); } }
  async function remove() { if (!initial || !window.confirm("删除当前家庭共享的空间模型？")) return; setBusy(true); try { const response = await fetch(`/api/xiaomi/spatial-layout?homeId=${encodeURIComponent(homeId)}&revision=${encodeURIComponent(initial.revision)}`, { method: "DELETE" }); if (!response.ok) throw new Error(response.status === 409 ? "空间已被其他家庭成员更新，请刷新后再删除。" : "删除失败"); onSaved(null); } catch (reason) { setMessage(reason instanceof Error ? reason.message : "删除失败"); } finally { setBusy(false); } }
  return <div className="spatial-editor"><header><div><button type="button" onClick={onCancel}>← 返回空间</button><h3>编辑墙图</h3><p>校准后只提取墙图。用节点拆分墙边并转换门窗，再从墙图节点或封闭区域创建房间。</p></div><div>{initial && <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>删除</button>}<button type="button" className="primary" disabled={busy || analyzing} onClick={() => void save()}>{busy ? "处理中…" : "保存并生成 GLB"}</button></div></header>
    <div className="spatial-editor-grid"><aside><label className="spatial-upload">上传户型图<input type="file" accept="image/png,image/jpeg,image/webp" onChange={event => chooseImage(event.target.files?.[0])} /></label>{imageUrl && <button type="button" className="spatial-analyze" disabled={analyzing || !calibrated} onClick={() => { const image = new Image(); image.onload = () => void analyzeImage(image); image.src = imageUrl; }}>{analyzing ? "识别中…" : "按当前图片和参数重建墙体"}</button>}<div className={`spatial-scale-summary ${scaleSummary ? "ready" : ""}`}><strong>{scaleSummary ? `1 米 = ${scaleSummary.pixelsPerMeter.toFixed(1)} px` : "比例尚未校准"}</strong><small>{scaleSummary ? `当前图纸约 ${scaleSummary.planWidth.toFixed(1)} × ${scaleSummary.planHeight.toFixed(1)} 米。该比例用于 GLB 墙长、门窗宽度和设备平面坐标，不改变墙线识别结果。` : "在图上选择一段已知长度。比例只负责把图像像素换算为真实米制尺寸。"}</small></div><nav aria-label="绘制步骤"><button className={mode === "calibrate" ? "active" : ""} onClick={() => { setMode("calibrate"); setDraft([]); setSelectedWallId(null); setSelectedZoneId(null); setSelectedEdge(null); }}>1 校准比例</button><button className={mode === "zone" ? "active" : ""} onClick={() => { setMode("zone"); setTool("select"); setDraft([]); }}>2 修正空间 / 墙</button><button className={mode === "place" ? "active" : ""} onClick={() => { setMode("place"); setTool("select"); setDraft([]); setSelectedWallId(null); setSelectedZoneId(null); setSelectedEdge(null); }}>3 放置设备</button><button type="button" className={mode === "furniture" ? "active" : ""} onClick={() => { setMode("furniture"); setDraft([]); }}>4 放置家具</button></nav>
      {mode === "furniture" && <FurniturePanel bounds={size} items={furniture} selected={selectedFurniture} kind={furnitureKind} onSelect={setSelectedFurniture} onKind={value => { setFurnitureKind(value); setSelectedFurniture(""); }} onChange={setFurniture} />}
      {mode === "zone" && imageUrl && selectedSegment() && <fieldset className="spatial-wall-inspector"><legend>选中墙边</legend><label>厚度（px）<input type="number" min="2" max="80" value={Math.round(selectedSegment()!.thicknessPixels)} onChange={event => setWalls(current => current.map(wall => wall.id === selectedWallId ? { ...wall, thicknessPixels: Math.max(2, Number(event.target.value)) } : wall))} /></label><div><button type="button" onClick={splitSelectedWall}>中点加节点</button><button type="button" onClick={mergeSelectedWall}>合并同轴边</button><button type="button" onClick={() => convertSelectedWall("door")}>转换为门</button><button type="button" onClick={() => convertSelectedWall("window")}>转换为窗</button></div><small>转换作用于整条选中边。先双击或用“加节点”切出准确范围，再转换为门窗。</small></fieldset>}
      {mode === "zone" && imageUrl && <fieldset className="spatial-analysis-settings"><legend>CAD 墙图参数</legend><label>最小实心墙厚（px）<input type="number" min="2" max="48" value={analysisOptions.minWallThicknessPixels ?? 12} onChange={event => setAnalysisOptions(value => ({ ...value, minWallThicknessPixels: Number(event.target.value) }))} /></label><label>最短墙长（图宽比例）<input type="number" min=".02" max=".4" step=".005" value={analysisOptions.minWallLengthRatio ?? .035} onChange={event => setAnalysisOptions(value => ({ ...value, minWallLengthRatio: Number(event.target.value) }))} /></label><label>短断点合并距离（px）<input type="number" min="2" max="80" value={analysisOptions.mergeDistancePixels ?? 8} onChange={event => setAnalysisOptions(value => ({ ...value, mergeDistancePixels: Number(event.target.value) }))} /></label><small>这里只识别墙。门窗由用户把拆分后的墙边转换得到，不再根据图片线型猜测。</small></fieldset>}
      {mode === "calibrate" && <fieldset><legend>实际长度</legend><label>米<input type="number" min="0.01" step="0.01" value={calibration.meters} onChange={event => setCalibration(value => ({ ...value, meters: Number(event.target.value) }))} /></label><button type="button" onClick={finishCalibration}>采用这条标尺</button></fieldset>}
      {mode === "zone" && <fieldset><legend>房间 / 区域</legend><label>名称（双击自动创建时可留空）<input value={zoneName} onChange={event => setZoneName(event.target.value)} /></label><label>类型<select value={zoneKind} onChange={event => setZoneKind(event.target.value as "room" | "area")}><option value="room">房间</option><option value="area">区域</option></select></label><label>关联米家房间<select value={roomName} disabled={roomOptions.length === 0} onChange={event => setRoomName(event.target.value)}><option value="">{roomOptions.length ? "不关联" : "暂无房间，请先同步设备"}</option>{roomOptions.map(value => <option key={value}>{value}</option>)}</select></label><button type="button" className={tool === "zone" ? "active" : ""} onClick={() => { setTool("zone"); setDraft([]); }}>按墙图节点勾画</button><button type="button" disabled={tool !== "zone" || draft.length < 3} onClick={finishZone}>闭合空间</button><small>也可直接双击由墙边完全围合的区域。</small></fieldset>}
      {mode === "place" && <DevicePlacementPanel groups={groupTargets} groupedTargets={placementTargetsByRoom} targetMap={placementTargetMap} groupModes={groupPlacementModes} targetKey={targetKey} query={targetQuery} placements={placements} zones={zones} pixelsPerMeter={calibrated ? pixelsPerMeter(calibration) : null} bounds={size} placementLevel={placementLevel} onGroupMode={(groupId, value) => { setGroupPlacementModes(current => ({ ...current, [groupId]: value })); setTargetKey(""); }} onQuery={setTargetQuery} onSelect={(key, level) => { setTargetKey(key); setPlacementLevel(level); }} onPlacementLevel={setPlacementLevel} onPlacements={setPlacements} />}
      {mode === "zone" && <div className="spatial-zone-list">{zones.map(zone => <article key={zone.id} className={selectedZoneId === zone.id ? "selected" : ""}><div className="spatial-zone-fields"><label>空间名称<input aria-label={`${zone.name} 名称`} value={zone.name} onChange={event => setZones(current => current.map(item => item.id === zone.id ? { ...item, name: event.target.value } : item))} /></label><label>米家房间<select value={zone.roomName ?? ""} disabled={roomOptions.length === 0} onChange={event => setZones(current => current.map(item => item.id === zone.id ? { ...item, roomName: event.target.value || null } : item))}><option value="">{roomOptions.length ? "不关联" : "暂无房间，请先同步设备"}</option>{roomOptions.map(value => <option key={value}>{value}</option>)}</select></label><small>{zone.kind === "room" ? "房间" : "区域"} · {zone.wallEdges.filter(Boolean).length}/{zone.wallEdges.length} 面附加墙</small></div><div className="spatial-zone-actions"><button type="button" onClick={() => setZones(current => current.map(item => item.id === zone.id ? { ...item, wallEdges: item.wallEdges.map(flag => !flag) } : item))}>反选墙边</button><button type="button" onClick={() => setZones(current => current.map(item => item.id === zone.id ? { ...item, wallEdges: item.wallEdges.map(() => false) } : item))}>全部无墙</button><button type="button" className="danger" aria-label={`删除 ${zone.name}`} onClick={() => deleteZone(zone.id)}>删除区域</button></div><details className="spatial-zone-edges" open={selectedZoneId === zone.id} onToggle={event => { if (event.currentTarget.open) setSelectedZoneId(zone.id); else setSelectedZoneId(current => current === zone.id ? null : current); }}><summary>边界与附加墙</summary><p>选择墙边会在图中高亮；勾选仅表示沿该边额外生成墙。</p><div>{zone.wallEdges.map((enabled, edge) => <label key={edge} className={`spatial-zone-edge-option ${selectedEdge?.zoneId === zone.id && selectedEdge.edge === edge ? "active" : ""}`} onClick={() => { setSelectedZoneId(zone.id); setSelectedEdge({ zoneId: zone.id, edge }); setSelectedWallId(null); }}><input type="checkbox" checked={enabled} onFocus={() => { setSelectedZoneId(zone.id); setSelectedEdge({ zoneId: zone.id, edge }); setSelectedWallId(null); }} onChange={() => setZones(current => current.map(item => item.id === zone.id ? { ...item, wallEdges: item.wallEdges.map((flag, index) => index === edge ? !flag : flag) } : item))} /><span>墙边 {edge + 1}</span></label>)}</div></details></article>)}</div>}
      {mode === "zone" && openings.length > 0 && <details className="spatial-opening-list"><summary>已转换的门窗边（{openings.length}）</summary><div>{openings.map(opening => <article key={opening.id}><select aria-label="门窗类型" value={opening.kind} onChange={event => setOpenings(current => current.map(item => item.id === opening.id ? { ...item, kind: event.target.value as "door" | "window", height: event.target.value === "door" ? 2.1 : 1.2, sill: event.target.value === "door" ? 0 : .9 } : item))}><option value="door">门</option><option value="window">窗</option></select><small>整条墙图边</small><button type="button" aria-label="恢复为普通墙边" onClick={() => setOpenings(current => current.filter(item => item.id !== opening.id))}>恢复墙</button></article>)}</div></details>}
    </aside><main>{imageUrl && mode === "zone" && <div className="spatial-canvas-toolbar" role="toolbar" aria-label="墙图编辑工具"><button type="button" className={tool === "select" ? "active" : ""} aria-pressed={tool === "select"} onClick={() => { setTool("select"); setDraft([]); }}>↖ 选择 <kbd>V</kbd></button><button type="button" className={tool === "wall" ? "active" : ""} aria-pressed={tool === "wall"} onClick={() => { setTool("wall"); setMode("zone"); setDraft([]); }}>╱ 画墙 <kbd>W</kbd></button><button type="button" className={tool === "split" ? "active" : ""} aria-pressed={tool === "split"} onClick={() => { setTool("split"); setMode("zone"); setDraft([]); }}>＋ 加节点</button><button type="button" disabled={!selectedWallId} onClick={() => convertSelectedWall("window")}>▭ 转窗</button><button type="button" disabled={!selectedWallId} onClick={() => convertSelectedWall("door")}>门 转门</button><button type="button" className={tool === "zone" ? "active" : ""} aria-pressed={tool === "zone"} onClick={() => { setTool("zone"); setMode("zone"); setDraft([]); }}>⬡ 房间</button><button type="button" className={tool === "erase" ? "active" : ""} aria-pressed={tool === "erase"} onClick={() => { setTool("erase"); setMode("zone"); setDraft([]); }}>⌫ 删除</button><span aria-live="polite">{selectedWallId ? "墙边已选中" : tool === "select" ? "拖动节点；Option 关闭对齐" : tool === "wall" ? "左键连续绘制，右键结束" : tool === "split" ? "点击墙边插入节点" : tool === "zone" ? "点击节点，或双击封闭区域" : "点击对象删除"}</span></div>}{imageUrl ? <svg role="application" aria-label="墙图编辑画布" viewBox={`0 0 ${size.width} ${size.height}`} onClick={clickPlan} onDoubleClick={doubleClickPlan} onContextMenu={endWallDrawing} onPointerMove={dragWall} onPointerUp={finishWallDrag} onPointerCancel={finishWallDrag}>
      <image href={imageUrl} width={size.width} height={size.height} opacity=".48" />
      {zones.map(zone => <g key={zone.id} className={selectedZoneId === zone.id ? "selected" : ""}><polygon points={zone.polygon.map(value => `${value.x},${value.y}`).join(" ")} className={`spatial-zone ${zone.kind}`} onClick={event => { if (mode !== "zone") return; event.stopPropagation(); clickZone(zone.id); }} />{zone.polygon.map((value, edge) => { const next = zone.polygon[(edge + 1) % zone.polygon.length], selected = selectedEdge?.zoneId === zone.id && selectedEdge.edge === edge; return <line key={edge} className={`spatial-wall ${zone.wallEdges[edge] ? "enabled" : "disabled"} ${selected ? "selected" : ""}`} x1={value.x} y1={value.y} x2={next.x} y2={next.y} style={{ strokeWidth: visibleWallThickness(zone) }} onClick={event => { if (mode !== "zone") return; event.stopPropagation(); clickWall(zone.id, edge); }} />; })}<text x={zone.polygon[0].x + 8} y={zone.polygon[0].y + 22}>{zone.name}</text></g>)}
      {renderPaths.map(path => <polyline key={path.id} className="spatial-wall-path" points={path.points.map(point => `${point.x},${point.y}`).join(" ")} style={{ strokeWidth: Math.min(12, Math.max(4, path.thicknessPixels)) }} />)}
      {walls.map(wall => <g key={wall.id}><line className={`spatial-wall-segment ${selectedWallId === wall.id ? "selected" : ""}`} x1={wall.start.x} y1={wall.start.y} x2={wall.end.x} y2={wall.end.y} style={{ strokeWidth: selectedWallId === wall.id ? Math.max(4, visibleSegmentThickness(wall) * .28) : 18 }} onPointerDown={event => beginWallDrag(event, wall, "wall")} onDoubleClick={event => { if (mode !== "zone" || tool !== "select") return; event.stopPropagation(); const svg = event.currentTarget.ownerSVGElement; if (svg) splitWallAt(wall.id, clientPoint(event.clientX, event.clientY, svg)); }} onClick={event => { if (mode !== "zone") return; event.stopPropagation(); const svg = event.currentTarget.ownerSVGElement; if (tool === "wall" && svg) appendWallPoint(clientPoint(event.clientX, event.clientY, svg)); else if (tool === "split" && svg) splitWallAt(wall.id, clientPoint(event.clientX, event.clientY, svg)); else clickSegment(wall.id); }} />{mode === "zone" && selectedWallId === wall.id && <><circle className="spatial-wall-handle" cx={wall.start.x} cy={wall.start.y} r="8" onPointerDown={event => beginWallDrag(event, wall, "start")} onClick={event => event.stopPropagation()} /><circle className="spatial-wall-handle" cx={wall.end.x} cy={wall.end.y} r="8" onPointerDown={event => beginWallDrag(event, wall, "end")} onClick={event => event.stopPropagation()} /></>}</g>)}
      {mode === "zone" && graphNodes.map(node => <circle key={node.id} className={`spatial-graph-node ${node.wallIds.length > 1 ? "shared" : "endpoint"} ${draft.some(point => Math.hypot(point.x - node.point.x, point.y - node.point.y) < 1) ? "used" : ""}`} cx={node.point.x} cy={node.point.y} r={node.wallIds.length > 1 ? 6 : 5} onPointerDown={event => beginNodeDrag(event, node)} onClick={event => { if (tool !== "zone") return; event.stopPropagation(); setDraft(current => [...current, node.point]); }} />)}
      {openings.map(opening => { const wall = opening.wallId ? walls.find(item => item.id === opening.wallId) : undefined, zone = opening.zoneId ? zones.find(item => item.id === opening.zoneId) : undefined; if (!wall && !zone) return null; const start = wall?.start ?? zone!.polygon[opening.edge], end = wall?.end ?? zone!.polygon[(opening.edge + 1) % zone!.polygon.length], dx = end.x - start.x, dy = end.y - start.y, length = Math.max(1, Math.hypot(dx, dy)), half = Math.min(length, opening.width) / 2, center = opening.offset * length, from = Math.max(0, center - half), to = Math.min(length, center + half), x1 = start.x + dx * from / length, y1 = start.y + dy * from / length, x2 = start.x + dx * to / length, y2 = start.y + dy * to / length; return <g key={opening.id} className={`spatial-opening-edge ${opening.kind}`}><line x1={x1} y1={y1} x2={x2} y2={y2}/><text x={(x1 + x2) / 2 + 8} y={(y1 + y2) / 2 - 8}>{opening.kind === "door" ? "门" : "窗"}</text></g>; })}
      {draft.length > 0 && <polyline points={draft.map(value => `${value.x},${value.y}`).join(" ")} className="spatial-draft" />}
      {calibrated && furniture.map(item => { const scale = pixelsPerMeter(calibration), width = item.width * scale, depth = item.depth * scale; return <g key={item.id} role="button" tabIndex={mode === "furniture" ? 0 : -1} aria-label={`选择家具 ${furnitureCatalog[item.kind].name}`} transform={`translate(${item.point.x} ${item.point.y}) rotate(${item.rotation})`} onClick={event => { if (mode !== "furniture") return; event.stopPropagation(); setSelectedFurniture(item.id); }} onKeyDown={event => { if (mode === "furniture" && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); setSelectedFurniture(item.id); } }}><rect x={-width / 2} y={-depth / 2} width={width} height={depth} fill={selectedFurniture === item.id ? "#fff2ec" : "#e9edf2"} fillOpacity=".85" stroke={selectedFurniture === item.id ? "#ff6b2c" : "#596574"} strokeWidth={2} /><text textAnchor="middle" pointerEvents="none" fill="#17202b" fontSize={14}>{furnitureCatalog[item.kind].name}</text></g>; })}
      {placements.map(value => { const target = placementTargetMap.get(`${value.targetKind}:${value.targetId}`); return <g key={value.id} className="spatial-placement" role="button" tabIndex={mode === "place" ? 0 : -1} aria-label={`编辑设备 ${value.name}`} onClick={event => { if (mode !== "place") return; event.stopPropagation(); setTargetKey(`${value.targetKind}:${value.targetId}`); setPlacementLevel(placementLevelFor(value.elevation)); }} onKeyDown={event => { if (mode === "place" && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); setTargetKey(`${value.targetKind}:${value.targetId}`); setPlacementLevel(placementLevelFor(value.elevation)); } }}>
        {calibrated && <g transform={`translate(${value.point.x} ${value.point.y}) rotate(${value.rotationY * 180 / Math.PI}) scale(${pixelsPerMeter(calibration)})`} fill="none" stroke="#855800" strokeWidth={.04} pointerEvents="none">
          {value.appearance?.type === "strip" ? <polyline points={stripPoints(value.appearance.segments).map(point => `${point.x},${point.y}`).join(" ")} /> : value.appearance?.type === "area" ? <rect x={-value.appearance.length / 2} y={-value.appearance.width / 2} width={value.appearance.length} height={value.appearance.width} /> : <line x1={-(value.appearance?.length ?? 1.2) / 2} x2={(value.appearance?.length ?? 1.2) / 2} y1={0} y2={0} />}
        </g>}<circle cx={value.point.x} cy={value.point.y} r="13" /><text className="spatial-placement-icon" textAnchor="middle" x={value.point.x} y={value.point.y + 5}>{target?.icon ?? "◇"}</text><text className="spatial-placement-name" x={value.point.x + 18} y={value.point.y + 5}>{value.name}</text></g>; })}
    </svg> : <label className="spatial-plan-empty">选择 PNG、JPEG 或 WebP 户型图<input type="file" accept="image/png,image/jpeg,image/webp" onChange={event => chooseImage(event.target.files?.[0])} /></label>}<p className="spatial-canvas-help">{mode === "calibrate" ? "在图上点击标尺的两个端点。" : mode === "zone" ? "V 选择 · W 连续画墙（左键落点、右键结束）· 拖动节点默认水平/垂直对齐，按住 Option 自由拖动 · 双击墙体拆分 · Delete 删除。" : mode === "furniture" ? "选择家具后点击图纸放置或移动，尺寸采用校准比例。" : "选择稳定身份的设备或照明目标，再点击放置位置。"}</p></main></div>{message && <p className="spatial-alert" role="status">{message}</p>}
  </div>;
}

function SpatialViewer({ layout, homeId, targets, connected, onOpenDevice, onQuickControl }: Props & { layout: SpatialLayoutV1; targets: Target[] }) {
  const { root: fullscreenRoot, toggle: fullscreenToggle, fullscreen, enter: enterFullscreen, exit: exitFullscreen } = useSpatialFullscreen();
  const [deviceListOpen, setDeviceListOpen] = useState(false);
  const [visualValues, setVisualValues] = useState<Record<string, Partial<SpatialVisualState>>>({});
  const confirmedVisualValues = useRef<Record<string, Partial<SpatialVisualState>>>({});
  const parameterGeneration = useRef(0);
  const [parameterVersion, setParameterVersion] = useState(0);
  useEffect(() => {
    if (!connected || homeId === "demo") return;
    let active = true, timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const cache = new Map<string, VisualProperty[]>();
    const refresh = async () => {
      const generation = parameterGeneration.current;
      const updates: Record<string, Partial<SpatialVisualState>> = {};
      for (const placement of layout.placements) {
        if (!active) return;
        const target = targets.find(item => item.kind === placement.targetKind && item.id === placement.targetId), device = target?.device;
        updates[placement.id] = confirmedVisualValues.current[placement.id] ?? {};
        if (!device?.did || !device.detail || target?.online === false || placement.targetKind === "lighting") continue;
        try {
          const specKey = `${device.detail}:${device.urn ?? ""}`;
          let properties = cache.get(specKey);
          if (!properties) {
            const response = await fetch(`/api/xiaomi/spec?model=${encodeURIComponent(device.detail)}${device.urn ? `&urn=${encodeURIComponent(device.urn)}` : ""}`, { signal: controller.signal });
            const data = await response.json();
            if (!response.ok) throw new Error("SPEC_FAILED");
            properties = visualProperties((data.groups ?? []).flatMap((group: { properties: VisualProperty[] }) => group.properties));
            cache.set(specKey, properties);
          }
          if (!properties.length) continue;
          const query = [...new Set(properties.map(property => `${property.siid}.${property.piid}`))].join(",");
          const response = await fetch(`/api/xiaomi/control?did=${encodeURIComponent(device.did)}&properties=${query}`, { cache: "no-store", signal: controller.signal });
          const data = await response.json();
          if (response.ok) {
            updates[placement.id] = visualParameters(properties, data.values ?? {});
            confirmedVisualValues.current[placement.id] = updates[placement.id];
          }
        } catch { /* Failed reads clear the corresponding visual parameters. */ }
      }
      if (active && generation === parameterGeneration.current) setVisualValues(updates);
      if (active) timer = setTimeout(refresh, 10000);
    };
    void refresh();
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [connected, homeId, layout.placements, targets, parameterVersion]);
  const [resetVersion, setResetVersion] = useState(0);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const effectsRef = useRef<THREE.Group | null>(null);
  const renderedStates = useRef<Record<string, SpatialVisualState>>({});
  const visualTransitions = useRef<Record<string, { from: SpatialVisualState; to: SpatialVisualState; started: number; duration: number }>>({});
  const host = useRef<HTMLDivElement | null>(null), [selected, setSelected] = useState(""), [focus, setFocus] = useState(""), [webgl, setWebgl] = useState(true), [environmentMode, setEnvironmentMode] = useState<SpatialEnvironmentMode>("day");
  const environmentModeRef = useRef(environmentMode);
  useEffect(() => { environmentModeRef.current = environmentMode; }, [environmentMode]);
  const [readings, setReadings] = useState<Record<string, boolean | null>>({});
  const confirmedReadings = useRef<Record<string, boolean | null>>({});
  const readGeneration = useRef(0);
  const powerTargets = useMemo(() => targets.filter(target => target.power && layout.placements.some(item => item.targetKind === target.kind && item.targetId === target.id)), [targets, layout.placements]);
  useEffect(() => {
    if (!connected || homeId === "demo") return;
    let active = true, timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const refresh = async () => {
      const generation = ++readGeneration.current;
      const values: Record<string, boolean | null> = {};
      const groups = new Map<string, Target[]>();
      for (const target of powerTargets) groups.set(target.power!.did, [...(groups.get(target.power!.did) ?? []), target]);
      for (const [did, items] of groups) {
        if (!active) return;
        try {
          const properties = [...new Set(items.map(item => `${item.power!.siid}.${item.power!.piid}`))].join(",");
          const response = await fetch(`/api/xiaomi/control?did=${encodeURIComponent(did)}&properties=${properties}`, { cache: "no-store", signal: controller.signal });
          const data = await response.json();
          for (const item of items) {
            const raw = data.values?.[`${item.power!.siid}.${item.power!.piid}`];
            const key = `${item.kind}:${item.id}`;
            values[key] = response.ok && typeof raw === "boolean" ? raw : confirmedReadings.current[key] ?? null;
          }
        } catch { for (const item of items) { const key = `${item.kind}:${item.id}`; values[key] = confirmedReadings.current[key] ?? null; } }
      }
      if (active && generation === readGeneration.current) {
        confirmedReadings.current = values;
        setReadings(values);
        const readPlacementIds = new Set(layout.placements.filter(item => `${item.targetKind}:${item.targetId}` in values).map(item => item.id));
        setVisualValues(current => Object.fromEntries(Object.entries(current).map(([id, state]) => [id, readPlacementIds.has(id) ? { ...state, pending: false } : state])));
      }
      if (active) timer = setTimeout(refresh, 10000);
    };
    void refresh();
    return () => { active = false; ++readGeneration.current; controller.abort(); clearTimeout(timer); };
  }, [connected, homeId, powerTargets]);
  const targetMap = useMemo(() => new Map(targets.map(target => {
    const key = `${target.kind}:${target.id}`;
    return [key, key in readings ? { ...target, on: readings[key] } : target];
  })), [targets, readings]);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const scene = new THREE.Scene(); sceneRef.current = scene;
    const hemisphere = new THREE.HemisphereLight(); hemisphere.name = "spatial-environment-hemisphere"; scene.add(hemisphere);
    const sun = new THREE.DirectionalLight(); sun.name = "spatial-environment-directional"; sun.position.set(8, 14, 9); scene.add(sun);
    applySpatialEnvironment(scene, environmentModeRef.current);
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true }); } catch { queueMicrotask(() => setWebgl(false)); return; }
    const labels = new CSS2DRenderer();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.domElement.className = "spatial-webgl"; renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute("aria-label", "3D 空间：拖动旋转，双指滑动平移，捏合或加减键缩放");
    labels.domElement.className = "spatial-label-layer";
    const modeControl = document.createElement("div"); modeControl.className = "spatial-environment-mode"; modeControl.setAttribute("role", "group"); modeControl.setAttribute("aria-label", "3D 光照模式");
    for (const [mode, label] of [["day", "日间"], ["night", "夜间"]] as const) { const button = document.createElement("button"); button.type = "button"; button.dataset.mode = mode; button.textContent = label; const active = mode === environmentModeRef.current; button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active)); button.onclick = () => setEnvironmentMode(mode); modeControl.append(button); }
    element.replaceChildren(renderer.domElement, labels.domElement, modeControl);
    const camera = new THREE.OrthographicCamera(-8, 8, 6, -6, .1, 200);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.touches.ONE = THREE.TOUCH.ROTATE;
    controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
    controls.enableDamping = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    controls.minZoom = .3; controls.maxZoom = 8; controls.minPolarAngle = .1; controls.maxPolarAngle = Math.PI / 2 - .05;
    const model = createSpatialScene(layout, focus); scene.add(model);
    const focused = focus ? model.getObjectByName(`zone:${focus}:floor`) : undefined;
    const box = new THREE.Box3().setFromObject(focused ?? model);
    const center = box.getCenter(new THREE.Vector3()), extent = box.getSize(new THREE.Vector3());
    controls.target.copy(center);
    camera.position.set(center.x + Math.max(extent.x, 5), center.y + 12, center.z + Math.max(extent.z, 5));
    camera.zoom = Math.min(2.6, 10 / Math.max(extent.x, extent.z, 3)); controls.update();
    const resize = () => {
      const width = Math.max(1, element.clientWidth), height = Math.max(1, element.clientHeight);
      renderer.setSize(width, height); labels.setSize(width, height);
      camera.left = -width / 100; camera.right = width / 100; camera.top = height / 100; camera.bottom = -height / 100;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize); observer.observe(element); resize();
    const keydown = (event: KeyboardEvent) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "-", "="].includes(event.key)) return;
      event.preventDefault();
      if (event.key === "+" || event.key === "=") camera.zoom = Math.min(8, camera.zoom * 1.15);
      else if (event.key === "-") camera.zoom = Math.max(.3, camera.zoom / 1.15);
      else {
        const delta = new THREE.Vector3(event.key === "ArrowLeft" ? -.4 : event.key === "ArrowRight" ? .4 : 0, 0, event.key === "ArrowUp" ? -.4 : event.key === "ArrowDown" ? .4 : 0);
        camera.position.add(delta); controls.target.add(delta);
      }
      camera.updateProjectionMatrix(); controls.update();
    };
    const wheelPan = (event: WheelEvent) => {
      if (event.ctrlKey || event.deltaMode !== 0) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
      const delta = right.multiplyScalar(event.deltaX * (camera.right - camera.left) / camera.zoom / element.clientWidth)
        .add(up.multiplyScalar(-event.deltaY * (camera.top - camera.bottom) / camera.zoom / element.clientHeight));
      camera.position.add(delta); controls.target.add(delta); controls.update();
    };
    renderer.domElement.addEventListener("wheel", wheelPan, { capture: true, passive: false });
    renderer.domElement.addEventListener("keydown", keydown);
    let frame = 0;
    const animate = () => {
      const before = controls.target.clone();
      controls.target.x = THREE.MathUtils.clamp(controls.target.x, center.x - 20, center.x + 20);
      controls.target.z = THREE.MathUtils.clamp(controls.target.z, center.z - 20, center.z + 20);
      camera.position.add(controls.target.clone().sub(before));
      controls.update();
      for (const marker of element.querySelectorAll<HTMLButtonElement>(".spatial-marker")) {
        const hovered = marker.matches(":hover"), hoverEnded = marker.dataset.hovered === "true" && !hovered;
        const expanded = shouldExpandSpatialMarker(camera.zoom, marker.dataset.expanded === "true" && !hoverEnded, marker.classList.contains("selected") || hovered || marker.matches(":focus-visible"));
        marker.dataset.hovered = String(hovered); marker.dataset.expanded = String(expanded); marker.classList.toggle("compact", !expanded);
      }
      renderer.render(scene, camera); labels.render(scene, camera); frame = requestAnimationFrame(animate);
    };
    animate();
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); controls.dispose(); renderer.dispose();
      renderer.domElement.removeEventListener("keydown", keydown);
      renderer.domElement.removeEventListener("wheel", wheelPan, true);
      disposeSpatialObject(scene); sceneRef.current = null; effectsRef.current = null; element.replaceChildren();
    };
  }, [homeId, layout, focus, resetVersion]);
  useEffect(() => {
    if (sceneRef.current) applySpatialEnvironment(sceneRef.current, environmentMode);
    for (const button of host.current?.querySelectorAll<HTMLButtonElement>(".spatial-environment-mode button") ?? []) {
      const active = button.dataset.mode === environmentMode; button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active));
    }
  }, [environmentMode]);
  useEffect(() => {
    const scene = sceneRef.current; if (!scene) return;
    const animationFrames: number[] = [];
    if (effectsRef.current) { scene.remove(effectsRef.current); disposeSpatialObject(effectsRef.current); effectsRef.current.traverse(child => { if (child instanceof CSS2DObject) child.element.remove(); }); }
    const effects = new THREE.Group(); effectsRef.current = effects; scene.add(effects);
    for (const placement of layout.placements) {
      const target = targetMap.get(`${placement.targetKind}:${placement.targetId}`);
      // Historical switch placements remain editable but are not physical objects in the room.
      if (!target) continue;
      const focusedZone = focus ? layout.zones.find(zone => zone.id === focus) : undefined;
      const inFocus = !focusedZone || placement.zoneId === focusedZone.id || placement.zoneId === null && pointInPolygon(placement.point, focusedZone.polygon);
      const state: SpatialVisualState = { kind: target.kind === "lighting" || ["light", "lamp"].includes(target.device?.kind ?? "") || target.groupMemberIds !== undefined ? "light" : target.device?.kind === "aircondition" ? "climate" : target.device?.kind === "curtain" ? "curtain" : "other", online: target.online, ...visualValues[placement.id], on: target.on };
      const now = performance.now(), running = visualTransitions.current[placement.id];
      const previous = running ? interpolateVisualState(running.from, running.to, running.duration ? (now - running.started) / running.duration : 1) : renderedStates.current[placement.id] ?? state;
      const renderedState = inFocus ? state : { ...state, on: state.kind === "light" ? false : state.on };
      const transition = createTransitioningDeviceEffect(previous, renderedState, placement.appearance, placement.elevation);
      const effect = transition.group;
      if (!inFocus) { if (state.kind === "light") fadeSpatialObject(effect); else effect.visible = false; }
      const reducedMotion = !inFocus || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const duration = reducedMotion ? 0 : state.kind === "curtain" ? 1800 : state.kind === "light" ? 1400 : 0;
      visualTransitions.current[placement.id] = { from: previous, to: state, started: now, duration };
      transition.apply(reducedMotion ? 1 : 0);
      if (!reducedMotion && renderedStates.current[placement.id]) {
        const started = now;
        const animate = (time: number) => {
          const progress = duration ? Math.min(1, (time - started) / duration) : 1;
          transition.apply(progress);
          if (progress < 1) animationFrames.push(requestAnimationFrame(animate));
        };
        animationFrames.push(requestAnimationFrame(animate));
      } else transition.apply(1);
      renderedStates.current[placement.id] = state;
      const world = spatialPointToWorld(layout, placement.point);
      effect.position.copy(world); effect.rotation.y = -placement.rotationY; effects.add(effect);
      if (!inFocus) continue;
      const button = document.createElement("button"); button.type = "button";
      button.className = `spatial-marker compact ${selected === placement.id ? "selected" : ""} ${state.on === true && state.online !== false ? "on" : ""} ${state.online === false ? "offline" : ""} ${state.pending ? "pending" : ""}`;
      const detail = state.kind === "climate" && state.temperature !== undefined ? ` · ${state.temperature}°C` : state.kind === "light" && state.brightness !== undefined ? ` · ${Math.round(state.brightness * 100)}%` : state.kind === "curtain" && state.position !== undefined ? ` · ${state.positionIsTarget ? "目标 " : ""}${Math.round(state.position * 100)}%` : "";
      const icon = document.createElement("span"); icon.className = "spatial-marker-icon"; icon.innerHTML = spatialIconSvg(spatialIconKind(target.device?.kind, target.kind === "lighting", target.groupMemberIds !== undefined));
      const copy = document.createElement("span"); copy.className = "spatial-marker-copy"; copy.textContent = `${placement.name}${detail}${state.pending ? " · 同步中" : ""}`; button.append(icon, copy);
      button.setAttribute("aria-label", `${placement.name}，${placementLevelLabel(placement.elevation)}，${statusLabel(target)}${detail}`);
      button.onclick = () => setSelected(placement.id);
      const label = new CSS2DObject(button); label.position.set(world.x, placement.elevation, world.z); effects.add(label);
    }
    return () => { for (const frame of animationFrames) cancelAnimationFrame(frame); };
  }, [layout, targetMap, visualValues, focus, resetVersion, selected]);

  const selection = layout.placements.find(item => item.id === selected), rawSelectedTarget = selection ? targetMap.get(`${selection.targetKind}:${selection.targetId}`) : undefined;
  const selectedTarget = rawSelectedTarget;
  return <div ref={fullscreenRoot} className={`spatial-viewer-layout ${fullscreen ? "spatial-fullscreen" : ""}`} role={fullscreen ? "dialog" : undefined} aria-modal={fullscreen || undefined} aria-label={fullscreen ? "全屏空间控制" : undefined}><section className="spatial-stage"><p className="spatial-camera-help">拖动旋转 · 右键平移 · 双指滑动平移 · 捏合缩放 · 墙厚 {Math.round(layout.defaults.wallThickness * 100)} cm</p><div className="spatial-focus"><label>聚焦空间<select value={focus} onChange={event => { setFocus(event.target.value); setSelected(""); }}><option value="">全屋</option>{layout.zones.map(zone => <option key={zone.id} value={zone.id}>{zone.name}</option>)}</select></label><button type="button" onClick={() => { setFocus(""); setSelected(""); setResetVersion(value => value + 1); }}>重置视图</button>{fullscreen && <button type="button" aria-expanded={deviceListOpen} aria-controls="spatial-fullscreen-devices" onClick={() => { setDeviceListOpen(value => !value); setSelected(""); }}>设备列表</button>}<button type="button" ref={fullscreenToggle} onClick={() => { setDeviceListOpen(false); if (fullscreen) void exitFullscreen(); else enterFullscreen(); }}>{fullscreen ? "退出全屏" : "全屏控制"}</button></div>{fullscreen && homeId === "demo" && <span className="spatial-fullscreen-demo">演示数据 · 只读预览</span>}{webgl ? <div className="spatial-three" ref={host} data-focus={focus} /> : <div className="spatial-webgl-fallback"><strong>此浏览器无法显示 WebGL 空间</strong><p>仍可使用下方无障碍设备列表查看状态与打开详情。</p></div>}</section><aside className={`spatial-side-panel ${selection ? "open" : ""}`}>{selection && selectedTarget ? <QuickPanel key={selection.id} connected={connected && homeId !== "demo"} placement={selection} target={selectedTarget} visualState={visualValues[selection.id] ?? {}} onClose={() => setSelected("")} onOpen={() => { void exitFullscreen().then(() => { if (selectedTarget.device) onOpenDevice(selectedTarget.device); }); }} onControl={async (device, input) => { ++parameterGeneration.current; const result = await onQuickControl(device, input); if (!input.isPower) setParameterVersion(value => value + 1); return result; }} onVisualState={state => {
      ++parameterGeneration.current;
      if (state.on !== undefined) {
        ++readGeneration.current;
        setReadings(current => ({ ...current, [`${selection.targetKind}:${selection.targetId}`]: state.on! }));
      }
      setVisualValues(current => ({ ...current, [selection.id]: { ...current[selection.id], ...state } }));
    }} /> : <><h3>空间设备</h3><p>缩小时显示按设备类型区分的小图标，放大或选中后显示名称与读数。设备状态以文字为准；窗帘优先显示实测位置，仅有目标值时会标注“目标”。</p></>}</aside><section id="spatial-fullscreen-devices" className={`spatial-accessible-list ${deviceListOpen || !webgl ? "spatial-list-open" : ""}`} aria-label="空间设备列表"><h3>全部空间标记</h3>{layout.zones.map(zone => <div key={zone.id}><h4>{zone.name}</h4>{layout.placements.filter(item => item.zoneId === zone.id && targetMap.has(`${item.targetKind}:${item.targetId}`)).map(item => { const target = targetMap.get(`${item.targetKind}:${item.targetId}`); return <button key={item.id} type="button" onClick={() => { setSelected(item.id); setDeviceListOpen(false); }}><span>{target?.icon ?? "◇"}</span><span><strong>{item.name}</strong><small>{statusLabel(target)}</small></span><b>›</b></button>; })}</div>)}{layout.placements.some(item => !item.zoneId) && <div><h4>未分配区域</h4>{layout.placements.filter(item => !item.zoneId && targetMap.has(`${item.targetKind}:${item.targetId}`)).map(item => { const target = targetMap.get(`${item.targetKind}:${item.targetId}`); return <button key={item.id} type="button" onClick={() => { setSelected(item.id); setDeviceListOpen(false); }}><span>{target?.icon ?? "◇"}</span><span><strong>{item.name}</strong><small>{target ? "位置未归属空间" : "设备缺失"}</small></span><b>›</b></button>; })}</div>}</section></div>;
}

function statusLabel(target?: Target) { return !target ? "设备缺失" : target.online === false ? "离线" : target.on === true ? "已开启" : target.on === false ? "已关闭" : "状态待确认"; }
function QuickPanel({ connected, placement, target, visualState, onClose, onOpen, onControl, onVisualState }: {
  onVisualState: (state: Partial<SpatialVisualState>) => void;
  connected: boolean;
  placement: SpatialPlacement;
  target: Target;
  visualState: Partial<SpatialVisualState>;
  onClose: () => void;
  onOpen: () => void;
  onControl: Props["onQuickControl"];
}) {
  type SpecProperty = VisualProperty & { key: string; label: string; writable: boolean; range?: { min: number; max: number; step: number }; unit?: string; choices?: Array<{ value: boolean | number | string; label: string; sourceLabel?: string }> };
  const device = target.device, canLoad = Boolean(connected && device?.did && device.detail);
  const visualCallback = useRef(onVisualState);
  useEffect(() => { visualCallback.current = onVisualState; }, [onVisualState]);
  const [property, setProperty] = useState<QuickProperty | null>(null), [motorActions, setMotorActions] = useState<SpatialMotorAction[]>([]), [value, setValue] = useState(0), [loading, setLoading] = useState(canLoad), [notice, setNotice] = useState("");
  useEffect(() => {
    let current = true;
    if (!connected || !device?.did || !device.detail) return;
    fetch(`/api/xiaomi/spec?model=${encodeURIComponent(device.detail)}`).then(async specResponse => {
      const data = await specResponse.json();
      if (!specResponse.ok) throw new Error(responseError(data, "SPEC_FAILED"));
      if (!current) return;
      const properties = (data.groups as Array<{ properties: SpecProperty[] }>).flatMap(group => group.properties);
      setMotorActions(spatialMotorActions(properties));
      const candidate = properties.find(item => item.readable && item.writable && item.range && ["brightness", "target-position", "target-temperature"].includes(item.name));
      const visuals = visualProperties(properties);
      const requested = [...new Map([...visuals, ...(candidate ? [candidate] : [])].map(item => [`${item.siid}.${item.piid}`, item])).values()];
      if (!requested.length) return;
      const controlResponse = await fetch(`/api/xiaomi/control?did=${encodeURIComponent(device.did!)}&properties=${requested.map(item => `${item.siid}.${item.piid}`).join(",")}`, { cache: "no-store" });
      const body = await controlResponse.json();
      if (!controlResponse.ok || !current) return;
      visualCallback.current(visualParameters(visuals, body.values ?? {}));
      if (!candidate?.range) return;
      const raw = body.values?.[`${candidate.siid}.${candidate.piid}`];
      if (typeof raw !== "number") return;
      const next: QuickProperty = { key: candidate.key, name: candidate.name, label: candidate.label, siid: candidate.siid, piid: candidate.piid, unit: candidate.unit, min: candidate.range.min, max: candidate.range.max, step: candidate.range.step, value: raw };
      setProperty(next); setValue(raw);
    }).catch(() => { if (current) setNotice("快捷能力读取失败，可在设备详情中重试。"); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [connected, device?.did, device?.detail, placement.id]);

  function preview(input: SpatialControlInput) {
    if (input.isPower) return { on: Boolean(input.value) };
    if (!property || typeof input.value !== "number") return {};
    const normalized = Math.max(0, Math.min(1, (input.value - property.min) / (property.max - property.min || 1)));
    if (property.name === "brightness") return { brightness: normalized };
    if (property.name === "target-temperature") return { temperature: input.value };
    if (property.name === "target-position") return { targetPosition: normalized, position: normalized, positionIsTarget: true };
    return {};
  }

  async function apply(input: SpatialControlInput) {
    if (!device) return;
    const rollback: Partial<SpatialVisualState> = {
      on: target.on,
      brightness: visualState.brightness,
      temperature: visualState.temperature,
      position: visualState.position,
      currentPosition: visualState.currentPosition,
      targetPosition: visualState.targetPosition,
      positionIsTarget: visualState.positionIsTarget,
      pending: false,
    };
    setLoading(true); setNotice("");
    visualCallback.current({ ...preview(input), pending: true });
    try {
      const result = await onControl(device, input);
      if (result === "confirmed") visualCallback.current({ pending: false });
      setNotice(result === "confirmed" ? "已回读确认设备状态" : "已发送，3D 为待同步预览；下次读取会校正。");
    } catch (reason) {
      visualCallback.current(rollback);
      setNotice(reason instanceof Error ? reason.message : "控制失败，已恢复先前显示。");
    } finally { setLoading(false); }
  }

  const curtain = target.device?.kind === "curtain";
  return <div className="spatial-quick"><button type="button" className="close" aria-label="关闭控制面板" onClick={onClose}>×</button><span>{placement.targetKind === "lighting" ? "照明目标" : "硬件设备"}</span><h3>{placement.name}</h3><p>{placement.room} · {statusLabel(target)}</p>
    {curtain && <dl className="spatial-position-readout"><div><dt>当前位置</dt><dd>{visualState.currentPosition === undefined ? "待读取" : `${Math.round(visualState.currentPosition * 100)}%`}</dd></div><div><dt>目标位置</dt><dd>{visualState.targetPosition === undefined ? "未报告" : `${Math.round(visualState.targetPosition * 100)}%`}</dd></div></dl>}
    {visualState.pending && <p role="status" className="spatial-pending-state">3D 预览正在等待设备同步</p>}
    {target.power && device && <button type="button" className="spatial-power" disabled={!connected || target.online === false || loading} onClick={() => void apply({ ...target.power!, value: target.on !== true, label: "电源", propertyKey: "power", isPower: true })}>{target.on === true ? "关闭" : "开启"}</button>}
    {motorActions.length > 0 && device && <fieldset className="spatial-motor-controls"><legend>电机控制</legend><div>{motorActions.map(action => <button type="button" key={action.action} className={action.action} disabled={!connected || target.online === false || loading} onClick={() => void apply({ did: device.did!, siid: action.siid, piid: action.piid, value: action.value, label: action.label, propertyKey: action.propertyKey })}>{action.label}</button>)}</div></fieldset>}
    {loading && <small role="status">正在读取或确认能力…</small>}
    {property && <fieldset><label htmlFor="spatial-range">{property.label}：{value}{property.unit ?? ""}</label><input id="spatial-range" type="range" min={property.min} max={property.max} step={property.step} value={value} disabled={!connected || loading} onChange={event => setValue(Number(event.target.value))} /><button type="button" disabled={!connected || loading || !device} onClick={() => void apply({ did: device!.did!, siid: property.siid, piid: property.piid, value, label: property.label, propertyKey: property.key })}>应用</button></fieldset>}
    {notice && <p role="status" className="spatial-control-note">{notice}</p>}<button type="button" className="spatial-details" disabled={!device} onClick={onOpen}>打开设备详情</button>{!connected && <small>演示或未连接状态仅可查看，不能控制物理设备。</small>}</div>;
}
