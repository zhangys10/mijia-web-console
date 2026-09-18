import { listHomes, type XiaomiSession } from "../../xiaomi-cloud.ts";
import { isPreviewEnvironment } from "../config.ts";
import { verifyAgentBinding, type AgentScope } from "../security/agent-binding.ts";
import { derivePrincipalId } from "../security/principal.ts";
import { loadAgentScenes, parseApprovedSceneIds, sceneSummaries, type AgentSceneRecord } from "./agent-scene-catalog.ts";

type Environment = Record<string, string | undefined>;
type Dependencies = {
  homes?: typeof listHomes;
  scenes?: (input: { principalId: string; homeId: string; session: XiaomiSession; approvedSceneIds: ReadonlySet<string> }) => Promise<AgentSceneRecord[]>;
};

export class RemoteToolError extends Error {
  readonly status: number;
  constructor(code: string, status: number) { super(code); this.status = status; }
}

export async function runRemoteTool(body: unknown, env: Environment, dependencies: Dependencies = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new RemoteToolError("AI_INVALID_REQUEST", 400);
  const input = body as Record<string, unknown>;
  const allowed = new Set(["requestId", "principalId", "homeId", "scopes", "sessionBinding", "idempotencyKey", "tool", "arguments"]);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new RemoteToolError("AI_INVALID_REQUEST", 400);
  for (const key of ["requestId", "principalId", "homeId", "sessionBinding", "tool"]) {
    if (typeof input[key] !== "string" || !input[key] || (input[key] as string).length > (key === "sessionBinding" ? 16384 : 128)) throw new RemoteToolError("AI_INVALID_REQUEST", 400);
  }
  if (!Array.isArray(input.scopes) || !input.scopes.includes("ai:chat") || input.scopes.some(scope => scope !== "ai:chat" && scope !== "scene:activate")) throw new RemoteToolError("AI_SCOPE_FORBIDDEN", 403);
  const scopes = input.scopes as AgentScope[];
  const principalId = input.principalId as string;
  const homeId = input.homeId as string;
  const idempotencyKey = input.idempotencyKey;
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
    const scenes = await (dependencies.scenes ?? loadAgentScenes)({ principalId, homeId, session: binding.session, approvedSceneIds: parseApprovedSceneIds(env.AI_SCENE_APPROVED_IDS) });
    return { scenes: sceneSummaries(scenes) };
  }
  if (input.tool !== "activate_scene") throw new RemoteToolError("AI_INVALID_REQUEST", 400);
  if (!scopes.includes("scene:activate")) throw new RemoteToolError("AI_SCOPE_FORBIDDEN", 403);
  if (!idempotencyKey) throw new RemoteToolError("AI_INVALID_REQUEST", 400);
  const sceneId = (args as Record<string, unknown>).sceneId;
  if (
    Object.keys(args).length !== 1
    || typeof sceneId !== "string"
    || !/^scene_[a-f0-9]{16}$/.test(sceneId)
  ) {
    throw new RemoteToolError("AI_INVALID_REQUEST", 400);
  }
  if (isPreviewEnvironment(env)) throw new RemoteToolError("AI_PREVIEW_READ_ONLY", 403);
  // Extraction is read-only until the executor owns durable, cross-conversation claims.
  // Agent memory and eventually consistent quota KV cannot guarantee this boundary.
  throw new RemoteToolError("AI_SCENE_EXECUTION_DISABLED", 403);
}

export async function authorizeRemoteTool(authorization: string | null, secret: string | undefined) {
  if (!secret || secret.length < 32 || !authorization?.startsWith("Bearer ")) return false;
  const hash = async (value: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const [left, right] = await Promise.all([hash(authorization.slice(7)), hash(secret)]);
  let mismatch = 0;
  for (let i = 0; i < left.length; i++) mismatch |= left[i] ^ right[i];
  return mismatch === 0;
}
