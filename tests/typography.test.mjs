import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("uses one readable type scale across all application surfaces", async () => {
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/typography.css", import.meta.url), "utf8");

  assert.ok(
    layout.indexOf('import "./typography.css"') > layout.indexOf('import "./automation-center.css"'),
    "the shared type scale must load after component styles",
  );
  assert.match(styles, /--font-meta:\s*11px/);
  assert.match(styles, /--font-control:\s*12px/);
  assert.match(styles, /--font-body:\s*13px/);
  assert.match(styles, /--font-label:\s*14px/);
  assert.match(styles, /--font-section-title:\s*16px/);
  assert.match(styles, /\.scene-editor-section-title strong/);
  assert.match(styles, /\.automation-section-copy strong/);
  assert.match(styles, /\.dm-channel-status/);
  assert.match(styles, /body small\s*\{[^}]*var\(--font-meta\)/s);
});
