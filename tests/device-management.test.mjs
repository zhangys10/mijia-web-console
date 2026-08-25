import assert from "node:assert/strict";
import test from "node:test";
import { buildDeviceTopology } from "../lib/device-topology.ts";
import { buildDeviceManagementModel } from "../lib/device-management.ts";
import { classifyDeviceKind, inferHardwareRole } from "../lib/device-views.ts";

function records(raw) {
  const topology = buildDeviceTopology(raw);
  return raw.map((device, index) => ({
    id: index + 1,
    did: device.did,
    name: device.name,
    home: "我的家",
    homeId: device.homeId ?? "home-1",
    room: device.roomName,
    kind: classifyDeviceKind(device.model, device.name),
    icon: "☀",
    on: false,
    status: "在线",
    detail: device.model,
    color: "orange",
    online: true,
    parentId: topology.get(device.did)?.parentId ?? null,
    hardwareRole: inferHardwareRole(device.model, device.name),
    topology: topology.get(device.did),
    groupMemberIds: device.groupMemberIds,
  }));
}

test("keeps smart lights, physical switches and voice aliases in their actual Xiaomi rooms", () => {
  const devices = records([
    { did: "bedroom-switch", name: "主卧中控", model: "xiaomi.controller.oh4w", roomName: "主卧" },
    { did: "bedroom-switch.1", name: "中间筒灯", model: "xiaomi.controller.oh4w", roomName: "勿关" },
    { did: "smart-light", name: "主卧智能灯", model: "yeelink.light.ceiling", roomName: "主卧" },
  ]);

  const model = buildDeviceManagementModel(devices);

  assert.deepEqual(model.records.map(record => [record.device.name, record.device.room, record.category]), [
    ["主卧中控", "主卧", "controller"],
    ["中间筒灯", "勿关", "voice-alias"],
    ["主卧智能灯", "主卧", "smart-light"],
  ]);
  assert.equal(model.records[1].owner.did, "bedroom-switch");
});

test("links a voice alias from 勿关 to the matching wired-room lamp topology", () => {
  const devices = records([
    { did: "bedroom-switch", name: "主卧中控", model: "xiaomi.controller.oh4w", roomName: "主卧" },
    { did: "bedroom-load", name: "中间筒灯", model: "vendor.switch.virtual", roomName: "主卧", extra: { parent_did: "bedroom-switch", channel_index: 1 } },
    { did: "bedroom-switch.2", name: "中间筒灯", model: "xiaomi.controller.oh4w", roomName: "勿关" },
  ]);

  const model = buildDeviceManagementModel(devices);
  const lamp = model.topologies.find(topology => topology.name === "中间筒灯");

  assert.equal(lamp.room, "主卧");
  assert.deepEqual(lamp.loads.map(device => device.did), ["bedroom-load"]);
  assert.deepEqual(lamp.aliases.map(device => device.did), ["bedroom-switch.2"]);
  assert.deepEqual(lamp.controls.map(control => [control.device.name, control.connection]), [
    ["主卧中控", "wired"],
    ["主卧中控", "wireless"],
  ]);
});

test("separates same-name lamp topologies by the location of their wired switch", () => {
  const devices = records([
    { did: "bedroom-switch", name: "主卧中控", model: "xiaomi.controller.oh4w", roomName: "主卧" },
    { did: "living-switch", name: "客厅三开", model: "vendor.switch.triple", roomName: "客厅" },
    { did: "bedroom-load", name: "中间筒灯", model: "vendor.switch.virtual", roomName: "勿关", extra: { parent_did: "bedroom-switch", channel_index: 1 } },
    { did: "living-load", name: "中间筒灯", model: "vendor.switch.virtual", roomName: "主卧", extra: { parent_did: "living-switch", channel_index: 1 } },
    { did: "bedroom-switch.2", name: "中间筒灯", model: "xiaomi.controller.oh4w", roomName: "勿关" },
  ]);

  const model = buildDeviceManagementModel(devices);
  const bedroom = model.topologies.find(topology => topology.name === "中间筒灯" && topology.room === "主卧");
  const living = model.topologies.find(topology => topology.name === "中间筒灯" && topology.room === "客厅");

  assert.deepEqual(bedroom.loads.map(device => device.did), ["bedroom-load"]);
  assert.deepEqual(bedroom.aliases.map(device => device.did), ["bedroom-switch.2"]);
  assert.deepEqual(living.loads.map(device => device.did), ["living-load"]);
  assert.equal(living.aliases.length, 0);
});

test("links a separate wireless bedside switch to the wired primary controller", () => {
  const devices = records([
    { did: "bedroom-control", name: "主卧中控", model: "xiaomi.controller.oh4w", roomName: "主卧" },
    { did: "bedside-switch", name: "床头无线开关", model: "vendor.switch.triple", roomName: "主卧" },
    { did: "bedroom-load", name: "中间筒灯", model: "vendor.switch.virtual", roomName: "主卧", extra: { parent_did: "bedroom-control", channel_index: 1 } },
    { did: "bedside-switch.1", name: "中间筒灯", model: "vendor.switch.triple", roomName: "勿关" },
  ]);

  const model = buildDeviceManagementModel(devices);
  const topology = model.topologies.find(item => item.name === "中间筒灯");

  assert.equal(topology.room, "主卧");
  assert.deepEqual(topology.aliases.map(device => [device.did, device.room]), [["bedside-switch.1", "勿关"]]);
  assert.deepEqual(topology.controls.map(control => [control.device.did, control.connection]), [
    ["bedroom-control", "wired"],
    ["bedside-switch", "wireless"],
  ]);
});

test("supports one wireless switch controlling multiple distinct lamp topologies", () => {
  const devices = records([
    { did: "lumi.main", name: "主卧中控", model: "xiaomi.controller.oh4w", roomName: "主卧" },
    { did: "lumi.remote", name: "床头无线开关", model: "vendor.switch.triple", roomName: "主卧" },
    { did: "circuit-middle", name: "中间筒灯", model: "vendor.switch.virtual", roomName: "主卧", extra: { parent_did: "lumi.main", channel_index: 1 } },
    { did: "circuit-bedside", name: "床头灯带", model: "vendor.switch.virtual", roomName: "主卧", extra: { parent_did: "lumi.main", channel_index: 2 } },
    { did: "lumi.remote.1", name: "中间筒灯", model: "vendor.switch.triple", roomName: "勿关" },
    { did: "lumi.remote.2", name: "床头灯带", model: "vendor.switch.triple", roomName: "勿关" },
  ]);

  const model = buildDeviceManagementModel(devices);

  for (const [name, alias] of [["中间筒灯", "lumi.remote.1"], ["床头灯带", "lumi.remote.2"]]) {
    const topology = model.topologies.find(item => item.name === name);
    assert.equal(topology.room, "主卧");
    assert.deepEqual(topology.aliases.map(device => device.did), [alias]);
    assert.ok(topology.controls.some(control => control.device.did === "lumi.main" && control.connection === "wired"));
    assert.ok(topology.controls.some(control => control.device.did === "lumi.remote" && control.connection === "wireless"));
  }
});

test("shows group cards in room inventory while preserving member editing targets", () => {
  const devices = records([
    { did: "group.42", name: "客厅灯组", model: "yeelink.light.group", roomName: "客厅", groupMemberIds: ["light-1", "light-2"] },
    { did: "light-1", name: "左侧筒灯", model: "yeelink.light.ceiling", roomName: "客厅" },
    { did: "light-2", name: "右侧筒灯", model: "yeelink.light.ceiling", roomName: "客厅" },
  ]);

  const model = buildDeviceManagementModel(devices);

  assert.equal(model.records.length, 1);
  assert.equal(model.records[0].category, "group");
  assert.deepEqual(model.records[0].groupMembers.map(device => device.did), ["light-1", "light-2"]);
});

test("keeps independent smart lights in their real room despite a gateway elsewhere", () => {
  const devices = records([
    { did: "living-gateway", name: "客厅中控", model: "xiaomi.controller.oh4w", roomName: "客厅" },
    { did: "bedroom-light", name: "主卧智能灯", model: "yeelink.light.ceiling", roomName: "主卧", extra: { parent_did: "living-gateway" } },
  ]);

  const model = buildDeviceManagementModel(devices);

  assert.equal(model.topologies.find(topology => topology.name === "主卧智能灯").room, "主卧");
});
