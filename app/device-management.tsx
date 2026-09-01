"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildDeviceManagementModel,
  type LightingControl,
  type LightingTopology,
  type ManagedDevice,
  type ManagedDeviceCategory,
  type ManagedDeviceRecord,
} from "../lib/device-management";

type Props = {
  devices: ManagedDevice[];
  room: string;
  connected: boolean;
  onSelectRoom: (room: string) => void;
  onOpenDevice: (device: ManagedDevice, mappedDevice?: ManagedDevice) => void;
};

const categoryLabels: Record<ManagedDeviceCategory, string> = {
  "smart-light": "智能灯具",
  controller: "中控屏",
  switch: "实体开关",
  "voice-alias": "无线派生端点",
  "wired-load": "有线派生端点",
  group: "灯具组合",
  other: "智能设备",
};
const hiddenRoom = /勿关|勿删|语音|隐藏/;

function roomPriority(room: string) { return hiddenRoom.test(room) ? 1 : 0; }
function channelLabel(control: LightingControl) {
  if (control.channelIndex !== null) return `按键 ${control.channelIndex}`;
  if (control.channelSiid !== null) return `服务 ${control.channelSiid}`;
  return "关联按键";
}
function connectionLabel(control: LightingControl) {
  if (control.relation === "wired-smart-light-power") return "有线供电";
  if (control.relation === "wired-load") return control.evidence === "inferred" ? "有线回路（推定）" : "有线直连";
  if (control.relation === "wireless-control") return "无线控制";
  return "关系待确认";
}
function topologyKindLabel(topology: LightingTopology) {
  if (topology.kind === "smart-light-group") return "智能灯组";
  if (topology.kind === "smart-light") return "智能灯具";
  if (topology.kind === "ordinary-load") return "普通灯回路";
  return "目标待确认";
}
type PreviewChannel = NonNullable<ManagedDevice["topology"]>["channels"][number];

function channelStatusLabel(channel: PreviewChannel) {
  if (channel.classification === "wireless-unconfigured") return "无线未配置";
  if (channel.classification === "control-data-unavailable") return "控制对象不可用";
  if (channel.classification === "control-data-failed") return "控制对象读取失败";
  if (channel.classification === "control-data-incomplete") return "控制对象不完整";
  if (channel.classification === "inferred-wired") return "有线回路（推定）";
  return "待确认";
}

function channelPreviewPresentation(channel: PreviewChannel, targetKinds: Array<string | undefined>) {
  const relations = new Set(channel.edges.map(edge => edge.relation));
  const unconfigured = targetKinds.length > 0 && targetKinds.every(kind => kind === "unconfigured");
  const dual = relations.has("wireless-control") && relations.has("wired-smart-light-power");
  if (channel.classification === "wireless-unconfigured") return { tone: "wireless", label: "无线未配置" };
  if (channel.classification === "inferred-wired") return { tone: "inferred-wired", label: "推定有线" };
  if (unconfigured) return { tone: "unknown", label: "未配置" };
  if (dual) return { tone: "mixed", label: "无线 + 供电" };
  if (relations.has("wireless-control")) return { tone: "wireless", label: "无线" };
  if (relations.has("wired-smart-light-power")) return { tone: "wired", label: "供电" };
  if (relations.has("wired-load")) return { tone: "wired", label: "有线" };
  if (channel.connectionType === "wireless") return { tone: "wireless", label: "无线" };
  if (channel.connectionType === "wired") return { tone: "wired", label: "有线" };
  return { tone: "unknown", label: channelStatusLabel(channel) };
}

export default function DeviceManagement({ devices, room, connected, onSelectRoom, onOpenDevice }: Props) {
  const [view, setView] = useState<"hardware" | "topology">("hardware");
  const [selectedTopology, setSelectedTopology] = useState("");
  const model = useMemo(() => buildDeviceManagementModel(devices), [devices]);
  const endpointsById = useMemo(() => new Map(model.endpoints.flatMap(record => record.device.did ? [[record.device.did, record.device] as const] : [])), [model.endpoints]);
  const rooms = useMemo(() => ["全屋", ...Array.from(new Set([
    ...model.records.map(record => record.device.room),
    ...model.topologies.map(topology => topology.room),
  ])).sort((left, right) => roomPriority(left) - roomPriority(right) || left.localeCompare(right, "zh-CN"))], [model]);
  const roomRecords = useMemo(() => model.records.filter(record => room === "全屋" || record.device.room === room), [model.records, room]);
  const groupedRooms = useMemo(() => Array.from(new Set(roomRecords.map(record => record.device.room)))
    .sort((left, right) => roomPriority(left) - roomPriority(right) || left.localeCompare(right, "zh-CN"))
    .map(name => ({ name, records: roomRecords.filter(record => record.device.room === name) })), [roomRecords]);
  const topologies = useMemo(() => model.topologies.filter(topology => room === "全屋" || topology.room === room), [model.topologies, room]);
  const activeTopology = topologies.find(topology => topology.key === selectedTopology) ?? topologies[0];

  return <section className="dm-shell" aria-label="米家设备管理">
    <header className="dm-intro"><div><span className="dm-eyebrow">MIJIA HOME</span><h2>设备管理</h2><p>硬件按米家房间展示；照明视图按灯具位置分别聚合有线回路、无线控制和智能灯供电。</p></div><span className={`dm-connection ${connected ? "connected" : "demo"}`}>{connected ? "米家云已连接" : "演示设备"}</span></header>

    <section className="dm-summary" aria-label="家庭设备统计">
      <SummaryCard icon="▦" value={model.totals.devices} label="实际硬件" tone="neutral" />
      <SummaryCard icon="☀" value={model.totals.lights} label="照明目标" tone="orange" />
      <SummaryCard icon="⌘" value={model.totals.switches} label="开关与中控" tone="violet" />
      <SummaryCard icon="⌁" value={model.totals.aliases} label="无线派生端点" tone="blue" />
    </section>

    <div className="dm-filter-group"><span className="dm-filter-label">房间</span><div className="dm-room-tabs">{rooms.map(item => <button key={item} type="button" className={item === room ? "selected" : ""} onClick={() => onSelectRoom(item)}>{item}</button>)}</div></div>
    <div className="dm-view-bar"><div className="dm-view-tabs" role="tablist" aria-label="设备展示方式">
      <button type="button" role="tab" aria-selected={view === "hardware"} className={view === "hardware" ? "selected" : ""} onClick={() => setView("hardware")}>▦ 开关与硬件</button>
      <button type="button" role="tab" aria-selected={view === "topology"} className={view === "topology" ? "selected" : ""} onClick={() => setView("topology")}>⌁ 实际照明</button>
    </div><p>{view === "hardware" ? "每个物理 DID 只显示一张卡片，派生设备作为对应按键内容展示。" : "同家庭全局查找关联关系，普通灯按有线派生位置归类，智能灯按自身位置归类。"}</p></div>

    {view === "hardware" ? <div className="dm-room-inventory">{groupedRooms.map(group => <section key={group.name} className="dm-room-section"><div className="dm-room-heading"><div><strong>{group.name}</strong>{hiddenRoom.test(group.name) && <span>仅保留真实硬件</span>}</div><small>{group.records.length} 台硬件</small></div><div className="dm-room-grid">{group.records.map(record => <DeviceRecordCard key={`${record.device.homeId}:${record.device.did ?? record.device.id}`} record={record} endpointsById={endpointsById} onOpen={() => onOpenDevice(record.device)} onOpenMapped={(endpoint) => onOpenDevice(record.device, endpoint)} onOpenMember={onOpenDevice} />)}</div></section>)}{!groupedRooms.length && <EmptyState title="这个房间没有实际硬件" detail="开关派生端点不会在本视图中单独显示，请切换到实际照明视图查看控制关系。" />}</div>
      : <div className="dm-topology-view">{activeTopology ? <div className="dm-topology-explorer"><aside className="dm-topology-list" aria-label="实际照明目标"><div className="dm-list-heading"><strong>实际照明目标</strong><small>{topologies.length} 个</small></div>{topologies.map(topology => <button type="button" key={topology.key} className={`dm-topology-item ${topology.key === activeTopology.key ? "selected" : ""}`} onClick={() => setSelectedTopology(topology.key)}><span className="dm-light-icon">☀</span><div><strong>{topology.name}</strong><small>{topology.room} · {topologyKindLabel(topology)} · {topology.controls.length} 个控制来源</small></div>{topology.unresolved && <em>待确认</em>}</button>)}</aside>
        <section className="dm-topology-stage"><div className="dm-stage-heading"><div><span>{activeTopology.room} · {topologyKindLabel(activeTopology)}</span><h3>{activeTopology.name}</h3><p>{activeTopology.controls.filter(control => control.connection === "wired").length} 个有线控制 · {activeTopology.controls.filter(control => control.connection === "wireless").length} 个无线控制 · {activeTopology.controls.filter(control => control.connection === "unknown").length} 个关系待确认</p></div><TargetState topology={activeTopology} /></div>
          <LightingCanvas topology={activeTopology} onOpenDevice={onOpenDevice} />
          <div className="dm-legend"><span><i className="wired" />有线直连 / 供电</span><span><i className="wireless" />无线控制</span><span><i className="unknown" />关系待确认</span></div>
          <TopologyDetails topology={activeTopology} onOpenDevice={onOpenDevice} />
        </section></div> : <EmptyState title="这个房间暂未识别到照明目标" detail="模式读取失败的端点会保留为待确认；同步成功后将自动按真实模式重建拓扑。" />}</div>}
  </section>;
}

function SummaryCard({ icon, value, label, tone }: { icon: string; value: number; label: string; tone: string }) { return <article className={`dm-summary-card ${tone}`}><span>{icon}</span><div><strong>{value}</strong><small>{label}</small></div></article>; }

function DeviceRecordCard({ record, endpointsById, onOpen, onOpenMapped, onOpenMember }: { record: ManagedDeviceRecord; endpointsById: Map<string, ManagedDevice>; onOpen: () => void; onOpenMapped: (device: ManagedDevice) => void; onOpenMember: (device: ManagedDevice) => void }) {
  const { device, category, groupMembers } = record;
  const channels = category === "switch" || category === "controller" ? device.topology?.channels ?? [] : [];
  const summary = category === "group" ? groupMembers.length ? `${groupMembers.length} 台已公开成员` : "成员关系暂未公开"
    : channels.length ? `${channels.length} 个实际 switch 服务` : `${device.status} · 点击查看设备设置`;
  return <article className={`dm-record-card dm-record-kind-${category} ${device.online === false ? "offline" : ""}`} role="button" tabIndex={0} onClick={onOpen} onKeyDown={event => { if (event.currentTarget === event.target && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onOpen(); } }}>
    <div className="dm-record-top"><span className={`dm-record-icon ${device.color}`}>{category === "group" ? "◫" : device.icon}</span><span className={`dm-category dm-category-${category}`}>{categoryLabels[category]}</span></div>
    <h3>{device.name}</h3><p>{summary}</p>
    {channels.length > 0 && <div className="dm-channel-preview">{channels.map(channel => {
      const targets = channel.targets.length ? channel.targets : [{ id: "", targetKey: "", name: channel.controlObjects[0]?.targetName ?? channel.label, room: channel.controlObjects[0]?.targetRoom ?? device.room, kind: channel.controlObjects[0]?.targetKind }];
      const primaryTarget = targets[0];
      const { tone, label } = channelPreviewPresentation(channel, targets.map(target => target.kind));
      const targetName = targets.length > 1 ? `${primaryTarget.name} +${targets.length - 1}` : primaryTarget.name;
      const mappedEndpoint = channel.targets.length === 1 ? endpointsById.get(primaryTarget.id) : undefined;
      return <button type="button" key={channel.key} className={`dm-channel-row ${tone}`} title={`${label} · ${targets.map(target => target.name).join("、")}${channel.channelSiid !== null ? ` · s${channel.channelSiid}` : ""}`} onClick={event => { event.stopPropagation(); if (mappedEndpoint) onOpenMapped(mappedEndpoint); else onOpen(); }}><i className="dm-channel-status">{label}</i><span className="dm-channel-name">{targetName}</span><small className="dm-channel-siid">{channel.channelSiid !== null ? `s${channel.channelSiid}` : ""}</small></button>;
    })}</div>}
    {category === "group" && groupMembers.length > 0 && <div className="dm-group-members">{groupMembers.map(member => <button key={`${member.did}:${member.name}`} type="button" onClick={event => { event.stopPropagation(); onOpenMember(member); }}><span className={member.color}>{member.icon}</span><span><strong>{member.name}</strong><small>{member.room} · {member.did}</small></span><b>›</b></button>)}</div>}
    {category === "group" && !groupMembers.length && <div className="dm-group-unknown">组合设备 · 成员关系暂未公开</div>}
    <div className="dm-record-footer"><span>{device.room}</span>{device.did ? <code title={device.did}>{device.did}</code> : <small>演示设备</small>}<b>›</b></div>
  </article>;
}

function TargetState({ topology }: { topology: LightingTopology }) {
  const offline = topology.online === false;
  const label = offline ? "离线" : topology.on === true ? "已开启" : topology.on === false ? "已关闭" : "状态未知";
  return <span className={`dm-target-state ${offline ? "offline" : topology.on === true ? "on" : ""}`}>{label}</span>;
}

function TopologyDetails({ topology, onOpenDevice }: { topology: LightingTopology; onOpenDevice: (device: ManagedDevice, mappedDevice?: ManagedDevice) => void }) {
  const sections: Array<{ key: LightingControl["relation"]; title: string }> = [{ key: "wired-load", title: "有线直连回路" }, { key: "wired-smart-light-power", title: "智能灯有线供电" }, { key: "wireless-control", title: "无线控制" }, { key: "unknown", title: "关系待确认" }];
  return <div className="dm-control-groups">
    {sections.map(section => { const controls = topology.controls.filter(control => control.relation === section.key); const title = section.key === "wired-load" && controls.length > 0 && controls.every(control => control.evidence === "inferred") ? "有线回路（拓扑推定）" : section.title; return controls.length ? <section key={section.key}><h4>{title}</h4><div className="dm-control-grid">{controls.map(control => <ControlButton key={`${section.key}:${control.device.did}:${control.channelSiid}`} control={control} onOpen={onOpenDevice} />)}</div></section> : null; })}
    {topology.lights.length > 0 && <section><h4>{topology.kind === "smart-light-group" ? "智能灯组本体" : "智能灯具本体"}</h4><div className="dm-control-grid">{topology.lights.map(device => <button type="button" className="dm-control-button smart" key={device.did ?? device.id} onClick={() => onOpenDevice(device)}><span>☀</span><div><strong>{device.name}</strong><small>{device.room} · {device.online === false ? "离线" : device.did}</small></div><b>›</b></button>)}</div></section>}
    {topology.kind === "smart-light-group" && topology.groupMembers.length > 0 && <section><h4>灯组成员（{topology.groupMembers.length}）</h4><div className="dm-control-grid">{topology.groupMembers.map(device => <button type="button" className="dm-control-button smart" key={device.did ?? device.id} onClick={() => onOpenDevice(device)}><span>◌</span><div><strong>{device.name}</strong><small>{device.room} · 具体灯具</small></div><b>›</b></button>)}</div></section>}
    {topology.kind === "smart-light-group" && !topology.groupMembers.length && <p className="dm-group-note">灯组成员关系暂未公开；不会根据名称自动把其他灯具认定为成员。</p>}
  </div>;
}

function ControlButton({ control, onOpen }: { control: LightingControl; onOpen: (device: ManagedDevice, mappedDevice?: ManagedDevice) => void }) {
  return <button type="button" className={`dm-control-button ${control.connection}`} onClick={() => onOpen(control.device, control.endpoint)}><span>{control.relation === "wired-smart-light-power" ? "ϟ" : control.connection === "wired" ? "↦" : control.connection === "wireless" ? "⌁" : "?"}</span><div><strong>{control.device.name}</strong><small>{control.device.room} · {channelLabel(control)} · {connectionLabel(control)}{control.endpoint ? ` · ${control.endpoint.name}` : ""}{control.inferred ? control.evidenceSource === "split-device" ? " · 拓扑推定" : " · 名称推断" : control.evidence === "unknown" ? " · 待确认" : ""}</small></div><b>›</b></button>;
}

type CanvasNode = { x: number; y: number; width: number; height: number; title: string; subtitle: string; tone: "wired" | "wireless" | "unknown" | "light"; open?: () => void };
const graphColors = { wired: { accent: "#ed8050", background: "#fff5ef", border: "#f4c9b7" }, wireless: { accent: "#8771e8", background: "#f3f0ff", border: "#d7cff8" }, unknown: { accent: "#8995a2", background: "#f5f7f9", border: "#dce2e8" }, light: { accent: "#efaa41", background: "#fff9ea", border: "#f2ddaf" } };
function roundedRect(context: CanvasRenderingContext2D, node: CanvasNode) { context.beginPath(); context.roundRect(node.x, node.y, node.width, node.height, 14); }
function fitText(context: CanvasRenderingContext2D, text: string, width: number) { let value = text; while (value.length > 1 && context.measureText(`${value}…`).width > width) value = value.slice(0, -1); return value === text ? text : `${value}…`; }
function drawNode(context: CanvasRenderingContext2D, node: CanvasNode) { const color = graphColors[node.tone]; roundedRect(context, node); context.fillStyle = color.background; context.fill(); context.strokeStyle = color.border; context.stroke(); context.fillStyle = color.accent; context.beginPath(); context.arc(node.x + 17, node.y + 19, 4, 0, Math.PI * 2); context.fill(); context.fillStyle = "#26313d"; context.font = "600 13px sans-serif"; context.fillText(fitText(context, node.title, node.width - 40), node.x + 28, node.y + 24); context.fillStyle = "#73808d"; context.font = "11px sans-serif"; context.fillText(fitText(context, node.subtitle, node.width - 24), node.x + 12, node.y + 46); }

function LightingCanvas({ topology, onOpenDevice }: { topology: LightingTopology; onOpenDevice: (device: ManagedDevice, mappedDevice?: ManagedDevice) => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const nodesRef = useRef<CanvasNode[]>([]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => {
      const width = Math.max(280, Math.round(canvas.getBoundingClientRect().width));
      const compact = width < 570;
      const controls = topology.controls;
      const nodeWidth = compact ? Math.min(width - 32, 270) : Math.min(205, Math.floor((width - 90) / 2));
      const nodeHeight = 60;
      const height = compact ? Math.max(230, controls.length * 76 + 116) : Math.max(230, controls.length * 76 + 30);
      const scale = window.devicePixelRatio || 1;
      canvas.width = width * scale; canvas.height = height * scale; canvas.style.height = `${height}px`;
      const context = canvas.getContext("2d"); if (!context) return;
      context.setTransform(scale, 0, 0, scale, 0, 0); context.clearRect(0, 0, width, height);
      const targetAction = topology.lights[0] ? () => onOpenDevice(topology.lights[0]) : topology.controls.find(control => control.connection === "wired") ? () => { const control = topology.controls.find(item => item.connection === "wired")!; onOpenDevice(control.device, control.endpoint); } : undefined;
      const target: CanvasNode = { x: compact ? (width - nodeWidth) / 2 : width - nodeWidth - 18, y: compact ? height - nodeHeight - 20 : (height - nodeHeight) / 2, width: nodeWidth, height: nodeHeight, title: topology.name, subtitle: `${topology.room} · ${topologyKindLabel(topology)}${topology.groupMembers.length ? ` · ${topology.groupMembers.length} 台灯具` : ""}`, tone: "light", open: targetAction };
      const controlNodes = controls.length ? controls.map((control, index): CanvasNode => ({ x: compact ? (width - nodeWidth) / 2 : 18, y: 15 + index * 76, width: nodeWidth, height: nodeHeight, title: `${control.device.name} · ${channelLabel(control)}`, subtitle: `${connectionLabel(control)}${control.endpoint ? ` · ${control.endpoint.name}` : ""}`, tone: control.connection, open: () => onOpenDevice(control.device, control.endpoint) })) : [];
      for (const node of controlNodes) { context.beginPath(); context.setLineDash(node.tone === "wireless" ? [6, 5] : node.tone === "unknown" ? [3, 5] : []); context.strokeStyle = graphColors[node.tone].accent; context.lineWidth = 2; const sx = compact ? node.x + node.width / 2 : node.x + node.width; const sy = compact ? node.y + node.height : node.y + node.height / 2; const ex = compact ? target.x + target.width / 2 : target.x; const ey = compact ? target.y : target.y + target.height / 2; context.moveTo(sx, sy); context.bezierCurveTo(compact ? sx : sx + 35, compact ? sy + 20 : sy, compact ? ex : ex - 35, compact ? ey - 20 : ey, ex, ey); context.stroke(); context.setLineDash([]); }
      for (const node of [...controlNodes, target]) drawNode(context, node);
      nodesRef.current = [...controlNodes, target];
    };
    draw(); window.addEventListener("resize", draw); return () => window.removeEventListener("resize", draw);
  }, [topology, onOpenDevice]);
  return <canvas ref={canvasRef} className="dm-topology-canvas" aria-label={`${topology.name}控制拓扑`} onClick={event => { const bounds = event.currentTarget.getBoundingClientRect(); const x = event.clientX - bounds.left, y = event.clientY - bounds.top; nodesRef.current.find(node => x >= node.x && x <= node.x + node.width && y >= node.y && y <= node.y + node.height)?.open?.(); }} />;
}

function EmptyState({ title, detail }: { title: string; detail: string }) { return <div className="dm-empty"><span>⌁</span><strong>{title}</strong><p>{detail}</p></div>; }
