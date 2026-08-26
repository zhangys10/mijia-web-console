import type { DeviceControlChannel, DeviceTopology } from "./device-topology";

type StateValue = boolean | number | string;
type SwitchProperty = { key: string; name: string; choices?: Array<{ value: StateValue; label: string }> };
type SwitchGroup = { key: string; name: string; siid: number; properties: SwitchProperty[] };
export type SwitchConnection = "wired" | "wireless" | "unknown";

const modeProperty = /^(?:mode|wireless-mode|button-mode|button-type|switch-mode|control-mode)$/;
const wirelessLabel = /wireless|remote|secondary|slave|无线|副控/i;
const wiredLabel = /wired|relay|primary|有线|主控/i;

export function resolveSwitchMode(property: SwitchProperty, value: StateValue): SwitchConnection {
  const choice = property.choices?.find(item => String(item.value) === String(value));
  if (choice && wirelessLabel.test(choice.label)) return "wireless";
  if (choice && wiredLabel.test(choice.label)) return "wired";
  if (typeof value === "boolean") return value ? "wireless" : "wired";
  if (typeof value === "number") return value === 0 ? "wired" : "wireless";
  const normalized = value.trim().toLowerCase();
  if (wirelessLabel.test(normalized)) return "wireless";
  if (wiredLabel.test(normalized)) return "wired";
  if (["true", "1", "on", "enable", "enabled"].includes(normalized)) return "wireless";
  if (["false", "0", "off", "disable", "disabled"].includes(normalized)) return "wired";
  return "unknown";
}

export function switchGroupMatches(index: number | null, siid: number | null, group: SwitchGroup, groups: SwitchGroup[]) {
  if (siid !== null && siid === group.siid) return true;
  if (index === null) return false;
  const ordinal = groups.filter(item => item.name === "switch").findIndex(item => item.key === group.key);
  return ordinal >= 0 && (index === ordinal + 1 || index === 0 && ordinal === 0);
}

export function findSwitchGroupChannel(group: SwitchGroup, groups: SwitchGroup[], topology?: DeviceTopology | null): DeviceControlChannel | undefined {
  const channels = topology?.channels ?? [];
  const exact = channels.find(channel => switchGroupMatches(channel.channelIndex, channel.channelSiid, group, groups));
  if (exact) return exact;
  const switchGroups = groups.filter(item => item.name === "switch");
  const ordinal = switchGroups.findIndex(item => item.key === group.key);
  return ordinal >= 0 && channels.length === switchGroups.length ? channels[ordinal] : undefined;
}

export function switchGroupConnection(group: SwitchGroup, groups: SwitchGroup[], values: Record<string, StateValue>, topology?: DeviceTopology | null): SwitchConnection {
  const state = group.properties.find(property => modeProperty.test(property.name) && values[property.key] !== undefined);
  if (state) return resolveSwitchMode(state, values[state.key]);

  const channel = findSwitchGroupChannel(group, groups, topology);
  if (channel?.connectionType === "wireless") return "wireless";
  if (channel?.connectionType === "wired") return "wired";
  if (channel?.connectionType === "mixed") return channel.role === "secondary" ? "wireless" : "wired";
  if (topology?.role === "secondary-panel" || topology?.connectionType === "wireless") return "wireless";
  return "unknown";
}
