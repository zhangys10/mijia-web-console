import assert from "node:assert/strict";
import test from "node:test";
import { collectDeviceGroupMembers, isDeviceGroupId, organizeDeviceGroups } from "../lib/device-groups.ts";
import { selectDeviceView } from "../lib/device-views.ts";

test("identifies Xiaomi group devices and extracts published group memberships", () => {
  const raw = [
    { did: "group.120", name: "客厅筒灯组合", extra: { member_dids: ["light-1", "missing-light"] } },
    { did: "light-1", name: "左侧筒灯" },
    { did: "light-2", name: "右侧筒灯", extra: { group_id: "120" } },
    { did: "light-3", name: "其他灯具" },
  ];

  assert.equal(isDeviceGroupId("group.120"), true);
  assert.equal(isDeviceGroupId("group_120"), true);
  assert.equal(isDeviceGroupId("light-1"), false);
  assert.deepEqual(collectDeviceGroupMembers(raw).get("group.120"), ["light-1", "light-2"]);
});

test("nests group members under their group card and preserves individual configuration IDs", () => {
  const devices = [
    { did: "group.120", homeId: "home-1", name: "客厅筒灯组合", room: "客厅", kind: "light", model: "yeelink.light.group", groupMemberIds: ["light-1", "light-2"] },
    { did: "light-1", homeId: "home-1", name: "左侧筒灯", room: "客厅", kind: "light", model: "yeelink.light.ceiling", groupIds: ["group.120"] },
    { did: "light-2", homeId: "home-1", name: "右侧筒灯", room: "客厅", kind: "light", model: "yeelink.light.ceiling", groupIds: ["group.120"] },
    { did: "light-3", homeId: "home-1", name: "独立筒灯", room: "客厅", kind: "light", model: "yeelink.light.ceiling" },
  ];

  const hardware = organizeDeviceGroups(selectDeviceView(devices, "hardware"), devices);

  assert.deepEqual(hardware.map(device => device.did), ["group.120", "light-3"]);
  assert.deepEqual(hardware[0].groupMembers.map(device => device.did), ["light-1", "light-2"]);
});

test("does not hide identically named devices from another home", () => {
  const devices = [
    { did: "group.120", homeId: "home-1", name: "灯具组合", room: "客厅", groupMemberIds: ["light-1"] },
    { did: "light-1", homeId: "home-1", name: "客厅灯" },
    { did: "light-1", homeId: "home-2", name: "父母家客厅灯" },
  ];

  assert.deepEqual(organizeDeviceGroups(devices, devices).map(device => [device.homeId, device.did]), [
    ["home-1", "group.120"],
    ["home-2", "light-1"],
  ]);
});
