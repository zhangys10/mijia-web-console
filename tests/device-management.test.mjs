import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDeviceTopology,
  deviceChannelStateKey,
  parseDerivedDeviceId,
  topologyForDevice,
} from "../lib/device-topology.ts";
import { buildDeviceManagementModel } from "../lib/device-management.ts";
import { classifyDeviceKind, inferHardwareRole, physicalDeviceId } from "../lib/device-views.ts";

function runtime(homeId, did, siid, connectionType, reportedOn = false, buttonIndex = null) {
  return {
    homeId,
    did,
    siid,
    buttonIndex,
    label: buttonIndex ? `按键 ${buttonIndex}` : `服务 ${siid}`,
    connectionType,
    reportedOn,
    modeValue: connectionType === "wired" ? 0 : connectionType === "wireless" ? 1 : null,
    evidence: connectionType === "unknown" ? "unknown" : "miot-property",
  };
}

function records(raw, states = []) {
  const runtimeStates = new Map(states.map(state => [deviceChannelStateKey(state.homeId, state.did, state.siid), state]));
  const topologies = buildDeviceTopology(raw, runtimeStates);
  return raw.map((device, index) => {
    const topology = topologyForDevice(topologies, device);
    const parsed = parseDerivedDeviceId(device.did);
    const channel = parsed
      ? topologies.get(`${device.homeId}:${parsed.physicalDid}`)?.channels.find(item => item.channelSiid === parsed.siid)
      : undefined;
    return {
      id: index + 1,
      did: device.did,
      name: device.name,
      home: device.home ?? "我的家",
      homeId: device.homeId,
      room: device.roomName,
      kind: classifyDeviceKind(device.model, device.name, device.logicalType ?? ""),
      icon: "☀",
      on: device.on ?? channel?.reportedOn ?? false,
      status: device.online === false ? "离线" : "在线",
      detail: device.model,
      color: "orange",
      online: device.online ?? true,
      parentId: topology?.parentId ?? null,
      hardwareRole: inferHardwareRole(device.model, device.name),
      topology,
      groupMemberIds: device.groupMemberIds,
    };
  });
}

test("recognizes only Xiaomi .sN IDs as derived endpoints", () => {
  assert.deepEqual(parseDerivedDeviceId("720449456.s14"), { physicalDid: "720449456", siid: 14 });
  assert.equal(parseDerivedDeviceId("group.120"), null);
  assert.equal(parseDerivedDeviceId("blt.3.12345678"), null);
  assert.equal(parseDerivedDeviceId("lumi.158d0001.2"), null);
  assert.equal(physicalDeviceId("720449456.s14"), "720449456");
  assert.equal(physicalDeviceId("lumi.158d0001.2"), "lumi.158d0001.2");
});

test("hardware inventory contains physical panels and switches but never their .sN endpoints", () => {
  const raw = [
    { did: "720449456", homeId: "fabric", name: "主卧智能中控屏", model: "xiaomi.controller.oh4w", roomName: "主卧" },
    { did: "720449456.s14", homeId: "fabric", name: "床头筒灯", model: "xiaomi.controller.oh4w", roomName: "主卧" },
    { did: "1206737667", homeId: "fabric", name: "主卧床头开关-左", model: "linp.switch.qh2db4", roomName: "主卧" },
    { did: "1206737667.s3", homeId: "fabric", name: "床头筒灯", model: "linp.switch.qh2db4", roomName: "勿关" },
    { did: "smart-1", homeId: "fabric", name: "主卧吸顶灯", model: "yeelink.light.ceiling", roomName: "主卧" },
  ];
  const devices = records(raw, [
    runtime("fabric", "720449456", 14, "wired", false, 1),
    runtime("fabric", "1206737667", 3, "wireless", false, 2),
  ]);
  const model = buildDeviceManagementModel(devices);

  assert.deepEqual(model.records.map(record => record.device.did), ["720449456", "1206737667", "smart-1"]);
  assert.deepEqual(model.endpoints.map(record => record.device.did), ["720449456.s14", "1206737667.s3"]);
  assert.deepEqual(model.records.map(record => record.category), ["controller", "switch", "smart-light"]);
});

test("aggregates the four main-bedroom loads with their real wired and wireless channel counts", () => {
  const raw = [
    { did: "center", homeId: "fabric", name: "主卧智能中控屏", model: "xiaomi.controller.oh4w", roomName: "主卧" },
    { did: "center.s14", homeId: "fabric", name: "床头筒灯", model: "xiaomi.controller.oh4w", roomName: "主卧" },
    { did: "center.s15", homeId: "fabric", name: "中间筒灯", model: "xiaomi.controller.oh4w", roomName: "主卧" },
    { did: "center.s16", homeId: "fabric", name: "床尾筒灯", model: "xiaomi.controller.oh4w", roomName: "主卧" },
    { did: "left", homeId: "fabric", name: "主卧床头开关-左", model: "linp.switch.qh2db4", roomName: "主卧" },
    { did: "left.s2", homeId: "fabric", name: "灯带", model: "linp.switch.qh2db4", roomName: "勿关" },
    { did: "left.s3", homeId: "fabric", name: "床头筒灯", model: "linp.switch.qh2db4", roomName: "勿关" },
    { did: "left.s4", homeId: "fabric", name: "中间筒灯", model: "linp.switch.qh2db4", roomName: "勿关" },
    { did: "right", homeId: "fabric", name: "主卧床头开关-右", model: "linp.switch.qh2db4", roomName: "主卧" },
    { did: "right.s2", homeId: "fabric", name: "灯带", model: "linp.switch.qh2db4", roomName: "主卧" },
    { did: "right.s3", homeId: "fabric", name: "床头筒灯", model: "linp.switch.qh2db4", roomName: "勿关" },
    { did: "right.s4", homeId: "fabric", name: "中间筒灯", model: "linp.switch.qh2db4", roomName: "勿关" },
  ];
  const states = [
    runtime("fabric", "center", 14, "wired", false, 1),
    runtime("fabric", "center", 15, "wired", false, 2),
    runtime("fabric", "center", 16, "wired", false, 3),
    runtime("fabric", "left", 2, "wireless", true, 1),
    runtime("fabric", "left", 3, "wireless", true, 2),
    runtime("fabric", "left", 4, "wireless", true, 3),
    runtime("fabric", "right", 2, "wired", false, 1),
    runtime("fabric", "right", 3, "wireless", true, 2),
    runtime("fabric", "right", 4, "wireless", true, 3),
  ];
  const model = buildDeviceManagementModel(records(raw, states));
  const summary = Object.fromEntries(model.topologies.map(topology => [topology.name, {
    room: topology.room,
    wired: topology.controls.filter(control => control.connection === "wired").length,
    wireless: topology.controls.filter(control => control.connection === "wireless").length,
  }]));

  assert.deepEqual(summary, {
    灯带: { room: "主卧", wired: 1, wireless: 1 },
    中间筒灯: { room: "主卧", wired: 1, wireless: 2 },
    床头筒灯: { room: "主卧", wired: 1, wireless: 2 },
    床尾筒灯: { room: "主卧", wired: 1, wireless: 0 },
  });
});

test("keeps same-name ordinary lamps in different rooms attached to their own wired switches", () => {
  const raw = [
    { did: "kitchen", homeId: "fabric", name: "厨房开关", model: "linp.switch.t2dbw2", roomName: "厨房" },
    { did: "kitchen.s3", homeId: "fabric", name: "灯带", model: "linp.switch.t2dbw2", roomName: "厨房" },
    { did: "bedroom", homeId: "fabric", name: "主卧床头开关-右", model: "linp.switch.qh2db4", roomName: "主卧" },
    { did: "bedroom.s2", homeId: "fabric", name: "灯带", model: "linp.switch.qh2db4", roomName: "主卧" },
    { did: "remote", homeId: "fabric", name: "主卧床头开关-左", model: "linp.switch.qh2db4", roomName: "主卧" },
    { did: "remote.s2", homeId: "fabric", name: "灯带", model: "linp.switch.qh2db4", roomName: "勿关" },
  ];
  const model = buildDeviceManagementModel(records(raw, [
    runtime("fabric", "kitchen", 3, "wired", false, 2),
    runtime("fabric", "bedroom", 2, "wired", true, 1),
    runtime("fabric", "remote", 2, "wireless", true, 1),
  ]));
  const strips = model.topologies.filter(item => item.name === "灯带");

  assert.equal(strips.length, 2);
  assert.deepEqual(strips.map(item => item.room), ["厨房", "主卧"]);
  assert.deepEqual(strips.find(item => item.room === "厨房").controls.map(control => [control.device.did, control.connection]), [
    ["kitchen", "wired"],
  ]);
  assert.deepEqual(strips.find(item => item.room === "主卧").controls.map(control => [control.device.did, control.connection]), [
    ["bedroom", "wired"],
    ["remote", "wireless"],
  ]);
});

test("keeps main and secondary bedroom lamps separate before assigning their wireless controls", () => {
  const raw = [
    { did: "main", homeId: "fabric", name: "主卧中控屏", model: "xiaomi.controller.oh4w", roomName: "主卧" },
    { did: "main.s15", homeId: "fabric", name: "中间筒灯", model: "xiaomi.controller.oh4w", roomName: "主卧" },
    { did: "secondary", homeId: "fabric", name: "次卧中控屏", model: "xiaomi.controller.oh4w", roomName: "次卧" },
    { did: "secondary.s15", homeId: "fabric", name: "中间筒灯", model: "xiaomi.controller.oh4w", roomName: "次卧" },
    { did: "main-remote", homeId: "fabric", name: "主卧床头开关", model: "linp.switch.qh2db4", roomName: "主卧" },
    { did: "main-remote.s4", homeId: "fabric", name: "中间筒灯", model: "linp.switch.qh2db4", roomName: "勿关" },
    { did: "secondary-remote", homeId: "fabric", name: "次卧床头四键", model: "linp.switch.qh2db4", roomName: "次卧" },
    { did: "secondary-remote.s4", homeId: "fabric", name: "中间筒灯副控次卧床头", model: "linp.switch.qh2db4", roomName: "勿关" },
  ];
  const model = buildDeviceManagementModel(records(raw, [
    runtime("fabric", "main", 15, "wired"),
    runtime("fabric", "secondary", 15, "wired"),
    runtime("fabric", "main-remote", 4, "wireless"),
    runtime("fabric", "secondary-remote", 4, "wireless"),
  ]));
  const downlights = model.topologies.filter(item => item.name === "中间筒灯");

  assert.equal(downlights.length, 2);
  assert.deepEqual(downlights.map(item => item.room), ["次卧", "主卧"]);
  assert.deepEqual(downlights.find(item => item.room === "主卧").controls.map(control => control.device.did), ["main", "main-remote"]);
  assert.deepEqual(downlights.find(item => item.room === "次卧").controls.map(control => control.device.did), ["secondary", "secondary-remote"]);
});

test("normalizes a location-prefix wireless alias without dropping the lamp name", () => {
  const raw = [
    { did: "panel", homeId: "fabric", name: "玄关中控屏", model: "xiaomi.controller.oh4w", roomName: "玄关" },
    { did: "panel.s16", homeId: "fabric", name: "客厅灯带", model: "xiaomi.controller.oh4w", roomName: "客厅" },
    { did: "remote", homeId: "fabric", name: "客厅三开", model: "linp.switch.t2dbw3", roomName: "客厅" },
    { did: "remote.s4", homeId: "fabric", name: "客厅副控灯带", model: "linp.switch.t2dbw3", roomName: "勿关" },
  ];
  const model = buildDeviceManagementModel(records(raw, [
    runtime("fabric", "panel", 16, "wired"),
    runtime("fabric", "remote", 4, "wireless"),
  ]));

  assert.equal(model.topologies.length, 1);
  assert.equal(model.topologies[0].name, "客厅灯带");
  assert.deepEqual(model.topologies[0].controls.map(control => [control.device.did, control.connection]), [
    ["panel", "wired"],
    ["remote", "wireless"],
  ]);
});

test("uses the derived endpoint room for ordinary cross-room loads", () => {
  const raw = [
    { did: "living-switch", homeId: "fabric", name: "客厅三开", model: "linp.switch.t2dbw3", roomName: "客厅" },
    { did: "living-switch.s2", homeId: "fabric", name: "玄关柜灯带", model: "linp.switch.t2dbw3", roomName: "玄关" },
    { did: "living-switch.s3", homeId: "fabric", name: "餐边柜灯带", model: "linp.switch.t2dbw3", roomName: "餐厅" },
  ];
  const model = buildDeviceManagementModel(records(raw, [
    runtime("fabric", "living-switch", 2, "wired", true, 1),
    runtime("fabric", "living-switch", 3, "wired", false, 2),
  ]));

  assert.equal(model.topologies.find(item => item.name === "玄关柜灯带").room, "玄关");
  assert.equal(model.topologies.find(item => item.name === "餐边柜灯带").room, "餐厅");
  assert.ok(model.topologies.every(item => item.controls[0].device.did === "living-switch"));
});

test("links a derived power endpoint to the real smart light and keeps the smart light state", () => {
  const raw = [
    { did: "panel", homeId: "fabric", name: "餐厅中控", model: "xiaomi.controller.oh4w", roomName: "餐厅" },
    { did: "panel.s15", homeId: "fabric", name: "餐厅吊灯", model: "xiaomi.controller.oh4w", roomName: "勿关" },
    { did: "pendant", homeId: "fabric", name: "餐厅吊灯", model: "yeelink.light.pendant", roomName: "餐厅", online: false, on: true },
  ];
  const model = buildDeviceManagementModel(records(raw, [runtime("fabric", "panel", 15, "wired", true, 2)]));
  const target = model.topologies.find(item => item.name === "餐厅吊灯");

  assert.equal(target.kind, "smart-light");
  assert.equal(target.room, "餐厅");
  assert.equal(target.stateSource, "smart-device");
  assert.equal(target.online, false);
  assert.equal(target.on, null, "an offline smart light must not borrow the relay state");
  assert.equal(target.controls[0].relationship, "smart-device-power");
});

test("links wireless derived power aliases to a smart-light group without inventing group members", () => {
  const raw = [
    { did: "remote", homeId: "fabric", name: "客厅副控", model: "linp.switch.qh2db4", roomName: "客厅" },
    { did: "remote.s4", homeId: "fabric", name: "客厅射灯副控", model: "linp.switch.qh2db4", roomName: "勿关" },
    { did: "group.900", homeId: "fabric", name: "客厅射灯", model: "yeelink.light.group", roomName: "客厅", groupMemberIds: [] },
  ];
  const model = buildDeviceManagementModel(records(raw, [runtime("fabric", "remote", 4, "wireless", false, 3)]));
  const target = model.topologies.find(item => item.name === "客厅射灯");

  assert.equal(target.kind, "smart-light-group");
  assert.deepEqual(target.aliases.map(device => device.did), ["remote.s4"]);
  assert.equal(target.controls[0].relationship, "wireless-secondary");
  assert.deepEqual(model.records.find(record => record.device.did === "group.900").groupMembers, []);
});

test("keeps unknown channel mode unknown and never defaults it to wired", () => {
  const raw = [
    { did: "switch", homeId: "fabric", name: "未识别开关", model: "linp.switch.unknown", roomName: "书房" },
    { did: "switch.s2", homeId: "fabric", name: "书房灯带", model: "linp.switch.unknown", roomName: "书房" },
  ];
  const model = buildDeviceManagementModel(records(raw));
  const target = model.topologies[0];

  assert.equal(target.kind, "unknown");
  assert.equal(target.unresolved, true);
  assert.equal(target.controls[0].connection, "unknown");
});

test("does not merge identical names across Xiaomi homes", () => {
  const raw = [
    { did: "a", homeId: "home-a", name: "卧室开关", model: "linp.switch.t2dbw2", roomName: "卧室" },
    { did: "a.s2", homeId: "home-a", name: "灯带", model: "linp.switch.t2dbw2", roomName: "卧室" },
    { did: "b", homeId: "home-b", name: "卧室开关", model: "linp.switch.t2dbw2", roomName: "卧室" },
    { did: "b.s2", homeId: "home-b", name: "灯带", model: "linp.switch.t2dbw2", roomName: "卧室" },
  ];
  const model = buildDeviceManagementModel(records(raw, [
    runtime("home-a", "a", 2, "wired"),
    runtime("home-b", "b", 2, "wired"),
  ]));

  assert.deepEqual(model.topologies.map(item => [item.homeId, item.name]), [["home-a", "灯带"], ["home-b", "灯带"]]);
});
