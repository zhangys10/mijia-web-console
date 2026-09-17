import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ICP_NUMBER,
  MIIT_BEIAN_URL,
  isChinaMainlandRegion,
  resolveIcpFiling,
} from "../lib/site-compliance.ts";

test("identifies China Mainland region correctly", () => {
  assert.equal(isChinaMainlandRegion("cn"), true);
  assert.equal(isChinaMainlandRegion("CN"), true);
  assert.equal(isChinaMainlandRegion(" cn "), true);
  assert.equal(isChinaMainlandRegion(undefined), true);
  assert.equal(isChinaMainlandRegion(null), true);
  assert.equal(isChinaMainlandRegion(""), true);

  assert.equal(isChinaMainlandRegion("sg"), false);
  assert.equal(isChinaMainlandRegion("us"), false);
  assert.equal(isChinaMainlandRegion("de"), false);
  assert.equal(isChinaMainlandRegion("ru"), false);
  assert.equal(isChinaMainlandRegion("i2"), false);
});

test("resolves ICP filing configuration for Mainland China according to MIIT guidelines", () => {
  const defaultFiling = resolveIcpFiling({ region: "cn" });
  assert.equal(defaultFiling.enabled, true);
  assert.equal(defaultFiling.icpNumber, DEFAULT_ICP_NUMBER);
  assert.equal(defaultFiling.icpNumber, "沪ICP备2026045701号");
  assert.equal(defaultFiling.url, MIIT_BEIAN_URL);
  assert.equal(defaultFiling.url, "https://beian.miit.gov.cn/");
});

test("disables ICP filing display for non-mainland regions", () => {
  for (const overseasRegion of ["sg", "us", "de", "ru", "i2"]) {
    const filing = resolveIcpFiling({ region: overseasRegion });
    assert.equal(filing.enabled, false, `ICP filing should be disabled for region: ${overseasRegion}`);
    assert.equal(filing.url, "https://beian.miit.gov.cn/");
  }
});

test("allows custom ICP filing number override", () => {
  const custom = resolveIcpFiling({
    region: "cn",
    customNumber: "京ICP备2024012345号-1",
  });
  assert.equal(custom.enabled, true);
  assert.equal(custom.icpNumber, "京ICP备2024012345号-1");
  assert.equal(custom.url, "https://beian.miit.gov.cn/");
});

test("supports explicitly disabling ICP filing via customNumber none/false", () => {
  assert.equal(resolveIcpFiling({ region: "cn", customNumber: "none" }).enabled, false);
  assert.equal(resolveIcpFiling({ region: "cn", customNumber: "false" }).enabled, false);
});
