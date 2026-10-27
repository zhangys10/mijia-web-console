import { getStore } from "@edgeone/pages-blob";
import { imageMagic, isGlb, parseSpatialLayout, SpatialLayoutError, type SpatialLayoutV1 } from "./spatial-layout.ts";

export type SpatialLayoutStore = {
  get(key: string, options?: { type?: "json" | "arrayBuffer"; consistency?: "strong" | "eventual" }): Promise<unknown>;
  set?(key: string, value: ArrayBuffer | Blob | string): Promise<void>;
  setJSON(key: string, value: unknown, options?: { onlyIfNew?: boolean }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; consistency?: "strong" | "eventual" }): Promise<{ blobs: Array<{ key: string }> }>;
  createUploadUrl?(key: string, options?: { expireSeconds?: number; contentType?: string }): Promise<{ url: string; key: string; expiresAt: number }>;
};

type Environment = Record<string, string | undefined>;

export function shouldUseLocalSpatialLayoutStore(runtimeEnv: Environment = {}) {
  return runtimeEnv.AI_ENVIRONMENT === "development" || runtimeEnv.NODE_ENV === "development";
}

export function spatialBlobStore(runtimeEnv: Environment = {}): SpatialLayoutStore {
  const name = runtimeEnv.SPATIAL_LAYOUT_STORE?.trim() || "mijia-spatial-layout-v1";
  const projectId = runtimeEnv.PAGES_PROJECT_ID?.trim();
  const token = runtimeEnv.PAGES_BLOB_API_TOKEN?.trim();
  return projectId && token
    ? getStore({ name, projectId, token }) as SpatialLayoutStore
    : getStore(name) as SpatialLayoutStore;
}

export async function spatialHomeHash(homeId: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(homeId));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}

export async function spatialHomePrefix(homeId: string) { return `homes/${await spatialHomeHash(homeId)}/`; }

async function readPointer(store: SpatialLayoutStore, homeId: string) {
  const prefix = await spatialHomePrefix(homeId);
  const raw = await store.get(`${prefix}current.json`, { type: "json", consistency: "strong" });
  if (raw === null) return { prefix, revision: null as string | null };
  if (!raw || typeof raw !== "object" || typeof (raw as { revision?: unknown }).revision !== "string") throw new SpatialLayoutError("SPATIAL_STORE_UNAVAILABLE", 503);
  return { prefix, revision: (raw as { revision: string }).revision };
}

export async function readSpatialLayout(homeId: string, supplied?: SpatialLayoutStore): Promise<SpatialLayoutV1 | null> {
  const store = supplied ?? spatialBlobStore();
  try {
    const { prefix, revision } = await readPointer(store, homeId);
    if (!revision) return null;
    const raw = await store.get(`${prefix}revisions/${revision}.json`, { type: "json", consistency: "strong" });
    if (raw === null) throw new Error("missing revision");
    return parseSpatialLayout(raw, `${prefix}uploads/`);
  } catch (error) {
    if (error instanceof SpatialLayoutError) throw error;
    throw new SpatialLayoutError("SPATIAL_STORE_UNAVAILABLE", 503);
  }
}

async function bytes(store: SpatialLayoutStore, key: string) {
  const raw = await store.get(key, { type: "arrayBuffer", consistency: "strong" });
  if (!(raw instanceof ArrayBuffer)) throw new SpatialLayoutError("SPATIAL_ASSET_MISSING", 400);
  return new Uint8Array(raw);
}

export async function saveSpatialLayout(homeId: string, input: unknown, supplied?: SpatialLayoutStore): Promise<SpatialLayoutV1> {
  const store = supplied ?? spatialBlobStore();
  const { prefix, revision: currentRevision } = await readPointer(store, homeId);
  const layout = parseSpatialLayout(input, `${prefix}uploads/`);
  if (layout.baseRevision !== currentRevision) throw new SpatialLayoutError("SPATIAL_REVISION_CONFLICT", 409);
  const [image, model] = await Promise.all([bytes(store, layout.image.key), bytes(store, layout.model.key)]);
  if (image.byteLength !== layout.image.byteLength || imageMagic(image) !== layout.image.contentType) throw new SpatialLayoutError("SPATIAL_IMAGE_INVALID", 400);
  if (model.byteLength !== layout.model.byteLength || !isGlb(model)) throw new SpatialLayoutError("SPATIAL_MODEL_INVALID", 400);
  const next = { ...layout, updatedAt: new Date().toISOString() };
  try {
    await store.setJSON(`${prefix}revisions/${next.revision}.json`, next, { onlyIfNew: true });
    await store.setJSON(`${prefix}current.json`, { version: 1, revision: next.revision, updatedAt: next.updatedAt });
    return next;
  } catch (error) {
    if (error instanceof SpatialLayoutError) throw error;
    throw new SpatialLayoutError("SPATIAL_STORE_UNAVAILABLE", 503);
  }
}

export async function deleteSpatialLayout(homeId: string, expectedRevision?: string, supplied?: SpatialLayoutStore) {
  const store = supplied ?? spatialBlobStore();
  const prefix = await spatialHomePrefix(homeId);
  try {
    const current = await readPointer(store, homeId);
    if (expectedRevision && current.revision !== expectedRevision) throw new SpatialLayoutError("SPATIAL_REVISION_CONFLICT", 409);
    const result = await store.list({ prefix, consistency: "strong" });
    await Promise.all(result.blobs.map(blob => store.delete(blob.key)));
  } catch (error) {
    if (error instanceof SpatialLayoutError) throw error;
    throw new SpatialLayoutError("SPATIAL_STORE_UNAVAILABLE", 503);
  }
}

export async function readSpatialAsset(homeId: string, kind: "image" | "model", supplied?: SpatialLayoutStore) {
  const store = supplied ?? spatialBlobStore();
  const layout = await readSpatialLayout(homeId, store);
  if (!layout) throw new SpatialLayoutError("SPATIAL_LAYOUT_NOT_FOUND", 404);
  const asset = layout[kind];
  const value = await store.get(asset.key, { type: "arrayBuffer", consistency: "strong" });
  if (!(value instanceof ArrayBuffer)) throw new SpatialLayoutError("SPATIAL_ASSET_MISSING", 404);
  return { asset, value };
}

export async function createSpatialUpload(homeId: string, kind: "image" | "model", contentType: string, byteLength: number, origin: string, supplied?: SpatialLayoutStore) {
  const store = supplied ?? spatialBlobStore();
  const imageTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
  const modelTypes = new Set(["model/gltf-binary", "application/octet-stream"]);
  const validType = kind === "image" ? imageTypes.has(contentType) : modelTypes.has(contentType);
  const limit = kind === "image" ? 10 * 1024 * 1024 : 20 * 1024 * 1024;
  if (!validType || !Number.isInteger(byteLength) || byteLength < 1 || byteLength > limit) throw new SpatialLayoutError("SPATIAL_UPLOAD_INVALID", 400);
  const prefix = await spatialHomePrefix(homeId);
  const extension = contentType === "image/png" ? "png" : contentType === "image/jpeg" ? "jpg" : contentType === "image/webp" ? "webp" : "glb";
  const key = `${prefix}uploads/${crypto.randomUUID()}.${extension}`;
  if (store.createUploadUrl) return { ...(await store.createUploadUrl(key, { expireSeconds: 600, contentType })), contentType, byteLength, local: false };
  return { url: `${origin}/api/xiaomi/spatial-layout/uploads?homeId=${encodeURIComponent(homeId)}&key=${encodeURIComponent(key)}`, key, expiresAt: Math.floor(Date.now() / 1000) + 600, contentType, byteLength, local: true };
}

