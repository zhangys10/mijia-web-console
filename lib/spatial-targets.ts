import { buildDeviceManagementModel, type ManagedDevice } from "./device-management.ts";
export type Target = { kind: "device" | "lighting"; id: string; name: string; room: string; icon: string; on: boolean | null; online?: boolean | null; status: string; device?: ManagedDevice; groupMemberIds?: string[]; memberOf?: string[]; power?: { did: string; siid: number; piid: number } };
export function targetsFor(devices: ManagedDevice[]): Target[] {
  const model = buildDeviceManagementModel(devices);
  const targets: Target[] = model.records.filter(record => !["switch", "controller", "voice-alias", "wired-load"].includes(record.category)).map(record => ({ kind: "device", id: record.device.did ?? `device:${record.device.id}`, name: record.device.name, room: record.device.room, icon: record.device.icon || "◇", on: record.device.on, online: record.device.online, status: record.device.status, device: record.device, power: record.device.powerControl }));
  for (const record of model.records.filter(item => item.category === "group")) {
    const group = targets.find(target => target.id === record.device.did);
    if (!group) continue;
    group.groupMemberIds = record.groupMembers.map(member => member.did).filter((did): did is string => Boolean(did));
    for (const member of record.groupMembers) {
      if (!member.did || member.homeId !== record.device.homeId) continue;
      const existing = targets.find(target => target.kind === "device" && target.id === member.did);
      if (existing) existing.memberOf = [...new Set([...(existing.memberOf ?? []), group.id])];
      else targets.push({ kind: "device", id: member.did, name: member.name, room: member.room, icon: member.icon || "☀", on: member.on, online: member.online, status: member.status, device: member, power: member.powerControl, memberOf: [group.id] });
    }
  }
  for (const topology of model.topologies) {
    if (topology.kind !== "ordinary-load") continue;
    const control = topology.controls.find(item => item.relation === "wired-load" && item.endpoint?.powerControl);
    const power = topology.powerControl ?? control?.endpoint?.powerControl ?? topology.loads.find(item => item.powerControl)?.powerControl;
    const device = control?.device ?? topology.controls.find(item => item.relation === "wired-load")?.device;
    if (!power || !device) continue;
    targets.push({ kind: "lighting", id: `power:${power.did}:${power.siid}:${power.piid}`, name: topology.name, room: topology.room, icon: "☀", on: topology.on, online: topology.online, status: topology.on === true ? "已开启" : topology.on === false ? "已关闭" : "状态未知", device, power });
  }
  return Array.from(new Map(targets.map(target => [`${target.kind}:${target.id}`, target])).values());
}

