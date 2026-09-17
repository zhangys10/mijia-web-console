export type ConversationHandleEnvironment = Record<string, string | undefined>;

export const MAKERS_CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_.-]{6,36}$/;

const CONVERSATION_PREFIX = "cv1_";
const NONCE_LENGTH = 8;
const TAG_LENGTH = 12;
const encoder = new TextEncoder();

export class ConversationHandleError extends Error {
  readonly code: "AI_CONVERSATION_SECRET_NOT_CONFIGURED" | "AI_CONVERSATION_HANDLE_INVALID";

  constructor(code: ConversationHandleError["code"], message: string) {
    super(message);
    this.name = "ConversationHandleError";
    this.code = code;
  }
}

function bytesToBase64Url(bytes: Uint8Array) {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64url");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string) {
  try {
    if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(value, "base64url"));
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function resolveSecret(env: ConversationHandleEnvironment) {
  const secret = env.AI_PRINCIPAL_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new ConversationHandleError(
      "AI_CONVERSATION_SECRET_NOT_CONFIGURED",
      "会话签发 Secret 尚未配置",
    );
  }
  return secret;
}

async function conversationTag(
  secret: string,
  principalId: string,
  homeId: string,
  nonce: Uint8Array,
) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(
      `ai-web-conversation:v1:${principalId}:${homeId}:${bytesToBase64Url(nonce)}`,
    ),
  );
  return new Uint8Array(signature).slice(0, TAG_LENGTH);
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function decodeHandle(value: string) {
  if (!MAKERS_CONVERSATION_ID_PATTERN.test(value) || !value.startsWith(CONVERSATION_PREFIX)) {
    return null;
  }
  const payload = base64UrlToBytes(value.slice(CONVERSATION_PREFIX.length));
  if (!payload || payload.length !== NONCE_LENGTH + TAG_LENGTH) return null;
  return {
    nonce: payload.slice(0, NONCE_LENGTH),
    tag: payload.slice(NONCE_LENGTH),
  };
}

export async function createConversationHandle(
  principalId: string,
  homeId: string,
  env: ConversationHandleEnvironment,
  randomBytes: (length: number) => Uint8Array = (length) => crypto.getRandomValues(new Uint8Array(length)),
) {
  const secret = resolveSecret(env);
  const nonce = randomBytes(NONCE_LENGTH);
  if (!(nonce instanceof Uint8Array) || nonce.length !== NONCE_LENGTH) {
    throw new ConversationHandleError("AI_CONVERSATION_HANDLE_INVALID", "会话随机数生成失败");
  }
  const tag = await conversationTag(secret, principalId, homeId, nonce);
  const payload = new Uint8Array(NONCE_LENGTH + TAG_LENGTH);
  payload.set(nonce);
  payload.set(tag, NONCE_LENGTH);
  const handle = `${CONVERSATION_PREFIX}${bytesToBase64Url(payload)}`;
  if (!MAKERS_CONVERSATION_ID_PATTERN.test(handle)) {
    throw new ConversationHandleError("AI_CONVERSATION_HANDLE_INVALID", "会话句柄生成失败");
  }
  return handle;
}

export async function verifyConversationHandle(
  value: string,
  principalId: string,
  homeId: string,
  env: ConversationHandleEnvironment,
) {
  const decoded = decodeHandle(value);
  if (!decoded) return false;
  const expected = await conversationTag(resolveSecret(env), principalId, homeId, decoded.nonce);
  return timingSafeEqual(decoded.tag, expected);
}

export async function resolveConversationHomeId(
  value: string,
  principalId: string,
  homeIds: readonly string[],
  env: ConversationHandleEnvironment,
) {
  for (const homeId of homeIds) {
    if (await verifyConversationHandle(value, principalId, homeId, env)) return homeId;
  }
  return null;
}
