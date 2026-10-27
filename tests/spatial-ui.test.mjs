import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../app/spatial-room-view.tsx", import.meta.url), "utf8");
const placementSource = await readFile(new URL("../app/spatial-device-placement-panel.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("spatial UI exposes a dedicated top-level view, accessible markers, fallback and advanced details", async () => {
  const management = await readFile(new URL("../app/device-management.tsx", import.meta.url), "utf8");
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(management, />◇ 3D 空间<\/button>/); assert.match(page, /\["3D 家庭","◇"\]/); assert.match(page, /spatial-home-entry/);
  assert.match(source, /button\.setAttribute\("aria-label"/);
  assert.match(source, /spatial-webgl-fallback/);
  assert.match(source, /打开设备详情/);
  assert.match(source, /演示空间使用虚构数据/);
  assert.match(source, /onSaved=\{next => \{ setLayout\(next\); setError\(""\); setEditing\(false\); \}\}/);
});

test("editor and responsive UI include wall-free areas, side panel and mobile bottom sheet", () => {
  assert.match(source, /全部无墙/); assert.match(source, /wallEdges/); assert.match(source, /比例校准/); assert.match(source, /已转换的门窗边/); assert.match(source, /空间已被其他家庭成员更新/);
  assert.match(source, /画墙 <kbd>W/); assert.match(source, /＋ 加节点/); assert.match(source, /双击.*拆分/); assert.match(source, /合并同轴边/); assert.match(source, /转换为门/); assert.match(source, /转换为窗/); assert.match(source, /visibleSegmentThickness\(wall\)/); assert.match(source, /clickSegment\(wall\.id\)/); assert.match(source, /spatial-wall-handle/); assert.match(source, /buildWallRenderPaths/); assert.match(source, /findEnclosedWallFace/); assert.match(source, /不再根据图片线型猜测/);
  assert.match(source, /width: length/); assert.match(source, /graphNodes\.map/); assert.match(source, /双击由墙边完全围合的区域/); assert.match(source, /beginNodeDrag/); assert.match(source, /moveWallGraphNode/); assert.match(source, /materializeWallJunctions/); assert.match(source, /onContextMenu=\{endWallDrawing\}/); assert.match(source, /event\.altKey/); assert.match(source, /▭ 转窗/); assert.match(source, /门 转门/); assert.match(source, /function deleteZone/); assert.match(source, /clickZone\(zone\.id\)/); assert.match(source, /deleteSelectedZone/); assert.match(source, /区域已删除/); assert.match(source, /墙边 \{edge \+ 1\}/); assert.match(source, /selectedEdge\?\.zoneId === zone\.id/); assert.match(source, /额外生成墙/);
  assert.match(source, /const roomOptions/); assert.match(source, /const placementTargets/); assert.match(source, /placementTargetsByRoom/); assert.match(placementSource, /米家设备列表/); assert.match(placementSource, /candidate\.icon/); assert.match(source, /placementLevels/); assert.match(placementSource, /Z 高度（m）/); assert.match(source, /elevationForPlacementLevel/); assert.match(source, /pixelsPerMeter/); assert.match(source, /1 米 =/); assert.match(source, /不改变墙线识别结果/); assert.match(source, /roomName: roomName \|\| null/); assert.match(source, /DevicePlacementPanel/); assert.match(source, /mode !== "zone"/); assert.match(source, /暂无房间，请先同步设备/); assert.match(placementSource, /已放置/);
  assert.match(placementSource, />选择设备</); assert.match(placementSource, />设备属性</); assert.match(placementSource, /X（m，距图纸左侧）/); assert.match(placementSource, /Y（m，距图纸顶部）/); assert.match(placementSource, /所属空间/); assert.match(placementSource, /AppearancePanel/);
  assert.match(styles, /stroke-linejoin:miter/); assert.match(styles, /spatial-canvas-toolbar/); assert.match(styles, /spatial-wall\.selected/); assert.match(styles, /spatial-zone-edge-option\.active/);
  assert.match(styles, /spatial-zone-actions/); assert.match(styles, /spatial-placement-editor/); assert.match(styles, /spatial-placement-properties/); assert.match(styles, /spatial-device-picker/); assert.match(styles, /spatial-height-picker/); assert.match(styles, /spatial-scale-summary/); assert.match(styles, /spatial-placement circle\{pointer-events:auto;cursor:pointer\}/);
  assert.match(styles, /spatial-side-panel\.open/); assert.match(styles, /bottom:64px/); assert.match(styles, /prefers-reduced-motion/);
  assert.match(styles, /spatial-marker\.compact \.spatial-marker-icon\{width:28px;height:28px/);
  assert.match(source, /marker\.matches\(":hover"\)/);
  assert.match(source, /hoverEnded = marker\.dataset\.hovered === "true" && !hovered/);
  assert.match(styles, /@media\(max-width:900px\)/); assert.match(styles, /@media\(max-width:560px\)/);
  assert.match(styles, /spatial-editor-grid>main\{align-self:start;position:sticky/); assert.match(styles, /spatial-editor-grid>main\{position:static;max-height:none\}/);
});

test("quick controls are verified and unknown outcomes are explicitly pending without retry", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /result\.status==="outcome_unknown"\)return "pending"/);
  assert.match(page, /Object\.is\(state\.values/);
  assert.doesNotMatch(page.match(/async function applySpatialControl[\s\S]+?\n  }/)?.[0] ?? "", /while\s*\(|retry/i);
  assert.match(source, /brightness/); assert.match(source, /target-position/); assert.match(source, /target-temperature/);
  assert.match(source, /当前位置/); assert.match(source, /目标位置/); assert.match(source, /pending: true/); assert.match(source, /3D 为待同步预览/);
  const quickApply = source.match(/async function apply\(input: SpatialControlInput\)[\s\S]+?finally \{ setLoading\(false\); \}/)?.[0] ?? "";
  assert.ok(quickApply.indexOf("pending: true") < quickApply.indexOf("await onControl"));
  assert.match(source, /confirmedReadings/); assert.match(source, /confirmedVisualValues/); assert.match(source, /createTransitioningDeviceEffect/);
});

test("fullscreen keeps controls reachable, isolates navigation and provides touch panels", async () => {
  const fullscreen = await readFile(new URL("../app/use-spatial-fullscreen.ts", import.meta.url), "utf8");
  assert.match(source, /全屏控制/);
  assert.match(source, /退出全屏/);
  assert.match(source, /aria-modal=\{fullscreen \|\| undefined\}/);
  assert.match(source, /aria-expanded=\{deviceListOpen\}/);
  assert.match(source, /deviceListOpen \|\| !webgl/);
  assert.match(source, /exitFullscreen\(\).then/);
  assert.match(fullscreen, /requestFullscreen\?\./);
  assert.match(fullscreen, /sibling.inert = true/);
  assert.match(fullscreen, /item.element.inert = item.inert/);
  assert.match(fullscreen, /previousFocus.focus\(\)/);
  assert.match(fullscreen, /event.key === "Escape"/);
  assert.match(fullscreen, /event.key !== "Tab"/);
  assert.match(fullscreen, /fullscreenchange/);
  assert.match(styles, /spatial-fullscreen.*height:100dvh/);
  assert.match(styles, /min-height:48px;min-width:48px/);
  assert.match(styles, /max-height:45dvh/);
  assert.match(styles, /safe-area-inset-bottom/);
});
