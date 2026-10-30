import assert from "node:assert/strict";
import test from "node:test";
import { sceneGlyph } from "../lib/scene-display.ts";

test("scene glyphs reject raw Xiaomi icon identifiers and URLs", () => {
  assert.equal(sceneGlyph({ icon: "☀" }), "☀");
  assert.equal(sceneGlyph({ icon: "🏠" }), "🏠");
  assert.equal(sceneGlyph({ icon: "scene.icon.arrive-home" }), "✦");
  assert.equal(sceneGlyph({ icon: "https://example.invalid/scene.png" }), "✦");
  assert.equal(sceneGlyph({}), "✦");
});
