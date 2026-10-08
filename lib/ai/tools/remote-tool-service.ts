import { listDevices, listHomes, type XiaomiSession } from "../../xiaomi-cloud.ts";
import { isPreviewEnvironment } from "../config.ts";
import { verifyAgentBinding, type AgentScope } from "../security/agent-binding.ts";
import { derivePrincipalId } from "../security/principal.ts";
import { AUTOMATION_TOKEN_REALM, AutomationTokenError, openAutomationToken } from "../security/automation-token.ts";
import { collectHomeEnvironment } from "../../home-environment.ts";
import { collectDeviceStatus } from "../../device-status.ts";
import { loadAgentScenes, sceneSummaries, type AgentSceneRecord } from "./agent-scene-catalog.ts";
import { runManualScene } from "../../xiaomi-scenes.ts";
import { AssistantExposureError, isSceneExposed, readAssistantExposure, type AssistantExposureStore } from "./assistant-exposure.ts";
import { claimAction, claimSceneAction, recordActionOutcome, recordSceneActionOutcome, type SceneActionLedgerStore } from "./scene-action-ledger.ts";
import { loadDeviceOperationCatalog, publicDeviceCatalog, setDeviceProperty, validateDeviceOperationValue } from "./device-operation-catalog.ts";

type Environment = Record<string, string | undefined>;
type Dependencies = {
  homes?: typeof listHomes;
  scenes?: (input: { principalId: string; homeId: string; session: XiaomiSession }) => Promise<AgentSceneRecord[]>;
  homeStatus?: (input: { session: XiaomiSession; homeId: string }) => Promise<ReturnType<typeof collectHomeEnvironment>>;
  deviceStatus?: (input: { session: XiaomiSession; homeId: string }) => Promise<ReturnType<typeof collectDeviceStatus>>;
  runScene?: typeof runManualScene;
  exposureStore?: AssistantExposureStore;
  actionLedgerStore?: SceneActionLedgerStore;
  discovery?: typeof listDevices;
  setProperty?: typeof setDeviceProperty;
  deviceCatalog?: typeof loadDeviceOperationCatalog;
};

type SceneActionAuthorization = {
  version: 1;
  principalId: string;
  homeId: string;
  sceneAlias: string;
  revision: string;
  idempotencyKey: string;
  requestHash: string;
  expiresAt: number;
};

export class RemoteToolError extends Error {
  readonly status: number;
  constructor(code: string, status: number) { super(code); this.status = status; }
}

const defaultHomeStatusCollector = (input: { session: XiaomiSession; homeId: string }) =>
  collectHomeEnvironment(input.session, input.homeId);
const defaultDeviceStatusCollector = (input: { session: XiaomiSession; homeId: string }) =>
  collectDeviceStatus(input.session, input.homeId);

const MAX_AUTOMATION_TOKEN_LENGTH = 8192;

async function currentExposure(homeId: string, store?: AssistantExposureStore, env?: Environment) {
  try { return await readAssistantExposure(homeId, store, env); }
  catch (error) {
    if (error instanceof AssistantExposureError) throw new RemoteToolError(error.code, error.status);
    throw new RemoteToolError("AI_EXPOSURE_STORE_UNAVAILABLE", 503);
  }
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function fromBase64Url(value: string) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function issueSceneActionAuthorization(payload: Omit<SceneActionAuthorization, "version" | "expiresAt">, secret: string | undefined) {
  if (!secret || secret.length < 32) throw new RemoteToolError("AI_AGENT_UNAVAILABLE", 502);
  const ticket: SceneActionAuthorization = { version: 1, ...payload, expiresAt: Date.now() + 60_000 };
  const encoded = base64Url(new TextEncoder().encode(JSON.stringify(ticket)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encoded)));
  return `${encoded}.${base64Url(signature)}`;
}

async function verifySceneActionAuthorization(
  value: unknown,
  expected: Omit<SceneActionAuthorization, "version" | "expiresAt">,
  secret: string | undefined,
) {
  if (typeof value !== "string" || value.length > 2048 || !secret || secret.length < 32) return false;
  const [encoded, signature, extra] = value.split(".");
  if (!encoded || !signature || extra !== undefined) return false;
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    if (!await crypto.subtle.verify("HMAC", key, fromBase64Url(signature), new TextEncoder().encode(encoded))) return false;
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(encoded))) as Record<string, unknown>;
    return payload.version === 1
      && typeof payload.expiresAt === "number"
      && payload.expiresAt > Date.now()
      && payload.principalId === expected.principalId
      && payload.homeId === expected.homeId
      && payload.sceneAlias === expected.sceneAlias
      && payload.revision === expected.revision
      && payload.idempotencyKey === expected.idempotencyKey
      && payload.requestHash === expected.requestHash;
  } catch {
    return false;
  }
}

async function executeApprovedScene(input: {
  principalId: string;
  homeId: string;
  session: XiaomiSession;
  scene: AgentSceneRecord;
  idempotencyKey: string;
  requestHash: string;
  actionAuthorization: unknown;
  env: Environment;
  dependencies: Dependencies;
}) {
  if (isPreviewEnvironment(input.env)) throw new RemoteToolError("AI_PREVIEW_READ_ONLY", 403);
  if (input.env.AI_SCENE_EXECUTION_ENABLED !== "true") throw new RemoteToolError("AI_SCENE_EXECUTION_DISABLED", 403);
  const exposure = await currentExposure(input.homeId, input.dependencies.exposureStore, input.env);
  if (!isSceneExposed(exposure, input.scene)) throw new RemoteToolError("AI_SCENE_NOT_EXPOSED", 403);
  if (!await verifySceneActionAuthorization(input.actionAuthorization, {
    principalId: input.principalId,
    homeId: input.homeId,
    sceneAlias: input.scene.alias,
    revision: input.scene.revision,
    idempotencyKey: input.idempotencyKey,
    requestHash: input.requestHash,
  }, input.env.AI_ACTION_AUTHORIZATION_SECRET ?? input.env.AI_SCENE_ACTION_AUTHORIZATION_SECRET)) throw new RemoteToolError("AI_SCOPE_FORBIDDEN", 403);
  const requestHashBytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify({ requestHash: input.requestHash, homeId: input.homeId, sceneId: input.scene.sceneId, revision: input.scene.revision })),
  );
  const requestHash = Array.from(new Uint8Array(requestHashBytes), byte => byte.toString(16).padStart(2, "0")).join("");
  const claim = await claimSceneAction({
    principalId: input.principalId,
    homeId: input.homeId,
    idempotencyKey: input.idempotencyKey,
    requestHash,
    sceneRevision: input.scene.revision,
  }, input.dependencies.actionLedgerStore);
  if (claim.kind === "conflict") throw new RemoteToolError("AI_IDEMPOTENCY_CONFLICT", 409);
  if (claim.kind === "unknown") throw new RemoteToolError("AI_EXECUTION_STATUS_UNKNOWN", 409);
  if (claim.kind === "replay") {
    if (claim.outcome.status === "outcome_unknown") throw new RemoteToolError("AI_EXECUTION_STATUS_UNKNOWN", 409);
    return { status: "success", succeeded: 1, failed: 0, message: "场景执行请求已提交，设备状态尚未回读。" };
  }
  try {
    await (input.dependencies.runScene ?? runManualScene)(input.session, input.scene.sceneId);
    await recordSceneActionOutcome(claim, "success", input.dependencies.actionLedgerStore);
    return { status: "success", succeeded: 1, failed: 0, message: "场景执行请求已提交，设备状态尚未回读。" };
  } catch {
    try { await recordSceneActionOutcome(claim, "outcome_unknown", input.dependencies.actionLedgerStore); }
    catch { /* Keep the user-facing outcome uncertain even if the receipt store failed. */ }
    throw new RemoteToolError("AI_EXECUTION_STATUS_UNKNOWN", 409);
  }
}

async function executeApprovedDeviceProperty(input: {
  principalId: string;
  homeId: string;
  session: XiaomiSession;
  grant: NonNullable<import("../security/automation-token.ts").AutomationTokenPayload["actionGrant"]>;
  env: Environment;
  dependencies: Dependencies;
}) {
  if (isPreviewEnvironment(input.env)) throw new RemoteToolError("AI_PREVIEW_READ_ONLY", 403);
  if (input.env.AI_DEVICE_EXECUTION_ENABLED !== "true") throw new RemoteToolError("AI_DEVICE_EXECUTION_DISABLED", 403);
  const exposure = await currentExposure(input.homeId, input.dependencies.exposureStore, input.env);
  if (!exposure.enabled || !exposure.deviceActionsEnabled) throw new RemoteToolError("AI_DEVICE_NOT_EXPOSED", 403);
  const discovery = await (input.dependencies.discovery ?? listDevices)(input.session);
  const catalog = await (input.dependencies.deviceCatalog ?? loadDeviceOperationCatalog)(discovery, input.homeId, exposure.deviceDids);
  const device = catalog.find(item => item.deviceId === input.grant.deviceId);
  const operation = device?.operations.find(item => item.operationId === input.grant.operationId);
  if (!device || !operation) throw new RemoteToolError("AI_DEVICE_NOT_EXPOSED", 403);
  if (!device.online) throw new RemoteToolError("AI_DEVICE_OFFLINE", 409);
  if (operation.revision !== input.grant.revision) throw new RemoteToolError("AI_DEVICE_REVISION_CHANGED", 409);
  if (!validateDeviceOperationValue(operation, input.grant.value)) throw new RemoteToolError("AI_INVALID_REQUEST", 400);
  const requestHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({
    kind: "device_property", messageHash: input.grant.messageHash, deviceId: device.deviceId,
    operationId: operation.operationId, revision: operation.revision, value: input.grant.value,
  }))).then(bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join(""));
  const claim = await claimAction({ principalId: input.principalId, homeId: input.homeId,
    idempotencyKey: input.grant.idempotencyKey, requestHash, actionRevision: operation.revision }, input.dependencies.actionLedgerStore);
  if (claim.kind === "conflict") throw new RemoteToolError("AI_IDEMPOTENCY_CONFLICT", 409);
  if (claim.kind === "unknown") throw new RemoteToolError("AI_EXECUTION_STATUS_UNKNOWN", 409);
  if (claim.kind === "replay") {
    if (claim.outcome.status === "outcome_unknown") throw new RemoteToolError("AI_EXECUTION_STATUS_UNKNOWN", 409);
    if (claim.outcome.status === "failed") throw new RemoteToolError("AI_DEVICE_OPERATION_FAILED", 502);
    return { status: "success", message: `${device.name} 的操作请求已提交，设备状态尚未回读。` };
  }
  try {
    await (input.dependencies.setProperty ?? setDeviceProperty)(input.session, device, operation, input.grant.value);
    await recordActionOutcome(claim, "success", input.dependencies.actionLedgerStore);
    return { status: "success", message: `${device.name} 的操作请求已提交，设备状态尚未回读。` };
  } catch (error) {
    if (error instanceof Error && /^XIAOMI_PROPERTY_CODE_/.test(error.message)) {
      try { await recordActionOutcome(claim, "failed", input.dependencies.actionLedgerStore); }
      catch { throw new RemoteToolError("AI_EXECUTION_STATUS_UNKNOWN", 409); }
      throw new RemoteToolError("AI_DEVICE_OPERATION_FAILED", 502);
    }
    try { await recordActionOutcome(claim, "outcome_unknown", input.dependencies.actionLedgerStore); } catch { /* unknown remains unknown */ }
    throw new RemoteToolError("AI_EXECUTION_STATUS_UNKNOWN", 409);
  }
}

async function authorizeSceneAction(input: {
  principalId: string;
  homeId: string;
  session: XiaomiSession;
  args: Record<string, unknown>;
  idempotencyKey: string;
  requestHash: string;
  env: Environment;
  dependencies: Dependencies;
}) {
  if (input.env.AI_SCENE_EXECUTION_ENABLED !== "true") throw new RemoteToolError("AI_SCENE_EXECUTION_DISABLED", 403);
  if (isPreviewEnvironment(input.env)) throw new RemoteToolError("AI_PREVIEW_READ_ONLY", 403);
  const sceneId = input.args.sceneId;
  const revision = input.args.revision;
  if (
    Object.keys(input.args).length !== 2
    || typeof sceneId !== "string"
    || !/^scene_[a-f0-9]{16}$/.test(sceneId)
    || typeof revision !== "string"
    || !/^rev_[a-f0-9]{24}$/.test(revision)
  ) throw new RemoteToolError("AI_INVALID_REQUEST", 400);
  const scenes = await (input.dependencies.scenes ?? loadAgentScenes)({
    principalId: input.principalId,
    homeId: input.homeId,
    session: input.session,
  });
  const scene = scenes.find(item => item.alias === sceneId);
  if (!scene || scene.revision !== revision) throw new RemoteToolError("AI_SCENE_REVISION_CHANGED", 409);
  const exposure = await currentExposure(input.homeId, input.dependencies.exposureStore, input.env);
  if (!isSceneExposed(exposure, scene)) {
    throw new RemoteToolError("AI_SCENE_NOT_EXPOSED", 403);
  }
  const actionAuthorization = await issueSceneActionAuthorization({
    principalId: input.principalId,
    homeId: input.homeId,
    sceneAlias: scene.alias,
    revision: scene.revision,
    idempotencyKey: input.idempotencyKey,
    requestHash: input.requestHash,
  }, input.env.AI_ACTION_AUTHORIZATION_SECRET ?? input.env.AI_SCENE_ACTION_AUTHORIZATION_SECRET);
  return { actionAuthorization };
}

export async function runRemoteTool(body: unknown, env: Environment, dependencies: Dependencies = {}, userToken?: string) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new RemoteToolError("AI_INVALID_REQUEST", 400);
  const input = body as Record<string, unknown>;
  if (userToken) return runUserTokenTool(input, userToken, env, dependencies);
  const allowed = new Set(["requestId", "principalId", "homeId", "scopes", "sessionBinding", "idempotencyKey", "requestHash", "actionAuthorization", "tool", "arguments"]);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new RemoteToolError("AI_INVALID_REQUEST", 400);
  for (const key of ["requestId", "principalId", "homeId", "sessionBinding", "tool"]) {
    if (typeof input[key] !== "string" || !input[key] || (input[key] as string).length > (key === "sessionBinding" ? 16384 : 128)) throw new RemoteToolError("AI_INVALID_REQUEST", 400);
  }
  if (!Array.isArray(input.scopes) || !input.scopes.includes("ai:chat") || input.scopes.some(scope => scope !== "ai:chat" && scope !== "scene:activate" && scope !== "device:operate")) throw new RemoteToolError("AI_SCOPE_FORBIDDEN", 403);
  const scopes = input.scopes as AgentScope[];
  const principalId = input.principalId as string;
  const homeId = input.homeId as string;
  const idempotencyKey = input.idempotencyKey;
  const requestHash = input.requestHash;
  const actionAuthorization = input.actionAuthorization;
  if (
    idempotencyKey !== undefined
    && (
      typeof idempotencyKey !== "string"
      || idempotencyKey.length < 16
      || idempotencyKey.length > 128
    )
  ) {
    throw new RemoteToolError("AI_INVALID_REQUEST", 400);
  }
  if (requestHash !== undefined && (typeof requestHash !== "string" || !/^[a-f0-9]{64}$/.test(requestHash))) throw new RemoteToolError("AI_INVALID_REQUEST", 400);
  let binding;
  try {
    binding = await verifyAgentBinding(input.sessionBinding as string, { principalId, homeId, scopes }, env.XIAOMI_SESSION_SECRET);
    if (await derivePrincipalId(binding.session, env) !== principalId) throw new Error("mismatch");
  } catch { throw new RemoteToolError("AI_UNAUTHENTICATED", 401); }
  const homes = await (dependencies.homes ?? listHomes)(binding.session);
  if (!homes.some(home => home.id === homeId)) throw new RemoteToolError("AI_HOME_FORBIDDEN", 403);
  const args = input.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new RemoteToolError("AI_INVALID_REQUEST", 400);
  if (input.tool === "authorize" || input.tool === "list_scenes") {
    if (Object.keys(args).length) throw new RemoteToolError("AI_INVALID_REQUEST", 400);
    if (input.tool === "authorize") return { ok: true };
    const scenes = await (dependencies.scenes ?? loadAgentScenes)({ principalId, homeId, session: binding.session });
    const exposure = await currentExposure(homeId, dependencies.exposureStore, env);
    const exposedScenes = scenes.filter(scene => isSceneExposed(exposure, scene));
    return { scenes: sceneSummaries(exposedScenes) };
  }
  if (input.tool === "list_device_controls") {
    if (Object.keys(args).length) throw new RemoteToolError("AI_INVALID_REQUEST", 400);
    const exposure = await currentExposure(homeId, dependencies.exposureStore, env);
    if (!exposure.enabled || !exposure.deviceActionsEnabled) throw new RemoteToolError("AI_CAPABILITY_UNAVAILABLE", 403);
    const discovery = await (dependencies.discovery ?? listDevices)(binding.session);
    const catalog = await (dependencies.deviceCatalog ?? loadDeviceOperationCatalog)(discovery, homeId, exposure.deviceDids);
    return { devices: publicDeviceCatalog(catalog) };
  }
  if (input.tool === "authorize_scene_action") {
    if (!scopes.includes("scene:activate")) throw new RemoteToolError("AI_SCOPE_FORBIDDEN", 403);
    if (!idempotencyKey || !requestHash || Object.keys(args).length !== 2) throw new RemoteToolError("AI_INVALID_REQUEST", 400);
    return authorizeSceneAction({ principalId, homeId, args: args as Record<string, unknown>, idempotencyKey, requestHash, env, dependencies, session: binding.session });
  }
  if (input.tool === "get_home_status") {
    // Read-only: ai:chat alone suffices, no physical-action scope is involved.
    if (Object.keys(args).length) throw new RemoteToolError("AI_INVALID_REQUEST", 400);
    if (isPreviewEnvironment(env)) throw new RemoteToolError("AI_PREVIEW_READ_ONLY", 403);
    const collector = dependencies.homeStatus ?? defaultHomeStatusCollector;
    return await collector({ session: binding.session, homeId });
  }
  if (input.tool === "get_device_status") {
    // Read-only: ai:chat alone suffices, no physical-action scope is involved.
    if (Object.keys(args).length) throw new RemoteToolError("AI_INVALID_REQUEST", 400);
    if (isPreviewEnvironment(env)) throw new RemoteToolError("AI_PREVIEW_READ_ONLY", 403);
    const collector = dependencies.deviceStatus ?? defaultDeviceStatusCollector;
    return await collector({ session: binding.session, homeId });
  }
  if (input.tool !== "activate_scene") throw new RemoteToolError("AI_INVALID_REQUEST", 400);
  if (!scopes.includes("scene:activate")) throw new RemoteToolError("AI_SCOPE_FORBIDDEN", 403);
  if (!idempotencyKey) throw new RemoteToolError("AI_INVALID_REQUEST", 400);
  if (!requestHash) throw new RemoteToolError("AI_INVALID_REQUEST", 400);
  const sceneId = (args as Record<string, unknown>).sceneId;
  const revision = (args as Record<string, unknown>).revision;
  if (
    Object.keys(args).length !== 2
    || typeof sceneId !== "string"
    || !/^scene_[a-f0-9]{16}$/.test(sceneId)
    || typeof revision !== "string"
    || !/^rev_[a-f0-9]{24}$/.test(revision)
  ) {
    throw new RemoteToolError("AI_INVALID_REQUEST", 400);
  }
  if (isPreviewEnvironment(env)) throw new RemoteToolError("AI_PREVIEW_READ_ONLY", 403);
  const scenes = await (dependencies.scenes ?? loadAgentScenes)({ principalId, homeId, session: binding.session });
  const approvedScene = scenes.find(scene => scene.alias === sceneId);
  if (!approvedScene || approvedScene.revision !== revision) throw new RemoteToolError("AI_SCENE_REVISION_CHANGED", 409);
  return executeApprovedScene({ principalId, homeId, session: binding.session, scene: approvedScene, idempotencyKey, requestHash, actionAuthorization, env, dependencies });
}

/**
 * Automation-token ingress for the canonical assistant pipeline.
 *
 * The token is opaque to the agent: only this console decrypts it, re-derives
 * the principal from the embedded Xiaomi session, and resolves the home the
 * same way the automation ingress does — explicit request home (ID, exact name,
 * then substring), the token-bound home, then the account's first home. The token's
 * provider/model/apiKey fields are deliberately ignored: model access stays
 * with the console-issued gateway. The body carries `home` (name or ID); the
 * binding-only fields are rejected here so the two envelopes cannot be mixed.
 */
async function runUserTokenTool(
  input: Record<string, unknown>,
  userToken: string,
  env: Environment,
  dependencies: Dependencies,
) {
  if (userToken.length > MAX_AUTOMATION_TOKEN_LENGTH) throw new RemoteToolError("AUTOMATION_TOKEN_INVALID", 401);
  const allowed = new Set(["requestId", "home", "tool", "arguments", "idempotencyKey", "requestHash"]);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new RemoteToolError("AI_INVALID_REQUEST", 400);
  for (const key of ["requestId", "tool"]) {
    if (typeof input[key] !== "string" || !input[key] || (input[key] as string).length > 128) throw new RemoteToolError("AI_INVALID_REQUEST", 400);
  }
  if (input.home !== undefined && (typeof input.home !== "string" || !input.home.trim() || input.home.length > 100)) {
    throw new RemoteToolError("AI_INVALID_REQUEST", 400);
  }
  const idempotencyKey = input.idempotencyKey;
  const requestHash = input.requestHash;
  if (
    idempotencyKey !== undefined
    && (
      typeof idempotencyKey !== "string"
      || idempotencyKey.length < 16
      || idempotencyKey.length > 128
    )
  ) {
    throw new RemoteToolError("AI_INVALID_REQUEST", 400);
  }
  if (requestHash !== undefined && (typeof requestHash !== "string" || !/^[a-f0-9]{64}$/.test(requestHash))) throw new RemoteToolError("AI_INVALID_REQUEST", 400);
  let payload;
  try {
    payload = await openAutomationToken(userToken, {
      secret: env.AI_AUTOMATION_TOKEN_SECRET || undefined,
      expectedKeyId: env.AI_AUTOMATION_TOKEN_KEY_ID || undefined,
      env: AUTOMATION_TOKEN_REALM,
    });
  } catch (error) {
    if (error instanceof AutomationTokenError) {
      if (error.code === "AUTOMATION_TOKEN_EXPIRED") throw new RemoteToolError("AUTOMATION_TOKEN_EXPIRED", 401);
      if (error.code === "AI_AUTOMATION_TOKEN_SECRET_NOT_CONFIGURED") throw new RemoteToolError("AI_AUTOMATION_TOKEN_SECRET_NOT_CONFIGURED", 500);
    }
    throw new RemoteToolError("AUTOMATION_TOKEN_INVALID", 401);
  }
  if (payload.audience !== "mijia-agent") throw new RemoteToolError("AUTOMATION_TOKEN_INVALID", 401);
  const principalId = await derivePrincipalId(payload.xiaomiSession, env);
  const homes = await (dependencies.homes ?? listHomes)(payload.xiaomiSession);
  if (!homes.length) throw new RemoteToolError("AI_HOME_NOT_FOUND", 404);
  const homeName = typeof input.home === "string" ? input.home.trim() : "";
  let homeId: string | undefined;
  if (homeName) {
    const matched = homes.find(h => h.id === homeName)
      ?? homes.find(h => h.name === homeName)
      ?? homes.find(h => h.name.includes(homeName) || homeName.includes(h.name));
    if (!matched) throw new RemoteToolError("AI_HOME_NOT_FOUND", 404);
    homeId = matched.id;
  } else if (payload.homeId) {
    // A token-bound home that the account no longer owns fails closed.
    if (!homes.some(h => h.id === payload.homeId)) throw new RemoteToolError("AI_HOME_NOT_FOUND", 404);
    homeId = payload.homeId;
  } else {
    homeId = homes[0].id;
  }
  const args = input.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new RemoteToolError("AI_INVALID_REQUEST", 400);
  const toolArgs = args as Record<string, unknown>;
  const grant = payload.actionGrant;
  const validGrant = !isPreviewEnvironment(env)
    && ((env.AI_ACTION_AUTHORIZATION_SECRET ?? env.AI_SCENE_ACTION_AUTHORIZATION_SECRET)?.length ?? 0) >= 32
    && grant !== undefined && grant !== null
    && grant.requestId === input.requestId
    && typeof grant.expiresAt === "number" && grant.expiresAt > Date.now()
    && grant.expiresAt <= payload.expiresAt
    && typeof grant.messageHash === "string" && /^[a-f0-9]{64}$/.test(grant.messageHash)
    && typeof grant.revision === "string" && /^rev_[a-f0-9]{24}$/.test(grant.revision)
    && typeof grant.idempotencyKey === "string"
    && grant.idempotencyKey.length >= 16 && grant.idempotencyKey.length <= 128
    && payload.homeId === homeId;
  const validSceneGrant = validGrant && (grant?.kind === undefined || grant.kind === "scene")
    && env.AI_SCENE_EXECUTION_ENABLED === "true"
    && typeof grant?.sceneAlias === "string" && /^scene_[a-f0-9]{16}$/.test(grant.sceneAlias);
  const validDeviceGrant = validGrant && grant?.kind === "device_property"
    && env.AI_DEVICE_EXECUTION_ENABLED === "true"
    && typeof grant.deviceId === "string" && /^entity_[a-f0-9]{32}$/.test(grant.deviceId)
    && typeof grant.operationId === "string" && /^op_[a-f0-9]{24}$/.test(grant.operationId)
    && ["boolean", "number", "string"].includes(typeof grant.value);
  if (input.tool === "authorize" || input.tool === "list_scenes") {
    if (Object.keys(args).length) throw new RemoteToolError("AI_INVALID_REQUEST", 400);
    // The Makers adapter compares this server-derived context with its inbound
    // metadata before it can load conversation state or call Python.
    if (input.tool === "authorize") return validSceneGrant
      ? { ok: true, principalId, homeId, scopes: ["ai:chat", "scene:activate"],
        actionMessageHash: grant.messageHash, actionIdempotencyKey: grant.idempotencyKey }
      : validDeviceGrant
        ? { ok: true, principalId, homeId, scopes: ["ai:chat", "device:operate"],
          actionMessageHash: grant.messageHash, actionIdempotencyKey: grant.idempotencyKey }
      : { ok: true, principalId, homeId, scopes: ["ai:chat"] };
    const scenes = await (dependencies.scenes ?? loadAgentScenes)({ principalId, homeId, session: payload.xiaomiSession });
    const exposure = await currentExposure(homeId, dependencies.exposureStore, env);
    const exposedScenes = scenes.filter(scene => isSceneExposed(exposure, scene))
      .sort((left, right) => Number(right.alias === grant?.sceneAlias) - Number(left.alias === grant?.sceneAlias));
    return { scenes: sceneSummaries(exposedScenes) };
  }
  if (input.tool === "list_device_controls") {
    if (Object.keys(args).length) throw new RemoteToolError("AI_INVALID_REQUEST", 400);
    const exposure = await currentExposure(homeId, dependencies.exposureStore, env);
    if (!exposure.enabled || !exposure.deviceActionsEnabled) throw new RemoteToolError("AI_CAPABILITY_UNAVAILABLE", 403);
    const discovery = await (dependencies.discovery ?? listDevices)(payload.xiaomiSession);
    const catalog = await (dependencies.deviceCatalog ?? loadDeviceOperationCatalog)(discovery, homeId, exposure.deviceDids);
    catalog.sort((left, right) => Number(right.deviceId === grant?.deviceId) - Number(left.deviceId === grant?.deviceId));
    return { devices: publicDeviceCatalog(catalog) };
  }
  if (input.tool === "get_home_status") {
    if (Object.keys(args).length) throw new RemoteToolError("AI_INVALID_REQUEST", 400);
    if (isPreviewEnvironment(env)) throw new RemoteToolError("AI_PREVIEW_READ_ONLY", 403);
    const collector = dependencies.homeStatus ?? defaultHomeStatusCollector;
    return await collector({ session: payload.xiaomiSession, homeId });
  }
  if (input.tool === "get_device_status") {
    if (Object.keys(args).length) throw new RemoteToolError("AI_INVALID_REQUEST", 400);
    if (isPreviewEnvironment(env)) throw new RemoteToolError("AI_PREVIEW_READ_ONLY", 403);
    const collector = dependencies.deviceStatus ?? defaultDeviceStatusCollector;
    return await collector({ session: payload.xiaomiSession, homeId });
  }
  if (input.tool === "activate_scene") {
    if (!validSceneGrant || !grant || input.idempotencyKey !== grant.idempotencyKey
      || Object.keys(toolArgs).length !== 2
      || toolArgs.sceneId !== grant.sceneAlias || toolArgs.revision !== grant.revision) {
      throw new RemoteToolError("AI_SCOPE_FORBIDDEN", 403);
    }
    const scenes = await (dependencies.scenes ?? loadAgentScenes)({ principalId, homeId, session: payload.xiaomiSession });
    const scene = scenes.find(item => item.alias === grant.sceneAlias);
    if (!scene || scene.revision !== grant.revision) throw new RemoteToolError("AI_SCENE_REVISION_CHANGED", 409);
    const requestHashBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({
      requestId: grant.requestId, messageHash: grant.messageHash, sceneAlias: grant.sceneAlias,
      revision: grant.revision, idempotencyKey: grant.idempotencyKey,
    })));
    const requestHash = Array.from(new Uint8Array(requestHashBytes), byte => byte.toString(16).padStart(2, "0")).join("");
    const actionAuthorization = await issueSceneActionAuthorization({ principalId, homeId,
      sceneAlias: scene.alias, revision: scene.revision, idempotencyKey: grant.idempotencyKey,
      requestHash }, env.AI_ACTION_AUTHORIZATION_SECRET ?? env.AI_SCENE_ACTION_AUTHORIZATION_SECRET);
    return executeApprovedScene({ principalId, homeId, session: payload.xiaomiSession, scene,
      idempotencyKey: grant.idempotencyKey, requestHash, actionAuthorization, env, dependencies });
  }
  if (input.tool === "set_device_property") {
    if (!validDeviceGrant || !grant || input.idempotencyKey !== grant.idempotencyKey
      || Object.keys(toolArgs).length !== 4
      || toolArgs.deviceId !== grant.deviceId || toolArgs.operationId !== grant.operationId
      || toolArgs.revision !== grant.revision || toolArgs.value !== grant.value) {
      throw new RemoteToolError("AI_SCOPE_FORBIDDEN", 403);
    }
    return executeApprovedDeviceProperty({ principalId, homeId, session: payload.xiaomiSession, grant, env, dependencies });
  }
  throw new RemoteToolError("AI_INVALID_REQUEST", 400);
}

export async function authorizeRemoteTool(authorization: string | null, secret: string | undefined) {
  if (!secret || secret.length < 32 || !authorization?.startsWith("Bearer ")) return false;
  const hash = async (value: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const [left, right] = await Promise.all([hash(authorization.slice(7)), hash(secret)]);
  let mismatch = 0;
  for (let i = 0; i < left.length; i++) mismatch |= left[i] ^ right[i];
  return mismatch === 0;
}
