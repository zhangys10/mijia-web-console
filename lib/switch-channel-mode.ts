import type { DeviceControlChannel, DeviceTopology } from "./device-topology";

type StateValue = boolean | number | string;
export type SwitchProperty = { key: string; name: string; choices?: Array<{ value: StateValue; label: string }> };
type SwitchGroup = { key: string; name: string; siid: number; properties: SwitchProperty[] };
export type SwitchConnection = "wired" | "wireless" | "unknown";
export type SwitchModeCapability = "relay-enabled" | "wireless-only" | "unknown";
export type SwitchModeDiagnostic = {
  connection: SwitchConnection;
  capability: SwitchModeCapability;
  reason: "mode-property-missing" | "value-missing" | "value-unrecognized" | null;
};

const modeProperty = /^(?:mode|wireless-mode|button-mode|button-type|switch-mode|control-mode)$/;
const wirelessLabel = /wireless|remote|secondary|slave|无线|副控/i;
const wiredLabel = /wired|relay|primary|有线|主控/i;

function connectionFromLabel(label: string): SwitchConnection {
  const wireless = wirelessLabel.test(label);
  const wired = wiredLabel.test(label);
  if (wireless === wired) return "unknown";
  return wireless ? "wireless" : "wired";
}

function capabilityFromLabel(label: string): SwitchModeCapability {
  const wireless = wirelessLabel.test(label);
  const wired = wiredLabel.test(label);
  if (wired) return "relay-enabled";
  if (wireless) return "wireless-only";
  return "unknown";
}

export function isSwitchModeProperty(property: Pick<SwitchProperty, "name">) {
  return modeProperty.test(property.name);
}

export function resolveSwitchModeCapability(property: SwitchProperty, value: StateValue): SwitchModeCapability {
  const choice = property.choices?.find(item => String(item.value) === String(value));
  if (choice) return capabilityFromLabel(choice.label);
  if (typeof value === "boolean") return value ? "wireless-only" : "relay-enabled";
  if (typeof value === "number") return value === 0 ? "relay-enabled" : value === 1 ? "wireless-only" : "unknown";
  const normalized = value.trim().toLowerCase();
  const labelled = capabilityFromLabel(normalized);
  if (labelled !== "unknown") return labelled;
  if (["true", "1", "on", "enable", "enabled"].includes(normalized)) return "wireless-only";
  if (["false", "0", "off", "disable", "disabled"].includes(normalized)) return "relay-enabled";
  return "unknown";
}

export function resolveSwitchMode(property: SwitchProperty, value: StateValue): SwitchConnection {
  const choice = property.choices?.find(item => String(item.value) === String(value));
  if (choice) return connectionFromLabel(choice.label);
  const capability = resolveSwitchModeCapability(property, value);
  if (capability === "wireless-only") return "wireless";
  if (capability === "relay-enabled") return "wired";
  return "unknown";
}

export function diagnoseSwitchMode(property: SwitchProperty | undefined, value: StateValue | undefined): SwitchModeDiagnostic {
  if (!property) return { connection: "unknown", capability: "unknown", reason: "mode-property-missing" };
  if (value === undefined) return { connection: "unknown", capability: "unknown", reason: "value-missing" };
  const connection = resolveSwitchMode(property, value);
  const capability = resolveSwitchModeCapability(property, value);
  return { connection, capability, reason: capability === "unknown" ? "value-unrecognized" : null };
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
  const state = group.properties.find(property => isSwitchModeProperty(property) && values[property.key] !== undefined);
  const channel = findSwitchGroupChannel(group, groups, topology);
  if (state) {
    const mode = diagnoseSwitchMode(state, values[state.key]);
    if (mode.capability === "wireless-only") return "wireless";
    if (mode.capability === "relay-enabled") {
      if (mode.connection === "wired") return "wired";
      return channel?.connectionType === "wired" || channel?.connectionType === "mixed" ? "wired" : "unknown";
    }
  }

  if (channel?.connectionType === "wireless") return "wireless";
  if (channel?.connectionType === "wired") return "wired";
  if (channel?.connectionType === "mixed") return channel.role === "secondary" ? "wireless" : "wired";
  if (topology?.role === "secondary-panel" || topology?.connectionType === "wireless") return "wireless";
  return "unknown";
}
