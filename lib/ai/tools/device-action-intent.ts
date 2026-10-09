import type { ControllableDevice, DeviceOperation } from "./device-operation-catalog.ts";
import { validateDeviceOperationValue } from "./device-operation-catalog.ts";

export type MatchedDeviceAction = { device: ControllableDevice; operation: DeviceOperation; value: boolean | number | string };
export type MatchedDeviceActionBatch = { device: ControllableDevice; operations: Array<Omit<MatchedDeviceAction, "device">> };

function targets(device: ControllableDevice, all: readonly ControllableDevice[]) {
  const unique = all.filter(item => item.name.toLocaleLowerCase() === device.name.toLocaleLowerCase()).length === 1;
  const qualified = [`${device.room}${device.name}`, `${device.room}的${device.name}`, `${device.room} ${device.name}`];
  return unique ? [device.name, ...qualified] : qualified;
}

function normalizedValue(raw: string, operation: DeviceOperation): boolean | number | string | undefined {
  const text = raw.trim();
  if (operation.valueType === "boolean") {
    if (/^(?:开|开启|打开|on|true)$/iu.test(text)) return true;
    if (/^(?:关|关闭|off|false)$/iu.test(text)) return false;
    return undefined;
  }
  if (operation.valueType === "enum") {
    const matches = operation.choices?.filter(choice => choice.label.trim().toLocaleLowerCase() === text.toLocaleLowerCase()) ?? [];
    return matches.length === 1 ? matches[0].value : undefined;
  }
  const stripped = text.replace(/(?:℃|°C|度|%|%RH)$/iu, "").trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(stripped)) return undefined;
  const value = Number(stripped);
  return validateDeviceOperationValue(operation, value) ? value : undefined;
}

/** Narrow deterministic grammar used before a model can receive a write scope. */
export function matchDeviceActionIntent(message: string, devices: readonly ControllableDevice[]): MatchedDeviceAction | null {
  const text = message.trim().replace(/[!！。.]$/u, "");
  if (!text || /[“”"'‘’?？;,，；]|(?:如果|当|以后|稍后|不要|别|是否|能否|can you|could you|if |later|don't|do not)/iu.test(text)) return null;
  const matches: MatchedDeviceAction[] = [];
  for (const device of devices) for (const target of targets(device, devices)) {
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const power = device.operations.filter(operation => operation.name === "on" && operation.valueType === "boolean");
    const onOff = new RegExp(`^(打开|开启|关闭)\\s*${escaped}$`, "iu").exec(text)
      ?? new RegExp(`^turn\\s+(on|off)\\s+${escaped}$`, "iu").exec(text);
    if (onOff && power.length === 1) matches.push({ device, operation: power[0], value: !/^(?:关闭|off)$/iu.test(onOff[1]) });
    for (const operation of device.operations) {
      const label = operation.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const setting = new RegExp(`^设置\\s*${escaped}\\s*(?:的)?${label}\\s*(?:为)?\\s*(.+)$`, "iu").exec(text)
        ?? new RegExp(`^set\\s+${escaped}\\s+${label}\\s+to\\s+(.+)$`, "iu").exec(text);
      if (!setting) continue;
      const value = normalizedValue(setting[1], operation);
      if (value !== undefined && validateDeviceOperationValue(operation, value)) matches.push({ device, operation, value });
    }
  }
  const unique = matches.filter((item, index) => matches.findIndex(candidate => candidate.device.deviceId === item.device.deviceId && candidate.operation.operationId === item.operation.operationId && candidate.value === item.value) === index);
  return unique.length === 1 ? unique[0] : null;
}

function enumSetting(raw: string, device: ControllableDevice) {
  const text = raw.trim().toLocaleLowerCase();
  const matches = device.operations.flatMap(operation => operation.valueType !== "enum" ? [] :
    (operation.choices ?? []).flatMap(choice => {
      const choiceLabel = choice.label.trim().toLocaleLowerCase();
      const operationLabel = operation.label.trim().toLocaleLowerCase();
      const candidates = new Set([choiceLabel, `${choiceLabel}模式`, `${operationLabel}${choiceLabel}`, `${choiceLabel}${operationLabel}`]);
      return candidates.has(text) ? [{ operation, value: choice.value }] : [];
    }));
  return matches.length === 1 ? matches[0] : null;
}

/** Match either one safe property or a bounded same-device power+enum command. */
export function matchDeviceActionBatchIntent(message: string, devices: readonly ControllableDevice[]): MatchedDeviceActionBatch | null {
  const single = matchDeviceActionIntent(message, devices);
  if (single) return { device: single.device, operations: [{ operation: single.operation, value: single.value }] };
  const text = message.trim().replace(/[!！。.]$/u, "");
  if (!text || /[“”"'‘’?？;,，；]|(?:如果|当|以后|稍后|不要|别|是否|能否|can you|could you|if |later|don't|do not)/iu.test(text)) return null;
  const matches: MatchedDeviceActionBatch[] = [];
  for (const device of devices) for (const target of targets(device, devices)) {
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const compound = new RegExp(`^(打开|开启|关闭)\\s*(?:并|同时|然后|再)\\s*(?:设置|设为)\\s*${escaped}\\s*(?:的)?\\s*(.+)$`, "iu").exec(text);
    if (!compound) continue;
    const power = device.operations.filter(operation => operation.name === "on" && operation.valueType === "boolean");
    const setting = enumSetting(compound[2], device);
    if (power.length !== 1 || !setting || setting.operation.operationId === power[0].operationId) continue;
    matches.push({ device, operations: [
      { operation: power[0], value: !/^关闭$/u.test(compound[1]) },
      setting,
    ] });
  }
  return matches.length === 1 ? matches[0] : null;
}
