import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const componentUrl = new URL("../app/automation-center.tsx", import.meta.url);
const stylesUrl = new URL("../app/automation-center.css", import.meta.url);

test("automation center provides list, detail and a single-page create/edit surface", async () => {
  const source = await readFile(componentUrl, "utf8");
  assert.match(source, /正在运行/);
  assert.match(source, /已停用/);
  assert.match(source, /function AutomationDetail/);
  assert.match(source, /function AutomationFlow/);
  assert.match(source, /automation-editor-single/);
  assert.match(source, /基本信息/);
  assert.match(source, /触发条件/);
  assert.match(source, /生效日期/);
  assert.match(source, /执行动作/);
  assert.match(source, /保存检查/);
  assert.doesNotMatch(source, /STEP \{step\+1\} \/ 5/);
  assert.doesNotMatch(source, />下一步</);
  assert.match(source, /method:editing\?"PUT":"POST"/);
  assert.match(source, /revision:draft\.revision/);
  assert.match(source, /米家云回读完全一致后才报告成功/);
  assert.match(source, /新建规则默认关闭/);
});

test("real condition templates are selectable without exposing raw cloud nodes", async () => {
  const source = await readFile(componentUrl, "utf8");
  assert.match(source, /任一条件满足/);
  assert.match(source, /全部条件满足/);
  assert.match(source, /指定时间/);
  assert.match(source, /日出日落/);
  assert.match(source, /设备/);
  assert.match(source, /天气/);
  assert.match(source, /位置/);
  assert.match(source, /triggerSelections:draft\.triggerSelections/);
  assert.match(source, /actionsEditable/);
  assert.match(source, /action\.kind==="unsupported"/);
});

test("automation pages retain mobile controls and safe-area spacing", async () => {
  const styles = await readFile(stylesUrl, "utf8");
  assert.match(styles, /@media\(max-width:760px\)/);
  assert.match(styles, /grid-template-columns:1fr/);
  assert.match(styles, /env\(safe-area-inset-bottom\)/);
  assert.match(styles, /\.automation-weekdays/);
  assert.match(styles, /\.automation-flow/);
  assert.match(styles, /\.automation-trigger-kinds/);
});
