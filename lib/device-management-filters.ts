export type DeviceFilterState = "online" | "offline" | "unknown";
export type PowerFilterState = "on" | "off" | "unknown";
export type DeviceSort = "stable" | "name" | "state";

export type DeviceFilterItem = {
  name: string;
  room: string;
  kind: string;
  connection: DeviceFilterState;
  power: PowerFilterState;
};

export type DeviceFilters = {
  room: string;
  kinds: readonly string[];
  connections: readonly DeviceFilterState[];
  powers: readonly PowerFilterState[];
  query: string;
  sort: DeviceSort;
};

const stateOrder: Record<PowerFilterState, number> = { on: 0, off: 1, unknown: 2 };

export function filterDeviceItems<T extends DeviceFilterItem>(items: readonly T[], filters: DeviceFilters): T[] {
  const query = filters.query.trim().toLocaleLowerCase("zh-CN");
  const result = items.filter(item =>
    (filters.room === "全屋" || item.room === filters.room)
    && (!filters.kinds.length || filters.kinds.includes(item.kind))
    && (!filters.connections.length || filters.connections.includes(item.connection))
    && (!filters.powers.length || filters.powers.includes(item.power))
    && (!query || `${item.name} ${item.room} ${item.kind}`.toLocaleLowerCase("zh-CN").includes(query)),
  );
  if (filters.sort === "name") return result.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  if (filters.sort === "state") return result.sort((left, right) => stateOrder[left.power] - stateOrder[right.power] || left.name.localeCompare(right.name, "zh-CN"));
  return result;
}

export function deviceConnection(online: boolean | null | undefined): DeviceFilterState {
  return online === true ? "online" : online === false ? "offline" : "unknown";
}

export function devicePower(on: boolean | null | undefined): PowerFilterState {
  return on === true ? "on" : on === false ? "off" : "unknown";
}
