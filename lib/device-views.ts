import type { DeviceControlChannel, DeviceTopology } from "./device-topology";

export type HardwareRole = "controller" | "switch" | "device";
type ViewDevice = { did?: string; name: string; kind: string; icon?: string; room?: string; homeId?: string; parentId?: string | null; detail?: string; model?: string; logicalType?: string; hardwareRole?: HardwareRole; topology?: DeviceTopology | null };
export type ControlledDeviceGroup<T extends ViewDevice> = Omit<T, "did" | "parentId"> & { did?: undefined; parentId: null; virtual: true; members: T[] };
export type SwitchChannelTarget<T extends ViewDevice> = { id: string; name: string; room: string; device?: T; smart: boolean };

const lightingName = /灯带|灯光|灯具|灯组|灯泡|球泡|吸顶灯|吊灯|筒灯|射灯|壁灯|台灯|床头灯|柜灯|夜灯|氛围灯|照明|光源|灯$/;
const controllerName = /开关|面板|副控|主控|中控|中枢|网关|家庭屏|智能屏|控制屏|触控屏|遥控|控制器|[单双三四五六]开/;
const centralControllerName = /中控|中枢|网关|家庭屏|智能屏|控制屏|触控屏/;
const lightingModel = /(?:^|[._-])(?:light|lamp|bulb|strip|ceiling|downlight|spotlight|lighting|lightstrip)(?:[._-]|$)/;
const mappedModel = /(?:^|[._-])(?:switch|relay|channel|gang|virtual|split)(?:[._-]|$)/;
const centralControllerModel = /^(?:controller\w*|gateway\w*|central\w*|screen\w*|hub\w*)$/;
const switchModel = /^(?:switch\w*|panel\w*|remote\w*|relay\w*|key\w*|button\w*)$/;
const modelKinds: Record<string, string> = { light: "light", lamp: "lamp", bulb: "light", strip: "light", ceiling: "light", downlight: "light", spotlight: "light", lighting: "light", lightstrip: "light", aircondition: "aircondition", acpartner: "acpartner", airpurifier: "airpurifier", vacuum: "vacuum", fan: "fan", lock: "lock", curtain: "curtain", humidifier: "humidifier", plug: "plug", camera: "camera", sensor: "sensor", switch: "switch", panel: "switch", remote: "switch", relay: "switch", button: "switch", key: "switch", controller: "switch", gateway: "switch", screen: "switch", hub: "switch" };

function modelParts(value: string) {
  const normalized = value.trim().toLowerCase();
  const segments = normalized.split(".").filter(Boolean);
  return { value: normalized, category: segments.length > 1 ? segments[1] : segments[0] ?? "", tokens: normalized.split(/[._:\-]/).filter(Boolean) };
}

export function inferHardwareRole(model: string, name = ""): HardwareRole {
  const { category, tokens } = modelParts(model);
  if (centralControllerModel.test(category) || tokens.slice(1).some(token => centralControllerModel.test(token)) || centralControllerName.test(name)) return "controller";
  if (tokens.some(token => /^(?:virtual|split|channel)$/.test(token)) && lightingName.test(name) && !controllerName.test(name)) return "device";
  if (switchModel.test(category) || tokens.slice(1).some(token => switchModel.test(token)) || controllerName.test(name)) return "switch";
  return "device";
}

export function classifyDeviceKind(model: string, name: string, logicalType = "") {
  const reported = modelParts(logicalType);
  const reportedKind = reported.tokens.find(token => Boolean(modelKinds[token]));
  if (reportedKind) return modelKinds[reportedKind];

  const { category, tokens } = modelParts(model);
  const modelKind = modelKinds[category] ?? modelKinds[tokens.slice(1).find(token => Boolean(modelKinds[token])) ?? ""];
  if (inferHardwareRole(model) === "device" && modelKind) return modelKind;

  // Names and the cloud-reported logical type describe the controllable load.
  // The model is used separately for grouping the physical piece of hardware.
  if (lightingName.test(name) && !controllerName.test(name)) return "light";
  if (controllerName.test(name)) return "switch";

  if (modelKinds[category]) return modelKinds[category];
  if (switchModel.test(category)) {
    if (tokens.some(token => /^(?:virtual|split|channel)$/.test(token)) && lightingName.test(name) && !controllerName.test(name)) return "light";
    return "switch";
  }

  const centralToken = tokens.slice(1).find(token => centralControllerModel.test(token));
  if (centralToken) return "switch";
  const knownToken = tokens.slice(1).find(token => Boolean(modelKinds[token]));
  if (knownToken) return modelKinds[knownToken];
  const switchToken = tokens.slice(1).find(token => switchModel.test(token));
  if (switchToken) return "switch";

  return "sensor";
}

export function isControlDevice(device: ViewDevice) {
  const model = device.detail ?? device.model ?? "";
  const hardwareRole = device.hardwareRole ?? inferHardwareRole(model, device.name);
  if (hardwareRole === "controller") return true;
  if (hardwareRole === "switch") return !(device.topology?.relation === "mapped" && device.parentId);
  if (device.topology?.role === "primary" || device.topology?.role === "secondary-panel") return true;
  if (controllerName.test(device.name) && !lightingName.test(device.name)) return true;
  if (device.kind !== "switch") return false;
  if (lightingName.test(device.name) && !controllerName.test(device.name)) return false;
  return !device.topology?.controlledBy.length;
}

export function isIndependentSmartDevice(device: ViewDevice) {
  const model = (device.detail ?? device.model ?? "").toLowerCase();
  if (inferHardwareRole(model, device.name) !== "device") return false;
  if (!device.did && !(lightingModel.test(model) && !mappedModel.test(model))) return false;
  if (device.topology?.relation === "mapped" && device.parentId) return false;
  if (lightingName.test(device.name) && mappedModel.test(model)) return false;
  return true;
}

export function listSwitchChannelTargets<T extends ViewDevice>(channel: DeviceControlChannel | undefined, devices: T[]): SwitchChannelTarget<T>[] {
  if (!channel) return [];
  const targets = new Map<string, SwitchChannelTarget<T>>();
  for (const target of channel.targets) {
    if (targets.has(target.id)) continue;
    const device = devices.find(candidate => candidate.did === target.id);
    targets.set(target.id, { id: target.id, name: target.name, room: target.room, device, smart: Boolean(device && isIndependentSmartDevice(device)) });
  }
  return [...targets.values()];
}

export function selectDeviceView<T extends ViewDevice>(devices: T[], view: "hardware" | "controlled") {
  const ids = new Set(devices.map(device => device.did).filter((did): did is string => Boolean(did)));
  const controlledIds = new Set<string>();
  for (const device of devices) for (const channel of device.topology?.channels ?? []) for (const target of channel.targets) if (ids.has(target.id)) controlledIds.add(target.id);

  if (view === "hardware") {
    const groups = new Map<string, T[]>();
    devices.forEach((device, index) => {
      const hardwareRole = device.hardwareRole ?? inferHardwareRole(device.detail ?? device.model ?? "", device.name);
      const independentLight = (device.kind === "light" || device.kind === "lamp") && isIndependentSmartDevice(device);
      if (!isControlDevice(device) && !independentLight) return;
      if (hardwareRole === "device" && device.topology?.relation === "mapped" && device.parentId && ids.has(device.parentId)) return;
      const identity = device.did ? `${device.homeId ?? ""}:${device.did}` : `${device.homeId ?? ""}:anonymous:${index}`;
      const members = groups.get(identity) ?? [];
      members.push(device);
      groups.set(identity, members);
    });

    return [...groups.values()].map(members => {
      const first = members[0];
      const model = first.detail ?? first.model ?? "";
      const hardwareRole = members.map(device => device.hardwareRole ?? inferHardwareRole(device.detail ?? device.model ?? "", device.name)).find(role => role !== "device") ?? "device";
      const namedHardware = members.find(device => hardwareRole === "controller" ? centralControllerName.test(device.name) : hardwareRole === "switch" ? controllerName.test(device.name) : true) ?? first;
      const room = namedHardware.room ?? first.room ?? "";
      const name = hardwareRole === "controller" && !centralControllerName.test(namedHardware.name) ? `${room && room !== "未分配" ? room : ""}中控屏` : namedHardware.name;
      return {
        ...namedHardware,
        name,
        icon: hardwareRole === "controller" ? "▤" : namedHardware.icon,
        hardwareRole,
        members,
        detail: namedHardware.detail ?? namedHardware.model ?? model,
      };
    });
  }

  return devices.filter(device => {
    if ((device.kind === "light" || device.kind === "lamp" || lightingName.test(device.name)) && !controllerName.test(device.name)) return true;
    if (isControlDevice(device)) return false;
    if (device.did && controlledIds.has(device.did)) return true;
    if (device.topology?.controlledBy.length || device.topology?.relation === "mapped") return true;
    if (lightingName.test(device.name) && !controllerName.test(device.name)) return true;
    return true;
  });
}

function normalizedDeviceName(name: string) { return name.trim().replace(/[\s\u3000·•_\-]+/g, "").toLocaleLowerCase(); }

export function groupControlledDevices<T extends ViewDevice>(devices: T[]): Array<ControlledDeviceGroup<T>> {
  const groups = new Map<string, T[]>();
  for (const device of devices) {
    const key = `${device.homeId ?? ""}:${device.room ?? ""}:${normalizedDeviceName(device.name)}`;
    const items = groups.get(key) ?? [];
    items.push(device);
    groups.set(key, items);
  }
  return [...groups.values()].map(members => {
    const ranked = [...members].sort((left, right) => Number(Boolean(right.topology?.controlledBy.some(source => source.connectionType === "wired"))) - Number(Boolean(left.topology?.controlledBy.some(source => source.connectionType === "wired"))));
    const primary = ranked[0];
    const topology = ranked.map(device => device.topology).find(Boolean) ?? null;
    if (!topology) return { ...primary, did: undefined, parentId: null, virtual: true, members } as ControlledDeviceGroup<T>;
    const unique = new Map<string, DeviceTopology["controlledBy"][number]>();
    for (const member of ranked) for (const source of member.topology?.controlledBy ?? []) unique.set(`${source.sourceId}:${source.channelIndex}:${source.channelSiid}:${source.connectionType}`, source);
    return { ...primary, did: undefined, parentId: null, virtual: true, topology: { ...topology, controlledBy: [...unique.values()] }, members } as ControlledDeviceGroup<T>;
  });
}
