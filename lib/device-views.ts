import type { DeviceTopology } from "./device-topology";

type ViewDevice = { did?: string; name: string; kind: string; room?: string; homeId?: string; parentId?: string | null; detail?: string; model?: string; topology?: DeviceTopology | null };
export type ControlledDeviceGroup<T extends ViewDevice> = Omit<T, "did" | "parentId"> & { did?: undefined; parentId: null; virtual: true; members: T[] };

const lightingName = /灯带|灯光|吸顶灯|吊灯|筒灯|射灯|壁灯|台灯|床头灯|柜灯|夜灯|氛围灯|照明|灯$/;
const controllerName = /开关|面板|副控|主控|中控|中枢|控制屏|触控屏|遥控|控制器|[单双三四五六]开/;

export function classifyDeviceKind(model: string, name: string) {
  const value = model.toLowerCase();
  const known = ["light", "lamp", "aircondition", "acpartner", "airpurifier", "vacuum", "fan", "lock", "curtain", "humidifier", "plug", "switch", "camera", "sensor"];
  const kind = known.find(candidate => value.includes(candidate));
  if (lightingName.test(name) && !controllerName.test(name)) return "light";
  if (controllerName.test(name)) return "switch";
  if (kind) return kind;
  if (/(?:^|[._-])(?:gateway|panel|central|screen|controller|remote|hub)(?:[._-]|$)/.test(value)) return "switch";
  return controllerName.test(name) ? "switch" : "sensor";
}

export function isControlDevice(device: ViewDevice) {
  if (device.topology?.role === "primary" || device.topology?.role === "secondary-panel") return true;
  if (controllerName.test(device.name) && !lightingName.test(device.name)) return true;
  if (device.kind !== "switch") return false;
  if (lightingName.test(device.name) && !controllerName.test(device.name)) return false;
  return !device.topology?.controlledBy.length;
}

export function isIndependentSmartDevice(device: ViewDevice) {
  if (!device.did) return false;
  if (device.topology?.relation === "mapped" && device.parentId) return false;
  const model = (device.detail ?? device.model ?? "").toLowerCase();
  if (lightingName.test(device.name) && /(switch|relay|channel|gang|virtual)/.test(model) && !/(light|lamp|strip|bulb)/.test(model)) return false;
  return true;
}

export function selectDeviceView<T extends ViewDevice>(devices: T[], view: "hardware" | "controlled") {
  const ids = new Set(devices.map(device => device.did).filter((did): did is string => Boolean(did)));
  const controlledIds = new Set<string>();
  for (const device of devices) for (const channel of device.topology?.channels ?? []) for (const target of channel.targets) if (ids.has(target.id)) controlledIds.add(target.id);

  if (view === "hardware") return devices.filter(device => {
    if (!isControlDevice(device)) return (device.kind === "light" || device.kind === "lamp") && isIndependentSmartDevice(device);
    if (device.topology?.role === "secondary-panel") return true;
    if (device.topology?.relation === "mapped" && device.parentId && ids.has(device.parentId)) return false;
    return true;
  });

  return devices.filter(device => {
    if (device.did && controlledIds.has(device.did)) return true;
    if (device.topology?.controlledBy.length || device.topology?.relation === "mapped") return true;
    if (lightingName.test(device.name) && !controllerName.test(device.name)) return true;
    return !isControlDevice(device);
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
