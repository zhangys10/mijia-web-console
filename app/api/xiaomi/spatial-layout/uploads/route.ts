import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { createSpatialUpload, shouldUseLocalSpatialLayoutStore, spatialBlobStore, spatialHomePrefix, type SpatialLayoutStore } from "../../../../../lib/spatial-layout-store.ts";
import { SpatialLayoutError } from "../../../../../lib/spatial-layout.ts";
import { listHomes, readXiaomiSession } from "../../../../../lib/xiaomi-cloud.ts";

async function store(): Promise<SpatialLayoutStore> {
  if (shouldUseLocalSpatialLayoutStore(process.env)) {
    const { localSpatialLayoutStore } = await import("../../../../../lib/local-spatial-layout-store.ts");
    return localSpatialLayoutStore(process.env.SPATIAL_LAYOUT_DIR);
  }
  return spatialBlobStore(process.env);
}

async function authorize(homeId: string) {
  if (!homeId || homeId.length > 128) throw new SpatialLayoutError("SPATIAL_REQUEST_INVALID", 400);
  const value = (await cookies()).get("xiaomi_session")?.value;
  if (!value) throw new SpatialLayoutError("XIAOMI_NOT_CONNECTED", 401);
  const session = await readXiaomiSession(value, process.env.XIAOMI_SESSION_SECRET);
  if (!(await listHomes(session)).some(home => home.id === homeId)) throw new SpatialLayoutError("SPATIAL_HOME_FORBIDDEN", 403);
}

function failure(error: unknown) {
  return NextResponse.json({ ok: false, error: error instanceof SpatialLayoutError ? error.code : "SPATIAL_STORE_UNAVAILABLE" }, { status: error instanceof SpatialLayoutError ? error.status : 503, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const homeId = typeof body.homeId === "string" ? body.homeId : ""; await authorize(homeId);
    if (body.kind !== "image" && body.kind !== "model" || typeof body.contentType !== "string" || typeof body.byteLength !== "number") throw new SpatialLayoutError("SPATIAL_UPLOAD_INVALID", 400);
    const upload = await createSpatialUpload(homeId, body.kind, body.contentType, body.byteLength, request.nextUrl.origin, await store());
    return NextResponse.json({ ok: true, uploadUrl: upload.url, ...upload }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}

export async function PUT(request: NextRequest) {
  try {
    if (!shouldUseLocalSpatialLayoutStore(process.env)) throw new SpatialLayoutError("SPATIAL_REQUEST_INVALID", 405);
    const homeId = request.nextUrl.searchParams.get("homeId") ?? ""; await authorize(homeId);
    const key = request.nextUrl.searchParams.get("key") ?? "";
    if (!key.startsWith(`${await spatialHomePrefix(homeId)}uploads/`)) throw new SpatialLayoutError("SPATIAL_ASSET_FORBIDDEN", 403);
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (!Number.isInteger(contentLength) || contentLength < 1 || contentLength > 20 * 1024 * 1024) throw new SpatialLayoutError("SPATIAL_UPLOAD_INVALID", 400);
    const value = await request.arrayBuffer();
    if (value.byteLength !== contentLength) throw new SpatialLayoutError("SPATIAL_UPLOAD_INVALID", 400);
    const target = await store(); if (!target.set) throw new SpatialLayoutError("SPATIAL_STORE_UNAVAILABLE", 503);
    await target.set(key, value);
    return NextResponse.json({ ok: true }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}
