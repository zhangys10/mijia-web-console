import type { XiaomiSession } from "../../xiaomi-cloud.ts";
import { sealWithSecret, unsealWithSecret } from "../../xiaomi-cloud.ts";

export const AGENT_SCOPES = ["ai:chat", "scene:activate"] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

export type AgentBindingPayload = {
  version: 1;
  kind: "ai_agent_binding";
  principalId: string;
  homeId: string;
  scopes: AgentScope[];
  session: XiaomiSession;
  issuedAt: number;
  expiresAt: number;
};

export class AgentBindingError extends Error {
  readonly code:
    | "AI_AGENT_BINDING_INVALID"
    | "AI_AGENT_BINDING_EXPIRED"
    | "AI_AGENT_BINDING_MISMATCH";

  constructor(code: AgentBindingError["code"]) {
    super(code);
    this.name = "AgentBindingError";
    this.code = code;
  }
}

export async function createAgentBinding(
  input: {
    principalId: string;
    homeId: string;
    scopes?: readonly AgentScope[];
    session: XiaomiSession;
    expiresAt: number;
    issuedAt?: number;
  },
  secret?: string,
): Promise<string> {
  const issuedAt = input.issuedAt ?? Date.now();
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= issuedAt) {
    throw new AgentBindingError("AI_AGENT_BINDING_INVALID");
  }
  const payload: AgentBindingPayload = {
    version: 1,
    kind: "ai_agent_binding",
    principalId: input.principalId,
    homeId: input.homeId,
    scopes: [...new Set([...(input.scopes ?? ["ai:chat"])])].sort(),
    session: input.session,
    issuedAt,
    expiresAt: input.expiresAt,
  };
  return sealWithSecret(payload, secret);
}

export async function verifyAgentBinding(
  token: string,
  expected: {
    principalId: string;
    homeId: string;
    scopes?: readonly AgentScope[];
    now?: number;
  },
  secret?: string,
): Promise<AgentBindingPayload> {
  let payload: AgentBindingPayload;
  try {
    payload = await unsealWithSecret<AgentBindingPayload>(token, secret);
  } catch {
    throw new AgentBindingError("AI_AGENT_BINDING_INVALID");
  }

  if (
    payload?.version !== 1
    || payload?.kind !== "ai_agent_binding"
    || !Array.isArray(payload?.scopes)
    || !payload?.session
    || typeof payload?.principalId !== "string"
    || typeof payload?.homeId !== "string"
    || !Number.isSafeInteger(payload?.issuedAt)
    || !Number.isSafeInteger(payload?.expiresAt)
    || payload.issuedAt > (expected.now ?? Date.now())
    || payload.expiresAt <= payload.issuedAt
  ) {
    throw new AgentBindingError("AI_AGENT_BINDING_INVALID");
  }
  if ((expected.now ?? Date.now()) >= payload.expiresAt) {
    throw new AgentBindingError("AI_AGENT_BINDING_EXPIRED");
  }
  const expectedScopes = [...new Set([...(expected.scopes ?? ["ai:chat"])])].sort();
  if (
    payload.principalId !== expected.principalId
    || payload.homeId !== expected.homeId
    || JSON.stringify([...payload.scopes].sort()) !== JSON.stringify(expectedScopes)
  ) {
    throw new AgentBindingError("AI_AGENT_BINDING_MISMATCH");
  }
  return payload;
}
