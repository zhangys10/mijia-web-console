import type { DeviceControlChannel, DeviceTopology } from "./device-topology";

type ViewDevice = { did?: string; name: string; kind: string; room?: string; homeId?: string; parentId?: string | null; detail?: string; model?: string; topology?: DeviceTopology | null };
export type ControlledDeviceGroup<T extends ViewDevice> = Omit<T, "did" | "parentId"> & { did?: undefined; parentId: null; virtual: true; members: T[] };
export type SwitchChannelTarget<T extends ViewDevice> = { id: string; name: string; room: string; device?: T; smart: boolean };

const lightingName = /灯带|灯光|灯具|灯组|灯泡|球泡|吸顶灯|吊灯|筒灯|射灯|壁灯|台灯|床头灯|柜灯|夜灯|氛围灯|照明|光源|灯$/;
const controllerName = /开关|面板|副控|主控|中控|中枢|网关|家庭屏|智能屏|控制屏|触控屏|遥控|控制器|[单双三四五六]开/;
const centralControllerName = /中控|中枢|网关|家庭屏|智能屏|控制屏|触控屏/;
const lightingModel = /(?:^|[._-])(?:light|lamp|bulb|strip|ceiling|downlight|spotlight|lighting|lightstrip)(?:[._-]|$)/;
const mappedModel = /(?:^|[._-])(?:switch|relay|channel|gang|virtual|split)(?:[._-]|$)/;
const centralControllerModel = /^(?:controller\w*|gateway\w*|central\w*|screen\w*|hub\w*)$/;
const switchModel = /^(?:switch\w*|panel\w*|remote\w*|relay\w*|key\w*|button\w*)$/;
const modelKinds: Record<string, string> = { light: "light", lamp: "lamp", bulb: "light", strip: "light", ceiling: "light", downlight: "light", spotlight: "light", lighting: "light", lightstrip: "light", aircondition: "aircondition", acpartner: "acpartner", airpurifier: "airpurifier", vacuum: "vacuum", fan: "fan", lock: "lock", curtain: "curtain", humidifier: "humidifier", plug: "plug", camera: "camera", sensor: "sensor" };

export function classifyDeviceKind(model: string, name: string) {
  const value = model.trim().toLowerCase();
  const segments = value.split(".").filter(Boolean);
  const category = segments.length > 1 ? segments[1] : segments[0] ?? "";
  const tokens = value.split(/[._-]/).filter(Boolean);

  if (centralControllerModel.test(category)) return "controller";
  if (modelKinds[category]) return modelKinds[category];
  if (switchModel.test(category)) {
    if (tokens.some(token => /^(?:virtual|split|channel)$/.test(token)) && lightingName.test(name) && !controllerName.test(name)) return "light";
    return "switch";
  }

  const centralToken = tokens.slice(1).find(token => centralControllerModel.test(token));
  if (centralToken) return "controller";
  const knownToken = tokens.slice(1).find(token => Boolean(modelKinds[token]));
  if (knownToken) return modelKinds[knownToken];
  const switchToken = tokens.slice(1).find(token => switchModel.test(token));
  if (switchToken) return "switch";

  if (centralControllerName.test(name)) return "controller";
  if (controllerName.test(name)) return "switch";
  if (lightingName.test(name)) return "light";
  return "sensor";
}

export function isControlDevice(device: ViewDevice) {
  const model = device.detail ?? device.model ?? "";
  if (model) {
    const kind = classifyDeviceKind(model, device.name);
    if (kind === "controller") return true;
    if (kind === "light" || kind === "lamp") return false;
    if (kind === "switch") return !(device.topology?.relation === "mapped" && device.parentId);
  }
  if (device.topology?.role === "primary" || device.topology?.role === "secondary-panel") return true;
  if (controllerName.test(device.name) && !lightingName.test(device.name)) return true;
  if (device.kind !== "switch" && device.kind !== "controller") return false;
  if (lightingName.test(device.name) && !controllerName.test(device.name)) return false;
  return !device.topology?.controlledBy.length;
}

export function isIndependentSmartDevice(device: ViewDevice) {
  const model = (device.detail ?? device.model ?? "").toLowerCase();
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
    const seen = new Set<string>();
    return devices.filter(device => {
      const model = device.detail ?? device.model ?? "";
      const kind = model ? classifyDeviceKind(model, device.name) : device.kind;
      if (!isControlDevice(device) && !((kind === "light" || kind === "lamp") && isIndependentSmartDevice(device))) return false;
      if (kind !== "controller" && device.topology?.relation === "mapped" && device.parentId && ids.has(device.parentId)) return false;
      if (!device.did) return true;
      const identity = `${device.homeId ?? ""}:${device.did}`;
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
  }

  return devices.filter(device => {
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
