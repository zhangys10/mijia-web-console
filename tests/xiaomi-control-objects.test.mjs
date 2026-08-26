import assert from "node:assert/strict";
import test from "node:test";
import { controlObjectResult, parseEmbeddedControlObjectResults, parseXiaomiControlObjects } from "../lib/xiaomi-control-objects.ts";
import { buildDeviceTopology, deviceChannelStateKey } from "../lib/device-topology.ts";

function runtime(homeId, did, siid, connectionType, modeCapability = connectionType === "wireless" ? "wireless-only" : "relay-enabled") {
  return {
    homeId,
    did,
    siid,
    buttonIndex: 1,
    label: "按键 1",
    connectionType,
    modeCapability,
    reportedOn: false,
    modeValue: modeCapability === "relay-enabled" ? 0 : 1,
    evidence: "miot-property",
  };
}

function completeResult(homeId, did, siid, objects = []) {
  return controlObjectResult(homeId, did, siid, "available", true, objects);
}

test("parses only explicit per-button control-object containers", () => {
  const records = [
    {
      did: "switch-a",
      homeId: "home-a",
      name: "墙壁开关",
      roomName: "客厅",
      control_objects: [
        { source_siid: 2, button_index: 1, target_did: "light-a", target_name: "客厅灯" },
        { source_siid: 3, button_index: 2, target_name: "未配置", target_kind: "unconfigured" },
      ],
      unrelated: { did: "must-not-be-read", siid: 99 },
    },
    { did: "light-a", homeId: "home-a", name: "客厅灯", roomName: "客厅", type: "light" },
  ];

  const result = parseXiaomiControlObjects(records);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(item => [item.sourceSiid, item.targetDid, item.targetKind, item.evidence]), [
    [2, "light-a", "smart-light", "confirmed"],
    [3, null, "unconfigured", "confirmed"],
  ]);
  assert.ok(result.every(item => item.evidenceSource === "explicit-control-object"));
});

test("requires an explicit source service and never crosses home boundaries", () => {
  const result = parseXiaomiControlObjects([
    { did: "switch", homeId: "a", controlObjects: [{ targetDid: "same-did", targetName: "灯" }, { sourceSiid: 2, targetDid: "same-did", targetName: "灯" }] },
    { did: "same-did", homeId: "b", name: "另一个家庭的灯", type: "light" },
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].targetKind, "unknown");
  assert.equal(result[0].evidence, "unknown");
});

test("builds independent wireless-control and wired smart-light power edges", () => {
  const records = [
    { did: "switch", homeId: "home", name: "智能墙壁开关", roomName: "餐厅", control_objects: [{ source_siid: 2, button_index: 1, target_did: "light", target_name: "餐厅吊灯" }] },
    { did: "switch.s2", homeId: "home", name: "餐厅吊灯", roomName: "勿关" },
    { did: "light", homeId: "home", name: "餐厅吊灯", roomName: "餐厅", type: "light" },
  ];
  const states = new Map([[deviceChannelStateKey("home", "switch", 2), runtime("home", "switch", 2, "wired")]]);
  const controlObjects = parseXiaomiControlObjects(records);
  const topology = buildDeviceTopology(records, states, [completeResult("home", "switch", 2, controlObjects)]).get("home:switch");

  assert.deepEqual(topology.channels[0].edges.map(edge => edge.relation), ["wireless-control", "wired-smart-light-power"]);
  assert.equal(topology.channels[0].connectionType, "mixed");
  assert.equal(topology.channels[0].role, "primary");
  assert.equal(topology.channels[0].evidence, "explicit-control-object");
  assert.equal(topology.connectionType, "mixed");
  assert.equal(topology.role, "primary");
  assert.equal(topology.channels[0].targets.find(target => target.id === "light").targetKey, "home:light");
  assert.equal(topology.channels[0].targets.find(target => target.id === "switch.s2").targetKey, "home:switch.s2");

  const endpoint = buildDeviceTopology(records, states, [completeResult("home", "switch", 2, controlObjects)]).get("home:switch.s2");
  assert.equal(endpoint.connectionType, "wired");
  assert.equal(endpoint.role, "primary");
  assert.deepEqual(
    endpoint.controlledBy.map(source => [source.connectionType, source.sourceRole, source.evidence]),
    [["wired", "primary", "explicit-control-object"]],
  );
});

test("keeps an explicit unconfigured button visible as a target", () => {
  const records = [
    { did: "switch", homeId: "home", name: "双键开关", control_objects: [{ source_siid: 3, button_index: 2, target_kind: "unconfigured", target_name: "未配置" }] },
  ];
  const objects = parseXiaomiControlObjects(records);
  const states = new Map([[deviceChannelStateKey("home", "switch", 3), runtime("home", "switch", 3, "unknown", "relay-enabled")]]);
  const topology = buildDeviceTopology(records, states, [completeResult("home", "switch", 3, objects)]).get("home:switch");

  assert.equal(topology.channels[0].targets.length, 1);
  assert.equal(topology.channels[0].targets[0].kind, "unconfigured");
  assert.equal(topology.channels[0].targets[0].targetKey, "home:未分配:未配置");
  assert.deepEqual(topology.channels[0].edges.map(edge => edge.relation), ["wired-load"]);
});

test("matches edge targets by scoped identity rather than DID suffix", () => {
  const records = [
    { did: "switch", homeId: "home", name: "双键开关", control_objects: [
      { source_siid: 2, target_did: "1", target_name: "灯一" },
      { source_siid: 2, target_did: "21", target_name: "灯二" },
    ] },
    { did: "1", homeId: "home", name: "灯一", type: "light" },
    { did: "21", homeId: "home", name: "灯二", type: "light" },
  ];
  const objects = parseXiaomiControlObjects(records);
  const topology = buildDeviceTopology(records, new Map(), [completeResult("home", "switch", 2, objects)]).get("home:switch");

  assert.deepEqual(topology.channels[0].targets.map(target => target.targetKey), ["home:1", "home:21"]);
  assert.deepEqual(topology.channels[0].edges.map(edge => edge.targetKey), ["home:1", "home:21"]);
});

test("generic smart-device targets get wireless control without a power edge", () => {
  const records = [
    { did: "switch", homeId: "home", name: "无线开关", control_objects: [{ source_siid: 2, target_did: "curtain", target_name: "窗帘" }] },
    { did: "curtain", homeId: "home", name: "窗帘", type: "curtain" },
  ];
  const states = new Map([[deviceChannelStateKey("home", "switch", 2), runtime("home", "switch", 2, "wireless")]]);
  const objects = parseXiaomiControlObjects(records);
  const topology = buildDeviceTopology(records, states, [completeResult("home", "switch", 2, objects)]).get("home:switch");

  assert.deepEqual(topology.channels[0].edges.map(edge => edge.relation), ["wireless-control"]);
  assert.equal(topology.channels[0].controlObjects[0].targetKind, "smart-device");
});

test("does not treat embedded objects as a complete control-device query", () => {
  const records = [
    { did: "switch", homeId: "home", control_objects: [{ source_siid: 2, target_kind: "unconfigured", target_name: "未配置" }] },
  ];
  const [result] = parseEmbeddedControlObjectResults(records);

  assert.equal(result.status, "available");
  assert.equal(result.complete, false);
  assert.equal(result.reason, "embedded-data-incomplete");
});

test("classifies relay-enabled plus a complete empty result as confirmed wired", () => {
  const records = [
    { did: "switch", homeId: "home", name: "墙壁开关" },
    { did: "switch.s14", homeId: "home", name: "筒灯", roomName: "卧室" },
  ];
  const states = new Map([[deviceChannelStateKey("home", "switch", 14), runtime("home", "switch", 14, "unknown", "relay-enabled")]]);
  const topology = buildDeviceTopology(records, states, [completeResult("home", "switch", 14)]).get("home:switch");
  const channel = topology.channels[0];

  assert.equal(channel.connectionType, "wired");
  assert.equal(channel.classification, "confirmed-wired");
  assert.equal(channel.controlObjectComplete, true);
  assert.deepEqual(channel.edges.map(edge => edge.relation), ["wired-load"]);
});

test("infers all OH4W s14, s15, and s16 loads from relay mode plus split endpoints", () => {
  const records = [
    { did: "720449456", homeId: "home", name: "主卧中控", model: "xiaomi.controller.oh4w", roomName: "主卧" },
    { did: "720449456.s14", homeId: "home", name: "床头筒灯", roomName: "主卧" },
    { did: "720449456.s15", homeId: "home", name: "中间筒灯", roomName: "主卧" },
    { did: "720449456.s16", homeId: "home", name: "床尾筒灯", roomName: "主卧" },
  ];
  const states = new Map([14, 15, 16].map((siid, index) => [
    deviceChannelStateKey("home", "720449456", siid),
    { ...runtime("home", "720449456", siid, "unknown", "relay-enabled"), buttonIndex: index + 1 },
  ]));
  const topology = buildDeviceTopology(records, states, []).get("home:720449456");

  assert.deepEqual(topology.channels.map(channel => [channel.channelSiid, channel.classification, channel.connectionType]), [
    [14, "inferred-wired", "wired"],
    [15, "inferred-wired", "wired"],
    [16, "inferred-wired", "wired"],
  ]);
  assert.deepEqual(topology.channels.map(channel => channel.edges[0].endpointDid), [
    "720449456.s14",
    "720449456.s15",
    "720449456.s16",
  ]);
  assert.ok(topology.channels.every(channel => channel.edges[0].evidence === "inferred" && channel.edges[0].evidenceSource === "split-device"));

  const topologies = buildDeviceTopology(records, states, []);
  for (const siid of [14, 15, 16]) {
    const endpoint = topologies.get(`home:720449456.s${siid}`);
    assert.equal(endpoint.connectionType, "wired");
    assert.equal(endpoint.role, "primary");
    assert.deepEqual(
      endpoint.controlledBy.map(source => [source.connectionType, source.sourceRole, source.evidence]),
      [["wired", "primary", "split-device"]],
    );
  }
});

test("classifies a complete ordinary-load result as confirmed wired", () => {
  const records = [
    { did: "switch", homeId: "home", name: "墙壁开关", control_objects: [{ source_siid: 2, target_kind: "ordinary-load", target_name: "普通照明" }] },
  ];
  const states = new Map([[deviceChannelStateKey("home", "switch", 2), runtime("home", "switch", 2, "unknown", "relay-enabled")]]);
  const objects = parseXiaomiControlObjects(records);
  const topology = buildDeviceTopology(records, states, [completeResult("home", "switch", 2, objects)]).get("home:switch");

  assert.equal(topology.channels[0].classification, "confirmed-wired");
  assert.equal(topology.channels[0].connectionType, "wired");
  assert.deepEqual(topology.channels[0].edges.map(edge => edge.relation), ["wired-load"]);
});

test("does not treat an unknown complete control object as an empty binding list", () => {
  const records = [
    { did: "switch", homeId: "home", name: "墙壁开关", control_objects: [{ source_siid: 2, target_name: "场景控制" }] },
  ];
  const states = new Map([[deviceChannelStateKey("home", "switch", 2), runtime("home", "switch", 2, "unknown", "relay-enabled")]]);
  const objects = parseXiaomiControlObjects(records);
  const topology = buildDeviceTopology(records, states, [completeResult("home", "switch", 2, objects)]).get("home:switch");

  assert.equal(topology.channels[0].controlObjects[0].targetKind, "unknown");
  assert.equal(topology.channels[0].classification, "unknown");
  assert.equal(topology.channels[0].connectionType, "unknown");
  assert.deepEqual(topology.channels[0].edges.map(edge => edge.relation), ["unknown"]);
});

test("does not promote an unindexed smart-device candidate to configured", () => {
  const records = [
    { did: "switch", homeId: "home", name: "墙壁开关", control_objects: [{ source_siid: 2, target_did: "missing", target_name: "窗帘", target_kind: "smart-device" }] },
  ];
  const states = new Map([[deviceChannelStateKey("home", "switch", 2), runtime("home", "switch", 2, "unknown", "relay-enabled")]]);
  const objects = parseXiaomiControlObjects(records);
  const topology = buildDeviceTopology(records, states, [completeResult("home", "switch", 2, objects)]).get("home:switch");

  assert.equal(objects[0].evidence, "unknown");
  assert.equal(topology.channels[0].classification, "unknown");
  assert.equal(topology.channels[0].connectionType, "unknown");
  assert.equal(topology.channels[0].evidence, "miot-property");
  assert.deepEqual(topology.channels[0].edges.map(edge => edge.relation), ["unknown"]);
});

test("uses a confirmed same-home embedded target as positive evidence despite incomplete query data", () => {
  const records = [
    { did: "switch", homeId: "home", name: "墙壁开关", control_objects: [{ source_siid: 2, target_did: "curtain", target_name: "窗帘" }] },
    { did: "curtain", homeId: "home", name: "窗帘", type: "curtain" },
  ];
  const states = new Map([[deviceChannelStateKey("home", "switch", 2), runtime("home", "switch", 2, "unknown", "relay-enabled")]]);
  const results = parseEmbeddedControlObjectResults(records);
  const topology = buildDeviceTopology(records, states, results).get("home:switch");

  assert.equal(results[0].complete, false);
  assert.equal(topology.channels[0].classification, "configured-wireless");
  assert.equal(topology.channels[0].connectionType, "wireless");
  assert.equal(topology.channels[0].evidence, "explicit-control-object");
  assert.deepEqual(topology.channels[0].edges.map(edge => edge.relation), ["wireless-control"]);
});

test("infers a wired load from relay capability and a confirmed split endpoint when control data is unavailable", () => {
  const records = [
    { did: "switch", homeId: "home", name: "墙壁开关" },
    { did: "switch.s14", homeId: "home", name: "筒灯", roomName: "卧室" },
  ];
  const states = new Map([[deviceChannelStateKey("home", "switch", 14), runtime("home", "switch", 14, "unknown", "relay-enabled")]]);
  const topology = buildDeviceTopology(records, states, [controlObjectResult("home", "switch", 14, "unavailable", false)]).get("home:switch");
  const channel = topology.channels[0];

  assert.equal(channel.connectionType, "wired");
  assert.equal(channel.relayEnabled, true);
  assert.equal(channel.classification, "inferred-wired");
  assert.equal(channel.evidence, "split-device");
  assert.deepEqual(channel.edges.map(edge => [edge.relation, edge.evidence, edge.evidenceSource]), [["wired-load", "inferred", "split-device"]]);
});

test("infers a wired load from an implicit unavailable result only when a split endpoint exists", () => {
  const records = [
    { did: "switch", homeId: "home", name: "墙壁开关" },
    { did: "switch.s14", homeId: "home", name: "筒灯", roomName: "卧室" },
  ];
  const states = new Map([[deviceChannelStateKey("home", "switch", 14), runtime("home", "switch", 14, "unknown", "relay-enabled")]]);
  const topology = buildDeviceTopology(records, states, []).get("home:switch");

  assert.equal(topology.channels[0].classification, "inferred-wired");
  assert.equal(topology.channels[0].connectionType, "wired");
});

test("keeps relay-enabled channels unresolved when no split endpoint or control result exists", () => {
  const records = [{ did: "switch", homeId: "home", name: "墙壁开关" }];
  const states = new Map([[deviceChannelStateKey("home", "switch", 14), runtime("home", "switch", 14, "unknown", "relay-enabled")]]);
  const topology = buildDeviceTopology(records, states, []).get("home:switch");

  assert.equal(topology.channels[0].classification, "control-data-unavailable");
  assert.equal(topology.channels[0].connectionType, "unknown");
});

test("classifies wireless-only plus complete empty result as wireless unconfigured", () => {
  const records = [{ did: "switch", homeId: "home", name: "无线开关" }];
  const states = new Map([[deviceChannelStateKey("home", "switch", 2), runtime("home", "switch", 2, "wireless", "wireless-only")]]);
  const topology = buildDeviceTopology(records, states, [completeResult("home", "switch", 2)]).get("home:switch");
  const channel = topology.channels[0];

  assert.equal(channel.connectionType, "wireless");
  assert.equal(channel.classification, "wireless-unconfigured");
  assert.deepEqual(channel.edges, []);
});

test("infers the physical wired load after a failed control-device query when a split endpoint exists", () => {
  const records = [
    { did: "switch", homeId: "home", name: "墙壁开关" },
    { did: "switch.s2", homeId: "home", name: "灯", roomName: "客厅" },
  ];
  const states = new Map([[deviceChannelStateKey("home", "switch", 2), runtime("home", "switch", 2, "unknown", "relay-enabled")]]);
  const topology = buildDeviceTopology(records, states, [controlObjectResult("home", "switch", 2, "failed", false)]).get("home:switch");

  assert.equal(topology.channels[0].classification, "inferred-wired");
  assert.equal(topology.channels[0].connectionType, "wired");
});
