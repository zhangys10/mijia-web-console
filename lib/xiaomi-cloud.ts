const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const REGIONS = new Set(["cn", "sg", "de", "us", "ru", "i2", "in"]);
const USER_AGENT = "mijiawebconsole-ABCDABCDEABCD APP/com.xiaomi.mihome APPV/10.5.201";

export type XiaomiSession = {
  userId: string;
  ssecurity: string;
  serviceToken: string;
  region: string;
  createdAt: number;
};

export type XiaomiQrState = {
  pollUrl: string;
  imageUrl: string;
  loginUrl: string;
  region: string;
  cookieHeader: string;
  createdAt: number;
};

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function joinBytes(...parts: Uint8Array[]) {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

async function digest(algorithm: "SHA-1" | "SHA-256", data: Uint8Array) {
  return new Uint8Array(await crypto.subtle.digest(algorithm, data as BufferSource));
}

async function sessionKey() {
  const secret = process.env.XIAOMI_SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET_NOT_CONFIGURED");
  const keyBytes = await digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", keyBytes as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(value: XiaomiQrState | XiaomiSession) {
  const key = await sessionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = encoder.encode(JSON.stringify(value));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data));
  return `${bytesToBase64(iv)}.${bytesToBase64(encrypted)}`;
}

export async function unseal<T extends XiaomiQrState | XiaomiSession>(value: string): Promise<T> {
  const [iv, payload] = value.split(".");
  if (!iv || !payload) throw new Error("INVALID_SESSION");
  const key = await sessionKey();
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(iv) }, key, base64ToBytes(payload));
  return JSON.parse(decoder.decode(plain)) as T;
}

function parseXiaomiJson(text: string) {
  return JSON.parse(text.replace(/^&&&START&&&/, ""));
}

function cookiePairs(response: Response) {
  const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const values = typeof getSetCookie === "function" ? getSetCookie.call(response.headers) : [response.headers.get("set-cookie") ?? ""];
  return values.flatMap((value) => value.split(/,(?=\s*[a-zA-Z_][a-zA-Z0-9_]*=)/)).map((part) => part.split(";")[0].trim()).filter(Boolean);
}

function mergeCookies(existing: string, additions: string[]) {
  const merged = new Map<string, string>();
  for (const item of [...existing.split(/;\s*/), ...additions]) {
    const split = item.indexOf("=");
    if (split > 0) merged.set(item.slice(0, split), item.slice(split + 1));
  }
  return [...merged.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function randomDeviceId() {
  return [...crypto.getRandomValues(new Uint8Array(6))].map((byte) => String.fromCharCode(97 + byte % 26)).join("");
}

export async function startQrLogin(region: string): Promise<XiaomiQrState> {
  if (!REGIONS.has(region)) throw new Error("INVALID_REGION");
  const url = new URL("https://account.xiaomi.com/longPolling/loginUrl");
  for (const [key, value] of Object.entries({ _qrsize: "480", qs: "%3Fsid%3Dxiaomiio%26_json%3Dtrue", callback: "https://sts.api.io.mi.com/sts", _hasLogo: "false", sid: "xiaomiio", serviceParam: "", _locale: "zh_CN", _dc: String(Date.now()) })) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT, Cookie: `sdkVersion=accountsdk-18.8.15; deviceId=${randomDeviceId()}` }, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`XIAOMI_LOGIN_HTTP_${response.status}`);
  const result = parseXiaomiJson(await response.text());
  if (!result.qr || !result.lp || !result.loginUrl) throw new Error("XIAOMI_QR_UNAVAILABLE");
  return { pollUrl: result.lp, imageUrl: result.qr, loginUrl: result.loginUrl, region, cookieHeader: mergeCookies("", cookiePairs(response)), createdAt: Date.now() };
}

export async function loadQrImage(state: XiaomiQrState) {
  const response = await fetch(state.imageUrl, { headers: { "User-Agent": USER_AGENT, Cookie: state.cookieHeader }, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`XIAOMI_QR_IMAGE_HTTP_${response.status}`);
  return { data: await response.arrayBuffer(), contentType: response.headers.get("content-type") || "image/png" };
}

export async function pollQrLogin(state: XiaomiQrState): Promise<{ pending: true } | { pending: false; session: XiaomiSession }> {
  if (Date.now() - state.createdAt > 5 * 60 * 1000) throw new Error("XIAOMI_QR_EXPIRED");
  let response: Response;
  try { response = await fetch(state.pollUrl, { headers: { "User-Agent": USER_AGENT, Cookie: state.cookieHeader }, signal: AbortSignal.timeout(8000) }); }
  catch (error) { if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return { pending: true }; throw error; }
  if (response.status === 408 || response.status === 504) return { pending: true };
  if (!response.ok) throw new Error(`XIAOMI_POLL_HTTP_${response.status}`);
  const result = parseXiaomiJson(await response.text());
  if (!result.ssecurity || !result.userId || !result.location) return { pending: true };
  let cookies = mergeCookies(state.cookieHeader, cookiePairs(response));
  let current = String(result.location);
  let token = "";
  for (let hop = 0; hop < 6; hop++) {
    const hopResponse = await fetch(current, { headers: { "User-Agent": USER_AGENT, Cookie: cookies }, redirect: "manual", signal: AbortSignal.timeout(12000) });
    cookies = mergeCookies(cookies, cookiePairs(hopResponse));
    const tokenMatch = cookies.match(/(?:^|;\s*)serviceToken=([^;]+)/);
    if (tokenMatch) { token = decodeURIComponent(tokenMatch[1]); break; }
    const location = hopResponse.headers.get("location");
    if (!location) break;
    current = new URL(location, current).toString();
  }
  if (!token) throw new Error("XIAOMI_SERVICE_TOKEN_MISSING");
  return { pending: false, session: { userId: String(result.userId), ssecurity: String(result.ssecurity), serviceToken: token, region: state.region, createdAt: Date.now() } };
}

function nonce() {
  const random = crypto.getRandomValues(new Uint8Array(8));
  const timestamp = new Uint8Array(4);
  new DataView(timestamp.buffer).setUint32(0, Math.floor(Date.now() / 60000), false);
  return bytesToBase64(joinBytes(random, timestamp));
}

async function signedNonce(ssecurity: string, value: string) {
  return bytesToBase64(await digest("SHA-256", joinBytes(base64ToBytes(ssecurity), base64ToBytes(value))));
}

function rc4(key: Uint8Array, payload: Uint8Array) {
  const table = Uint8Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i++) { j = (j + table[i] + key[i % key.length]) & 255; [table[i], table[j]] = [table[j], table[i]]; }
  let i = 0; j = 0;
  const output = new Uint8Array(payload.length);
  for (let index = -1024; index < payload.length; index++) { i = (i + 1) & 255; j = (j + table[i]) & 255; [table[i], table[j]] = [table[j], table[i]]; const value = table[(table[i] + table[j]) & 255]; if (index >= 0) output[index] = payload[index] ^ value; }
  return output;
}

function encryptRc4(key: string, payload: string) { return bytesToBase64(rc4(base64ToBytes(key), encoder.encode(payload))); }
function decryptRc4(key: string, payload: string) { return decoder.decode(rc4(base64ToBytes(key), base64ToBytes(payload))); }

async function encSignature(path: string, signed: string, params: Record<string, string>) {
  const canonicalPath = path.replace(/^\/app\//, "/");
  const source = ["POST", canonicalPath, ...Object.entries(params).map(([name, value]) => `${name}=${value}`), signed].join("&");
  return bytesToBase64(await digest("SHA-1", encoder.encode(source)));
}

export async function xiaomiRequest(session: XiaomiSession, path: string, data: Record<string, unknown>) {
  const region = session.region === "cn" ? "" : `${session.region}.`;
  const base = `https://${region}api.io.mi.com`;
  const nonceValue = nonce();
  const signed = await signedNonce(session.ssecurity, nonceValue);
  const plain: Record<string, string> = { data: JSON.stringify(data) };
  plain.rc4_hash__ = await encSignature(path, signed, plain);
  const encrypted: Record<string, string> = {};
  for (const [name, value] of Object.entries(plain)) encrypted[name] = encryptRc4(signed, value);
  const signature = await encSignature(path, signed, encrypted);
  const fields = new URLSearchParams({ ...encrypted, signature, ssecurity: session.ssecurity, _nonce: nonceValue });
  let response: Response;
  try {
    response = await fetch(`${base}${path}?${fields.toString()}`, { method: "POST", headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded", "Accept-Encoding": "identity", "x-xiaomi-protocal-flag-cli": "PROTOCAL-HTTP2", "MIOT-ENCRYPT-ALGORITHM": "ENCRYPT-RC4", Cookie: `userId=${session.userId}; serviceToken=${session.serviceToken}; yetAnotherServiceToken=${session.serviceToken}; locale=zh_CN; timezone=GMT%2B08%3A00; is_daylight=0; dst_offset=0; channel=MI_APP_STORE` }, signal: AbortSignal.timeout(9000) });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) throw new Error("XIAOMI_CLOUD_TIMEOUT");
    throw error;
  }
  if (!response.ok) throw new Error(`XIAOMI_CLOUD_HTTP_${response.status}`);
  const text = await response.text();
  let result: Record<string, unknown>;
  try { result = JSON.parse(decryptRc4(signed, text)); } catch { try { result = JSON.parse(text); } catch { throw new Error("XIAOMI_CLOUD_RESPONSE_INVALID"); } }
  if (typeof result.code === "number" && result.code !== 0) throw new Error(`XIAOMI_CLOUD_CODE_${result.code}`);
  return result;
}

async function signedXiaomiRequest(session: XiaomiSession, path: string, data: Record<string, unknown>) {
  const region = session.region === "cn" ? "" : `${session.region}.`;
  const nonceValue = nonce();
  const signed = await signedNonce(session.ssecurity, nonceValue);
  const payload = JSON.stringify(data);
  const canonicalPath = path.replace(/^\/app\//, "/");
  const source = `${canonicalPath}&${signed}&${nonceValue}&data=${payload}`;
  const key = await crypto.subtle.importKey("raw", base64ToBytes(signed) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = bytesToBase64(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(source))));
  let response: Response;
  try {
    response = await fetch(`https://${region}api.io.mi.com${path}`, {
      method: "POST",
      headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded", Cookie: `userId=${session.userId}; serviceToken=${session.serviceToken}; locale=zh_CN; timezone=GMT%2B08%3A00` },
      body: new URLSearchParams({ data: payload, _nonce: nonceValue, signature }),
      signal: AbortSignal.timeout(9000),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) throw new Error("XIAOMI_CLOUD_TIMEOUT");
    throw error;
  }
  if (!response.ok) throw new Error(`XIAOMI_CLOUD_HTTP_${response.status}`);
  const result = parseXiaomiJson(await response.text()) as Record<string, unknown>;
  if (typeof result.code === "number" && result.code !== 0) throw new Error(`XIAOMI_CLOUD_CODE_${result.code}`);
  return result;
}

export async function listDevices(session: XiaomiSession) {
  let firstError: Error | undefined;
  try {
    const homesResponse = await xiaomiRequest(session, "/app/v2/homeroom/gethome", { fg: true, fetch_share: true, fetch_share_dev: true, limit: 300, app_ver: 7 });
    const result = homesResponse.result as Record<string, unknown> | undefined;
    const homes = (result?.homelist ?? result?.list ?? []) as Array<Record<string, unknown>>;
    if (homes.length > 0) {
      const devices: Array<Record<string, unknown>> = [];
      for (const home of homes.slice(0, 10)) {
        const response = await xiaomiRequest(session, "/app/v2/home/home_device_list", { home_owner: home.home_owner, home_id: home.home_id, limit: 200, get_split_device: true, support_smart_home: true });
        const payload = response.result as Record<string, unknown> | undefined;
        const entries = (payload?.device_info ?? payload?.list ?? []) as Array<Record<string, unknown>>;
        for (const device of entries) devices.push({ ...device, homeName: home.name ?? home.home_name ?? "我的家", roomName: device.room_name ?? "未分配" });
      }
      return { homes: homes.map((home) => ({ id: home.home_id, name: home.name ?? home.home_name ?? "我的家" })), devices };
    }
  } catch (error) {
    firstError = error instanceof Error ? error : new Error("XIAOMI_DEVICE_SYNC_FAILED");
  }

  const path = "/app/home/device_list";
  const payload = { getVirtualModel: false, getHuamiDevices: 0, get_split_device: true, support_smart_home: true };
  let response: Record<string, unknown>;
  try {
    response = await xiaomiRequest(session, path, payload);
  } catch (encryptedError) {
    try {
      response = await signedXiaomiRequest(session, path, payload);
    } catch (signedError) {
      const finalError = signedError instanceof Error ? signedError : firstError;
      console.error("[xiaomi-cloud-sync]", JSON.stringify({ region: session.region, primaryError: firstError?.message, legacyEncryptedError: encryptedError instanceof Error ? encryptedError.message : "UNKNOWN_ERROR", legacySignedError: finalError?.message }));
      throw finalError ?? firstError ?? new Error("XIAOMI_DEVICE_SYNC_FAILED");
    }
  }
  const result = response.result as Record<string, unknown> | Array<Record<string, unknown>> | undefined;
  const entries = Array.isArray(result) ? result : ((result?.list ?? result?.device_info ?? []) as Array<Record<string, unknown>>);
  const devices: Array<Record<string, unknown>> = entries.map((device) => ({ ...device, homeName: device.home_name ?? "我的家", roomName: device.room_name ?? "未分配" }));
  return { homes: [], devices };
}
