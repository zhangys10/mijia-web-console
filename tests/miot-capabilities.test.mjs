import assert from "node:assert/strict";
import test from "node:test";
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
