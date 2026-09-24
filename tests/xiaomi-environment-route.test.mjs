import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("home environment route explicitly supplies the session secret before Xiaomi calls", async () => {
  const source = await readFile(new URL("../app/api/xiaomi/environment/route.ts", import.meta.url), "utf8");
  assert.match(source, /readXiaomiSession\(value, process\.env\.XIAOMI_SESSION_SECRET\)/);
  assert.doesNotMatch(source, /readXiaomiSession\(value\)/);
});
