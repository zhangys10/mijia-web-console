import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { listHomes, readXiaomiSession } from "../../../../lib/xiaomi-cloud.ts";
import {
  computePrincipalId,
  sealAutomationToken,
  type AutomationTokenPayload,
} from "../../../../lib/ai/security/automation-token.ts";

// Phase 3 之后，automation token 是 mijia-agent /ai/command 的入口凭据：
// 只封装小米会话与可选的绑定家庭，不再携带 BYOK 模型字段（模型访问由
// agent 侧的 Makers Gateway 提供）。

export async function GET() {
  const cookieJar = await cookies();
  const sessionCookie = cookieJar.get("xiaomi_session")?.value;
  let loggedIn = false;
  let userId: string | undefined;

  if (sessionCookie) {
    try {
      const session = await readXiaomiSession(sessionCookie);
      loggedIn = true;
      userId = session.userId;
    } catch {
      loggedIn = false;
    }
  }

  return NextResponse.json(
    {
      ok: true,
      authenticated: loggedIn,
      userId: userId ? `${userId.slice(0, 3)}***` : undefined,
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}

export async function POST(request: NextRequest) {
  try {
    const cookieJar = await cookies();
    const sessionCookie = cookieJar.get("xiaomi_session")?.value;
    if (!sessionCookie) {
      return NextResponse.json(
        { error: "XIAOMI_NOT_CONNECTED", message: "请先登录小米账号" },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }

    const session = await readXiaomiSession(sessionCookie);

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json(
        { error: "INVALID_REQUEST", message: "请求体格式错误" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }

    // 拒绝 BYOK 字段：token 不再携带任何模型凭据，防止旧客户端把密钥封进来。
    if ("apiKey" in body || "provider" in body || "model" in body || "baseUrl" in body) {
      return NextResponse.json(
        { error: "INVALID_REQUEST", message: "automation token 不再携带模型凭据（BYOK 已下线）" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }

    const homeIdParam =
      typeof body.homeId === "string"
        ? body.homeId.trim()
        : typeof body.home === "string"
          ? body.home.trim()
          : undefined;

    if (homeIdParam) {
      try {
        const homes = await listHomes(session);
        const homeExists = homes.some((h) => h.id === homeIdParam);
        if (!homeExists) {
          return NextResponse.json(
            { error: "INVALID_REQUEST", message: "指定的家庭不存在或无权访问" },
            { status: 400, headers: { "Cache-Control": "no-store" } },
          );
        }
      } catch (error) {
        console.error("[automation-token] Failed to verify home ownership:", error instanceof Error ? error.message : error);
        return NextResponse.json(
          { error: "XIAOMI_CLOUD_ERROR", message: "无法验证家庭归属，请稍后重试" },
          { status: 502, headers: { "Cache-Control": "no-store" } },
        );
      }
    }

    const rawExpiresInDays = body.expiresInDays;
    let expiresInDays = 30;
    if (rawExpiresInDays !== undefined) {
      const parsed = typeof rawExpiresInDays === "number" ? rawExpiresInDays : Number.parseInt(String(rawExpiresInDays), 10);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 90) {
        return NextResponse.json(
          { error: "INVALID_REQUEST", message: "有效期必须在 1 至 90 天之间" },
          { status: 400, headers: { "Cache-Control": "no-store" } },
        );
      }
      expiresInDays = parsed;
    }

    const now = Date.now();
    const expiresAt = now + expiresInDays * 86400 * 1000;
    const principalId = await computePrincipalId(session.region || "cn", session.userId);

    const payload: AutomationTokenPayload = {
      version: 1,
      purpose: "ai-home-automation",
      audience: "mijia-agent",
      principalId,
      xiaomiSession: session,
      region: session.region || "cn",
      homeId: homeIdParam,
      issuedAt: now,
      expiresAt,
    };

    const token = await sealAutomationToken(payload);

    return NextResponse.json(
      {
        ok: true,
        token,
        homeId: homeIdParam ?? null,
        expiresAt,
      },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    console.error("[automation-token] Generation error:", error instanceof Error ? error.message : error);
    return NextResponse.json(
      { error: "TOKEN_GENERATION_FAILED", message: "生成自动化凭据失败" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
