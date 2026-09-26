import type { XiaomiSession } from "../../xiaomi-cloud.ts";

export type AutomationTokenPayload = {
  version: 1;
  purpose: "ai-home-automation";
  audience?: "mijia-agent";
  principalId: string;
  xiaomiSession: XiaomiSession;
  region: string;
  homeId?: string;
  /** Phase 3 之后签发的 token 不再携带 BYOK 字段；旧 token 中可能仍存在，读取方一律忽略。 */
  provider?: string;
  model?: string;
  apiKey?: string;
  issuedAt: number;
  expiresAt: number;
};

export type AutomationTokenErrorCode =
  | "AUTOMATION_TOKEN_INVALID"
  | "AUTOMATION_TOKEN_EXPIRED"
  | "AUTOMATION_TOKEN_ENVIRONMENT_MISMATCH"
  | "AI_AUTOMATION_TOKEN_ENVIRONMENT_NOT_CONFIGURED"
  | "AI_AUTOMATION_TOKEN_SECRET_NOT_CONFIGURED";

export class AutomationTokenError extends Error {
  readonly code: AutomationTokenErrorCode;

  constructor(code: AutomationTokenErrorCode, message: string) {
    super(message);
    this.name = "AutomationTokenError";
    this.code = code;
  }
}

const TOKEN_PREFIX = "v1";
const DEFAULT_KEY_ID = "key-2026-01";
/** Stable AAD realm preserves production token compatibility. */
export const AUTOMATION_TOKEN_REALM = "production";
const MAX_TOKEN_LENGTH = 8192;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64url");
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(str: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(str, "base64url"));
  }
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) base64 += "=";
  const binary = atob(base64);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

export async function computePrincipalId(region: string, userId: string): Promise<string> {
  const data = encoder.encode(`xiaomi:${region}:${userId}`);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

export type SealTokenOptions = {
  secret?: string;
  keyId?: string;
  env: string;
};

export type OpenTokenOptions = {
  secret?: string;
  expectedKeyId?: string;
  env: string;
  now?: number;
};

function resolveSecret(customSecret?: string): string {
  const secret = customSecret;
  if (!secret) {
    throw new AutomationTokenError(
      "AI_AUTOMATION_TOKEN_SECRET_NOT_CONFIGURED",
      "自动化令牌加密密钥尚未配置",
    );
  }
  return secret;
}

function resolveKeyId(customKeyId?: string): string {
  return customKeyId || DEFAULT_KEY_ID;
}

function resolveEnv(customEnv?: string): string {
  const environment = customEnv?.trim();
  if (!environment) {
    throw new AutomationTokenError(
      "AI_AUTOMATION_TOKEN_ENVIRONMENT_NOT_CONFIGURED",
      "自动化令牌运行环境尚未配置",
    );
  }
  return environment;
}

async function deriveCryptoKey(secret: string): Promise<CryptoKey> {
  const keyBytes = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function buildAad(envName: string, keyId: string): Uint8Array {
  return encoder.encode(`mijia-web-console:${envName}:ai-home-automation:1:${keyId}`);
}

export async function sealAutomationToken(
  payload: AutomationTokenPayload,
  options?: SealTokenOptions,
): Promise<string> {
  const secret = resolveSecret(options?.secret);
  const keyId = resolveKeyId(options?.keyId);
  const envName = resolveEnv(options?.env);

  const cryptoKey = await deriveCryptoKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = buildAad(envName, keyId);
  const plaintext = encoder.encode(JSON.stringify(payload));

  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource, additionalData: aad as BufferSource },
    cryptoKey,
    plaintext as BufferSource,
  );

  const encryptedBytes = new Uint8Array(encryptedBuffer);
  const authTagLength = 16;
  if (encryptedBytes.length < authTagLength) {
    throw new AutomationTokenError("AUTOMATION_TOKEN_INVALID", "加密产物异常");
  }

  const ciphertext = encryptedBytes.slice(0, encryptedBytes.length - authTagLength);
  const authTag = encryptedBytes.slice(encryptedBytes.length - authTagLength);

  const ivStr = bytesToBase64Url(iv);
  const ctStr = bytesToBase64Url(ciphertext);
  const tagStr = bytesToBase64Url(authTag);

  return `${TOKEN_PREFIX}.${keyId}.${ivStr}.${ctStr}.${tagStr}`;
}

export async function openAutomationToken(
  token: string,
  options?: OpenTokenOptions,
): Promise<AutomationTokenPayload> {
  if (!token || typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) {
    throw new AutomationTokenError("AUTOMATION_TOKEN_INVALID", "自动化凭据格式错误");
  }

  const parts = token.split(".");
  if (parts.length !== 5) {
    throw new AutomationTokenError("AUTOMATION_TOKEN_INVALID", "自动化凭据格式错误");
  }

  const [prefix, keyId, ivStr, ctStr, tagStr] = parts;
  if (prefix !== TOKEN_PREFIX || !keyId || !ivStr || !ctStr || !tagStr) {
    throw new AutomationTokenError("AUTOMATION_TOKEN_INVALID", "自动化凭据段结构错误");
  }

  const expectedKeyId = options?.expectedKeyId;
  if (expectedKeyId && keyId !== expectedKeyId) {
    throw new AutomationTokenError("AUTOMATION_TOKEN_INVALID", "自动化凭据密钥标识不匹配");
  }

  const secret = resolveSecret(options?.secret);
  const envName = resolveEnv(options?.env);

  let iv: Uint8Array;
  let ciphertext: Uint8Array;
  let authTag: Uint8Array;
  try {
    iv = base64UrlToBytes(ivStr);
    ciphertext = base64UrlToBytes(ctStr);
    authTag = base64UrlToBytes(tagStr);
  } catch {
    throw new AutomationTokenError("AUTOMATION_TOKEN_INVALID", "自动化凭据编码错误");
  }

  if (iv.length !== 12 || authTag.length !== 16) {
    throw new AutomationTokenError("AUTOMATION_TOKEN_INVALID", "自动化凭据组件长度错误");
  }

  const combined = new Uint8Array(ciphertext.length + authTag.length);
  combined.set(ciphertext, 0);
  combined.set(authTag, ciphertext.length);

  const cryptoKey = await deriveCryptoKey(secret);
  const aad = buildAad(envName, keyId);

  let decryptedBuffer: ArrayBuffer;
  try {
    decryptedBuffer = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource, additionalData: aad as BufferSource },
      cryptoKey,
      combined as BufferSource,
    );
  } catch {
    throw new AutomationTokenError("AUTOMATION_TOKEN_INVALID", "自动化凭据校验失败");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(decryptedBuffer));
  } catch {
    throw new AutomationTokenError("AUTOMATION_TOKEN_INVALID", "载荷序列化解析失败");
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new AutomationTokenError("AUTOMATION_TOKEN_INVALID", "载荷结构非法");
  }

  const payload = parsed as Partial<AutomationTokenPayload>;
  if (
    payload.version !== 1 ||
    payload.purpose !== "ai-home-automation" ||
    typeof payload.principalId !== "string" ||
    !payload.principalId ||
    typeof payload.region !== "string" ||
    typeof payload.issuedAt !== "number" ||
    typeof payload.expiresAt !== "number" ||
    (payload.audience !== undefined && payload.audience !== "mijia-agent") ||
    typeof payload.xiaomiSession !== "object" ||
    payload.xiaomiSession === null ||
    typeof payload.xiaomiSession.userId !== "string" ||
    typeof payload.xiaomiSession.ssecurity !== "string" ||
    typeof payload.xiaomiSession.serviceToken !== "string"
  ) {
    throw new AutomationTokenError("AUTOMATION_TOKEN_INVALID", "载荷字段缺失或无效");
  }

  const now = options?.now ?? Date.now();
  if (payload.expiresAt <= now) {
    throw new AutomationTokenError("AUTOMATION_TOKEN_EXPIRED", "自动化凭据已过期，请重新生成");
  }

  if (payload.issuedAt > now + 5 * 60 * 1000) {
    throw new AutomationTokenError("AUTOMATION_TOKEN_INVALID", "自动化凭据签发时间不合理");
  }

  return payload as AutomationTokenPayload;
}
