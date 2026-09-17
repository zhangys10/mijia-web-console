import { seal, unseal, type XiaomiQrState, type XiaomiSession } from "../../xiaomi-cloud.ts";

export type AiBindingPayload = {
  version: 1;
  kind: "siri_binding";
  userId: string;
  session: XiaomiSession;
  homeId?: string;
  createdAt: number;
};

export async function createAiBindingToken(
  session: XiaomiSession,
  homeId?: string,
): Promise<string> {
  const payload: AiBindingPayload = {
    version: 1,
    kind: "siri_binding",
    userId: session.userId,
    session,
    homeId,
    createdAt: Date.now(),
  };
  return seal(payload as unknown as XiaomiSession);
}

export async function verifyAndExtractBinding(token: string): Promise<AiBindingPayload | null> {
  try {
    const data = await unseal<XiaomiSession | XiaomiQrState>(token);
    if (typeof data === "object" && data !== null) {
      const payload = data as Partial<AiBindingPayload>;
      if (payload.kind === "siri_binding" && payload.session && typeof payload.userId === "string") {
        return payload as AiBindingPayload;
      }
      if ("userId" in data && "ssecurity" in data && "serviceToken" in data) {
        const session = data as XiaomiSession;
        return {
          version: 1,
          kind: "siri_binding",
          userId: session.userId,
          session,
          createdAt: session.createdAt ?? Date.now(),
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}
