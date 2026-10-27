import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { deleteSpatialLayout, readSpatialAsset, readSpatialLayout, saveSpatialLayout, shouldUseLocalSpatialLayoutStore, spatialBlobStore, type SpatialLayoutStore } from "../../../../lib/spatial-layout-store.ts";
import { parseSpatialLayoutSaveEnvelope, SpatialLayoutError } from "../../../../lib/spatial-layout.ts";
import { listHomes, readXiaomiSession } from "../../../../lib/xiaomi-cloud.ts";

async function store(): Promise<SpatialLayoutStore> {
  if (shouldUseLocalSpatialLayoutStore(process.env)) {
    const { localSpatialLayoutStore } = await import("../../../../lib/local-spatial-layout-store.ts");
    return localSpatialLayoutStore(process.env.SPATIAL_LAYOUT_DIR);
  }
  return spatialBlobStore(process.env);
}

function homeId(request: NextRequest, body?: unknown) {
  const candidate = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).homeId : request.nextUrl.searchParams.get("homeId");
  if (typeof candidate !== "string" || !candidate || candidate.length > 128 || /[\u0000-\u001f]/.test(candidate)) throw new SpatialLayoutError("SPATIAL_REQUEST_INVALID", 400);
  return candidate;
}

async function authorize(request: NextRequest, requestedHome: string) {
  const value = (await cookies()).get("xiaomi_session")?.value;
  if (!value) throw new SpatialLayoutError("XIAOMI_NOT_CONNECTED", 401);
  const session = await readXiaomiSession(value, process.env.XIAOMI_SESSION_SECRET);
  if (!(await listHomes(session)).some(home => home.id === requestedHome)) throw new SpatialLayoutError("SPATIAL_HOME_FORBIDDEN", 403);
}

function failure(error: unknown) {
  const code = error instanceof SpatialLayoutError ? error.code : "SPATIAL_STORE_UNAVAILABLE";
  const status = error instanceof SpatialLayoutError ? error.status : 503;
  return NextResponse.json({ ok: false, error: code }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: NextRequest) {
  try {
    const requestedHome = homeId(request); await authorize(request, requestedHome);
    const asset = request.nextUrl.searchParams.get("asset");
    if (asset === "image" || asset === "model") {
      const result = await readSpatialAsset(requestedHome, asset, await store());
      return new NextResponse(result.value, { status: 200, headers: { "Content-Type": result.asset.contentType, "Content-Length": String(result.asset.byteLength), "Cache-Control": "private, no-store", "Content-Disposition": asset === "model" && request.nextUrl.searchParams.get("download") === "1" ? 'attachment; filename="mijia-home.glb"' : "inline" } });
    }
    const layout = await readSpatialLayout(requestedHome, await store());
    if (!layout) return NextResponse.json({ ok: true, layout: null }, { headers: { "Cache-Control": "no-store" } });
    return NextResponse.json({ ok: true, layout, assets: { imageUrl: `/api/xiaomi/spatial-layout?homeId=${encodeURIComponent(requestedHome)}&asset=image`, modelUrl: `/api/xiaomi/spatial-layout?homeId=${encodeURIComponent(requestedHome)}&asset=model` } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}

export async function PUT(request: NextRequest) {
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > 512 * 1024) throw new SpatialLayoutError("SPATIAL_REQUEST_TOO_LARGE", 413);
    const body = parseSpatialLayoutSaveEnvelope(JSON.parse(text) as unknown);
    const requestedHome = homeId(request, body); await authorize(request, requestedHome);
    const layout = await saveSpatialLayout(requestedHome, body.layout, await store());
    return NextResponse.json({ ok: true, layout }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}

export async function DELETE(request: NextRequest) {
  try {
    const requestedHome = homeId(request); await authorize(request, requestedHome);
    const revision = request.nextUrl.searchParams.get("revision") ?? undefined;
    await deleteSpatialLayout(requestedHome, revision, await store());
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}

