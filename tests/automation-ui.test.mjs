import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const componentUrl = new URL("../app/automation-center.tsx", import.meta.url);
const stylesUrl = new URL("../app/automation-center.css", import.meta.url);

test("automation center provides list, detail, editing and a separate review surface", async () => {
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
  assert.match(source, /function AutomationReview/);
  assert.match(source, /aria-label="检查自动化"/);
  assert.match(source, /返回编辑/);
  assert.match(source, /下一步：检查/);
  assert.match(source, /确认创建自动化/);
  assert.doesNotMatch(source, /<strong>保存检查<\/strong>/);
  assert.doesNotMatch(source, /STEP \{step\+1\} \/ 5/);
  assert.match(source, /method:editing\?"PUT":"POST"/);
  assert.match(source, /revision:draft\.revision/);
  assert.match(source, /只有名称、条件与动作回读一致才会报告成功/);
  assert.match(source, /新建规则默认关闭/);
  // Configurable sunrise/sunset triggers
  assert.match(source, /日出或日落条件配置/);
  assert.match(source, /automation-sun-builder/);
  assert.match(source, /parseSunFromLabel/);
  assert.match(source, /formatSunLabel/);
  // Configurable temperature and environmental conditions
  assert.match(source, /parseTemperatureFromLabel/);
  assert.match(source, /formatTemperatureLabel/);
  assert.match(source, /automation-temp-builder/);
  assert.match(source, /设定目标气温/);
  assert.match(source, /室外气温/);
});

test("real condition templates are selectable without exposing raw cloud nodes", async () => {
  const source = await readFile(componentUrl, "utf8");
  assert.match(source, /任一条件满足/);
  assert.match(source, /全部条件满足/);
  assert.match(source, /指定时间/);
  assert.match(source, /日出\|日落/);
  assert.match(source, /设备/);
  assert.match(source, /天气/);
  assert.match(source, /位置/);
  assert.match(source, /先确认已选条件/);
  assert.match(source, /showTriggerPicker,setShowTriggerPicker\]=useState\(false\)/);
  assert.match(source, /aria-expanded=\{showTriggerPicker\}/);
  assert.match(source, /aria-controls="automation-trigger-picker"/);
  assert.match(source, /showTriggerPicker&&<div className="automation-trigger-builder"/);
  assert.match(source, /triggerCount>1&&<div className="automation-trigger-mode" role="radiogroup"/);
  assert.match(source, /aria-label=\{`移除条件：\$\{template\.label\}`\}/);
  assert.ok(source.indexOf("automation-selected-panel") < source.indexOf("automation-trigger-builder"), "selected conditions must precede the add-condition picker");
  assert.match(source, /选择设备/);
  assert.match(source, /选择状态变化/);
  assert.match(source, /deviceKey/);
  assert.match(source, /米家支持的状态变化/);
  assert.match(source, /米家支持的执行动作/);
  assert.match(source, /当前设备已确认/);
  assert.match(source, /官方型号目录/);
  assert.match(source, /MIoT 规格/);
  assert.match(source, /triggerDevices/);
  assert.match(source, /triggerCategory/);
  assert.match(source, /triggerSelections:draft\.triggerSelections/);
  assert.match(source, /actionsEditable/);
  assert.match(source, /action\.kind==="unsupported"/);
  assert.match(source, /automationPropertyDisplay/);
  assert.match(source, /actionPropertySummary/);
  assert.match(source, /propertyDescriptions/);
  assert.match(source, /descriptor\?\.editable===false/);
  assert.doesNotMatch(source, /\$\{property\.siid\}\.\$\{property\.piid\}/, "MIoT addresses must not be used as action labels");
});

test("automation pages retain mobile controls and safe-area spacing", async () => {
  const styles = await readFile(stylesUrl, "utf8");
  assert.match(styles, /@media\(max-width:760px\)/);
  assert.match(styles, /grid-template-columns:1fr/);
  assert.match(styles, /env\(safe-area-inset-bottom\)/);
  assert.match(styles, /\.automation-weekdays/);
  assert.match(styles, /\.automation-flow/);
  assert.match(styles, /\.automation-trigger-kinds/);
  assert.match(styles, /\.automation-selected-panel/);
  assert.match(styles, /\.automation-trigger-builder/);
  assert.match(styles, /\.automation-date-empty span\{font-size:9px/);
  assert.match(styles, /\.automation-selected-heading>button,.automation-selected-trigger>button\{min-height:44px\}/);
  assert.match(styles, /\.automation-device-picker/);
  assert.match(styles, /\.automation-discovered-capabilities/);
  assert.match(styles, /\.automation-review-page/);
  assert.match(styles, /\.automation-value-readonly/);
});

test("automation detail and editor incorporate triggers AND/OR, conditions AND/OR, true/false action branches and effective time", async () => {
  const source = await readFile(componentUrl, "utf8");
  // Logic: triggers AND/OR and conditions AND/OR
  assert.match(source, /满足所有触发点 \(AND\)/);
  assert.match(source, /满足任一触发点 \(OR\)/);
  assert.match(source, /满足所有条件 \(AND\)/);
  assert.match(source, /满足任一条件 \(OR\)/);
  assert.match(source, /conditionMode/);

  // Logic: True actions and False actions (Else branch)
  assert.match(source, /满足条件时执行 \(True\)/);
  assert.match(source, /不满足条件时执行 \(False\)/);
  assert.match(source, /automation-else-section/);
  assert.match(source, /falseActions/);
  assert.match(source, /false-action-row/);
  assert.match(source, /resolvedFalseActions/);

  // Logic: Other conditions (Effective time period and repetition)
  assert.match(source, /生效时段与其他条件/);
  assert.match(source, /全天生效/);
  assert.match(source, /自定义生效时段/);
  assert.match(source, /effectiveTime/);

  // Categories per section (reference Mi Home App)
  assert.match(source, /智能设备状态/);
  assert.match(source, /时间条件 \(生效时段\)/);
  assert.match(source, /环境气象状态/);
  assert.match(source, /智能设备控制/);
  assert.match(source, /延时执行/);
  assert.match(source, /发送通知/);

  // Calling IoT interface for all selectable smart devices
  assert.match(source, /调用 IoT 接口/);
  assert.match(source, /onFetchCatalog/);
  assert.match(source, /catalogLoading/);
  assert.match(source, /resolveActionModel/);
  assert.match(source, /catalog\.actions/);
  assert.doesNotMatch(source, /actionCatalog is not defined/);
  assert.doesNotMatch(source, /matchedDev\?\.kind \|\| \"device\"/);
});
