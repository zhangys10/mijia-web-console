import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageUrl = new URL("../app/page.tsx", import.meta.url);

test("connected scene UI never falls back to demo data", async () => {
  const source = await readFile(pageUrl, "utf8");
  assert.match(source, /connection\.connected\?\(selectedHome==="demo"\?\[\]:sceneState\.items\):demoScenes/);
  assert.match(source, /connection\.connected\)void loadScenes\(homeId\)/, "switching homes must load that home's scenes");
  assert.match(source, /const homeId=await loadDevices\(true\);await loadScenes\(homeId,true\)/, "manual sync must refresh scenes");
});

test("scene cards represent loading, empty, error and duplicate-execution states", async () => {
  const source = await readFile(pageUrl, "utf8");
  assert.match(source, /正在读取米家场景/);
  assert.match(source, /当前家庭没有可用的手动场景/);
  assert.match(source, /场景读取失败/);
  assert.match(source, /if\(!scene\.enabled\|\|sceneOperating\)return/);
  assert.match(source, /disabled=\{!scene\.enabled\|\|blocked\}/);
});

test("scene cards open details and use a separate execution button", async () => {
  const source = await readFile(pageUrl, "utf8");
  const start = source.indexOf("function SceneCard");
  const end = source.indexOf("function SceneStateMessage", start);
  const sceneCard = source.slice(start, end);
  assert.match(sceneCard, /className="scene-card-open"[^>]*onClick=\{onOpen\}/s);
  assert.match(sceneCard, /className="scene-run"[^>]*onClick=\{\(\)=>onRun\(scene\)\}/s);
  assert.doesNotMatch(sceneCard, /runScene\(/, "the card component must not execute a scene from its detail action");
  assert.match(source, /selectedScene&&<div className="modal-bg"/, "opening a card must show scene details");
  assert.match(source, /className="scene-modal-run"/, "the detail card must expose an explicit execution action");
});

test("real execution reports submission without speculative device updates", async () => {
  const source = await readFile(pageUrl, "utf8");
  const start = source.indexOf("async function runScene");
  const end = source.indexOf("function openLogin", start);
  const runScene = source.slice(start, end);
  assert.match(runScene, /已下发到米家云/);
  assert.doesNotMatch(runScene.slice(runScene.indexOf("setSceneOperating(scene.id)")), /setDevices/, "connected execution must not change device state");
});
