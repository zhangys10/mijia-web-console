import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { listHomes, readXiaomiSession } from "../../../../lib/xiaomi-cloud.ts";
import {
  computePrincipalId,
  sealAutomationToken,
  type AutomationTokenPayload,
} from "../../../../lib/ai/security/automation-token.ts";
import {
  listSupportedProviders,
  resolveProvider,
  validateProviderKey,
  ProviderCatalogError,
} from "../../../../lib/ai/providers/provider-catalog.ts";

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
      supportedProviders: listSupportedProviders(),
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

    // 拒绝自定义 baseUrl，防止外部重定向或凭据外送
    if ("baseUrl" in body) {
      return NextResponse.json(
        { error: "INVALID_REQUEST", message: "不支持自定义 baseUrl" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }

    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    if (!apiKey) {
      return NextResponse.json(
        { error: "INVALID_REQUEST", message: "必须提供模型 API Key" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }

    const providerId = typeof body.provider === "string" ? body.provider.trim() : "qwen-cn";
    const modelId = typeof body.model === "string" ? body.model.trim() : undefined;

    let resolved;
    try {
      resolved = resolveProvider(providerId, modelId);
    } catch (err) {
      if (err instanceof ProviderCatalogError) {
        return NextResponse.json(
          { error: err.code, message: err.message },
          { status: 422, headers: { "Cache-Control": "no-store" } },
        );
      }
      throw err;
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

    // 发起最小验证请求，确认用户的 API Key 是否有效，不允许跳过
    try {
      await validateProviderKey(resolved.provider.id, apiKey, resolved.model);
    } catch (err) {
      const cause = err instanceof Error ? err : new Error(String(err));
      const providerFetchCause = cause.cause;
      console.error("[automation-token] Provider validation failed:", {
        provider: resolved.provider.id,
        model: resolved.model,
        error: cause instanceof ProviderCatalogError ? cause.code : "LLM_PROVIDER_ERROR",
        message: cause.message,
        ...(providerFetchCause instanceof Error && {
          fetchError: providerFetchCause.message,
          fetchErrorName: providerFetchCause.name,
        }),
      });
      if (err instanceof ProviderCatalogError) {
        const status =
          err.code === "LLM_CREDENTIAL_INVALID"
            ? 422
            : err.code === "LLM_TIMEOUT"
              ? 504
              : 502;
        return NextResponse.json(
          { error: err.code, message: err.message },
          { status, headers: { "Cache-Control": "no-store" } },
        );
      }
      return NextResponse.json(
        { error: "LLM_PROVIDER_ERROR", message: "验证模型凭据失败" },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }

    const now = Date.now();
    const expiresAt = now + expiresInDays * 86400 * 1000;
    const principalId = await computePrincipalId(session.region || "cn", session.userId);

    const payload: AutomationTokenPayload = {
      version: 1,
      purpose: "ai-home-automation",
      principalId,
      xiaomiSession: session,
      region: session.region || "cn",
      homeId: homeIdParam,
      provider: resolved.provider.id,
      model: resolved.model,
      apiKey,
      issuedAt: now,
      expiresAt,
    };

    const token = await sealAutomationToken(payload);

    return NextResponse.json(
      {
        ok: true,
        token,
        provider: resolved.provider.id,
        model: resolved.model,
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
