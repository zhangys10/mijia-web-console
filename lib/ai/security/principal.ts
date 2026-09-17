import type { XiaomiSession } from "../../xiaomi-cloud.ts";

export type PrincipalEnvironment = Record<string, string | undefined>;

export type PrincipalErrorCode =
  | "AI_PRINCIPAL_SECRET_NOT_CONFIGURED"
  | "AI_PRINCIPAL_SECRET_WEAK"
  | "AI_PRINCIPAL_SESSION_INVALID";

export class PrincipalError extends Error {
  readonly code: PrincipalErrorCode;

  constructor(code: PrincipalErrorCode, message: string) {
    super(message);
    this.name = "PrincipalError";
    this.code = code;
  }
}

/** 高熵 Secret 的最低长度，低于该长度的值不进入 HMAC 派生。 */
export const MIN_PRINCIPAL_SECRET_LENGTH = 32;

const PRINCIPAL_PREFIX = "usr_";
const encoder = new TextEncoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64url");
  }
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function resolvePrincipalSecret(env: PrincipalEnvironment): string {
  const secret = env.AI_PRINCIPAL_SECRET?.trim();
  if (!secret) {
    throw new PrincipalError(
      "AI_PRINCIPAL_SECRET_NOT_CONFIGURED",
      "AI_PRINCIPAL_SECRET 未配置",
    );
  }
  if (secret.length < MIN_PRINCIPAL_SECRET_LENGTH) {
    throw new PrincipalError(
      "AI_PRINCIPAL_SECRET_WEAK",
      `AI_PRINCIPAL_SECRET 至少需要 ${MIN_PRINCIPAL_SECRET_LENGTH} 个字符`,
    );
  }
  return secret;
}

/**
 * 从服务端解密的 Xiaomi Session 派生稳定 principalId。
 *
 * principalId = "usr_" + base64url(HMAC-SHA256(AI_PRINCIPAL_SECRET, "xiaomi:" + userId))
 *
 * 客户端提交的任何 principalId、Header 或请求体都不会参与派生。
 */
export async function derivePrincipalId(
  session: Pick<XiaomiSession, "userId">,
  env: PrincipalEnvironment = process.env,
): Promise<string> {
  const userId = session?.userId;
  if (typeof userId !== "string" || !userId.trim()) {
    throw new PrincipalError("AI_PRINCIPAL_SESSION_INVALID", "小米会话缺少有效 userId");
  }
  const secret = resolvePrincipalSecret(env);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`xiaomi:${userId}`));
  return PRINCIPAL_PREFIX + bytesToBase64Url(new Uint8Array(signature));
}
