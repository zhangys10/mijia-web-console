"use client";

import { useEffect, useRef } from "react";

export type AssistantSceneSummary = {
  name: string;
  description: string;
  actionCount: number;
};

export type AssistantToolResult = {
  name: "list_scenes" | "get_home_status" | "get_device_status" | "activate_scene";
  status: "success" | "partial_success";
  sceneName?: string;
};

export type AssistantHomeStatus = {
  capturedAt: string;
  completeness: "complete" | "partial" | "empty";
  groups: Array<{
    metric: "temperature" | "humidity" | "co2" | "formaldehyde" | "pm25" | "pm10" | "tvoc" | "pressure" | "battery";
    label: string;
    unit: string;
    latest: { value: number; unit: string; sourceLabel: string; roomName: string | null } | null;
    readings: Array<{ value: number; unit: string; sourceLabel: string; roomName: string | null }>;
  }>;
  warnings: string[];
};

export type AssistantDeviceStatus = {
  capturedAt: string;
  completeness: "complete" | "partial" | "empty";
  poweredOn: number;
  rooms: Array<{
    room: string;
    items: Array<{ name: string; kind: string; state: "on" | "off" | "unknown"; online: boolean }>;
  }>;
  warnings: string[];
};

export type AssistantMessage = {
  role: "user" | "assistant" | "system";
  text: string;
  tool?: AssistantToolResult;
  scenes?: AssistantSceneSummary[];
  homeStatus?: AssistantHomeStatus;
  deviceStatus?: AssistantDeviceStatus;
};

const toolStatusLabel: Record<string, string> = {
  success: "成功",
  partial_success: "部分成功",
};

function toolSummary(tool: AssistantToolResult) {
  if (tool.name === "list_scenes") return `已查询场景列表 · ${toolStatusLabel[tool.status] ?? tool.status}`;
  if (tool.name === "get_home_status") return `已查询家庭环境 · ${toolStatusLabel[tool.status] ?? tool.status}`;
  if (tool.name === "get_device_status") return `已查询设备状态 · ${toolStatusLabel[tool.status] ?? tool.status}`;
  const sceneName = tool.sceneName ?? "未命名场景";
  return `已执行场景「${sceneName}」 · ${toolStatusLabel[tool.status] ?? tool.status}`;
}

function formatReadingValue(value: number) {
  if (Number.isInteger(value)) return String(value);
  if (Math.abs(value) < 1) return value.toPrecision(3).replace(/\.?0+$/, "");
  return value.toFixed(1);
}

function HomeStatusCard({ status }: { status: AssistantHomeStatus }) {
  if (!status.groups.length) {
    return (
      <div className="ai-message-home-status ai-message-home-status-empty">
        <strong>当前家庭暂无环境读数</strong>
        <small>{status.warnings[0] ?? "未发现可读取环境数据的设备"}</small>
      </div>
    );
  }
  return (
    <div className="ai-message-home-status" aria-label="家庭环境读数">
      {status.groups.map(group => (
        <div key={group.metric} className="ai-message-metric">
          <span className="ai-message-metric-value">
            {formatReadingValue(group.latest?.value ?? group.readings[0]?.value ?? 0)}
            <small>{group.unit}</small>
          </span>
          <span className="ai-message-metric-label">{group.label}</span>
          {group.readings.length > 1 && (
            <small className="ai-message-metric-count">{group.readings.length} 台设备</small>
          )}
        </div>
      ))}
      {status.completeness === "partial" && status.warnings.length > 0 && (
        <small className="ai-message-home-warning">{status.warnings[0]}</small>
      )}
    </div>
  );
}

const deviceStateLabel: Record<AssistantDeviceStatus["rooms"][number]["items"][number]["state"], string> = {
  on: "已开启",
  off: "已关闭",
  unknown: "未知",
};

function DeviceStatusCard({ status }: { status: AssistantDeviceStatus }) {
  if (!status.rooms.length) {
    return (
      <div className="ai-message-home-status ai-message-home-status-empty">
        <strong>当前家庭暂无可用的设备状态</strong>
        <small>{status.warnings[0] ?? "未发现可读取状态的设备"}</small>
      </div>
    );
  }
  return (
    <div className="ai-message-device-status" aria-label="家庭设备状态">
      {status.rooms.map(group => (
        <section key={group.room} className="ai-message-device-room">
          <header>{group.room}</header>
          <ul>
            {group.items.map(item => (
              <li key={`${group.room}:${item.name}`} className={`ai-message-device ai-message-device-${item.state}`}>
                <span className="ai-message-device-name">{item.name}</span>
                <span className="ai-message-device-state">{item.online ? deviceStateLabel[item.state] : "离线"}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {status.completeness === "partial" && status.warnings.length > 0 && (
        <small className="ai-message-home-warning">{status.warnings[0]}</small>
      )}
    </div>
  );
}

export default function AiMessageList({ messages, sending }: { messages: AssistantMessage[]; sending: boolean }) {
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, sending]);

  return (
    <div className="ai-message-list" aria-live="polite">
      {messages.map((message, index) =>
        message.role === "system" ? (
          <p key={index} className="ai-message-system">{message.text}</p>
        ) : (
          <div key={index} className={`ai-message ${message.role}`}>
            <div className="ai-message-bubble">
              <p>{message.text}</p>
              {message.tool && <span className="ai-message-tool">⌁ {toolSummary(message.tool)}</span>}
              {message.homeStatus && <HomeStatusCard status={message.homeStatus} />}
              {message.deviceStatus && <DeviceStatusCard status={message.deviceStatus} />}
              {message.scenes && message.scenes.length > 0 && (
                <div className="ai-message-scenes">
                  {message.scenes.map((scene) => (
                    <div key={scene.name} className="ai-message-scene">
                      <strong>{scene.name}</strong>
                      <small>{scene.description || "暂无描述"}</small>
                      <span>{scene.actionCount} 个动作</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ),
      )}
      {sending && (
        <div className="ai-message assistant">
          <div className="ai-message-bubble ai-message-pending"><span />正在思考…</div>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
