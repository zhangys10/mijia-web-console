import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { deleteClimateState, publicClimateState, readClimateState, reconcileClimateConfig, sampleClimate, selectClimateProperties, writeClimateState } from "../lib/ai/climate/climate-store.ts";
import { climateDerivationPayload } from "../lib/ai/api/climate.ts";

function memoryStore() {
  const values = new Map();
  return {
    values,
    async get(key) { return values.get(key) ?? null; },
    async setJSON(key, value) { values.set(key, structuredClone(value)); },
    async delete(key) { values.delete(key); },
  };
}

test("climate Blob keys isolate homes and public state omits Xiaomi addresses", async () => {
  const store = memoryStore();
  const first = await readClimateState("home-a", store);
  first.enabled = true;
  first.rooms.push({ roomRef: "room_aaaaaaaaaaaaaaaaaaaaaaaa", roomName: "卧室", sensorRef: "sensor_aaaaaaaaaaaaaaaaaaaaaaaa", actuatorRef: "actuator_aaaaaaaaaaaaaaaaaaaaaaaa", sensor: { did: "secret-sensor", siid: 2, piid: 1 }, actuator: { target: { did: "secret-ac", siid: 2, piid: 3 }, mode: { did: "secret-ac", siid: 2, piid: 2 }, range: { min: 16, max: 30, step: 1 }, modes: [0, 1] }, capabilityRevision: "rev_a", sensorName: "温度计", actuatorName: "空调" });
  await writeClimateState("home-a", first, store);
  assert.equal((await readClimateState("home-b", store)).rooms.length, 0);
  assert.doesNotMatch(JSON.stringify(publicClimateState(await readClimateState("home-a", store))), /secret-ac|secret-sensor|siid|piid|did/);
  assert.equal(store.values.size, 1);
  await deleteClimateState("home-a", store);
  assert.equal(store.values.size, 0);
});

test("all phase 1 API route modules delegate only to the climate read/derive service", async () => {
  const service = await readFile(new URL("../lib/ai/api/climate.ts", import.meta.url), "utf8");
  assert.doesNotMatch(service, /prop\/set|miotspec\/action|scene.*run|automation.*write|executor/i);
  assert.match(service, /sampleClimate/);
});

test("periodic valid status creates points without creating preference observations", async () => {
  const store = memoryStore(), homeId = "home-periodic";
  const state = await readClimateState(homeId, store);
  state.enabled = true;
  state.rooms.push({ roomRef: "room_aaaaaaaaaaaaaaaaaaaaaaaa", roomName: "卧室", sensorRef: "sensor_aaaaaaaaaaaaaaaaaaaaaaaa", sensorName: "温度计", sensor: { did: "sensor", siid: 2, piid: 1 }, actuators: [{ actuatorRef: "actuator_bbbbbbbbbbbbbbbbbbbbbbbb", actuatorName: "锅炉", actuatorRoom: "设备间", target: { did: "boiler", siid: 2, piid: 3 }, power: { did: "boiler", siid: 2, piid: 1 }, range: { min: 10, max: 35, step: 1 }, capabilityRevision: "rev_test" }] });
  await writeClimateState(homeId, state, store);
  const requester = async (_session, _path, body) => ({ result: body.params.map(item => ({ ...item, code: 0, value: item.did === "sensor" ? 21 : item.piid === 1 ? true : 24 })) });
  const session = { userId: "fake", cUserId: "fake", ssecurity: "fake", serviceToken: "fake", region: "cn", deviceId: "fake", userAgent: "fake", createdAt: 0 };
  const firstResult = await sampleClimate(session, homeId, store, {}, new Date("2026-01-01T00:00:00Z"), requester);
  await sampleClimate(session, homeId, store, {}, new Date("2026-01-01T00:02:00Z"), requester);
  await sampleClimate(session, homeId, store, {}, new Date("2026-01-01T00:16:00Z"), requester);
  const saved = await readClimateState(homeId, store);
  assert.equal(saved.samples.length, 2);
  assert.equal(saved.observations.length, 0);
  assert.equal(saved.samples[0].ambientTemperature, 21);
  assert.equal(saved.samples[0].targetTemperature, 24);
  assert.equal(saved.samples[0].power, true);
  assert.equal(firstResult.newSamples, 1);
  const payload = climateDerivationPayload(saved);
  assert.equal(payload.historyPoints.length, 2);
  assert.equal(payload.historyPoints[0].mode, null);
  assert.equal(payload.historyPoints[0].localHour, 8);
  assert.doesNotMatch(JSON.stringify(payload), /\"did\"|\"siid\"|\"piid\"/);
});

test("boiler capability selection uses only the thermostat setpoint and thermostat power", () => {
  const property = (name, piid, extras = {}) => ({ key: `2.${piid}`, name, label: name, siid: 2, piid, format: "float", readable: true, writable: name === "target-temperature", notify: false, ...extras });
  const selected = selectClimateProperties([
    { name: "boiler", label: "锅炉", properties: [property("on", 1), property("target-temperature", 2, { range: { min: 35, max: 75, step: 1 } })] },
    { name: "thermostat", label: "采暖温控", properties: [property("target-temperature", 12, { range: { min: 5, max: 35, step: 0.5 } }), property("mode", 13, { writable: false, choices: [{ value: 1, label: "采暖" }] }), property("on", 14)] },
    { name: "boiler-controller", label: "锅炉总控", properties: [property("on", 21)] },
  ]);
  assert.equal(selected.target.piid, 12);
  assert.equal(selected.power.piid, 14);
  assert.equal(selected.mode.piid, 13);
});

test("boiler without a thermostat or room-heating setpoint is not a climate actuator", () => {
  const property = (name, piid, extras = {}) => ({ key: `2.${piid}`, name, label: name, siid: 2, piid, format: "float", readable: true, writable: name === "target-temperature", notify: false, ...extras });
  assert.equal(selectClimateProperties([
    { name: "boiler", label: "锅炉", properties: [property("on", 1), property("target-temperature", 2, { range: { min: 35, max: 75, step: 1 } })] },
    { name: "boiler-controller", label: "锅炉总控", properties: [property("on", 21)] },
  ]), null);
});

test("saved boiler plans refresh to newly discovered thermostat and power properties", async () => {
  const state = await readClimateState("home-refresh", memoryStore());
  state.rooms.push({ roomRef: "room_a", roomName: "全屋", sensorRef: "sensor_a", sensorName: "温度计", sensor: { did: "sensor", siid: 2, piid: 1 }, actuators: [{ actuatorRef: "actuator_a", actuatorName: "锅炉", actuatorRoom: "设备间", target: { did: "boiler", siid: 2, piid: 2 }, power: { did: "boiler", siid: 2, piid: 1 }, range: { min: 35, max: 75, step: 1 }, capabilityRevision: "rev_hot_water" }] });
  state.runtime["room_a:actuator_a"] = { confirmed: { targetTemperature: 55, mode: null, observedAt: "2026-01-01T00:00:00Z" } };
  state.samples.push({ sampleRef: "sample_water", roomRef: "room_a", actuatorRef: "actuator_a", ambientTemperature: 20, targetTemperature: 41, mode: null, power: true, capturedAt: "2026-01-01T00:00:00Z" });
  state.observations.push({ observationRef: "obs_water", roomRef: "room_a", actuatorRef: "actuator_a", ambientTemperature: 20, targetTemperature: 41, mode: null, powerOn: true, capturedAt: "2026-01-01T00:00:00Z", localHour: 8, dayOfWeek: 4, source: "external_override", excluded: false, previous: { targetTemperature: 40, mode: null } });
  state.draftProfile = { version: "1", revision: "profile_water", generatedAt: "2026-01-01T00:00:00Z", rooms: [{ roomRef: "room_a", actuatorRef: "actuator_a", cells: [] }] };
  state.profileRevisions = [structuredClone(state.draftProfile)];
  state.reviewedRevision = "profile_water";
  state.reviewedAt = "2026-01-01T00:00:00Z";
  const changed = reconcileClimateConfig(state, { sensors: [{ ref: "sensor_a", name: "温度计", room: "全屋", plan: { did: "sensor", siid: 2, piid: 1 } }], actuators: [{ ref: "actuator_a", name: "锅炉", room: "设备间", target: { did: "boiler", siid: 2, piid: 12 }, mode: { did: "boiler", siid: 2, piid: 13 }, power: { did: "boiler", siid: 2, piid: 14 }, range: { min: 5, max: 35, step: 0.5 }, modes: [1], revision: "rev_thermostat" }] });
  assert.equal(changed, true);
  assert.equal(state.rooms[0].actuators[0].target.piid, 12);
  assert.equal(state.rooms[0].actuators[0].power.piid, 14);
  assert.equal(state.rooms[0].actuators[0].range.max, 35);
  assert.equal(state.runtime["room_a:actuator_a"], undefined);
  assert.equal(state.samples.length, 0);
  assert.equal(state.observations.length, 0);
  assert.equal(state.draftProfile.rooms.length, 0);
  assert.equal(state.profileRevisions[0].rooms.length, 0);
  assert.equal(state.reviewedRevision, null);
});

test("climate profiles render on the Environment page with no duplicate Climate tab", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const settings = page.slice(page.indexOf("function SettingsView"));
  assert.match(page, /tab==="环境"\?<ClimateDashboard/);
  assert.match(page, /function ClimateDashboard/);
  assert.doesNotMatch(page, /\["气候","♨"\]/);
  assert.doesNotMatch(settings, /<AdaptiveClimateProfiles/);
});

test("each room shows periodic history and the Agent final recommendation", async () => {
  const component = await readFile(new URL("../app/components/ai-assistant/adaptive-climate-profiles.tsx", import.meta.url), "utf8");
  assert.match(component, /function RoomClimateReview/);
  assert.match(component, /Agent 当前建议/);
  assert.match(component, /基于周期历史的临时建议/);
  assert.match(component, /模式 \{final\.mode/);
  assert.match(component, /配置已保存/);
  assert.match(component, /操作失败（\$\{code\}）/);
  assert.match(component, /历史状态/);
  assert.match(component, /currentTimeWindow\(\).*ambientBand\(sample\.ambientTemperature\)/s);
  assert.match(component, /仅供审阅/);
});
