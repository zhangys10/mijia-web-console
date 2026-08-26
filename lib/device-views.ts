import type { DeviceControlChannel, DeviceTopology } from "./device-topology";

export type HardwareRole = "controller" | "switch" | "device";
type ViewDevice = { did?: string; name: string; kind: string; icon?: string; room?: string; homeId?: string; parentId?: string | null; detail?: string; model?: string; logicalType?: string; hardwareRole?: HardwareRole; topology?: DeviceTopology | null };
export type ControlledDeviceGroup<T extends ViewDevice> = Omit<T, "did" | "parentId"> & { did?: undefined; parentId: null; virtual: true; members: T[] };
export type SwitchChannelTarget<T extends ViewDevice> = { id: string; name: string; room: string; device?: T; smart: boolean; kind?: DeviceControlChannel["controlObjects"][number]["targetKind"]; evidence?: DeviceControlChannel["controlObjects"][number]["evidence"] };

const lightingName = /灯带|灯光|灯具|灯组|灯泡|球泡|吸顶灯|吊灯|筒灯|射灯|壁灯|台灯|床头灯|柜灯|夜灯|氛围灯|照明|光源|灯$/;
const controllerName = /开关|面板|副控|主控|中控|中枢|网关|家庭屏|智能屏|控制屏|触控屏|遥控|控制器|[单双三四五六]开/;
const centralControllerName = /中控|家庭屏|智能屏|控制屏|触控屏/;
const lightingModel = /(?:^|[._-])(?:light|lamp|bulb|strip|ceiling|downlight|spotlight|lighting|lightstrip)(?:[._-]|$)/;
const mappedModel = /(?:^|[._-])(?:switch|relay|channel|gang|virtual|split)(?:[._-]|$)/;
const centralControllerModel = /^(?:controller\w*|central\w*|screen\w*)$/;
const switchModel = /^(?:switch\w*|panel\w*|remote\w*|relay\w*|key\w*|button\w*)$/;
const modelKinds: Record<string, string> = { light: "light", lamp: "lamp", bulb: "light", strip: "light", ceiling: "light", downlight: "light", spotlight: "light", lighting: "light", lightstrip: "light", aircondition: "aircondition", airc: "aircondition", acpartner: "acpartner", airpurifier: "airpurifier", vacuum: "vacuum", fan: "fan", lock: "lock", curtain: "curtain", humidifier: "humidifier", plug: "plug", camera: "camera", sensor: "sensor", switch: "switch", panel: "switch", remote: "switch", relay: "switch", button: "switch", key: "switch", controller: "switch", screen: "switch", gateway: "gateway", hub: "gateway" };

function groupedDeviceId(did: string | null | undefined) { return Boolean(did && /^group/i.test(did.trim())); }

export function physicalDeviceId(did: string | null | undefined) {
  const value = did?.trim() ?? "";
  if (groupedDeviceId(value)) return value;
  return value.match(/^(.+)\.s\d+$/i)?.[1] ?? value;
}

export function samePhysicalDevice(left: string | null | undefined, right: string | null | undefined) {
  return Boolean(left && right && physicalDeviceId(left) === physicalDeviceId(right));
}

export function findPhysicalDevice<T extends ViewDevice>(devices: T[], did: string | null | undefined) {
  if (!did) return;
  return devices.find(device => device.did === did) ?? devices.find(device => samePhysicalDevice(device.did, did));
}

function modelParts(value: string) {
  const normalized = value.trim().toLowerCase();
  const segments = normalized.split(".").filter(Boolean);
  return { value: normalized, category: segments.length > 1 ? segments[1] : segments[0] ?? "", tokens: normalized.split(/[._:\-]/).filter(Boolean) };
}

export function inferHardwareRole(model: string, name = ""): HardwareRole {
  const { category, tokens } = modelParts(model);
  if (centralControllerModel.test(category) || tokens.slice(1).some(token => centralControllerModel.test(token))) return "controller";
  const declaredKind = modelKinds[category] ?? modelKinds[tokens.slice(1).find(token => Boolean(modelKinds[token])) ?? ""];
  if (declaredKind === "gateway" || declaredKind && declaredKind !== "switch") return "device";
  if (declaredKind === "switch") return "switch";
  if (centralControllerName.test(name)) return "controller";
  if (tokens.some(token => /^(?:virtual|split|channel)$/.test(token)) && lightingName.test(name) && !controllerName.test(name)) return "device";
  if (switchModel.test(category) || tokens.slice(1).some(token => switchModel.test(token)) || controllerName.test(name)) return "switch";
  return "device";
}

export function classifyDeviceKind(model: string, name: string, logicalType = "") {
  const { category, tokens } = modelParts(model);
  const modelKind = modelKinds[category] ?? modelKinds[tokens.slice(1).find(token => Boolean(modelKinds[token])) ?? ""];
  if (modelKind) return modelKind;

  const reported = modelParts(logicalType);
  const reportedKind = reported.tokens.find(token => Boolean(modelKinds[token]));
  if (reportedKind) return modelKinds[reportedKind];

  // Names and the cloud-reported logical type describe the controllable load.
  // The model is used separately for grouping the physical piece of hardware.
  if (lightingName.test(name) && !controllerName.test(name)) return "light";
  if (controllerName.test(name)) return "switch";

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
  if (groupedDeviceId(device.did)) return false;
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
  if (groupedDeviceId(device.did)) return false;
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
    const device = findPhysicalDevice(devices, target.id);
    targets.set(target.id, { id: target.id, name: target.name, room: target.room, device, smart: Boolean(device && isIndependentSmartDevice(device)), kind: target.kind, evidence: target.evidence });
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
      const grouped = groupedDeviceId(device.did);
      const hardwareRole = device.hardwareRole ?? inferHardwareRole(device.detail ?? device.model ?? "", device.name);
      const independentLight = (device.kind === "light" || device.kind === "lamp") && isIndependentSmartDevice(device);
      if (!grouped && !isControlDevice(device) && !independentLight) return;
      if (hardwareRole === "device" && device.topology?.relation === "mapped" && device.parentId && ids.has(device.parentId)) return;
      const identity = device.did ? `${device.homeId ?? ""}:${grouped ? device.did : physicalDeviceId(device.did)}` : `${device.homeId ?? ""}:anonymous:${index}`;
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
    if (groupedDeviceId(device.did)) return true;
    if ((device.kind === "light" || device.kind === "lamp" || lightingName.test(device.name)) && !controllerName.test(device.name)) return true;
    if (isControlDevice(device)) return false;
    if (device.did && controlledIds.has(device.did)) return true;
    if (device.topology?.controlledBy.length || device.topology?.relation === "mapped") return true;
    if (lightingName.test(device.name) && !controllerName.test(device.name)) return true;
    return true;
  });
}

function normalizedDeviceName(name: string) { return name.trim().replace(/[\s\u3000·•_\-]+/g, "").toLocaleLowerCase(); }

function controlledDeviceRoom<T extends ViewDevice>(device: T, allDevices: T[], visited = new Set<ViewDevice>()): string {
  const fallback = device.room ?? device.topology?.parentRoom ?? "未分配";
  if (visited.has(device) || isIndependentSmartDevice(device)) return fallback;
  visited.add(device);

  const homeDevices = allDevices.filter(candidate => candidate.homeId === device.homeId);
  const primary = device.topology?.controlledBy.find(source => source.connectionType === "wired")
    ?? device.topology?.controlledBy.find(source => source.sourceRole === "primary");
  if (primary) {
    const controller = findPhysicalDevice(homeDevices, primary.sourceId);
    return controller?.room ?? primary.sourceRoom ?? fallback;
  }

  const parent = findPhysicalDevice(homeDevices, device.parentId ?? device.topology?.parentId);
  if (parent && isControlDevice(parent) && parent.topology?.role !== "secondary-panel") return parent.room ?? device.topology?.parentRoom ?? fallback;

  const owners = homeDevices.filter(candidate => isControlDevice(candidate) && samePhysicalDevice(candidate.did, device.did));
  if (parent && isControlDevice(parent) && !owners.includes(parent)) owners.unshift(parent);
  for (const owner of owners) {
    for (const channel of owner.topology?.channels ?? []) {
      for (const target of channel.targets) {
        if (normalizedDeviceName(target.name) !== normalizedDeviceName(device.name)) continue;
        const actual = findPhysicalDevice(homeDevices, target.id);
        if (actual && actual !== device) return controlledDeviceRoom(actual, allDevices, visited);
      }
    }
  }

  return parent?.room ?? device.topology?.parentRoom ?? fallback;
}

function controlledDeviceRank(device: ViewDevice) {
  let score = 0;
  if (device.topology?.controlledBy.some(source => source.connectionType === "wired")) score += 8;
  if (isIndependentSmartDevice(device)) score += 4;
  if (device.topology?.relation === "mapped") score += 2;
  if (device.room && normalizedDeviceName(device.name).includes(normalizedDeviceName(device.room))) score += 1;
  return score;
}

export function groupControlledDevices<T extends ViewDevice>(devices: T[], allDevices: T[] = devices): Array<ControlledDeviceGroup<T>> {
  const groups = new Map<string, T[]>();
  for (const device of devices) {
    const room = controlledDeviceRoom(device, allDevices);
    const key = `${device.homeId ?? ""}:${room}:${normalizedDeviceName(device.name)}`;
    const members = groups.get(key) ?? [];
    members.push(device);
    groups.set(key, members);
  }
  return [...groups.values()].map(members => {
    const ranked = [...members].sort((left, right) => controlledDeviceRank(right) - controlledDeviceRank(left));
    const primary = ranked[0];
    const room = controlledDeviceRoom(primary, allDevices);
    const topology = ranked.map(device => device.topology).find(Boolean) ?? null;
    const unique = new Map<string, DeviceTopology["controlledBy"][number]>();
    for (const member of ranked) for (const source of member.topology?.controlledBy ?? []) unique.set(`${source.sourceId}:${source.channelIndex}:${source.channelSiid}:${source.connectionType}`, source);
    for (const controller of allDevices) {
      if (!controller.did || controller.homeId !== primary.homeId || !isControlDevice(controller)) continue;
      for (const channel of controller.topology?.channels ?? []) {
        const matched = channel.targets.some(target => members.some(member => target.id === member.did || samePhysicalDevice(target.id, member.did) && normalizedDeviceName(target.name) === normalizedDeviceName(primary.name)));
        if (!matched) continue;
        const connectionType = channel.connectionType === "mixed" ? channel.role === "secondary" ? "wireless" : "wired" : channel.connectionType;
        const source = { sourceId: controller.did, sourceName: controller.name, sourceRoom: controller.room ?? "未分配", sourceRole: channel.role, channelIndex: channel.channelIndex, channelSiid: channel.channelSiid, viaId: null, viaName: null, targetCount: channel.targets.length, connectionType };
        unique.set(`${source.sourceId}:${source.channelIndex}:${source.channelSiid}:${source.connectionType}`, source);
      }
    }
    if (!topology) return { ...primary, room, did: undefined, parentId: null, virtual: true, members } as ControlledDeviceGroup<T>;
    return { ...primary, room, did: undefined, parentId: null, virtual: true, topology: { ...topology, controlledBy: [...unique.values()] }, members } as ControlledDeviceGroup<T>;
  });
}
