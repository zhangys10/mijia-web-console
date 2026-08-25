import type { DeviceTopology } from "./device-topology";

type ViewDevice = { did?: string; name: string; kind: string; parentId?: string | null; topology?: DeviceTopology | null };

const lightingName = /灯带|灯光|吸顶灯|吊灯|筒灯|射灯|壁灯|台灯|床头灯|柜灯|夜灯|氛围灯|照明|灯$/;
const controllerName = /开关|面板|副控|主控|遥控|控制器|[单双三四五六]开/;

export function classifyDeviceKind(model: string, name: string) {
  const value = model.toLowerCase();
  const known = ["light", "lamp", "aircondition", "acpartner", "airpurifier", "vacuum", "fan", "lock", "curtain", "humidifier", "plug", "switch", "camera", "sensor"];
  const kind = known.find(candidate => value.includes(candidate));
  if (lightingName.test(name) && !controllerName.test(name)) return "light";
  if (kind) return kind;
  return controllerName.test(name) ? "switch" : "sensor";
}

function isController(device: ViewDevice) {
  if (device.topology?.role === "primary" || device.topology?.role === "secondary-panel") return true;
  if (device.kind !== "switch") return false;
  if (lightingName.test(device.name) && !controllerName.test(device.name)) return false;
  return !device.topology?.controlledBy.length;
}

export function selectDeviceView<T extends ViewDevice>(devices: T[], view: "hardware" | "controlled") {
  const ids = new Set(devices.map(device => device.did).filter((did): did is string => Boolean(did)));
  const controlledIds = new Set<string>();
  for (const device of devices) for (const channel of device.topology?.channels ?? []) for (const target of channel.targets) if (ids.has(target.id)) controlledIds.add(target.id);

  if (view === "hardware") return devices.filter(device => {
    if (device.topology?.role === "secondary-panel") return true;
    if (device.did && controlledIds.has(device.did)) return false;
    if (device.topology?.controlledBy.some(source => ids.has(source.sourceId))) return false;
    if (device.topology?.relation === "mapped" && device.parentId && ids.has(device.parentId)) return false;
    return true;
  });

  return devices.filter(device => {
    if (device.did && controlledIds.has(device.did)) return true;
    if (device.topology?.controlledBy.length || device.topology?.relation === "mapped") return true;
    if (lightingName.test(device.name) && !controllerName.test(device.name)) return true;
    return !isController(device);
  });
}
