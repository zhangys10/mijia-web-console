import { getMiotCapabilities } from "../../miot-spec.ts";
import { classifyDeviceKind } from "../../device-views.ts";
import { parseDerivedDeviceId } from "../../device-topology.ts";
import { isScenePropertyValueSupported, isSceneWritableProperty, type ScenePropertyValue } from "../../xiaomi-scene-properties.ts";
import { interpretPropertyWriteResponse } from "../../xiaomi-control-result.ts";
import { xiaomiRequest, type XiaomiDeviceList, type XiaomiSession } from "../../xiaomi-cloud.ts";

export type DeviceOperation = {
  operationId: string;
  revision: string;
  name: string;
  label: string;
  valueType: "boolean" | "enum" | "number";
  unit?: string;
  choices?: Array<{ value: ScenePropertyValue; label: string }>;
  range?: { min: number; max: number; step: number };
  siid: number;
  piid: number;
};

export type ControllableDevice = {
  deviceId: string;
  name: string;
  room: string;
  kind: string;
  online: boolean;
  did: string;
  model: string;
  urn?: string;
  operations: DeviceOperation[];
};

async function hexDigest(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function deviceReference(homeId: string, did: string) {
  return `entity_${(await hexDigest(`${homeId}:${did}`)).slice(0, 32)}`;
}

function valueType(property: { format: string; choices?: unknown[] }): DeviceOperation["valueType"] {
  if (property.choices?.length) return "enum";
  return property.format === "bool" ? "boolean" : "number";
}

export async function loadDeviceOperationCatalog(
  discovery: XiaomiDeviceList,
  homeId: string,
  selectedDids: readonly string[],
): Promise<ControllableDevice[]> {
  const selected = new Set(selectedDids);
  const devices = discovery.devices.filter(record => {
    const did = String(record.did ?? "");
    return did && selected.has(did) && String(record.homeId ?? record.home_id ?? "") === homeId;
  });
  const result = await Promise.all(devices.map(async record => {
    const exposedDid = String(record.did ?? "");
    const derived = parseDerivedDeviceId(exposedDid);
    // The devices API represents a switch channel as `<physicalDid>.s<siid>`, but
    // Xiaomi property writes must use the physical DID and the channel service.
    // Keep the exposed DID for aliases/exposure checks while dispatching through
    // the same physical mapping used by the dashboard's `powerControl` object.
    const did = derived?.physicalDid ?? exposedDid;
    const model = typeof record.model === "string" ? record.model : "";
    if (!model) return null;
    let specification;
    try { specification = await getMiotCapabilities(model, typeof record.urn === "string" ? record.urn : undefined); }
    catch { return null; }
    const operations: DeviceOperation[] = [];
    for (const group of specification.groups) {
      if (derived && group.siid !== derived.siid) continue;
      for (const property of group.properties) {
        if (!isSceneWritableProperty(group.name, property)) continue;
        const canonical = JSON.stringify({ model, service: group.name, siid: property.siid, property: property.name, piid: property.piid, format: property.format, choices: property.choices ?? [], range: property.range ?? null });
        const digest = await hexDigest(`${homeId}:${exposedDid}:${canonical}`);
        operations.push({
          operationId: `op_${digest.slice(0, 24)}`,
          revision: `rev_${digest.slice(24, 48)}`,
          name: property.name,
          label: property.label,
          valueType: valueType(property),
          ...(property.unit ? { unit: property.unit } : {}),
          ...(property.choices?.length ? { choices: property.choices.map(choice => ({ value: choice.value, label: choice.label })) } : {}),
          ...(property.range ? { range: property.range } : {}),
          siid: property.siid,
          piid: property.piid,
        });
      }
    }
    const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : "未命名设备";
    const room = typeof record.roomName === "string" && record.roomName.trim() ? record.roomName.trim() : "未分配";
    const online = record.isOnline === true || record.online === true;
    return {
      deviceId: await deviceReference(homeId, exposedDid), name, room,
      kind: classifyDeviceKind(model, name, typeof record.logicalType === "string" ? record.logicalType : ""),
      online, did, model, ...(typeof record.urn === "string" ? { urn: record.urn } : {}),
      operations: operations.slice(0, 20),
    } satisfies ControllableDevice;
  }));
  return result.filter((item): item is ControllableDevice => Boolean(item?.operations.length));
}

export function publicDeviceCatalog(devices: readonly ControllableDevice[]) {
  return devices.slice(0, 40).map(({ deviceId, name, room, kind, online, operations }) => ({
    deviceId, name, room, kind, online,
    operations: operations.map(({ operationId, revision, name: property, label, valueType, unit, choices, range }) => ({
      operationId, revision, property, label, valueType,
      ...(unit ? { unit } : {}), ...(choices ? { choices } : {}), ...(range ? { range } : {}),
    })),
  }));
}

export function validateDeviceOperationValue(operation: DeviceOperation, value: unknown): value is ScenePropertyValue {
  const enumFormat = operation.choices?.length
    ? typeof operation.choices[0].value === "boolean" ? "bool" : typeof operation.choices[0].value === "number" ? "float" : "string"
    : "string";
  return (typeof value === "boolean" || typeof value === "number" || typeof value === "string")
    && isScenePropertyValueSupported({
      name: operation.name, format: operation.valueType === "boolean" ? "bool" : operation.valueType === "number" ? "float" : enumFormat,
      readable: true, writable: true, unit: operation.unit, choices: operation.choices, range: operation.range,
    }, value);
}

export async function setDeviceProperty(session: XiaomiSession, device: ControllableDevice, operation: DeviceOperation, value: ScenePropertyValue) {
  return setDeviceProperties(session, device, [{ operation, value }]);
}

export async function setDeviceProperties(session: XiaomiSession, device: ControllableDevice, changes: readonly { operation: DeviceOperation; value: ScenePropertyValue }[]) {
  const response = await xiaomiRequest(session, "/app/miotspec/prop/set", { params: changes.map(({ operation, value }) => ({ did: device.did, siid: operation.siid, piid: operation.piid, value })) });
  const outcome = interpretPropertyWriteResponse(response);
  if (outcome.status === "outcome_unknown") throw new Error(`XIAOMI_PROPERTY_CODE_${outcome.result.code}`);
}
