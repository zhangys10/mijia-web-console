import assert from "node:assert/strict";
import test from "node:test";
import { buildDeviceTopology } from "../lib/device-topology.ts";
import { classifyDeviceKind, groupControlledDevices, selectDeviceView } from "../lib/device-views.ts";
import { normalizeMiotSpecification } from "../lib/miot-spec.ts";
import { collectXiaomiHomes } from "../lib/xiaomi-cloud.ts";

test("preserves both owned and shared Xiaomi homes without duplicates", () => {
  const homes = collectXiaomiHomes({
    homelist: [{ home_id: "1001", name: "城市住宅" }],
    share_home_list: [{ id: "2002", home_name: "父母家" }],
    shared_homelist: [{ home_id: "1001", name: "城市住宅" }],
  });

  assert.deepEqual(homes.map(home => String(home.home_id ?? home.id)), ["1001", "2002"]);
});

test("maps a real three-gang specification into independent buttons and vendor features", () => {
  const bool = (iid, name) => ({ iid, type: `urn:miot-spec-v2:property:${name}:00000001:vendor:1`, format: "bool", access: ["read", "write", "notify"] });
  const result = normalizeMiotSpecification("vendor.switch.triple", "urn:miot-spec-v2:device:switch:0000:vendor:1", {
    type: "urn:miot-spec-v2:device:switch:0000:vendor:1",
    services: [
      ...[2, 3, 4].map(iid => ({ iid, type: `urn:miot-spec-v2:service:switch:00000001:vendor:1`, properties: [bool(1, "on"), bool(2, "wireless-mode")] })),
      {
        iid: 5,
        type: "urn:miot-spec-v2:service:switch-panel:00000001:vendor:1",
        properties: [bool(1, "panel-add-enable")],
        actions: [{ iid: 1, type: "urn:miot-spec-v2:action:enter-learn-mode:00000001:vendor:1", in: [1] }],
        events: [{ iid: 1, type: "urn:miot-spec-v2:event:double-click:00000001:vendor:1", arguments: [1] }],
      },
    ],
  });

  assert.deepEqual(result.groups.slice(0, 3).map(group => group.label), ["按键 1", "按键 2", "按键 3"]);
  assert.deepEqual(result.groups.slice(0, 3).map(group => group.properties[0].key), ["2.1", "3.1", "4.1"]);
  assert.equal(result.groups[0].properties[1].label, "无线开关模式");
  assert.equal(result.groups[3].label, "按键绑定");
  assert.equal(result.groups[3].actions[0].label, "进入绑定学习模式");
  assert.deepEqual(result.groups[3].actions[0].inputs, [1]);
  assert.equal(result.groups[3].events[0].label, "双击");
});

test("retains readable status and precise choice and range metadata", () => {
  const result = normalizeMiotSpecification("vendor.switch.triple", "urn:example", {
    type: "urn:example",
    services: [{
      iid: 6,
      type: "urn:miot-spec-v2:service:switch-panel:00000001:vendor:1",
      properties: [
        { iid: 1, type: "urn:miot-spec-v2:property:backlight-mode:00000001:vendor:1", format: "uint8", access: ["read", "write"], "value-list": [{ value: 0, description: "关闭" }, { value: 1, description: "常亮" }] },
        { iid: 2, type: "urn:miot-spec-v2:property:jog-delay-time:00000001:vendor:1", format: "uint16", access: ["read", "write"], unit: "seconds", "value-range": [1, 60, 1] },
        { iid: 3, type: "urn:miot-spec-v2:property:bound-keys:00000001:vendor:1", format: "string", access: ["read"] },
      ],
    }],
  });

  assert.deepEqual(result.groups[0].properties[0].choices, [{ value: 0, label: "关闭" }, { value: 1, label: "常亮" }]);
  assert.deepEqual(result.groups[0].properties[1].range, { min: 1, max: 60, step: 1 });
  assert.equal(result.groups[0].properties[2].label, "已绑定按键");
  assert.equal(result.groups[0].properties[2].writable, false);
});

test("links a mapped entrance light to its actual three-gang primary button", () => {
  const topology = buildDeviceTopology([
    { did: "switch-100", name: "客厅三开", model: "vendor.switch.triple", roomName: "客厅" },
    { did: "virtual-200", name: "玄关柜灯带", model: "vendor.light.virtual", roomName: "玄关", extra: { parent_did: "switch-100", channel_index: 2, parent_siid: 3 } },
  ]);

  assert.equal(topology.get("switch-100").role, "primary");
  assert.equal(topology.get("switch-100").secondaryCount, 1);
  assert.equal(topology.get("virtual-200").role, "secondary");
  assert.equal(topology.get("virtual-200").parentName, "客厅三开");
  assert.equal(topology.get("virtual-200").channelLabel, "按键 2");
  assert.deepEqual(topology.get("virtual-200").controlledBy.map(item => item.sourceName), ["客厅三开"]);
  assert.equal(topology.get("virtual-200").controlledBy[0].connectionType, "wired");
  assert.deepEqual(topology.get("switch-100").channels.map(channel => ({ label: channel.label, targets: channel.targets.map(target => target.name) })), [{ label: "按键 2", targets: ["玄关柜灯带"] }]);
});

test("maps one wireless secondary button to multiple independently controlled devices", () => {
  const topology = buildDeviceTopology([
    { did: "wireless-100", name: "床头副控面板", model: "vendor.switch.double", roomName: "主卧", extra: { wireless_mode: true, channels: [{ channel_index: 1, target_dids: ["light-201", "light-202"] }] } },
    { did: "light-201", name: "玄关柜灯带", model: "vendor.light.strip", roomName: "玄关" },
    { did: "light-202", name: "客厅灯带", model: "vendor.light.strip", roomName: "客厅" },
  ]);

  assert.equal(topology.get("wireless-100").role, "secondary-panel");
  assert.deepEqual(topology.get("wireless-100").bindings.map(binding => binding.targetName), ["玄关柜灯带", "客厅灯带"]);
  assert.deepEqual(topology.get("light-201").controlledBy.map(item => item.sourceRole), ["secondary"]);
  assert.equal(topology.get("light-201").controlledBy[0].connectionType, "wireless");
  assert.deepEqual(topology.get("light-202").controlledBy.map(item => item.sourceName), ["床头副控面板"]);
  assert.equal(topology.get("wireless-100").channels.length, 1);
  assert.equal(topology.get("wireless-100").channels[0].targets.length, 2);
  assert.equal(topology.get("wireless-100").channels[0].connectionType, "wireless");
  assert.equal(topology.get("light-201").controlledBy[0].targetCount, 2);
});

test("discovers child-to-parent control mappings exposed only on the main device", () => {
  const topology = buildDeviceTopology([
    { did: "switch-100", name: "客厅三开", model: "vendor.switch.triple", roomName: "客厅", extra: { split_devices: [{ did: "mapped-2", channel_index: 2, siid: 3 }] } },
    { did: "mapped-2", name: "玄关柜灯带", model: "vendor.light.virtual", roomName: "玄关" },
  ]);

  assert.equal(topology.get("mapped-2").parentId, "switch-100");
  assert.equal(topology.get("mapped-2").channelSiid, 3);
  assert.equal(topology.get("switch-100").role, "primary");
});

test("resolves wireless binding to a primary switch button into the actual mapped light", () => {
  const topology = buildDeviceTopology([
    { did: "switch-100", name: "客厅三开", model: "vendor.switch.triple", roomName: "客厅" },
    { did: "mapped-2", name: "玄关柜灯带", model: "vendor.switch.virtual", roomName: "玄关", extra: { parent_did: "switch-100", channel_index: 2, parent_siid: 3 } },
    { did: "remote-300", name: "餐厅副控", model: "vendor.switch.double", roomName: "餐厅", extra: { wireless_mode: true, keys: [{ channel_index: 1, targets: [{ did: "switch-100", channel_index: 2, siid: 3 }] }] } },
  ]);

  assert.deepEqual(topology.get("remote-300").bindings.map(item => ({ name: item.targetName, via: item.viaName })), [{ name: "玄关柜灯带", via: "客厅三开" }]);
  assert.deepEqual(topology.get("mapped-2").controlledBy.map(item => item.sourceName), ["客厅三开", "餐厅副控"]);
  assert.equal(topology.get("mapped-2").controlledBy[1].sourceRole, "secondary");
  assert.equal(topology.get("remote-300").channels[0].targets[0].controllerCount, 2);
});

test("keeps a wired switch primary when it exposes bound loads without a wireless marker", () => {
  const topology = buildDeviceTopology([
    { did: "switch-100", name: "客厅三开", model: "vendor.switch.triple", roomName: "客厅", extra: { channels: [{ channel_index: 2, target_dids: ["light-201", "light-202"] }] } },
    { did: "light-201", name: "玄关柜灯带", model: "vendor.light.strip", roomName: "玄关" },
    { did: "light-202", name: "过道灯带", model: "vendor.light.strip", roomName: "过道" },
  ]);

  assert.equal(topology.get("switch-100").role, "primary");
  assert.equal(topology.get("switch-100").channels[0].role, "primary");
  assert.equal(topology.get("switch-100").channels[0].targets.length, 2);
  assert.deepEqual(topology.get("light-201").controlledBy.map(item => item.sourceRole), ["primary"]);
  assert.equal(topology.get("switch-100").channels[0].connectionType, "wired");
});

test("does not fabricate a target when a wireless-only switch does not publish bindings", () => {
  const topology = buildDeviceTopology([
    { did: "remote-300", name: "全屋副控", model: "vendor.switch.triple", roomName: "卧室", extra: { wireless_mode: true } },
    { did: "light-201", name: "玄关柜灯带", model: "vendor.light.strip", roomName: "玄关" },
  ]);

  assert.equal(topology.get("remote-300").role, "secondary-panel");
  assert.deepEqual(topology.get("remote-300").channels, []);
  assert.deepEqual(topology.get("light-201").controlledBy, []);
});

test("keeps a bedroom light strip visible even when Xiaomi reports a switch model", () => {
  const raw = [
    { did: "switch-100", name: "卧室三开", model: "vendor.switch.triple", roomName: "卧室" },
    { did: "light-200", name: "卧室灯带", model: "vendor.switch.virtual", roomName: "卧室" },
  ];
  const topology = buildDeviceTopology(raw);
  const devices = raw.map(device => ({ ...device, kind: classifyDeviceKind(device.model, device.name), topology: topology.get(device.did) }));

  assert.equal(classifyDeviceKind("vendor.switch.virtual", "卧室灯带"), "light");
  assert.equal(classifyDeviceKind("vendor.switch.triple", "卧室三开"), "switch");
  assert.deepEqual(selectDeviceView(devices, "controlled").map(device => device.name), ["卧室灯带"]);
});

test("hardware view keeps actual controlled devices nested below their switch only", () => {
  const raw = [
    { did: "switch-100", name: "卧室三开", model: "vendor.switch.triple", roomName: "卧室", extra: { channels: [{ channel_index: 1, target_dids: ["light-200"] }] } },
    { did: "light-200", name: "卧室灯带", model: "vendor.switch.virtual", roomName: "卧室" },
  ];
  const topology = buildDeviceTopology(raw);
  const devices = raw.map(device => ({ ...device, kind: classifyDeviceKind(device.model, device.name), topology: topology.get(device.did) }));

  assert.deepEqual(selectDeviceView(devices, "hardware").map(device => device.name), ["卧室三开"]);
  assert.deepEqual(topology.get("switch-100").channels[0].targets.map(target => target.name), ["卧室灯带"]);
  assert.deepEqual(selectDeviceView(devices, "controlled").map(device => device.name), ["卧室灯带"]);
});

test("hardware view hides a mapped cross-room load while retaining the secondary panel", () => {
  const raw = [
    { did: "main-100", name: "客厅三开", model: "vendor.switch.triple", roomName: "客厅" },
    { did: "bed-200", name: "卧室灯带", model: "vendor.switch.virtual", roomName: "卧室", extra: { parent_did: "main-100", channel_index: 2 } },
    { did: "remote-300", name: "床头副控面板", model: "vendor.switch.double", roomName: "卧室", extra: { wireless_mode: true, channels: [{ channel_index: 1, target_dids: ["bed-200"] }] } },
  ];
  const topology = buildDeviceTopology(raw);
  const devices = raw.map(device => ({ ...device, kind: classifyDeviceKind(device.model, device.name), parentId: topology.get(device.did).parentId, topology: topology.get(device.did) }));

  assert.deepEqual(selectDeviceView(devices, "hardware").map(device => device.name), ["客厅三开", "床头副控面板"]);
  assert.deepEqual(selectDeviceView(devices, "controlled").map(device => device.name), ["卧室灯带"]);
  assert.deepEqual(topology.get("bed-200").controlledBy.map(source => source.sourceName), ["客厅三开", "床头副控面板"]);
});

test("distinguishes the wired main-bedroom control from wireless bedside controls", () => {
  const raw = [
    { did: "center-100", name: "主卧中控", model: "vendor.switch.triple", roomName: "主卧" },
    { did: "light-200", name: "主卧中间筒灯", model: "vendor.switch.virtual", roomName: "主卧", extra: { parent_did: "center-100", channel_index: 2, parent_siid: 3 } },
    { did: "bed-300", name: "床头开关", model: "vendor.switch.double", roomName: "主卧", extra: { wireless_mode: true, channels: [{ channel_index: 1, target_dids: ["light-200"] }] } },
  ];
  const topology = buildDeviceTopology(raw);
  const devices = raw.map(device => ({ ...device, kind: classifyDeviceKind(device.model, device.name), parentId: topology.get(device.did).parentId, topology: topology.get(device.did) }));

  assert.equal(classifyDeviceKind("vendor.switch.virtual", "主卧中间筒灯"), "light");
  assert.deepEqual(topology.get("light-200").controlledBy.map(source => [source.sourceName, source.connectionType]), [["主卧中控", "wired"], ["床头开关", "wireless"]]);
  assert.equal(topology.get("center-100").channels[0].connectionType, "wired");
  assert.equal(topology.get("bed-300").channels[0].connectionType, "wireless");
  assert.deepEqual(selectDeviceView(devices, "hardware").map(device => device.name), ["主卧中控", "床头开关"]);
  assert.deepEqual(selectDeviceView(devices, "controlled").map(device => device.name), ["主卧中间筒灯"]);
});

test("classifies separate wired and wireless keys on the same physical panel", () => {
  const topology = buildDeviceTopology([
    { did: "panel-100", name: "主卧中控", model: "vendor.switch.triple", roomName: "主卧", extra: { channels: [{ channel_index: 2, wireless_mode: true, target_dids: ["lamp-300"] }] } },
    { did: "lamp-200", name: "主卧中间筒灯", model: "vendor.switch.virtual", roomName: "主卧", extra: { parent_did: "panel-100", channel_index: 1 } },
    { did: "lamp-300", name: "床头灯带", model: "vendor.light.strip", roomName: "主卧" },
  ]);

  assert.equal(topology.get("panel-100").connectionType, "mixed");
  assert.deepEqual(topology.get("panel-100").channels.map(channel => channel.connectionType), ["wired", "wireless"]);
  assert.equal(topology.get("lamp-300").controlledBy[0].sourceRole, "secondary");
});

test("merges repeated light cards and preserves every bound wired and wireless controller", () => {
  const raw = [
    { did: "center-100", name: "主卧中控", model: "vendor.switch.triple", roomName: "主卧" },
    { did: "wired-200", name: "主卧中间筒灯", model: "vendor.switch.virtual", roomName: "主卧", extra: { parent_did: "center-100", channel_index: 2 } },
    { did: "wireless-201", name: "主卧中间筒灯", model: "vendor.switch.virtual", roomName: "主卧" },
    { did: "bed-300", name: "床头开关", model: "vendor.switch.double", roomName: "主卧", extra: { wireless_mode: true, channels: [{ channel_index: 1, target_dids: ["wireless-201"] }] } },
  ];
  const topology = buildDeviceTopology(raw);
  const devices = raw.map(device => ({ ...device, room: device.roomName, homeId: "home-1", kind: classifyDeviceKind(device.model, device.name), parentId: topology.get(device.did).parentId, topology: topology.get(device.did) }));
  const actual = groupControlledDevices(selectDeviceView(devices, "controlled"));

  assert.equal(actual.length, 1);
  assert.equal(actual[0].name, "主卧中间筒灯");
  assert.equal(actual[0].members.length, 2);
  assert.deepEqual(actual[0].topology.controlledBy.map(source => [source.sourceName, source.connectionType]), [["主卧中控", "wired"], ["床头开关", "wireless"]]);
});

test("does not merge identical load names across different rooms or homes", () => {
  const devices = [
    { did: "light-1", name: "灯带", kind: "light", room: "主卧", homeId: "home-1" },
    { did: "light-2", name: "灯带", kind: "light", room: "客厅", homeId: "home-1" },
    { did: "light-3", name: "灯带", kind: "light", room: "主卧", homeId: "home-2" },
  ];

  assert.equal(groupControlledDevices(devices).length, 3);
});

test("switch view exposes only physical switches and central control panels", () => {
  const raw = [
    { did: "center-100", name: "主卧中控", model: "vendor.gateway.screen", roomName: "主卧" },
    { did: "bed-200", name: "床头开关", model: "vendor.switch.double", roomName: "主卧" },
    { did: "light-300", name: "主卧灯带", model: "vendor.switch.virtual", roomName: "主卧" },
    { did: "vacuum-400", name: "扫拖机器人", model: "vendor.vacuum.cleaner", roomName: "主卧" },
  ];
  const topology = buildDeviceTopology(raw);
  const devices = raw.map(device => ({ ...device, kind: classifyDeviceKind(device.model, device.name), topology: topology.get(device.did) }));

  assert.equal(classifyDeviceKind("vendor.gateway.screen", "主卧中控"), "switch");
  assert.deepEqual(selectDeviceView(devices, "hardware").map(device => device.name), ["主卧中控", "床头开关"]);
});
