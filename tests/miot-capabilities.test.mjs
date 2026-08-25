import assert from "node:assert/strict";
import test from "node:test";
import { buildDeviceTopology } from "../lib/device-topology.ts";
import { classifyDeviceKind, findPhysicalDevice, groupControlledDevices, inferHardwareRole, isControlDevice, isIndependentSmartDevice, listSwitchChannelTargets, physicalDeviceId, selectDeviceView } from "../lib/device-views.ts";
import { normalizeMiotSpecification } from "../lib/miot-spec.ts";
import { analyzeSwitchBindingCapabilities, buildBindingActionParameters, listSwitchBindingTargets, listVisibleControlSources } from "../lib/switch-bindings.ts";
import { collectXiaomiHomes, mergeXiaomiDeviceRecords } from "../lib/xiaomi-cloud.ts";

test("preserves both owned and shared Xiaomi homes without duplicates", () => {
  const homes = collectXiaomiHomes({
    homelist: [{ home_id: "1001", name: "城市住宅" }],
    share_home_list: [{ id: "2002", home_name: "父母家" }],
    shared_homelist: [{ home_id: "1001", name: "城市住宅" }],
  });

  assert.deepEqual(homes.map(home => String(home.home_id ?? home.id)), ["1001", "2002"]);
});

test("preserves different logical load names that share one physical device ID", () => {
  const devices = mergeXiaomiDeviceRecords(
    [{ did: "center-1", homeId: "home-1", name: "中间筒灯" }],
    [
      { did: "center-1", homeId: "home-1", name: "中间筒灯", model: "xiaomi.controller.oh4w" },
      { did: "center-1", homeId: "home-1", name: "床头筒灯", model: "xiaomi.controller.oh4w" },
    ],
  );

  assert.deepEqual(devices.map(device => device.name), ["中间筒灯", "床头筒灯"]);
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

test("does not treat a wireless-mode toggle as a writable light-binding interface", () => {
  const specification = normalizeMiotSpecification("vendor.switch.mode-only", "urn:example", {
    type: "urn:example",
    services: [{ iid: 2, type: "urn:miot-spec-v2:service:switch:00000001:vendor:1", properties: [
      { iid: 1, type: "urn:miot-spec-v2:property:on:00000001:vendor:1", format: "bool", access: ["read", "write"] },
      { iid: 2, type: "urn:miot-spec-v2:property:wireless-mode:00000001:vendor:1", format: "bool", access: ["read", "write"] },
    ] }],
  });

  const capability = analyzeSwitchBindingCapabilities(specification.model, specification.groups);
  assert.equal(capability.status, "unsupported");
  assert.equal(capability.mode, "unsupported");
  assert.deepEqual(capability.targetActions, []);
});

test("keeps published binding information read-only when the actual model has no write operation", () => {
  const specification = normalizeMiotSpecification("vendor.switch.readonly", "urn:example", {
    type: "urn:example",
    services: [{ iid: 5, type: "urn:miot-spec-v2:service:switch-panel:00000001:vendor:1", properties: [
      { iid: 1, type: "urn:miot-spec-v2:property:bound-keys:00000001:vendor:1", format: "string", access: ["read"] },
      { iid: 2, type: "urn:miot-spec-v2:property:max-key-count:00000001:vendor:1", format: "uint8", access: ["read"] },
    ] }],
  });

  const capability = analyzeSwitchBindingCapabilities(specification.model, specification.groups);
  assert.equal(capability.status, "readonly");
  assert.equal(capability.mode, "readonly");
  assert.deepEqual(capability.properties.map(property => property.name), ["bound-keys", "max-key-count"]);
  assert.deepEqual(capability.writableProperties, []);
});

test("uses only real published source-key, target-device and target-channel action parameters", () => {
  const specification = normalizeMiotSpecification("vendor.switch.bindable", "urn:example", {
    type: "urn:example",
    services: [{ iid: 7, type: "urn:miot-spec-v2:service:switch-panel:00000001:vendor:1", properties: [
      { iid: 1, type: "urn:miot-spec-v2:property:source-key:00000001:vendor:1", format: "uint8", access: ["write"] },
      { iid: 2, type: "urn:miot-spec-v2:property:target-did:00000001:vendor:1", format: "string", access: ["write"] },
      { iid: 3, type: "urn:miot-spec-v2:property:target-channel:00000001:vendor:1", format: "uint8", access: ["write"] },
    ], actions: [{ iid: 1, type: "urn:miot-spec-v2:action:bind-device:00000001:vendor:1", in: [1, 2, 3] }] }],
  });

  const capability = analyzeSwitchBindingCapabilities(specification.model, specification.groups);
  assert.equal(capability.status, "writable");
  assert.equal(capability.mode, "target-action");
  assert.equal(capability.targetActions[0].sourceKeySelectable, true);
  assert.equal(capability.targetActions[0].targetChannelSelectable, true);
  assert.deepEqual(buildBindingActionParameters(capability.targetActions[0], {
    key: "light-1", name: "主卧灯带", room: "主卧", did: "wired-panel-1", deviceDid: "mapped-light-1",
    channelIndex: 3, channelSiid: 4, controllerName: "主卧中控", kind: "wired-circuit",
  }, 2), [2, "wired-panel-1", 3]);
});

test("never invents target selection when a vendor action contains an opaque private parameter", () => {
  const specification = normalizeMiotSpecification("vendor.switch.private", "urn:example", {
    type: "urn:example",
    services: [{ iid: 7, type: "urn:miot-spec-v2:service:switch-panel:00000001:vendor:1", properties: [
      { iid: 1, type: "urn:miot-spec-v2:property:target-did:00000001:vendor:1", format: "string", access: ["read"] },
      { iid: 2, type: "urn:miot-spec-v2:property:private-payload:00000001:vendor:1", format: "string", access: ["write"] },
    ], actions: [{ iid: 1, type: "urn:miot-spec-v2:action:bind-device:00000001:vendor:1", in: [1, 2] }] }],
  });

  const capability = analyzeSwitchBindingCapabilities(specification.model, specification.groups);
  assert.equal(capability.mode, "pairing");
  assert.equal(capability.targetActions.length, 0);
  assert.equal(capability.actions[0].parameters[1].semantic, "unknown");
});

test("lists ordinary lamps through their real wired switch and excludes unrelated hardware", () => {
  const raw = [
    { did: "source-1", name: "床头无线开关", model: "vendor.switch.remote", roomName: "主卧" },
    { did: "wired-1", name: "客厅三开", model: "vendor.switch.triple", roomName: "客厅" },
    { did: "mapped-1", name: "玄关柜灯带", model: "vendor.switch.virtual", roomName: "玄关", extra: { parent_did: "wired-1", channel_index: 2, parent_siid: 3 } },
    { did: "smart-1", name: "客厅智能吸顶灯", model: "yeelink.light.ceiling", roomName: "客厅" },
    { did: "vacuum-1", name: "扫地机器人", model: "vendor.vacuum.cleaner", roomName: "客厅" },
  ];
  const topology = buildDeviceTopology(raw);
  const devices = raw.map(device => ({ ...device, room: device.roomName, homeId: "home-1", kind: classifyDeviceKind(device.model, device.name), parentId: topology.get(device.did).parentId, topology: topology.get(device.did) }));
  const targets = listSwitchBindingTargets(devices[0], devices);

  assert.equal(targets.length, 2);
  const ordinary = targets.find(target => target.name === "玄关柜灯带");
  assert.equal(ordinary.kind, "wired-circuit");
  assert.equal(ordinary.did, "wired-1");
  assert.equal(ordinary.channelIndex, 2);
  assert.equal(ordinary.channelSiid, 3);
  assert.equal(targets.find(target => target.name === "客厅智能吸顶灯").kind, "smart-device");
  assert.equal(targets.some(target => target.name === "扫地机器人"), false);
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
  assert.equal(actual[0].virtual, true);
  assert.equal(actual[0].did, undefined);
  assert.equal(actual[0].members.length, 2);
  assert.deepEqual(actual[0].topology.controlledBy.map(source => [source.sourceName, source.connectionType]), [["主卧中控", "wired"], ["床头开关", "wireless"]]);
});

test("only independent smart lights open from a switch binding", () => {
  const wiredCircuit = { did: "circuit-1", name: "玄关柜灯带", kind: "light", detail: "vendor.switch.virtual", parentId: "switch-1", topology: { relation: "mapped" } };
  const smartStrip = { did: "strip-1", name: "卧室灯带", kind: "light", detail: "yeelink.light.strip", parentId: null, topology: { relation: "none" } };

  assert.equal(isIndependentSmartDevice(wiredCircuit), false);
  assert.equal(isIndependentSmartDevice(smartStrip), true);
});

test("does not merge identical load names across different rooms or homes", () => {
  const devices = [
    { did: "light-1", name: "灯带", kind: "light", room: "主卧", homeId: "home-1" },
    { did: "light-2", name: "灯带", kind: "light", room: "客厅", homeId: "home-1" },
    { did: "light-3", name: "灯带", kind: "light", room: "主卧", homeId: "home-2" },
  ];

  assert.equal(groupControlledDevices(devices).length, 3);
});

test("hardware view exposes real switches, central panels and independent smart lights only", () => {
  const raw = [
    { did: "center-100", name: "主卧中控", model: "vendor.gateway.screen", roomName: "主卧" },
    { did: "bed-200", name: "床头开关", model: "vendor.switch.double", roomName: "主卧" },
    { did: "light-300", name: "主卧灯带", model: "vendor.switch.virtual", roomName: "主卧" },
    { did: "vacuum-400", name: "扫拖机器人", model: "vendor.vacuum.cleaner", roomName: "主卧" },
    { did: "smart-500", name: "主卧智能灯", model: "vendor.light.ceiling", roomName: "主卧" },
  ];
  const topology = buildDeviceTopology(raw);
  const devices = raw.map(device => ({ ...device, kind: classifyDeviceKind(device.model, device.name), topology: topology.get(device.did) }));

  assert.equal(classifyDeviceKind("vendor.gateway.screen", "主卧中控"), "switch");
  assert.deepEqual(selectDeviceView(devices, "hardware").map(device => device.name), ["主卧中控", "床头开关", "主卧智能灯"]);
});

test("keeps smart lights behind a real gateway visible as independent hardware", () => {
  const raw = [
    { did: "gateway-1", name: "客厅中控", model: "vendor.gateway.screen", roomName: "客厅" },
    { did: "mesh-light-2", name: "客厅智能灯具", model: "vendor.light.mesh", roomName: "客厅", extra: { parent_did: "gateway-1" } },
    { did: "mapped-light-3", name: "客厅普通筒灯", model: "vendor.switch.virtual", roomName: "客厅", extra: { parent_did: "gateway-1", channel_index: 1 } },
  ];
  const topology = buildDeviceTopology(raw);
  const devices = raw.map(device => ({ ...device, kind: classifyDeviceKind(device.model, device.name), parentId: topology.get(device.did).parentId, topology: topology.get(device.did) }));

  assert.equal(topology.get("mesh-light-2").relation, "subdevice");
  assert.equal(isIndependentSmartDevice(devices[1]), true);
  assert.equal(isIndependentSmartDevice(devices[2]), false);
  assert.deepEqual(selectDeviceView(devices, "hardware").map(device => device.name), ["客厅中控", "客厅智能灯具"]);
});

test("shows every living-room central panel, switch and smart light behind a switch-model panel", () => {
  const raw = [
    { did: "center-1", name: "客厅中控", model: "vendor.switch.panel", roomName: "客厅" },
    { did: "switch-2", name: "客厅三开", model: "vendor.switch.triple", roomName: "客厅" },
    { did: "smart-3", name: "客厅智能灯具", model: "yeelink.light.mesh", roomName: "客厅", extra: { parent_did: "center-1" } },
    { did: "load-4", name: "玄关柜灯带", model: "vendor.switch.virtual", roomName: "客厅", extra: { parent_did: "switch-2", channel_index: 1 } },
  ];
  const topology = buildDeviceTopology(raw);
  const devices = raw.map(device => ({ ...device, kind: classifyDeviceKind(device.model, device.name), parentId: topology.get(device.did).parentId, topology: topology.get(device.did) }));

  assert.equal(topology.get("smart-3").relation, "subdevice");
  assert.equal(topology.get("load-4").relation, "mapped");
  assert.deepEqual(selectDeviceView(devices, "hardware").map(device => device.name), ["客厅中控", "客厅三开", "客厅智能灯具"]);
  assert.equal(isIndependentSmartDevice(devices[2]), true);
  assert.equal(isIndependentSmartDevice(devices[3]), false);
});

test("recognizes actual home screens, gateways and vendor-specific light names", () => {
  assert.equal(classifyDeviceKind("vendor.gateway2.mcn001", "客厅设备"), "switch");
  assert.equal(classifyDeviceKind("vendor.custom.mesh", "客厅家庭屏"), "switch");
  assert.equal(classifyDeviceKind("vendor.custom.mesh", "客厅智能灯具"), "light");
  assert.equal(inferHardwareRole("vendor.gateway2.mcn001", "客厅设备"), "controller");
  assert.equal(isIndependentSmartDevice({ name: "客厅吸顶灯", kind: "light", detail: "yeelink.light.demo" }), true);
});

test("keeps logical load type separate from the physical hardware role", () => {
  assert.equal(classifyDeviceKind("xiaomi.controller.oh4w", "客厅中控"), "switch");
  assert.equal(classifyDeviceKind("xiaomi.controller.oh4w", "主卧中间筒灯"), "light");
  assert.equal(classifyDeviceKind("xiaomi.controller.oh4w", "玄关柜灯带"), "light");
  assert.equal(classifyDeviceKind("xiaomi.switch.triple", "客厅灯具"), "light");
  assert.equal(classifyDeviceKind("yeelink.light.ceiling", "客厅中控"), "light");
  assert.equal(classifyDeviceKind("vendor.switch.virtual", "主卧中间筒灯"), "light");
  assert.equal(classifyDeviceKind("xiaomi.controller.oh4w", "未命名", "light"), "light");
  assert.equal(inferHardwareRole("xiaomi.controller.oh4w", "主卧中间筒灯"), "controller");
});

test("keeps a Xiaomi controller in hardware view even when its reported target type is light", () => {
  const raw = [
    { did: "controller-100", name: "主卧中间筒灯", model: "xiaomi.controller.oh4w", type: "light", roomName: "客厅" },
    { did: "mapped-200", name: "主卧中间筒灯", model: "vendor.switch.virtual", type: "light", roomName: "主卧", extra: { parent_did: "controller-100", channel_index: 2, parent_siid: 3 } },
    { did: "smart-300", name: "客厅智能灯", model: "yeelink.light.ceiling", type: "light", roomName: "客厅" },
  ];
  const topology = buildDeviceTopology(raw);
  const devices = raw.map(device => ({ ...device, homeId: "home-1", room: device.roomName, kind: classifyDeviceKind(device.model, device.name), parentId: topology.get(device.did).parentId, topology: topology.get(device.did) }));

  assert.equal(devices[0].kind, "light");
  assert.equal(isControlDevice(devices[0]), true);
  assert.equal(topology.get("controller-100").role, "primary");
  assert.deepEqual(selectDeviceView(devices, "hardware").map(device => [device.did, device.kind]), [["controller-100", "light"], ["smart-300", "light"]]);
  assert.deepEqual(selectDeviceView(devices, "controlled").map(device => device.did), ["controller-100", "mapped-200", "smart-300"]);
});

test("uses each home and real device ID to keep one controller hardware card", () => {
  const duplicated = [
    { did: "controller-100", homeId: "home-1", name: "客厅中控", model: "xiaomi.controller.oh4w", kind: "light" },
    { did: "controller-100", homeId: "home-1", name: "客厅灯带", model: "xiaomi.controller.oh4w", kind: "light" },
    { did: "controller-100", homeId: "home-2", name: "客厅中控", model: "xiaomi.controller.oh4w", kind: "light" },
  ];

  assert.deepEqual(selectDeviceView(duplicated, "hardware").map(device => [device.homeId, device.did]), [
    ["home-1", "controller-100"],
    ["home-2", "controller-100"],
  ]);
  assert.deepEqual(selectDeviceView(duplicated, "controlled").map(device => device.name), ["客厅灯带"]);
});

test("normalizes split-device suffixes without merging complete Xiaomi protocol IDs", () => {
  assert.equal(physicalDeviceId("93485761.1"), "93485761");
  assert.equal(physicalDeviceId("93485761.2"), "93485761");
  assert.equal(physicalDeviceId("lumi.158d0001.2"), "lumi.158d0001");
  assert.equal(physicalDeviceId("lumi.158d0001"), "lumi.158d0001");
  assert.equal(physicalDeviceId("blt.3.12345678"), "blt.3.12345678");
});

test("merges hardware IDs that differ only in the final dot suffix", () => {
  const devices = [
    { id: 1, did: "93485761.1", homeId: "home-1", room: "主卧", name: "中间筒灯", model: "xiaomi.controller.oh4w", kind: "light" },
    { id: 2, did: "93485761.2", homeId: "home-1", room: "主卧", name: "床头筒灯", model: "xiaomi.controller.oh4w", kind: "light" },
    { id: 3, did: "93485762.1", homeId: "home-1", room: "主卧", name: "衣柜灯带", model: "xiaomi.controller.oh4w", kind: "light" },
    { id: 4, did: "93485761.3", homeId: "home-2", room: "主卧", name: "走廊筒灯", model: "xiaomi.controller.oh4w", kind: "light" },
  ];

  const hardware = selectDeviceView(devices, "hardware");
  assert.equal(hardware.length, 3);
  assert.deepEqual(hardware.find(device => device.homeId === "home-1" && device.did === "93485761.1").members.map(member => member.did), ["93485761.1", "93485761.2"]);
  assert.equal(findPhysicalDevice(hardware.filter(device => device.homeId === "home-1"), "93485761.2").did, "93485761.1");
  assert.deepEqual(selectDeviceView(devices.filter(device => device.homeId === "home-1"), "controlled").map(device => device.name), ["中间筒灯", "床头筒灯", "衣柜灯带"]);
});

test("shows one controller by physical ID but two logical lamps in the controlled view", () => {
  const devices = [
    { id: 1, did: "bedroom-center-1", homeId: "home-1", room: "主卧", name: "中间筒灯", model: "xiaomi.controller.oh4w", kind: "light" },
    { id: 2, did: "bedroom-center-1", homeId: "home-1", room: "主卧", name: "床头筒灯", model: "xiaomi.controller.oh4w", kind: "light" },
  ];

  const hardware = selectDeviceView(devices, "hardware");
  assert.equal(hardware.length, 1);
  assert.deepEqual([hardware[0].did, hardware[0].name, hardware[0].kind, hardware[0].hardwareRole, hardware[0].members.length], ["bedroom-center-1", "主卧中控屏", "light", "controller", 2]);
  assert.deepEqual(selectDeviceView(devices, "controlled").map(device => device.name), ["中间筒灯", "床头筒灯"]);
});

test("groups controlled loads by name and preserves every associated device ID", () => {
  const devices = [
    { did: "center-1", homeId: "home-1", room: "主卧", name: "中间筒灯", kind: "light" },
    { did: "bedside-left-2", homeId: "home-1", room: "主卧", name: "中间筒灯", kind: "light" },
    { did: "bedside-right-3", homeId: "home-1", room: "主卧", name: "中间筒灯", kind: "light" },
    { did: "bedside-light-4", homeId: "home-1", room: "主卧", name: "床头筒灯", kind: "light" },
  ];

  const groups = groupControlledDevices(devices);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.find(group => group.name === "中间筒灯").members.map(member => member.did), ["center-1", "bedside-left-2", "bedside-right-3"]);
});

test("finds the same controlled load and all controlling hardware across rooms", () => {
  const raw = [
    { did: "living-panel.1", name: "客厅中控", model: "xiaomi.controller.oh4w", roomName: "客厅" },
    { did: "bedroom-load.1", name: "主卧中间筒灯", model: "vendor.switch.virtual", roomName: "主卧", extra: { parent_did: "living-panel.1", channel_index: 1 } },
    { did: "remote-panel.1", name: "走廊无线开关", model: "vendor.switch.remote", roomName: "走廊", extra: { wireless_mode: true, channels: [{ channel_index: 2, target_dids: ["bedroom-load.1"] }] } },
    { did: "remote-panel.2", name: "主卧中间筒灯", model: "vendor.switch.remote", roomName: "走廊" },
  ];
  const topology = buildDeviceTopology(raw);
  const devices = raw.map(device => ({ ...device, room: device.roomName, homeId: "home-1", kind: classifyDeviceKind(device.model, device.name), parentId: topology.get(device.did).parentId, topology: topology.get(device.did) }));

  const actual = groupControlledDevices(selectDeviceView(devices, "controlled"), devices);
  assert.equal(actual.length, 1);
  assert.equal(actual[0].room, "主卧");
  assert.deepEqual(actual[0].members.map(member => member.did), ["bedroom-load.1", "remote-panel.2"]);
  assert.deepEqual(actual[0].topology.controlledBy.map(source => [source.sourceName, source.sourceRoom, source.connectionType]), [
    ["客厅中控", "客厅", "wired"],
    ["走廊无线开关", "走廊", "wireless"],
  ]);
  assert.equal(selectDeviceView(devices, "hardware").filter(device => physicalDeviceId(device.did) === "remote-panel").length, 1);
});

test("shows each button's ordinary-light names and separately opens real smart lights", () => {
  const raw = [
    { did: "panel-1", name: "客厅三开", model: "vendor.switch.triple", roomName: "客厅", extra: { channels: [{ channel_index: 1, target_dids: ["load-2", "smart-3", "smart-3"] }] } },
    { did: "load-2", name: "玄关柜灯带", model: "vendor.switch.virtual", roomName: "客厅", extra: { parent_did: "panel-1", channel_index: 1 } },
    { did: "smart-3", name: "客厅智能吸顶灯", model: "yeelink.light.ceiling", roomName: "客厅" },
  ];
  const topology = buildDeviceTopology(raw);
  const devices = raw.map(device => ({ ...device, kind: classifyDeviceKind(device.model, device.name), parentId: topology.get(device.did).parentId, topology: topology.get(device.did) }));
  const targets = listSwitchChannelTargets(topology.get("panel-1").channels[0], devices);

  assert.deepEqual(targets.map(target => [target.name, target.smart]), [
    ["玄关柜灯带", false],
    ["客厅智能吸顶灯", true],
  ]);
  assert.equal(targets.filter(target => target.id === "smart-3").length, 1);
});

test("expands every binding even when several keys belong to the same physical switch", () => {
  const raw = [
    { did: "wired-1", name: "主卧中控", model: "vendor.switch.triple", roomName: "主卧" },
    { did: "load-1", name: "主卧中间筒灯", model: "vendor.switch.virtual", roomName: "主卧", extra: { parent_did: "wired-1", channel_index: 1 } },
    { did: "remote-2", name: "床头开关", model: "vendor.switch.double", roomName: "主卧", extra: { wireless_mode: true, channels: [
      { channel_index: 1, target_dids: ["load-1"] },
      { channel_index: 2, target_dids: ["load-1"] },
    ] } },
  ];
  const topology = buildDeviceTopology(raw);
  const sources = listVisibleControlSources(topology.get("load-1").controlledBy);

  assert.equal(topology.get("load-1").controlledBy.length, 3);
  assert.equal(sources.length, 3);
  assert.deepEqual(sources.map(source => [source.sourceName, source.channelIndex, source.connectionType]), [
    ["主卧中控", 1, "wired"],
    ["床头开关", 1, "wireless"],
    ["床头开关", 2, "wireless"],
  ]);
});
