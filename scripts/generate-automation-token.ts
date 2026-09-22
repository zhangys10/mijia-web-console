/**
 * Offline automation-token generator for local agent testing.
 *
 * Uses the console's own automation-token library, so the issued token is
 * byte-compatible with the settings UI: AES-GCM under
 * AI_AUTOMATION_TOKEN_SECRET, payload v1 / "ai-home-automation", with the
 * sealed Xiaomi session embedded. The token carries no model fields —
 * model access stays on the Makers Gateway in the agent.
 *
 * Usage:
 *   node --experimental-strip-types scripts/generate-automation-token.ts \
 *     --session '<xiaomi_session cookie value>' \
 *     [--home <homeId>] [--days 30] [--out /tmp/token.txt]
 *
 * Env: AI_AUTOMATION_TOKEN_SECRET must match the secret the verifying console
 * runs with (prod console for prod-token verification).
 * Optional env XIAOMI_SESSION_SECRET if the cookie was sealed with a custom
 * secret.
 */

import { unsealWithSecret, type XiaomiSession } from "../lib/xiaomi-cloud.ts";
import { computePrincipalId, sealAutomationToken } from "../lib/ai/security/automation-token.ts";

function args(argv: string[]) {
  const parsed: Record<string, string | undefined> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--session") parsed.session = argv[++i];
    else if (argv[i] === "--session-file") parsed.sessionFile = argv[++i];
    else if (argv[i] === "--home") parsed.home = argv[++i];
    else if (argv[i] === "--days") parsed.days = argv[++i];
    else if (argv[i] === "--out") parsed.out = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") parsed.help = "1";
    else {
      console.error(`Unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  return parsed;
}

const parsed = args(process.argv.slice(2));
if (parsed.help || (!parsed.session && !parsed.sessionFile)) {
  console.log(`Usage: node --experimental-strip-types scripts/generate-automation-token.ts \\
  (--session '<xiaomi_session cookie value>' | --session-file '<cookie file>') \\
  [--home <homeId>] [--days 1-90, default 30] [--out <file>]

--session-file reads the pasted cookie from a file (avoids argv/history
exposure; should be owner-only, mode 0600).
Reads AI_AUTOMATION_TOKEN_SECRET (and optionally XIAOMI_SESSION_SECRET) from env.
`);
  process.exit(parsed.help ? 0 : 2);
}
if (parsed.session && parsed.sessionFile) {
  console.error("Use either --session or --session-file, not both.");
  process.exit(2);
}

let sessionInput = parsed.session ?? "";
if (parsed.sessionFile) {
  const { readFile } = await import("node:fs/promises");
  try {
    sessionInput = (await readFile(parsed.sessionFile, "utf8")).trim();
  } catch (error) {
    console.error(`Cannot read session file: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
  if (!sessionInput) {
    console.error("Session file is empty.");
    process.exit(1);
  }
}

const secret = process.env.AI_AUTOMATION_TOKEN_SECRET;
if (!secret || secret.length < 32) {
  console.error("AI_AUTOMATION_TOKEN_SECRET must be set (>= 32 chars) and match the verifying console.");
  process.exit(1);
}

const days = parsed.days ? Number.parseInt(parsed.days, 10) : 30;
if (!Number.isFinite(days) || days < 1 || days > 90) {
  console.error("--days must be 1-90");
  process.exit(2);
}

// Decrypts and validates the sealed cookie with the console's own logic.
// DevTools copies cookie values URL-encoded (e.g. %2B for +) and terminal
// pastes can wrap; the server-side cookie jar decodes automatically, so the
// script does the same, tolerating both encoded and raw input.
let sealedSession = sessionInput.replace(/\s+/g, "");
if (sealedSession.includes("%")) {
  try {
    sealedSession = decodeURIComponent(sealedSession);
  } catch {
    // Keep as-is: not actually URL-encoded.
  }
}
const session: XiaomiSession = await unsealWithSecret<XiaomiSession>(
  sealedSession,
  process.env.XIAOMI_SESSION_SECRET || undefined,
);

const now = Date.now();
const payload = {
  version: 1 as const,
  purpose: "ai-home-automation" as const,
  principalId: await computePrincipalId(session.region || "cn", session.userId),
  xiaomiSession: session,
  region: session.region || "cn",
  ...(parsed.home ? { homeId: parsed.home } : {}),
  issuedAt: now,
  expiresAt: now + days * 86_400_000,
};

const token = await sealAutomationToken(payload, { secret });

if (parsed.out) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(parsed.out, token + "\n", { mode: 0o600 });
  console.log(`Token written to ${parsed.out} (mode 0600), expires ${new Date(payload.expiresAt).toISOString()}`);
} else {
  console.log(`Expires: ${new Date(payload.expiresAt).toISOString()}`);
  console.log(`principalId: ${payload.principalId.slice(0, 8)}…`);
  console.log(token);
}
