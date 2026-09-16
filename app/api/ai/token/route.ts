import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { listHomes, readXiaomiSession } from "../../../../lib/xiaomi-cloud.ts";
import { listManualScenes } from "../../../../lib/xiaomi-scenes.ts";
import { createAiBindingToken } from "../../../../lib/ai/security/binding.ts";

export async function GET(request: NextRequest) {
  try {
    const value = (await cookies()).get("xiaomi_session")?.value;
    if (!value) return NextResponse.json({ error: "XIAOMI_NOT_CONNECTED" }, { status: 401 });

    const session = await readXiaomiSession(value);
    const searchParams = request.nextUrl.searchParams;
    let homeId = searchParams.get("homeId") ?? undefined;
    let sceneId = searchParams.get("sceneId") ?? undefined;
    let sceneName: string | undefined;

    if (!homeId || !sceneId) {
      try {
        const homes = await listHomes(session);
        if (homes.length > 0) {
          homeId = homeId ?? homes[0].id;
          const scenes = await listManualScenes(session, homeId);
          const homeScene = scenes.find(s => /回家|到家|进门|到家模式|回家模式/.test(s.name)) ?? scenes[0];
          if (homeScene) {
            sceneId = sceneId ?? homeScene.id;
            sceneName = homeScene.name;
          }
        }
      } catch (error) {
        console.warn("ai_token_scene_resolve_failed", JSON.stringify({
          error: error instanceof Error ? error.message : "UNKNOWN",
        }));
      }
    }

    const token = await createAiBindingToken(session, homeId, sceneId);
    return NextResponse.json({
      ok: true,
      token,
      userId: session.userId,
      homeId,
      sceneId,
      sceneName,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "TOKEN_GENERATION_FAILED";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  return GET(request);
}
