import assert from "node:assert/strict";
import test from "node:test";

import { deviceConnection, devicePower, filterDeviceItems } from "../lib/device-management-filters.ts";

const items = [
  { name: "客厅灯", room: "客厅", kind: "灯具", connection: "online", power: "on" },
  { name: "客厅开关", room: "客厅", kind: "开关", connection: "online", power: "off" },
  { name: "卧室灯", room: "卧室", kind: "灯具", connection: "offline", power: "unknown" },
  { name: "未分配传感器", room: "未分配房间", kind: "传感器", connection: "unknown", power: "unknown" },
];
const defaults = { room: "全屋", kinds: [], connections: [], powers: [], query: "", sort: "stable" };

test("device filters combine dimensions with AND and choices within a dimension with OR", () => {
  const result = filterDeviceItems(items, { ...defaults, room: "客厅", kinds: ["灯具", "开关"], connections: ["online"], powers: ["on"], query: "客厅" });
  assert.deepEqual(result.map(item => item.name), ["客厅灯"]);
  assert.deepEqual(filterDeviceItems(items, { ...defaults, powers: ["off", "unknown"] }).map(item => item.name), ["客厅开关", "卧室灯", "未分配传感器"]);
});

test("unknown connection and power never become offline or off", () => {
  assert.equal(deviceConnection(undefined), "unknown");
  assert.equal(devicePower(null), "unknown");
  assert.deepEqual(filterDeviceItems(items, { ...defaults, connections: ["offline"], powers: ["off"] }), []);
});

test("device sorting is stable by default and explicit by name or state", () => {
  assert.equal(filterDeviceItems(items, defaults)[0].name, "客厅灯");
  const byName = filterDeviceItems(items, { ...defaults, sort: "name" }).map(item => item.name);
  assert.deepEqual(byName, items.map(item => item.name).sort((left, right) => left.localeCompare(right, "zh-CN")));
  assert.deepEqual(filterDeviceItems(items, { ...defaults, sort: "state" }).map(item => item.power), ["on", "off", "unknown", "unknown"]);
});

test("large homes keep every room and device available to filtering", () => {
  const largeHome = Array.from({ length: 100 }, (_, index) => ({
    name: index === 99 ? "超长中文设备名称用于验证搜索不会因显示宽度丢失" : `设备 ${index}`,
    room: index === 99 ? "未分配房间" : `房间 ${index % 20}`,
    kind: "灯具",
    connection: "online",
    power: index % 2 ? "off" : "on",
  }));
  assert.equal(filterDeviceItems(largeHome, defaults).length, 100);
  assert.equal(filterDeviceItems(largeHome, { ...defaults, room: "房间 19" }).length, 4);
  assert.deepEqual(filterDeviceItems(largeHome, { ...defaults, query: "超长中文" }).map(item => item.room), ["未分配房间"]);
});
