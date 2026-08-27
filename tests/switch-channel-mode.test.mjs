import assert from "node:assert/strict";
import test from "node:test";
import { diagnoseSwitchMode, findSwitchGroupChannel, isSwitchModeProperty, resolveSwitchMode, resolveSwitchModeCapability, switchGroupConnection } from "../lib/switch-channel-mode.ts";

const groups = [
  { key: "2", name: "switch", siid: 2, properties: [{ key: "2.2", name: "wireless-mode" }] },
  { key: "3", name: "switch", siid: 3, properties: [{ key: "3.2", name: "wireless-mode" }] },
];

test("labels each key from its own wired or wireless topology channel", () => {
  const topology = {
    role: "primary",
    connectionType: "mixed",
    channels: [
      { channelIndex: 1, channelSiid: null, role: "primary", connectionType: "wired" },
      { channelIndex: 2, channelSiid: null, role: "secondary", connectionType: "wireless" },
    ],
  };

  assert.equal(findSwitchGroupChannel(groups[0], groups, topology).channelIndex, 1);
  assert.equal(findSwitchGroupChannel(groups[1], groups, topology).channelIndex, 2);
  assert.equal(switchGroupConnection(groups[0], groups, {}, topology), "wired");
  assert.equal(switchGroupConnection(groups[1], groups, {}, topology), "wireless");
});

test("prefers the real per-key wireless state returned by MIoT", () => {
  const topology = { role: "primary", connectionType: "wired", channels: [] };

  assert.equal(switchGroupConnection(groups[0], groups, { "2.2": true }, topology), "wireless");
  assert.equal(switchGroupConnection(groups[1], groups, { "3.2": false }, topology), "wired");
});

test("understands vendor mode choices where zero means wireless", () => {
  const choiceGroup = {
    key: "4",
    name: "switch",
    siid: 4,
    properties: [{
      key: "4.2",
      name: "button-mode",
      choices: [{ value: 0, label: "无线副控" }, { value: 1, label: "有线主控" }],
    }],
  };

  assert.equal(switchGroupConnection(choiceGroup, [choiceGroup], { "4.2": 0 }), "wireless");
  assert.equal(switchGroupConnection(choiceGroup, [choiceGroup], { "4.2": 1 }), "wired");
});

test("uses the exact mode property returned by the observed Linp and Xiaomi models", () => {
  const modeGroup = {
    key: "14",
    name: "switch",
    siid: 14,
    properties: [{ key: "14.2", name: "mode" }],
  };

  assert.equal(switchGroupConnection(modeGroup, [modeGroup], { "14.2": 0 }), "wired");
  assert.equal(switchGroupConnection(modeGroup, [modeGroup], { "14.2": 1 }), "wireless");
});

test("does not turn unrecognized mode values into a known channel", () => {
  assert.equal(resolveSwitchMode({ key: "2.2", name: "mode" }, "vendor-private"), "unknown");
  assert.equal(resolveSwitchMode({ key: "2.2", name: "mode" }, 2), "unknown");
  assert.equal(resolveSwitchMode({ key: "2.2", name: "mode" }, 99), "unknown");
  assert.equal(switchGroupConnection(groups[0], groups, {}, { role: "unknown", connectionType: "unknown", channels: [] }), "unknown");
});

test("represents mixed wired and wireless labels as relay-enabled capability", () => {
  const property = {
    key: "2.2",
    name: "mode",
    choices: [{ value: 0, label: "有线和无线开关" }],
  };

  assert.equal(resolveSwitchMode(property, 0), "unknown");
  assert.equal(resolveSwitchModeCapability(property, 0), "relay-enabled");
  assert.deepEqual(diagnoseSwitchMode(property, 0), {
    connection: "unknown",
    capability: "relay-enabled",
    reason: null,
  });
  assert.equal(switchGroupConnection(
    { ...groups[0], properties: [property] },
    [{ ...groups[0], properties: [property] }],
    { "2.2": 0 },
    {
      role: "primary",
      connectionType: "mixed",
      channels: [{ channelIndex: 1, channelSiid: 2, role: "primary", connectionType: "mixed" }],
    },
  ), "wired");
});

test("uses the same vendor mode-property names during synchronization and display", () => {
  for (const name of ["mode", "wireless-mode", "button-mode", "button-type", "switch-mode", "control-mode"]) {
    assert.equal(isSwitchModeProperty({ name }), true, name);
  }
  assert.equal(isSwitchModeProperty({ name: "on" }), false);
  assert.equal(isSwitchModeProperty({ name: "wireless-enable" }), false);
});

test("classifies why a channel mode remains unknown", () => {
  assert.deepEqual(diagnoseSwitchMode(undefined, undefined), {
    connection: "unknown",
    capability: "unknown",
    reason: "mode-property-missing",
  });
  assert.deepEqual(diagnoseSwitchMode({ key: "14.2", name: "mode" }, undefined), {
    connection: "unknown",
    capability: "unknown",
    reason: "value-missing",
  });
  assert.deepEqual(diagnoseSwitchMode({ key: "14.2", name: "mode" }, 99), {
    connection: "unknown",
    capability: "unknown",
    reason: "value-unrecognized",
  });
  assert.deepEqual(diagnoseSwitchMode({ key: "14.2", name: "mode" }, 0), {
    connection: "wired",
    capability: "relay-enabled",
    reason: null,
  });
});
