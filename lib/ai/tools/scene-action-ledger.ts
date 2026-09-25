import { getStore } from "@edgeone/pages-blob";

export type SceneActionLedgerStore = {
  get(key: string, options?: { type?: "json"; consistency?: "strong" | "eventual" }): Promise<unknown>;
  setJSON(key: string, value: unknown, options?: { onlyIfNew?: boolean }): Promise<void>;
};

type Claim = {
  version: 1;
  claimId: string;
  requestHash: string;
  sceneRevision: string;
  claimedAt: string;
};

type Outcome = {
  version: 1;
  requestHash: string;
  status: "success" | "outcome_unknown";
  completedAt: string;
};

export type SceneActionClaim =
  | { kind: "claimed"; claim: Claim; claimKey: string; outcomeKey: string }
  | { kind: "replay"; outcome: Outcome }
  | { kind: "unknown" }
  | { kind: "conflict" };

export class SceneActionLedgerError extends Error {
  readonly code: "AI_ACTION_LEDGER_UNAVAILABLE";

  constructor(code: "AI_ACTION_LEDGER_UNAVAILABLE") {
    super(code);
    this.code = code;
  }
}

function ledgerStore(): SceneActionLedgerStore {
  const name = process.env.AI_SCENE_ACTION_LEDGER_STORE?.trim() || "mijia-ai-scene-actions-v1";
  const projectId = process.env.PAGES_PROJECT_ID?.trim();
  const token = process.env.PAGES_BLOB_API_TOKEN?.trim();
  if (projectId && token) return getStore({ name, projectId, token }) as SceneActionLedgerStore;
  return getStore(name) as SceneActionLedgerStore;
}

async function digest(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function claimSceneAction(
  input: { principalId: string; homeId: string; idempotencyKey: string; requestHash: string; sceneRevision: string },
  store = ledgerStore(),
): Promise<SceneActionClaim> {
  const scope = await digest(`${input.principalId}\u0000${input.homeId}\u0000${input.idempotencyKey}`);
  const claimKey = `actions/${scope}.claim.json`;
  const outcomeKey = `actions/${scope}.outcome.json`;
  const claim: Claim = { version: 1, claimId: crypto.randomUUID(), requestHash: input.requestHash, sceneRevision: input.sceneRevision, claimedAt: new Date().toISOString() };
  try {
    try { await store.setJSON(claimKey, claim, { onlyIfNew: true }); }
    catch { /* The strong read below decides whether this process owns the claim. */ }
    const existing = await store.get(claimKey, { type: "json", consistency: "strong" });
    if (!existing || typeof existing !== "object") throw new Error("invalid action claim");
    const record = existing as Record<string, unknown>;
    if (record.version !== 1 || typeof record.claimId !== "string" || typeof record.requestHash !== "string" || typeof record.sceneRevision !== "string") throw new Error("invalid action claim");
    if (record.claimId === claim.claimId) return { kind: "claimed", claim, claimKey, outcomeKey };
    if (record.requestHash !== input.requestHash || record.sceneRevision !== input.sceneRevision) return { kind: "conflict" };
    const rawOutcome = await store.get(outcomeKey, { type: "json", consistency: "strong" });
    if (rawOutcome && typeof rawOutcome === "object") {
      const outcome = rawOutcome as Record<string, unknown>;
      if (outcome.version === 1 && outcome.requestHash === input.requestHash && (outcome.status === "success" || outcome.status === "outcome_unknown") && typeof outcome.completedAt === "string") {
        return { kind: "replay", outcome: outcome as Outcome };
      }
      throw new Error("invalid action outcome");
    }
    // A claim without a terminal receipt may have crossed the physical dispatch boundary.
    // Treat it as unknown and never let a replay dispatch the scene again.
    return { kind: "unknown" };
  } catch {
    throw new SceneActionLedgerError("AI_ACTION_LEDGER_UNAVAILABLE");
  }
}

export async function recordSceneActionOutcome(
  claim: Extract<SceneActionClaim, { kind: "claimed" }>,
  status: Outcome["status"],
  store = ledgerStore(),
) {
  const outcome: Outcome = {
    version: 1,
    requestHash: claim.claim.requestHash,
    status,
    completedAt: new Date().toISOString(),
  };
  try {
    await store.setJSON(claim.outcomeKey, outcome, { onlyIfNew: true });
  } catch {
    // An existing receipt or a Blob outage cannot establish a fresh outcome.
    // The caller must surface uncertainty and must not retry the physical action.
    throw new SceneActionLedgerError("AI_ACTION_LEDGER_UNAVAILABLE");
  }
}
