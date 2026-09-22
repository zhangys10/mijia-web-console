import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sealWithSecret } from "../lib/xiaomi-cloud.ts";
import { openAutomationToken } from "../lib/ai/security/automation-token.ts";

// Fake-only credentials per AGENTS.md; nothing here is a real account.
const secrets = {
  AI_AUTOMATION_TOKEN_SECRET: "test-automation-secret-not-real-12345",
  XIAOMI_SESSION_SECRET: "test-session-secret-not-real-123456789",
};
const session = {
  userId: "test-user", cUserId: "test-c-user", serviceToken: "fake-token",
  ssecurity: "fake-security", region: "cn", deviceId: "fake-device",
  userAgent: "test-agent",
};
const cookie = await sealWithSecret(session, secrets.XIAOMI_SESSION_SECRET);
// DevTools copies cookies URL-encoded and pastes can wrap — pass the exact
// hostile form: encoded, with an embedded newline.
const devtoolsStyle = encodeURIComponent(cookie).replace("j", "j\n");

const workDir = mkdtempSync(join(tmpdir(), "automation-token-"));
const sessionFile = join(workDir, "cookie.txt");
writeFileSync(sessionFile, devtoolsStyle + "\n", { mode: 0o600 });
chmodSync(sessionFile, 0o600);

try {
  const stdout = execFileSync("node", [
    "--experimental-strip-types", "scripts/generate-automation-token.ts",
    "--session-file", sessionFile, "--days", "7",
  ], { env: { ...process.env, ...secrets }, encoding: "utf8" });
  const token = stdout.trim().split("\n").at(-1);
  console.log("token prefix:", token.slice(0, 12) + "…");

  const payload = await openAutomationToken(token, { secret: secrets.AI_AUTOMATION_TOKEN_SECRET });
  if (payload.xiaomiSession.userId !== session.userId) throw new Error("userId mismatch");
  if (payload.purpose !== "ai-home-automation" || payload.version !== 1) throw new Error("payload mismatch");
  const expectedPrincipal = await computePrincipalForTest(session);
  if (payload.principalId !== expectedPrincipal) throw new Error("principal mismatch");
  console.log("roundtrip OK: token opens with the same secret, principal + session intact, expires", new Date(payload.expiresAt).toISOString());
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

async function computePrincipalForTest(session) {
  const { computePrincipalId } = await import("../lib/ai/security/automation-token.ts");
  return computePrincipalId(session.region, session.userId);
}
