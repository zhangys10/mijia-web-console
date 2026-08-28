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

test("groups scene details by room and folds same-state power-only lights", () => {
  const rooms = groupManualSceneActions([
    manual(1, "灯带", [power("off")]),
    manual(2, "射灯", [power("off")]),
    manual(3, "床头灯", [power("on")]),
    manual(4, "客厅空调", [power("off")]),
  ], devices);
  assert.deepEqual(rooms.map(room => [room.room, room.actionCount]), [["客厅", 3], ["主卧", 1]]);
  assert.equal(rooms[0].items[0].kind, "light-batch");
  assert.deepEqual(rooms[0].items[0].deviceNames, ["灯带", "射灯"]);
  assert.equal(rooms[0].items[1].kind, "action", "non-light power actions must remain separate");
});

test("does not fold composite light actions, different states, or ambiguous device names", () => {
  const ambiguous = [...devices, { did: "other", name: "灯带", room: "书房", kind: "light" }];
  const rooms = groupManualSceneActions([
    manual(1, "灯带", [power("off")]),
    manual(2, "射灯", [power("on")]),
    manual(3, "床头灯", [power("off"), { kind: "brightness", label: "亮度", value: "20%" }]),
  ], ambiguous);
  assert.equal(rooms.at(-1).room, "未分配");
  assert.ok(rooms.every(room => room.items.every(item => item.kind === "action")));
});

test("uses a sanitized server room to disambiguate same-name devices without exposing DID", () => {
  const ambiguous = [...devices, { did: "other", name: "灯带", room: "书房", kind: "light" }];
  const rooms = groupManualSceneActions([
    { ...manual(1, "灯带", [power("off")]), room: "客厅" },
    manual(2, "射灯", [power("off")]),
  ], ambiguous);
  assert.equal(rooms.length, 1);
  assert.equal(rooms[0].room, "客厅");
  assert.equal(rooms[0].items[0].kind, "light-batch");
});

test("folds identical multi-property light batches but not different values", () => {
  const details = [power("on"), { kind: "brightness", label: "亮度", value: "35%" }, { kind: "color-temperature", label: "色温", value: "4000 K" }];
  const rooms = groupManualSceneActions([
    manual(1, "灯带", details),
    manual(2, "射灯", structuredClone(details)),
    manual(3, "床头灯", [power("on"), { kind: "brightness", label: "亮度", value: "50%" }]),
  ], devices);
  assert.equal(rooms.find(room => room.room === "客厅").items[0].kind, "light-batch");
  assert.equal(rooms.find(room => room.room === "客厅").items[0].state, undefined);
  assert.equal(rooms.find(room => room.room === "主卧").items[0].kind, "action");
});

test("editor groups use DID identity and keep the underlying action indices", () => {
  const action = (clientId, did, value, piid = 1) => ({ clientId, kind: "set-properties", did, deviceName: did, model: "light.v1", label: "设置设备属性", properties: [{ siid: 2, piid, value }] });
  const actions = [action("one", "living-1", false), action("ac", "ac-1", false), action("two", "living-2", false), action("brightness", "bedroom-1", 20, 2)];
  const rooms = groupSceneDraftActions(actions, devices);
  const living = rooms.find(room => room.room === "客厅");
  assert.deepEqual(living.items[0].indices, [0, 2]);
  assert.equal(living.items[0].collapsible, true);
  assert.equal(living.items[1].collapsible, false);
  assert.equal(rooms.find(room => room.room === "主卧").items[0].collapsible, false);
});
