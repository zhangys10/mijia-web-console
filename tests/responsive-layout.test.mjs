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
  assert.match(styles, /\.dm-room-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill,/s);
  assert.match(styles, /\.dm-room-grid\s*\{[^}]*align-items:\s*start/s);
  assert.doesNotMatch(styles, /\.dm-room-grid\s*\{[^}]*repeat\(auto-fit,/s);
  assert.match(styles, /\.dm-channel-row\s*\{[^}]*grid-template-columns:\s*minmax\(54px, max-content\)\s+minmax\(0, 1fr\)\s+28px/s);
  assert.match(styles, /\.dm-channel-name\s*\{[^}]*text-overflow:\s*ellipsis/s);
  assert.match(styles, /\.dm-channel-siid\s*\{[^}]*white-space:\s*nowrap/s);
  assert.match(styles, /\.dm-channel-row\.inferred-wired\s*\{[^}]*border-style:\s*dashed/s);
  assert.match(component, /<canvas\s+ref=\{canvasRef\}/);
  assert.match(component, /开关与硬件/);
  assert.match(component, /实际照明/);
  assert.match(component, /有线直连/);
  assert.match(component, /推定有线/);
  assert.match(component, /dm-record-card dm-record-kind-\$\{category\}/);
  assert.match(component, /dm-category dm-category-\$\{category\}/);
  assert.doesNotMatch(component, /dm-record-card \$\{category\}/);
  assert.doesNotMatch(component, /dm-category \$\{category\}/);
  assert.match(styles, /\.dm-category-switch\s*\{/);
  assert.doesNotMatch(styles, /\.dm-category\.switch\s*\{/);
  assert.match(component, /channels\.map\(channel =>/);
  assert.doesNotMatch(component, /channels\.flatMap\(channel =>/);
  assert.match(component, /targets\.length > 1 \? `\$\{primaryTarget\.name\} \+\$\{targets\.length - 1\}`/);
  assert.match(component, /channel\.targets\.length === 1 \? endpointsById\.get\(primaryTarget\.id\) : undefined/);
  assert.match(component, /dm-channel-status/);
  assert.match(component, /dm-channel-name/);
  assert.match(component, /dm-channel-siid/);
  assert.match(component, /无线控制/);
  assert.match(component, /关系待确认/);
  assert.match(component, /stopPropagation\(\);\s*onOpenMember\(member\)/);
});
