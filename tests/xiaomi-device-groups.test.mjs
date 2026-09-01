import assert from "node:assert/strict";
import test from "node:test";

import { loadDeviceGroupMemberships, mergeDeviceGroupMemberships, parseDeviceGroupMemberships } from "../lib/xiaomi-device-groups.ts";

test("parses published group membership maps and ignores inactive members", () => {
  const groups = parseDeviceGroupMemberships({ result: [
    { did: "group.120", status: "1", membership: { "light-1": "1", "light-2": 1, removed: "0" } },
  ] }, ["group.120"]);
  assert.deepEqual(groups.get("group.120"), ["light-1", "light-2"]);
});

test("accepts group-keyed responses and direct member arrays", () => {
  const groups = parseDeviceGroupMemberships({ result: {
    "group.120": { member_dids: ["light-1", { did: "light-2" }] },
  } }, ["group.120"]);
  assert.deepEqual(groups.get("group.120"), ["light-1", "light-2"]);
});

test("accepts nested result containers returned by group status APIs", () => {
  const groups = parseDeviceGroupMemberships({ result: { data: { list: [
    { group_did: "group.120", membership: { "light-1": "1", "light-2": "1" } },
  ] } } }, ["group.120"]);
  assert.deepEqual(groups.get("group.120"), ["light-1", "light-2"]);
});

test("accepts stringified and array membership variants", () => {
  const groups = parseDeviceGroupMemberships({ result: JSON.stringify({ list: [
    { group_id: "209", membership: JSON.stringify([{ did: "light-1" }]) },
  ] }) }, ["group.209"]);
  assert.deepEqual(groups.get("group.209"), ["light-1"]);
});

test("queries the read-only group status endpoint", async () => {
  const calls = [];
  const groups = await loadDeviceGroupMemberships({}, ["group.120"], async (_session, path, data) => {
    calls.push({ path, data });
    return { result: [{ group_did: "group.120", membership: { "light-1": "1" } }] };
  });
  assert.deepEqual(calls, [{ path: "/app/v2/groupv2/query_status", data: { group_did: ["group.120"] } }]);
  assert.deepEqual(groups.get("group.120"), ["light-1"]);
});

test("merges list and queried membership evidence without duplicates", () => {
  const merged = mergeDeviceGroupMemberships(
    new Map([["group.120", ["light-1"]]]),
    new Map([["group.120", ["light-1", "light-2"]]]),
  );
  assert.deepEqual(merged.get("group.120"), ["light-1", "light-2"]);
});
