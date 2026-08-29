import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
}

test("uses the platform-specific build output for each deployment target", async () => {
  const [edgeOne, packageJson, vercel] = await Promise.all([
    readJson("../edgeone.json"),
    readJson("../package.json"),
    readJson("../vercel.json"),
  ]);

  assert.equal(packageJson.scripts.build, "vinext build");
  assert.equal(packageJson.scripts["build:edgeone"], "next build --webpack");
  assert.equal(packageJson.scripts["build:vercel"], "next build --webpack");

  assert.deepEqual(edgeOne, {
    buildCommand: "npm run build:edgeone",
    installCommand: "npm ci",
    outputDirectory: ".next",
  });
  assert.equal(vercel.buildCommand, "npm run build:vercel");
});
