import assert from "node:assert/strict";
import test from "node:test";
import { buildDeviceTopology, deviceChannelStateKey, topologyForDevice } from "../lib/device-topology.ts";
import { classifyDeviceKind, inferHardwareRole, physicalDeviceId } from "../lib/device-views.ts";
import { listMiotAutomationTriggerCapabilities, normalizeMiotSpecification } from "../lib/miot-spec.ts";
import {
  analyzeSwitchBindingCapabilities,
  buildBindingActionParameters,
  listSwitchBindingTargets,
  listVisibleControlSources,
} from "../lib/switch-bindings.ts";
import { collectXiaomiHomes, mergeXiaomiDeviceRecords } from "../lib/xiaomi-cloud.ts";

test("preserves both owned and shared Xiaomi homes without duplicates", () => {
  const homes = collectXiaomiHomes({
    homelist: [{ home_id: "1001", name: "城市住宅" }],
    share_home_list: [{ id: "2002", home_name: "父母家" }],
    shared_homelist: [{ home_id: "1001", name: "城市住宅" }],
  });

  assert.deepEqual(homes.map(home => String(home.home_id ?? home.id)), ["1001", "2002"]);
});

test("preserves different Xiaomi list records instead of collapsing them by display name", () => {
  const devices = mergeXiaomiDeviceRecords(
    [{ did: "center-1.s14", homeId: "home-1", name: "中间筒灯" }],
    [
      { did: "center-1.s14", homeId: "home-1", name: "中间筒灯", model: "xiaomi.controller.oh4w" },
      { did: "center-1.s15", homeId: "home-1", name: "床头筒灯", model: "xiaomi.controller.oh4w" },
    ],
  );

  assert.deepEqual(devices.map(device => device.name), ["中间筒灯", "床头筒灯"]);
});

test("maps a real three-gang specification into independent switch services", () => {
  const property = (iid, name, format = "bool") => ({
    iid,
    type: `urn:miot-spec-v2:property:${name}:00000001:vendor:1`,
    format,
    access: ["read", "write", "notify"],
  });
  const result = normalizeMiotSpecification("linp.switch.qh2db4", "urn:example", {
    type: "urn:example",
    services: [2, 3, 4].map(iid => ({
      iid,
      type: "urn:miot-spec-v2:service:switch:00000001:vendor:1",
      properties: [property(1, "on"), property(2, "mode", "uint8")],
    })),
  });

  assert.deepEqual(result.groups.map(group => group.siid), [2, 3, 4]);
  assert.deepEqual(result.groups.map(group => group.properties.map(item => item.key)), [
    ["2.1", "2.2"],
    ["3.1", "3.2"],
    ["4.1", "4.2"],
  ]);
});

test("retains readable status plus exact choice and range metadata", () => {
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
  assert.equal(result.groups[0].properties[2].writable, false);
});

test("gives curtain automation properties and values readable Chinese labels", () => {
  const result = normalizeMiotSpecification("vendor.curtain.v1", "urn:example", {
    type: "urn:example",
    services: [{
      iid: 2,
      type: "urn:miot-spec-v2:service:curtain:00007816:vendor:1",
      description: "curtain",
      properties: [{
        iid: 1,
        type: "urn:miot-spec-v2:property:motor-control:00000038:vendor:1",
        description: "motor control",
        format: "uint8",
        access: ["write"],
        "value-list": [
          { value: 0, description: "Open" },
          { value: 1, description: "Close" },
          { value: 2, description: "Pause" },
          { value: 3, description: "Toggle" },
        ],
      }],
    }],
  });

  assert.equal(result.groups[0].label, "窗帘");
  assert.equal(result.groups[0].properties[0].label, "电机控制");
  assert.deepEqual(result.groups[0].properties[0].choices, [
    { value: 0, label: "打开" },
    { value: 1, label: "关闭" },
    { value: 2, label: "暂停" },
    { value: 3, label: "切换开关状态" },
  ]);
});

test("derives automation-visible state changes from notify properties and events", () => {
  const specification = normalizeMiotSpecification("vendor.sensor.test", "urn:example", {
    services: [{
      iid: 2,
      type: "urn:miot-spec-v2:service:light:00007802:vendor:1",
      description: "灯光",
      properties: [
        { iid: 1, type: "urn:miot-spec-v2:property:on:00000006:vendor:1", description: "开关", format: "bool", access: ["read", "notify"] },
        { iid: 2, type: "urn:miot-spec-v2:property:status:00000007:vendor:1", description: "状态", format: "uint8", access: ["read", "notify"], "value-list": [{ value: 1, description: "运行" }, { value: 2, description: "暂停" }] },
        { iid: 3, type: "urn:miot-spec-v2:property:battery-level:00000014:vendor:1", description: "电量", format: "uint8", access: ["read"] },
      ],
      events: [{ iid: 1, type: "urn:miot-spec-v2:event:motion-detected:0000500C:vendor:1", description: "检测到移动", arguments: [] }],
    }],
  });

  assert.deepEqual(listMiotAutomationTriggerCapabilities(specification.groups).map(item => ({ key: item.key, label: item.label, value: item.value })), [
    { key: "event:2.1", label: "灯光 · 检测到移动", value: undefined },
    { key: "property:2.1:true", label: "灯光 · 开关：开启", value: true },
    { key: "property:2.1:false", label: "灯光 · 开关：关闭", value: false },
    { key: "property:2.2:1", label: "灯光 · 运行状态：运行", value: 1 },
    { key: "property:2.2:2", label: "灯光 · 运行状态：暂停", value: 2 },
  ]);
});

test("does not treat a mode toggle or vendor local-control action as a cloud binding API", () => {
  const specification = normalizeMiotSpecification("linp.switch.qh2db4", "urn:example", {
    type: "urn:example",
    services: [{
      iid: 2,
      type: "urn:miot-spec-v2:service:switch:00000001:vendor:1",
      properties: [
        { iid: 1, type: "urn:miot-spec-v2:property:on:00000001:vendor:1", format: "bool", access: ["read", "write"] },
        { iid: 2, type: "urn:miot-spec-v2:property:mode:00000001:vendor:1", format: "uint8", access: ["read", "write"] },
        { iid: 3, type: "urn:miot-spec-v2:property:local-control:00000001:vendor:1", format: "string", access: ["read", "write"] },
      ],
      actions: [{ iid: 1, type: "urn:miot-spec-v2:action:get-control-num:00000001:vendor:1", in: [3] }],
    }],
  });
  const capability = analyzeSwitchBindingCapabilities(specification.model, specification.groups);

  assert.equal(capability.status, "unsupported");
  assert.equal(capability.mode, "unsupported");
  assert.deepEqual(capability.properties, []);
  assert.deepEqual(capability.actions, []);
  assert.deepEqual(capability.pairingActions, []);
});

test("keeps published binding information read-only when no safe write operation exists", () => {
  const specification = normalizeMiotSpecification("vendor.switch.readonly", "urn:example", {
    type: "urn:example",
    services: [{
      iid: 5,
      type: "urn:miot-spec-v2:service:switch-panel:00000001:vendor:1",
      properties: [
        { iid: 1, type: "urn:miot-spec-v2:property:bound-keys:00000001:vendor:1", format: "string", access: ["read"] },
        { iid: 2, type: "urn:miot-spec-v2:property:max-key-count:00000001:vendor:1", format: "uint8", access: ["read"] },
      ],
    }],
  });
  const capability = analyzeSwitchBindingCapabilities(specification.model, specification.groups);

  assert.equal(capability.status, "readonly");
  assert.equal(capability.mode, "readonly");
  assert.deepEqual(capability.properties.map(property => property.name), ["bound-keys", "max-key-count"]);
  assert.deepEqual(capability.writableProperties, []);
});

test("uses only published source-key, target-device and target-channel parameters", () => {
  const specification = normalizeMiotSpecification("vendor.switch.bindable", "urn:example", {
    type: "urn:example",
    services: [{
      iid: 7,
      type: "urn:miot-spec-v2:service:switch-panel:00000001:vendor:1",
      properties: [
        { iid: 1, type: "urn:miot-spec-v2:property:source-key:00000001:vendor:1", format: "uint8", access: ["write"] },
        { iid: 2, type: "urn:miot-spec-v2:property:target-did:00000001:vendor:1", format: "string", access: ["write"] },
        { iid: 3, type: "urn:miot-spec-v2:property:target-channel:00000001:vendor:1", format: "uint8", access: ["write"] },
      ],
      actions: [{ iid: 1, type: "urn:miot-spec-v2:action:bind-device:00000001:vendor:1", in: [1, 2, 3] }],
    }],
  });
  const capability = analyzeSwitchBindingCapabilities(specification.model, specification.groups);

  assert.equal(capability.status, "writable");
  assert.equal(capability.mode, "target-action");
  assert.deepEqual(buildBindingActionParameters(capability.targetActions[0], {
    key: "light-1",
    name: "主卧灯带",
    room: "主卧",
    did: "wired-panel-1",
    deviceDid: "wired-panel-1.s4",
    channelIndex: 3,
    channelSiid: 4,
    controllerName: "主卧中控",
    kind: "wired-circuit",
  }, 2), [2, "wired-panel-1", 3]);
});

test("never exposes an opaque private binding payload as a pairing operation", () => {
  const specification = normalizeMiotSpecification("vendor.switch.private", "urn:example", {
    type: "urn:example",
    services: [{
      iid: 7,
      type: "urn:miot-spec-v2:service:switch-panel:00000001:vendor:1",
      properties: [
        { iid: 1, type: "urn:miot-spec-v2:property:target-did:00000001:vendor:1", format: "string", access: ["read"] },
        { iid: 2, type: "urn:miot-spec-v2:property:private-payload:00000001:vendor:1", format: "string", access: ["write"] },
      ],
      actions: [{ iid: 1, type: "urn:miot-spec-v2:action:bind-device:00000001:vendor:1", in: [1, 2] }],
    }],
  });
  const capability = analyzeSwitchBindingCapabilities(specification.model, specification.groups);

  assert.equal(capability.status, "readonly");
  assert.equal(capability.mode, "readonly");
  assert.equal(capability.targetActions.length, 0);
  assert.equal(capability.pairingActions.length, 0);
});

test("derives hardware role and display kind from the model, not the cloud logical type", () => {
  assert.equal(classifyDeviceKind("xiaomi.controller.oh4w", "中间筒灯", "light"), "switch");
  assert.equal(inferHardwareRole("xiaomi.controller.oh4w", "中间筒灯"), "controller");
  assert.equal(classifyDeviceKind("xiaomi.gateway.hub1", "Xiaomi 中枢网关", "light"), "gateway");
  assert.equal(inferHardwareRole("xiaomi.gateway.hub1", "Xiaomi 中枢网关"), "device");
  assert.equal(classifyDeviceKind("yeelink.light.ceiling", "客厅吸顶灯", "switch"), "light");
  assert.equal(physicalDeviceId("group.88"), "group.88");
});

test("lists an ordinary .sN load through its physical switch and a smart light through itself", () => {
  const raw = [
    { did: "source", homeId: "home-1", name: "床头无线开关", model: "linp.switch.qh2db4", roomName: "主卧" },
    { did: "wired", homeId: "home-1", name: "客厅三开", model: "linp.switch.t2dbw3", roomName: "客厅" },
    { did: "wired.s3", homeId: "home-1", name: "玄关柜灯带", model: "linp.switch.t2dbw3", roomName: "玄关" },
    { did: "smart", homeId: "home-1", name: "客厅智能吸顶灯", model: "yeelink.light.ceiling", roomName: "客厅" },
    { did: "vacuum", homeId: "home-1", name: "扫地机器人", model: "vendor.vacuum.cleaner", roomName: "客厅" },
  ];
  const state = {
    homeId: "home-1",
    did: "wired",
    siid: 3,
    buttonIndex: 2,
    label: "按键 2",
    connectionType: "wired",
    reportedOn: true,
    modeValue: 0,
    evidence: "miot-property",
  };
  const topologies = buildDeviceTopology(raw, new Map([[deviceChannelStateKey("home-1", "wired", 3), state]]));
  const devices = raw.map(device => ({
    ...device,
    room: device.roomName,
    kind: classifyDeviceKind(device.model, device.name),
    parentId: topologyForDevice(topologies, device)?.parentId,
    topology: topologyForDevice(topologies, device),
  }));
  const targets = listSwitchBindingTargets(devices[0], devices);

  assert.equal(targets.length, 2);
  assert.deepEqual(targets.find(target => target.name === "玄关柜灯带"), {
    key: "home-1:玄关:玄关柜灯带:wired:3",
    name: "玄关柜灯带",
    room: "玄关",
    did: "wired",
    deviceDid: "wired.s3",
    channelIndex: 2,
    channelSiid: 3,
    controllerName: "客厅三开",
    kind: "wired-circuit",
  });
  assert.equal(targets.find(target => target.name === "客厅智能吸顶灯").kind, "smart-device");
  assert.equal(targets.some(target => target.name === "扫地机器人"), false);
});

test("deduplicates visible control sources without hiding wired and wireless relations", () => {
  const source = (connectionType, channelSiid) => ({
    sourceId: "panel",
    sourceName: "主卧中控",
    sourceRoom: "主卧",
    sourceRole: connectionType === "wired" ? "primary" : "secondary",
    channelIndex: 1,
    channelSiid,
    viaId: null,
    viaName: null,
    targetCount: 1,
    connectionType,
  });
  const visible = listVisibleControlSources([source("wired", 14), source("wired", 14), source("wireless", 15)]);

  assert.deepEqual(visible.map(item => [item.connectionType, item.channelSiid]), [["wired", 14], ["wireless", 15]]);
});
