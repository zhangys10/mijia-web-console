import assert from "node:assert/strict";
import test from "node:test";

import {
  assertHomeAccess,
  listManualScenes,
  parseManualScenes,
  runManualScene,
  selectRunnableManualScene,
} from "../lib/xiaomi-scenes.ts";

const session = {
  userId: "redacted-user",
  ssecurity: "unused-in-injected-tests",
  serviceToken: "unused-in-injected-tests",
  region: "cn",
  createdAt: 0,
};

test("normalizes only manual scenes for the requested home", () => {
  const response = {
    result: {
      scene_info_list: [
        {
          scene_id: 11,
          home_id: 100,
          name: "回家",
          icon: "home",
          enable: 1,
          scene_trigger: { triggers: [{ src: "user" }] },
          scene_action: { actions: [{}, {}] },
          update_time: 1234,
          owner_uid: "must-not-leak",
        },
        {
          scene_id: "12",
          home_id: "100",
          scene_name: "晚安",
          enabled: "false",
          scene_trigger: JSON.stringify({ triggers: [{ src: "user" }] }),
          setting: JSON.stringify({ action_list: [{}, {}, {}] }),
        },
        {
          scene_id: "automation",
          home_id: "100",
          name: "自动开灯",
          scene_trigger: { triggers: [{ src: "timer" }] },
        },
        {
          scene_id: "other-home",
          home_id: "200",
          name: "别人的场景",
          scene_trigger: { triggers: [{ src: "user" }] },
        },
        { home_id: "100", name: "缺少 ID", scene_trigger: { triggers: [{ src: "user" }] } },
        { scene_id: "missing-name", home_id: "100", scene_trigger: { triggers: [{ src: "user" }] } },
      ],
    },
  };

  assert.deepEqual(parseManualScenes(response, "100"), [
    { id: "11", homeId: "100", name: "回家", icon: "home", enabled: true, actionCount: 2, updatedAt: "1234" },
    { id: "12", homeId: "100", name: "晚安", enabled: false, actionCount: 3 },
  ]);
});

test("accepts numbered scene maps and rejects unrecognized responses", () => {
  assert.deepEqual(parseManualScenes({ result: { 0: { id: "one", name: "手动", triggers: [{ src: "USER" }] } } }, "home"), [
    { id: "one", homeId: "home", name: "手动", enabled: true, actionCount: 0 },
  ]);
  assert.throws(() => parseManualScenes({ result: { unexpected: [] } }, "home"), /XIAOMI_SCENE_RESPONSE_INVALID/);
});

test("treats Xiaomi's null result for a home without scenes as an empty list", () => {
  assert.deepEqual(parseManualScenes({ result: null }, "empty-home"), []);
  assert.throws(() => parseManualScenes({}, "empty-home"), /XIAOMI_SCENE_RESPONSE_INVALID/);
});

test("enforces home and scene isolation before execution", () => {
  const scenes = [
    { id: "enabled", homeId: "home-a", name: "回家", enabled: true, actionCount: 1 },
    { id: "disabled", homeId: "home-a", name: "晚安", enabled: false, actionCount: 1 },
    { id: "enabled", homeId: "home-b", name: "另一个家", enabled: true, actionCount: 1 },
  ];
  assert.doesNotThrow(() => assertHomeAccess([{ id: "home-a" }], "home-a"));
  assert.throws(() => assertHomeAccess([{ id: "home-a" }], "home-b"), /XIAOMI_HOME_NOT_FOUND/);
  assert.equal(selectRunnableManualScene(scenes, "home-a", "enabled").name, "回家");
  assert.throws(() => selectRunnableManualScene(scenes, "home-a", "disabled"), /XIAOMI_SCENE_DISABLED/);
  assert.throws(() => selectRunnableManualScene(scenes, "home-a", "missing"), /XIAOMI_SCENE_NOT_FOUND/);
  assert.throws(() => selectRunnableManualScene(scenes, "home-b", "disabled"), /XIAOMI_SCENE_NOT_FOUND/);
});

test("uses the verified scene-list endpoint and propagates upstream failures", async () => {
  let call;
  const scenes = await listManualScenes(session, "home-1", async (_session, path, data) => {
    call = { path, data };
    return { result: { scene_list: [{ id: "scene-1", name: "测试", triggers: [{ src: "user" }] }] } };
  });
  assert.deepEqual(call, {
    path: "/app/appgateway/miot/appsceneservice/AppSceneService/GetSceneList",
    data: { home_id: "home-1" },
  });
  assert.equal(scenes[0].homeId, "home-1");
  await assert.rejects(
    listManualScenes(session, "home-1", async () => { throw new Error("XIAOMI_CLOUD_HTTP_503"); }),
    /XIAOMI_CLOUD_HTTP_503/,
  );
});

test("submits the exact verified manual scene payload", async () => {
  let call;
  await runManualScene(session, "scene-9", async (_session, path, data) => {
    call = { path, data };
    return { result: true };
  });
  assert.deepEqual(call, {
    path: "/app/appgateway/miot/appsceneservice/AppSceneService/NewRunScene",
    data: { scene_id: "scene-9", scene_type: 2, trigger_key: "user.click" },
  });
  await assert.rejects(runManualScene(session, "scene-9", async () => ({ result: false })), /XIAOMI_SCENE_NOT_ACCEPTED/);
});
