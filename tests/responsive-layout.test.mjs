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

test("renders the rebuilt device inventory and interactive light topology on desktop and mobile", async () => {
  const styles = await readFile(new URL("../app/device-management.css", import.meta.url), "utf8");
  const component = await readFile(new URL("../app/device-management.tsx", import.meta.url), "utf8");

  assert.match(styles, /\.dm-topology-explorer\s*\{[^}]*grid-template-columns:/s);
  assert.match(styles, /@media\s*\(max-width:\s*760px\)/);
  assert.match(styles, /\.dm-topology-explorer\s*\{\s*grid-template-columns:\s*1fr/s);
  assert.match(styles, /\.dm-room-grid\s*\{[^}]*grid-template-columns:/s);
  assert.match(component, /<canvas\s+ref=\{canvasRef\}/);
  assert.match(component, /语音映射/);
  assert.match(component, /有线主控/);
  assert.match(component, /无线副控/);
  assert.match(component, /stopPropagation\(\);\s*onOpenMember\(member\)/);
});
