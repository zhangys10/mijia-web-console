import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { readXiaomiSession } from "../../../../lib/xiaomi-cloud.ts";
import { derivePrincipalId, PrincipalError } from "../../../../lib/ai/security/principal.ts";

const NO_STORE = { "Cache-Control": "no-store" } as const;

function unauthenticated() {
  return NextResponse.json(
    { error: "AI_UNAUTHENTICATED", message: "请先登录米家账号" },
    { status: 401, headers: NO_STORE },
  );
}

export async function GET() {
  const cookieValue = (await cookies()).get("xiaomi_session")?.value;
  if (!cookieValue) return unauthenticated();

  let session;
  try {
    session = await readXiaomiSession(cookieValue, process.env.XIAOMI_SESSION_SECRET);
  } catch {
    return unauthenticated();
  }

  try {
    const principalId = await derivePrincipalId(session, process.env);
    return NextResponse.json({ principalId }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof PrincipalError) {
      console.error("[ai-principal] Principal derivation failed:", error.code);
      return NextResponse.json(
        { error: error.code, message: "服务端身份派生尚未配置" },
        { status: 500, headers: NO_STORE },
      );
    }
    console.error("[ai-principal] Unexpected principal error");
    return NextResponse.json(
      { error: "AI_PRINCIPAL_ERROR", message: "暂时无法读取身份标识" },
      { status: 500, headers: NO_STORE },
    );
  }
}
