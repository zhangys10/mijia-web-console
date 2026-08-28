import assert from "node:assert/strict";
import test from "node:test";

import { groupManualSceneActions, groupSceneDraftActions } from "../lib/scene-action-groups.ts";

const devices = [
  { did: "living-1", name: "灯带", room: "客厅", kind: "light" },
  { did: "living-2", name: "射灯", room: "客厅", kind: "lamp" },
  { did: "bedroom-1", name: "床头灯", room: "主卧", kind: "light" },
  { did: "ac-1", name: "客厅空调", room: "客厅", kind: "aircondition" },
];

function manual(order, deviceName, details) {
  return { order, deviceName, label: "设置设备属性", details };
}

function power(state) {
  return { kind: "power", label: "电源", value: state === "on" ? "开启" : "关闭", state };
}

test("groups scene details by matching properties before rooms and folds matching lights", () => {
  const groups = groupManualSceneActions([
    manual(1, "灯带", [power("off")]),
    manual(2, "射灯", [power("off")]),
    manual(3, "床头灯", [power("on")]),
    manual(4, "客厅空调", [power("off")]),
  ], devices);
  assert.deepEqual(groups.map(group => [group.label, group.actionCount]), [["关闭", 3], ["开启", 1]]);
  assert.deepEqual(groups[0].rooms.map(room => [room.room, room.actionCount]), [["客厅", 3]]);
  assert.equal(groups[0].rooms[0].items[0].kind, "light-batch");
  assert.deepEqual(groups[0].rooms[0].items[0].deviceNames, ["灯带", "射灯"]);
  assert.equal(groups[0].rooms[0].items[1].kind, "action", "non-light power actions must remain separate");
  assert.equal(groups[1].rooms[0].room, "主卧");
});

test("keeps rooms nested inside a shared property group", () => {
  const groups = groupManualSceneActions([
    manual(1, "灯带", [power("off")]),
    manual(2, "床头灯", [power("off")]),
  ], devices);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, "关闭");
  assert.deepEqual(groups[0].rooms.map(room => room.room), ["客厅", "主卧"]);
});

test("identifies the concrete switch button for mapped power actions", () => {
  const switchTargets = [
    { did: "switch.s14", name: "玄关筒灯", room: "玄关", kind: "light", topology: { relation: "mapped", channelSiid: 14, channelIndex: 1, channelLabel: "按键 1", parentName: "客厅中控屏" } },
    { did: "switch.s15", name: "餐厅吊灯", room: "餐厅", kind: "light", topology: { relation: "mapped", channelSiid: 15, channelIndex: 2, channelLabel: "按键 2", parentName: "客厅中控屏" } },
  ];
  const groups = groupManualSceneActions([
    manual(1, "玄关筒灯", [power("on")]),
    manual(2, "餐厅吊灯", [power("on")]),
  ], switchTargets);
  assert.deepEqual(groups.map(group => group.label), ["开启"]);
  assert.deepEqual(groups[0].rooms.flatMap(room => room.items.map(item => item.action.deviceName)), ["客厅中控屏 · 按键 2 · 餐厅吊灯", "客厅中控屏 · 按键 1 · 玄关筒灯"]);
});

test("does not fold composite light actions, different states, or ambiguous device names", () => {
  const ambiguous = [...devices, { did: "other", name: "灯带", room: "书房", kind: "light" }];
  const groups = groupManualSceneActions([
    manual(1, "灯带", [power("off")]),
    manual(2, "射灯", [power("on")]),
    manual(3, "床头灯", [power("off"), { kind: "brightness", label: "亮度", value: "20%" }]),
  ], ambiguous);
  assert.equal(groups[0].rooms[0].room, "未分配");
  assert.ok(groups.every(group => group.rooms.every(room => room.items.every(item => item.kind === "action"))));
});

test("uses a sanitized server room to disambiguate same-name devices without exposing DID", () => {
  const ambiguous = [...devices, { did: "other", name: "灯带", room: "书房", kind: "light" }];
  const groups = groupManualSceneActions([
    { ...manual(1, "灯带", [power("off")]), room: "客厅" },
    manual(2, "射灯", [power("off")]),
  ], ambiguous);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].rooms[0].room, "客厅");
  assert.equal(groups[0].rooms[0].items[0].kind, "light-batch");
});

test("folds identical multi-property light batches but not different values", () => {
  const details = [power("on"), { kind: "brightness", label: "亮度", value: "35%" }, { kind: "color-temperature", label: "色温", value: "4000 K" }];
  const groups = groupManualSceneActions([
    manual(1, "灯带", details),
    manual(2, "射灯", structuredClone(details)),
    manual(3, "床头灯", [power("on"), { kind: "brightness", label: "亮度", value: "50%" }]),
  ], devices);
  assert.equal(groups[0].rooms[0].room, "客厅");
  assert.equal(groups[0].rooms[0].items[0].kind, "light-batch");
  assert.equal(groups[0].rooms[0].items[0].state, undefined);
  assert.equal(groups[1].rooms[0].room, "主卧");
  assert.equal(groups[1].rooms[0].items[0].kind, "action");
});

test("editor groups use DID identity and keep the underlying action indices", () => {
  const action = (clientId, did, value, piid = 1) => ({ clientId, kind: "set-properties", did, deviceName: did, model: "light.v1", label: "设置设备属性", properties: [{ siid: 2, piid, value }] });
  const actions = [action("one", "living-1", false), action("ac", "ac-1", false), action("two", "living-2", false), action("brightness", "bedroom-1", 20, 2)];
  const groups = groupSceneDraftActions(actions, devices);
  assert.equal(groups[0].label, "属性 2.1 关闭");
  const living = groups[0].rooms.find(room => room.room === "客厅");
  assert.deepEqual(living.items[0].indices, [0, 2]);
  assert.equal(living.items[0].collapsible, true);
  assert.equal(living.items[1].collapsible, false);
  assert.equal(groups[1].rooms.find(room => room.room === "主卧").items[0].collapsible, false);
});
