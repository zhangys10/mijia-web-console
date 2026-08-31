import assert from "node:assert/strict";
import test from "node:test";
import { dashboardAccountLabel, dashboardGreeting, formatDashboardDate } from "../lib/dashboard-display.ts";

test("formats the dashboard date from the browser-local calendar", () => {
  assert.equal(formatDashboardDate(new Date(2026, 7, 31, 9)), "2026年8月31日 · 星期一");
  assert.equal(formatDashboardDate(new Date(Number.NaN)), "今天");
});

test("uses the current hour for the greeting instead of a fixed person name", () => {
  assert.equal(dashboardGreeting(new Date(2026, 7, 31, 2)), "夜深了");
  assert.equal(dashboardGreeting(new Date(2026, 7, 31, 8)), "早上好");
  assert.equal(dashboardGreeting(new Date(2026, 7, 31, 12)), "中午好");
  assert.equal(dashboardGreeting(new Date(2026, 7, 31, 16)), "下午好");
  assert.equal(dashboardGreeting(new Date(2026, 7, 31, 20)), "晚上好");
});

test("shows only the verified masked Xiaomi account identity", () => {
  assert.equal(dashboardAccountLabel(true, "••••8392"), "米家账号 ••••8392");
  assert.equal(dashboardAccountLabel(false), "访客");
});
