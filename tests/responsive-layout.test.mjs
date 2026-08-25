import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("keeps typography readable across desktop, tablet and mobile layouts", async () => {
  const styles = await readFile(new URL("../app/responsive.css", import.meta.url), "utf8");

  assert.match(styles, /body\s*\{[^}]*font-size:\s*15px/s);
  assert.match(styles, /@media\s*\(max-width:\s*1320px\)/);
  assert.match(styles, /@media\s*\(max-width:\s*980px\)/);
  assert.match(styles, /@media\s*\(max-width:\s*760px\)/);
  assert.match(styles, /@media\s*\(max-width:\s*560px\)/);
  assert.match(styles, /env\(safe-area-inset-bottom\)/);
  assert.match(styles, /\.actions button\.mobile-account/);
  assert.match(styles, /\.associated-device-ids code/);
});
