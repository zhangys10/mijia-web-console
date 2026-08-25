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

type Home = { id: string; name: string };

type DeviceManagementProps = {
  devices: ManagedDevice[];
  allDevices: ManagedDevice[];
  homes: Home[];
  selectedHome: string;
  room: string;
  connected: boolean;
  onSelectHome: (homeId: string) => void;
  onSelectRoom: (room: string) => void;
  onOpenDevice: (device: ManagedDevice, mappedDevice?: ManagedDevice) => void;
};

const categoryLabels: Record<ManagedDeviceCategory, string> = {
  "smart-light": "智能灯具",
  controller: "中控屏",
  switch: "实体开关",
  "voice-alias": "语音映射",
  "wired-load": "有线回路",
  group: "组合设备",
  other: "智能设备",
};

function channelLabel(control: LightingControl) {
  if (control.channelIndex !== null) return `按键 ${control.channelIndex === 0 ? 1 : control.channelIndex}`;
  if (control.channelSiid !== null) return `服务 ${control.channelSiid}`;
  return "关联按键";
}

function roomPriority(room: string) {
  return /勿关|勿删|语音|隐藏/.test(room) ? 1 : 0;
}

function recordIdentity(device: ManagedDevice) {
  return `${device.homeId}:${device.did ?? `demo-${device.id}`}`;
}

export default function DeviceManagement({
  devices,
  allDevices,
  homes,
  selectedHome,
  room,
  connected,
  onSelectHome,
  onSelectRoom,
  onOpenDevice,
}: DeviceManagementProps) {
  const [view, setView] = useState<"rooms" | "topology">("rooms");
  const [selectedTopology, setSelectedTopology] = useState("");
  const model = useMemo(() => buildDeviceManagementModel(devices), [devices]);
  const recordsById = useMemo(() => new Map(model.records.map(record => [recordIdentity(record.device), record])), [model.records]);
  const rooms = useMemo(() => ["全屋", ...Array.from(new Set(devices.map(device => device.room)))
    .sort((left, right) => roomPriority(left) - roomPriority(right) || left.localeCompare(right, "zh-CN"))], [devices]);
  const roomRecords = useMemo(() => model.records.filter(record => room === "全屋" || record.device.room === room), [model.records, room]);
  const groupedRooms = useMemo(() => Array.from(new Set(roomRecords.map(record => record.device.room)))
    .sort((left, right) => roomPriority(left) - roomPriority(right) || left.localeCompare(right, "zh-CN"))
    .map(name => ({ name, records: roomRecords.filter(record => record.device.room === name) })), [roomRecords]);
  const topologies = useMemo(() => model.topologies.filter(topology => room === "全屋" || topology.room === room), [model.topologies, room]);
  const activeTopology = topologies.find(topology => topology.key === selectedTopology) ?? topologies[0];

  function openRecord(record: ManagedDeviceRecord) {
    if ((record.category === "voice-alias" || record.category === "wired-load") && record.owner) {
      onOpenDevice(record.owner, record.device);
      return;
    }
    onOpenDevice(record.device);
  }

  function openTopologyDevice(device: ManagedDevice) {
    const record = recordsById.get(recordIdentity(device));
    if (record) openRecord(record);
    else onOpenDevice(device);
  }

  return <section className="dm-shell" aria-label="米家设备管理">
    <header className="dm-intro">
      <div><span className="dm-eyebrow">MIJIA HOME</span><h2>设备管理</h2><p>我的设备 · 按米家真实房间查看设备，按主控位置查看灯具关系。</p></div>
      <span className={`dm-connection ${connected ? "connected" : "demo"}`}>{connected ? "米家云已连接" : "演示设备"}</span>
    </header>

    <section className="dm-summary" aria-label="家庭设备统计">
      <SummaryCard icon="▦" value={model.totals.devices} label="房间设备" tone="neutral" />
      <SummaryCard icon="☀" value={model.totals.lights} label="灯具与回路" tone="orange" />
      <SummaryCard icon="⌘" value={model.totals.switches} label="开关与中控" tone="violet" />
      <SummaryCard icon="◌" value={model.totals.aliases} label="语音映射" tone="blue" />
    </section>

    <div className="dm-filter-group"><span className="dm-filter-label">家庭</span><div className="dm-home-list">
      {homes.map(home => <button key={home.id} type="button" className={`dm-home-card ${home.id === selectedHome ? "selected" : ""}`} onClick={() => onSelectHome(home.id)}><span>⌂</span><strong>{home.name}</strong><small>{allDevices.filter(device => device.homeId === home.id).length} 台设备</small></button>)}
    </div></div>

    <div className="dm-filter-group"><span className="dm-filter-label">房间</span><div className="dm-room-tabs">
      {rooms.map(item => <button key={item} type="button" className={item === room ? "selected" : ""} onClick={() => onSelectRoom(item)}>{item}</button>)}
    </div></div>

    <div className="dm-view-bar"><div className="dm-view-tabs" role="tablist" aria-label="设备展示方式">
      <button type="button" role="tab" aria-selected={view === "rooms"} className={view === "rooms" ? "selected" : ""} onClick={() => setView("rooms")}>▦ 房间设备</button>
      <button type="button" role="tab" aria-selected={view === "topology"} className={view === "topology" ? "selected" : ""} onClick={() => setView("topology")}>⌁ 灯具拓扑</button>
    </div><p>{view === "rooms" ? "保留每台设备在米家中的真实房间与设备 ID" : "以有线主控所在房间和灯具名称归类，跨房间关联无线映射"}</p></div>

    {view === "rooms" ? <div className="dm-room-inventory">
      {groupedRooms.map(group => <section key={`${selectedHome}:${group.name}`} className="dm-room-section"><div className="dm-room-heading"><div><strong>{group.name}</strong>{/勿关|勿删|语音|隐藏/.test(group.name) && <span>语音控制映射保留在原房间</span>}</div><small>{group.records.length} 台设备</small></div><div className="dm-room-grid">
        {group.records.map(record => <DeviceRecordCard key={`${record.device.homeId}:${record.device.did ?? record.device.id}`} record={record} onOpen={() => openRecord(record)} onOpenMember={onOpenDevice} />)}
      </div></section>)}
      {!groupedRooms.length && <EmptyState title="这个房间暂时没有设备" detail="同步米家设备后，将按它们在米家 App 中的真实房间显示。" />}
    </div> : <div className="dm-topology-view">
      {activeTopology ? <div className="dm-topology-explorer"><aside className="dm-topology-list" aria-label="按主控房间分类的灯具">
        <div className="dm-list-heading"><strong>灯具与控制回路</strong><small>{topologies.length} 个拓扑</small></div>
        {topologies.map(topology => <button type="button" key={topology.key} className={`dm-topology-item ${topology.key === activeTopology.key ? "selected" : ""}`} onClick={() => setSelectedTopology(topology.key)}><span className="dm-light-icon">☀</span><div><strong>{topology.name}</strong><small>{topology.room} · {topology.controls.length} 个控制来源</small></div>{topology.aliases.length > 0 && <em>{topology.aliases.length}</em>}</button>)}
      </aside><section className="dm-topology-stage"><div className="dm-stage-heading"><div><span>{activeTopology.room} · 有线主控归属</span><h3>{activeTopology.name}</h3><p>{activeTopology.controls.filter(control => control.connection === "wired").length} 个有线控制 · {activeTopology.controls.filter(control => control.connection === "wireless").length} 个无线控制 · {activeTopology.aliases.length} 个语音映射</p></div></div>
        <LightingCanvas topology={activeTopology} onOpenDevice={openTopologyDevice} />
        <div className="dm-legend"><span><i className="wired" />有线主控</span><span><i className="wireless" />无线副控</span><span><i className="alias" />语音映射</span></div>
        <TopologyDetails topology={activeTopology} onOpenDevice={openTopologyDevice} />
      </section></div> : <EmptyState title={/勿关|勿删|语音|隐藏/.test(room) ? "语音映射会归入实际主控所在房间" : "这个房间暂未识别到灯具控制关系"} detail={/勿关|勿删|语音|隐藏/.test(room) ? "切换到主卧、客厅等主开关所在房间，查看映射设备与无线副控的完整拓扑。" : "米家返回独立灯具、有线开关回路或语音映射后，将自动生成控制拓扑。"} />}
    </div>}
  </section>;
}

function SummaryCard({ icon, value, label, tone }: { icon: string; value: number; label: string; tone: string }) {
  return <article className={`dm-summary-card ${tone}`}><span>{icon}</span><div><strong>{value}</strong><small>{label}</small></div></article>;
}

function DeviceRecordCard({ record, onOpen, onOpenMember }: { record: ManagedDeviceRecord; onOpen: () => void; onOpenMember: (device: ManagedDevice) => void }) {
  const { device, category, owner, groupMembers } = record;
  const channels = category === "switch" || category === "controller" ? device.topology?.channels ?? [] : [];
  const summary = category === "voice-alias" ? `属于 ${owner?.room ?? "未识别房间"} · ${owner?.name ?? "未识别开关"}`
    : category === "group" ? `${groupMembers.length} 台成员设备 · 点击卡片编辑组合`
      : category === "switch" || category === "controller" ? `${channels.length} 个已识别按键 · 点击查看设备设置`
        : category === "wired-load" ? `有线主控：${owner?.name ?? device.topology?.parentName ?? "待识别"}`
          : `${device.status} · 点击打开设备设置`;

  return <article className={`dm-record-card ${category} ${device.online === false ? "offline" : ""}`} role="button" tabIndex={0} onClick={onOpen} onKeyDown={event => { if (event.currentTarget === event.target && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onOpen(); } }}>
    <div className="dm-record-top"><span className={`dm-record-icon ${device.color}`}>{category === "voice-alias" ? "◌" : category === "group" ? "◫" : device.icon}</span><span className={`dm-category ${category}`}>{categoryLabels[category]}</span></div>
    <h3>{device.name}</h3><p>{summary}</p>
    {channels.length > 0 && <div className="dm-channel-preview">{channels.slice(0, 3).map(channel => { const wireless = channel.connectionType === "wireless" || channel.connectionType === "mixed" && channel.role === "secondary"; return <span key={`${channel.channelIndex}:${channel.channelSiid}`} className={wireless ? "wireless" : "wired"}><i>{wireless ? "无线" : channel.connectionType === "mixed" ? "混合" : "有线"}</i>{channel.targets[0]?.name ?? channel.label}</span>; })}{channels.length > 3 && <small>另外 {channels.length - 3} 个按键</small>}</div>}
    {category === "group" && groupMembers.length > 0 && <div className="dm-group-members">{groupMembers.map(member => <button key={`${member.did}:${member.name}`} type="button" onClick={event => { event.stopPropagation(); onOpenMember(member); }}><span className={member.color}>{member.icon}</span><span><strong>{member.name}</strong><small>{member.room} · {member.did}</small></span><b>›</b></button>)}</div>}
    <div className="dm-record-footer"><span>{device.room}</span>{device.did ? <code title={device.did}>{device.did}</code> : <small>演示设备</small>}<b>›</b></div>
  </article>;
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="dm-empty"><span>⌁</span><strong>{title}</strong><p>{detail}</p></div>;
}

function TopologyDetails({ topology, onOpenDevice }: { topology: LightingTopology; onOpenDevice: (device: ManagedDevice) => void }) {
  const wired = topology.controls.filter(control => control.connection === "wired");
  const wireless = topology.controls.filter(control => control.connection === "wireless");
  return <div className="dm-control-groups">
    {wired.length > 0 && <section><h4>有线主控</h4><div className="dm-control-grid">{wired.map(control => <ControlButton key={`wired:${control.device.did}:${control.channelIndex}:${control.channelSiid}`} control={control} onOpen={onOpenDevice} />)}</div></section>}
    {wireless.length > 0 && <section><h4>无线副控</h4><div className="dm-control-grid">{wireless.map(control => <ControlButton key={`wireless:${control.device.did}:${control.channelIndex}:${control.channelSiid}`} control={control} onOpen={onOpenDevice} />)}</div></section>}
    {topology.lights.length > 0 && <section><h4>智能灯具</h4><div className="dm-control-grid">{topology.lights.map(device => <button type="button" className="dm-control-button smart" key={device.did ?? device.id} onClick={() => onOpenDevice(device)}><span>☀</span><div><strong>{device.name}</strong><small>{device.room} · {device.did ?? "独立灯具"}</small></div><b>›</b></button>)}</div></section>}
    {topology.aliases.length > 0 && <section><h4>语音映射 · 原始米家房间</h4><div className="dm-control-grid">{topology.aliases.map(device => <button type="button" className="dm-control-button alias" key={device.did ?? device.id} onClick={() => onOpenDevice(device)}><span>◌</span><div><strong>{device.name}</strong><small>{device.room} · {device.did}</small></div><b>›</b></button>)}</div></section>}
  </div>;
}

function ControlButton({ control, onOpen }: { control: LightingControl; onOpen: (device: ManagedDevice) => void }) {
  return <button type="button" className={`dm-control-button ${control.connection}`} onClick={() => onOpen(control.device)}><span>{control.connection === "wired" ? "ϟ" : "⌁"}</span><div><strong>{control.device.name}</strong><small>{control.device.room} · {channelLabel(control)}{control.inferred ? " · 根据设备 ID 关联" : ""}</small></div><b>›</b></button>;
}

type CanvasNode = { x: number; y: number; width: number; height: number; title: string; subtitle: string; tone: "wired" | "wireless" | "light" | "alias" | "empty"; device?: ManagedDevice };

const graphColors = {
  wired: { accent: "#ed8050", background: "#fff5ef", border: "#f4c9b7" },
  wireless: { accent: "#8771e8", background: "#f3f0ff", border: "#d7cff8" },
  light: { accent: "#efaa41", background: "#fff9ea", border: "#f2ddaf" },
  alias: { accent: "#4b91d9", background: "#edf6ff", border: "#c7def4" },
  empty: { accent: "#95a0ad", background: "#f6f8fa", border: "#e1e6ed" },
};

function canvasText(context: CanvasRenderingContext2D, text: string, maxWidth: number) {
  if (context.measureText(text).width <= maxWidth) return text;
  let value = text;
  while (value.length > 1 && context.measureText(`${value}…`).width > maxWidth) value = value.slice(0, -1);
  return `${value}…`;
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  context.beginPath();
  if (typeof context.roundRect === "function") context.roundRect(x, y, width, height, radius);
  else { context.moveTo(x + radius, y); context.arcTo(x + width, y, x + width, y + height, radius); context.arcTo(x + width, y + height, x, y + height, radius); context.arcTo(x, y + height, x, y, radius); context.arcTo(x, y, x + width, y, radius); context.closePath(); }
}

function drawNode(context: CanvasRenderingContext2D, node: CanvasNode) {
  const colors = graphColors[node.tone];
  roundedRect(context, node.x, node.y, node.width, node.height, 15);
  context.fillStyle = colors.background;
  context.fill();
  context.strokeStyle = colors.border;
  context.lineWidth = 1.2;
  context.stroke();
  context.fillStyle = colors.accent;
  context.beginPath();
  context.arc(node.x + 17, node.y + 20, 4, 0, Math.PI * 2);
  context.fill();
  context.font = "600 13px 'PingFang SC', 'Microsoft YaHei', sans-serif";
  context.fillStyle = "#26313d";
  context.fillText(canvasText(context, node.title, node.width - 40), node.x + 28, node.y + 25);
  context.font = "11px 'PingFang SC', 'Microsoft YaHei', sans-serif";
  context.fillStyle = "#73808d";
  context.fillText(canvasText(context, node.subtitle, node.width - 26), node.x + 13, node.y + 46);
}

function drawConnection(context: CanvasRenderingContext2D, from: CanvasNode, to: CanvasNode, tone: "wired" | "wireless" | "alias", vertical: boolean) {
  const color = graphColors[tone].accent;
  context.beginPath();
  context.setLineDash(tone === "wireless" ? [6, 5] : tone === "alias" ? [3, 5] : []);
  context.strokeStyle = color;
  context.globalAlpha = 0.78;
  context.lineWidth = 2;
  if (vertical) {
    const startX = from.x + from.width / 2, startY = from.y + from.height, endX = to.x + to.width / 2, endY = to.y;
    context.moveTo(startX, startY);
    context.bezierCurveTo(startX, startY + 25, endX, endY - 25, endX, endY);
  } else {
    const startX = from.x + from.width, startY = from.y + from.height / 2, endX = to.x, endY = to.y + to.height / 2;
    context.moveTo(startX, startY);
    context.bezierCurveTo(startX + 32, startY, endX - 32, endY, endX, endY);
  }
  context.stroke();
  context.globalAlpha = 1;
  context.setLineDash([]);
}

function LightingCanvas({ topology, onOpenDevice }: { topology: LightingTopology; onOpenDevice: (device: ManagedDevice) => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hitNodes = useRef<CanvasNode[]>([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    function draw() {
      if (!canvas) return;
      const bounds = canvas.getBoundingClientRect();
      const width = Math.max(280, Math.round(bounds.width || 640));
      const compact = width < 610;
      const controls = topology.controls;
      const aliases = topology.aliases;
      const maxCount = Math.max(controls.length, aliases.length, 1);
      const height = compact ? 198 + Math.max(controls.length, 1) * 82 + aliases.length * 82 : Math.max(230, maxCount * 82 + 58);
      const scale = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      canvas.style.height = `${height}px`;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(scale, 0, 0, scale, 0, 0);
      context.clearRect(0, 0, width, height);

      const nodeHeight = 62;
      const nodeWidth = compact ? Math.min(width - 36, 258) : Math.min(194, Math.floor((width - 116) / 3));
      const centerX = (width - nodeWidth) / 2;
      const controlCount = Math.max(controls.length, 1);
      const targetY = compact ? 38 + controlCount * 82 : (height - nodeHeight) / 2;
      const target: CanvasNode = { x: centerX, y: targetY, width: nodeWidth, height: nodeHeight, title: topology.name, subtitle: topology.lights.length ? "独立智能灯具" : `${topology.room} · 有线回路`, tone: "light", device: topology.lights[0] ?? topology.loads[0] };
      const controlNodes: CanvasNode[] = controls.length ? controls.map((control, index) => ({ x: compact ? centerX : 12, y: compact ? 18 + index * 82 : (height - controls.length * 82) / 2 + index * 82 + 10, width: nodeWidth, height: nodeHeight, title: control.device.name, subtitle: `${control.connection === "wired" ? "有线主控" : "无线副控"} · ${channelLabel(control)}`, tone: control.connection, device: control.device })) : [{ x: compact ? centerX : 12, y: compact ? 18 : (height - nodeHeight) / 2, width: nodeWidth, height: nodeHeight, title: "独立控制", subtitle: "暂无关联开关", tone: "empty" }];
      const aliasNodes: CanvasNode[] = aliases.map((alias, index) => ({ x: compact ? centerX : width - nodeWidth - 12, y: compact ? targetY + 86 + index * 82 : (height - aliases.length * 82) / 2 + index * 82 + 10, width: nodeWidth, height: nodeHeight, title: alias.name, subtitle: `${alias.room} · 语音映射`, tone: "alias", device: alias }));

      for (const node of controlNodes) drawConnection(context, node, target, node.tone === "wireless" ? "wireless" : "wired", compact);
      for (const node of aliasNodes) drawConnection(context, target, node, "alias", compact);
      for (const node of [...controlNodes, target, ...aliasNodes]) drawNode(context, node);
      hitNodes.current = [...controlNodes, target, ...aliasNodes].filter(node => Boolean(node.device));
    }

    draw();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(draw);
    observer?.observe(canvas);
    if (!observer) window.addEventListener("resize", draw);
    return () => { observer?.disconnect(); if (!observer) window.removeEventListener("resize", draw); };
  }, [topology]);

  return <canvas ref={canvasRef} className="dm-topology-canvas" role="img" aria-label={`${topology.room}${topology.name}控制拓扑：${topology.controls.filter(control => control.connection === "wired").length} 个有线主控，${topology.controls.filter(control => control.connection === "wireless").length} 个无线副控，${topology.aliases.length} 个语音映射`} onClick={event => { const bounds = event.currentTarget.getBoundingClientRect(); const x = event.clientX - bounds.left, y = event.clientY - bounds.top; const node = hitNodes.current.find(item => x >= item.x && x <= item.x + item.width && y >= item.y && y <= item.y + item.height); if (node?.device) onOpenDevice(node.device); }} />;
}
