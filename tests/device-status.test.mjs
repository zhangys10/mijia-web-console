import assert from "node:assert/strict";
import test from "node:test";

import { buildDeviceStatusSnapshot, collectDeviceStatus } from "../lib/device-status.ts";

const session = { userId: "test-user", serviceToken: "fake-token", ssecurity: "fake-security", region: "cn" };

function viewDevice(overrides) {
  return {
    did: "did-1",
    name: "设备",
    model: "vendor.kind.v1",
    online: true,
    on: null,
    room: "客厅",
    homeId: "home-1",
    home: "我的家",
    roomId: "",
    icon: null,
    parentId: null,
    logicalType: "",
    urn: null,
    groupMemberIds: [],
    groupIds: [],
    powerControl: null,
    topology: null,
    ...overrides,
  };
}

function fakeSync(devices, runtime = {}) {
  return async () => ({
    devices,
    runtime: {
      failedPropertyBatchCount: 0,
      specificationFailureCount: 0,
      timedOut: false,
      ...runtime,
    },
  });
}

function fakeDiscovery(homeIds = ["home-1"]) {
  return async () => ({
    homes: homeIds.map(id => ({ id, name: "我的家" })),
    devices: [],
    controlObjectResults: [],
    completeness: "complete",
    warnings: [],
    successfulHomeCount: homeIds.length,
    failedHomeCount: 0,
    requestAttemptCount: 1,
  });
}

test("groups device on/off state by room like the home dashboard", async () => {
  const snapshot = await collectDeviceStatus(session, "home-1", {
    listDevices: fakeDiscovery(),
    sync: fakeSync([
      viewDevice({ did: "light-1", name: "客厅吸顶灯", model: "yeelink.light.ceil1", on: true }),
      viewDevice({ did: "lamp-1", name: "床头灯", model: "yeelink.lamp.bed1", room: "主卧", on: false }),
      viewDevice({ did: "purifier-1", name: "空气净化器", model: "zhimi.airpurifier.ma2", on: true }),
      viewDevice({ did: "switch-1", name: "客厅三开", model: "xiaomi.switch.demo3" }),
    ]),
  });
  const rooms = Object.fromEntries(snapshot.rooms.map(group => [group.room, group.items]));
  assert.equal(snapshot.completeness, "complete");
  assert.deepEqual(snapshot.rooms.map(group => group.room), ["客厅", "主卧"]);
  assert.deepEqual(
    rooms["客厅"].map(item => [item.name, item.state]),
    [["客厅吸顶灯", "on"], ["空气净化器", "on"]],
  );
  assert.deepEqual(rooms["主卧"].map(item => [item.name, item.state]), [["床头灯", "off"]]);
  // Switch panels are control surfaces, not loads: never reported as powered devices.
  assert.ok(!JSON.stringify(snapshot).includes("客厅三开"));
  assert.equal(snapshot.poweredOn, 2);
});

test("offline devices and missing power readings stay unknown instead of guessed", async () => {
  const snapshot = await collectDeviceStatus(session, "home-1", {
    listDevices: fakeDiscovery(),
    sync: fakeSync([
      viewDevice({ did: "vacuum-1", name: "扫拖机器人", model: "xiaomi.vacuum.d109", online: false, on: null }),
      viewDevice({ did: "lock-1", name: "智能门锁", model: "xiaomi.lock.b64", room: "玄关", on: null }),
    ]),
  });
  const vacuum = snapshot.rooms.find(group => group.room === "客厅")?.items[0];
  const lock = snapshot.rooms.find(group => group.room === "玄关")?.items[0];
  assert.deepEqual({ state: vacuum.state, online: vacuum.online }, { state: "unknown", online: false });
  assert.deepEqual({ state: lock.state, online: lock.online }, { state: "unknown", online: true });
  assert.equal(snapshot.completeness, "partial");
  assert.ok(snapshot.warnings.some(warning => warning.includes("离线")));
});

test("snapshot never leaks identifiers or raw Xiaomi fields", async () => {
  const snapshot = await collectDeviceStatus(session, "home-1", {
    listDevices: fakeDiscovery(),
    sync: fakeSync([
      viewDevice({ did: "secret-did-001", name: "客厅吸顶灯", model: "yeelink.light.ceil1", urn: "urn:miot-spec:device:light:secret", on: true }),
    ]),
  });
  const serialized = JSON.stringify(snapshot);
  for (const forbidden of ["secret-did-001", "yeelink.light.ceil1", "urn:miot-spec", "home-1", "test-user"]) {
    assert.ok(!serialized.includes(forbidden), `snapshot leaks ${forbidden}`);
  }
});

test("empty homes produce an empty snapshot, and non-member homes fail closed", async () => {
  const empty = await collectDeviceStatus(session, "home-1", {
    listDevices: fakeDiscovery(),
    sync: fakeSync([]),
  });
  assert.equal(empty.completeness, "empty");
  assert.deepEqual(empty.rooms, []);
  await assert.rejects(
    collectDeviceStatus(session, "other-home", { listDevices: fakeDiscovery(), sync: fakeSync([]) }),
    /AI_HOME_FORBIDDEN/,
  );
});

test("failed property batches degrade to partial with a warning", async () => {
  const snapshot = await collectDeviceStatus(session, "home-1", {
    listDevices: fakeDiscovery(),
    sync: fakeSync(
      [viewDevice({ did: "light-1", name: "客厅吸顶灯", model: "yeelink.light.ceil1", on: true })],
      { failedPropertyBatchCount: 1 },
    ),
  });
  assert.equal(snapshot.completeness, "partial");
  assert.ok(snapshot.warnings.some(warning => warning.includes("暂时不可用")));
});

test("buildDeviceStatusSnapshot caps rooms and items to bounded lists", () => {
  const devices = Array.from({ length: 60 }, (_, index) => ({
    id: index + 1,
    did: `did-${index}`,
    name: `灯${String(index).padStart(2, "0")}`,
    home: "我的家",
    homeId: "home-1",
    room: `房间${String(Math.floor(index / 3)).padStart(2, "0")}`,
    kind: "light",
    icon: "",
    on: index % 2 === 0,
    status: "",
    detail: "",
    color: "",
    online: true,
  }));
  const snapshot = buildDeviceStatusSnapshot({
    capturedAt: "2026-09-21T08:00:00Z",
    devices,
    failedBatchCount: 0,
    specificationFailureCount: 0,
    timedOut: false,
  });
  assert.ok(snapshot.rooms.length <= 20);
  assert.ok(snapshot.rooms.every(group => group.items.length <= 40));
});
