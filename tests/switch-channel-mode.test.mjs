import assert from "node:assert/strict";
import test from "node:test";
import { findSwitchGroupChannel, switchGroupConnection } from "../lib/switch-channel-mode.ts";

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
