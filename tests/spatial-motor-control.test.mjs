import assert from "node:assert/strict";
import test from "node:test";
import { spatialMotorActions } from "../lib/spatial-motor-control.ts";

test("motor quick controls use declared motor-control choices and preserve raw values", () => {
  const actions = spatialMotorActions([{ key: "2.1", name: "motor-control", writable: true, siid: 2, piid: 1, choices: [
    { value: 7, label: "打开", sourceLabel: "Open" },
    { value: 4, label: "关闭", sourceLabel: "Close" },
    { value: 9, label: "暂停", sourceLabel: "Pause" },
    { value: 3, label: "切换开关状态", sourceLabel: "Toggle" },
  ] }]);
  assert.deepEqual(actions.map(action => [action.action, action.label, action.value]), [["open", "打开", 7], ["close", "关闭", 4], ["pause", "暂停", 9]]);
  assert.ok(actions.every(action => action.propertyKey === "2.1" && action.siid === 2 && action.piid === 1));
});

test("motor quick controls fail closed without one explicit writable choice", () => {
  assert.deepEqual(spatialMotorActions([{ key: "2.1", name: "motor-control", writable: false, siid: 2, piid: 1, choices: [{ value: 0, label: "打开" }] }]), []);
  assert.deepEqual(spatialMotorActions([{ key: "2.1", name: "mode", writable: true, siid: 2, piid: 1, choices: [{ value: 0, label: "打开" }] }]), []);
  assert.deepEqual(spatialMotorActions([{ key: "2.1", name: "motor-control", writable: true, siid: 2, piid: 1, choices: [{ value: 0, label: "打开" }, { value: 1, label: "打开" }] }]).map(action => action.action), []);
});
