import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { readXiaomiSession } from "../../../../lib/xiaomi-cloud.ts";
import { createAiBindingToken } from "../../../../lib/ai/security/binding.ts";

export async function GET(request: NextRequest) {
  try {
    const value = (await cookies()).get("xiaomi_session")?.value;
    if (!value) return NextResponse.json({ error: "XIAOMI_NOT_CONNECTED" }, { status: 401 });

    const session = await readXiaomiSession(value);
    const searchParams = request.nextUrl.searchParams;
    const homeId = searchParams.get("homeId") ?? undefined;

    // Token 仅作为用户米家会话凭据及默认家庭标识，绝不自动固化或绑定特定场景
    const token = await createAiBindingToken(session, homeId);
    return NextResponse.json({
      ok: true,
      token,
      userId: session.userId,
      homeId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "TOKEN_GENERATION_FAILED";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  return GET(request);
}
