import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import { sealWithSecret } from "../lib/xiaomi-cloud.ts";
import { openAutomationToken } from "../lib/ai/security/automation-token.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

test("token generator reports a cookie and secret mismatch without a Node stack trace", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mijia-token-test-"));
  try {
    const cookie = await sealWithSecret(
      { userId: "fake-user", region: "cn" },
      "fake-cookie-secret-that-is-at-least-32-characters",
    );
    const cookieFile = join(directory, "cookie.txt");
    const envFile = join(directory, "production.env");
    writeFileSync(cookieFile, cookie, { mode: 0o600 });
    writeFileSync(
      envFile,
      "AI_AUTOMATION_TOKEN_SECRET=fake-token-secret-that-is-at-least-32-characters\n"
      + "XIAOMI_SESSION_SECRET=different-fake-cookie-secret-at-least-32-characters\n",
      { mode: 0o600 },
    );

    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "scripts/generate-automation-token.ts",
        "--session-file",
        cookieFile,
        "--env-file",
        envFile,
      ],
      { cwd: repoRoot, env: { PATH: process.env.PATH, APP_ENV: "production" }, encoding: "utf8" },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /XIAOMI_SESSION_INVALID: cookie does not match the available XIAOMI_SESSION_SECRET/);
    assert.doesNotMatch(result.stderr, /Node\.js v|at unsealWithSecret/);
    assert.doesNotMatch(result.stdout + result.stderr, /fake-user|fake-cookie-secret/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("token generator combines the selected token secret with the console session secret", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mijia-token-test-"));
  const sessionSecret = "fake-session-secret-for-console-at-least-32-characters";
  const tokenSecret = "fake-production-token-secret-at-least-32-characters";
  try {
    const cookie = await sealWithSecret(
      { userId: "fake-user", region: "cn", ssecurity: "fake-security", serviceToken: "fake-token" },
      sessionSecret,
    );
    const cookieFile = join(directory, "cookie.txt");
    const tokenEnvFile = join(directory, "production.env");
    const sessionEnvFile = join(directory, "console.env");
    writeFileSync(cookieFile, cookie, { mode: 0o600 });
    writeFileSync(tokenEnvFile, `AI_AUTOMATION_TOKEN_SECRET=${tokenSecret}\n`, { mode: 0o600 });
    writeFileSync(sessionEnvFile, `XIAOMI_SESSION_SECRET=${sessionSecret}\n`, { mode: 0o600 });

    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "scripts/generate-automation-token.ts",
        "--session-file",
        cookieFile,
        "--env-file",
        tokenEnvFile,
        "--session-env-file",
        sessionEnvFile,
      ],
      { cwd: repoRoot, env: { PATH: process.env.PATH, APP_ENV: "production" }, encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    const token = result.stdout.trim().split("\n").at(-1);
    const payload = await openAutomationToken(token, { secret: tokenSecret, env: "production" });
    assert.equal(payload.xiaomiSession.userId, "fake-user");
    assert.equal(payload.audience, "mijia-agent");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
