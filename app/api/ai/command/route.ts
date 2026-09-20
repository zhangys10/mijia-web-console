import { NextResponse } from "next/server";

// 旧嵌入式命令编排已在 Phase 3 移除：命令流量由 mijia-agent 的
// POST /ai/command（automation token 直连入口）承接。本路由仅保留
// 稳定的退役响应，避免旧快捷指令收到无解释的 404。
// Siri/快捷指令是否改走 console 薄转发，将在 cutover 时另行决定。
const RETIRED_MESSAGE = "旧命令接口已下线，请使用 mijia-agent 的 /ai/command 入口（Bearer automation token）";

function respond(body: Record<string, unknown>, status: number) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function GET() {
  return respond({
    status: "retired",
    service: "mijia-web-console-ai",
    endpoint: "POST /ai/command (mijia-agent)",
    message: RETIRED_MESSAGE,
  }, 200);
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      Allow: "GET, POST, OPTIONS",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Idempotency-Key, Content-Type",
    },
  });
}

export async function POST() {
  const requestId = `req_${crypto.randomUUID().replaceAll("-", "")}`;
  return respond({ code: "AI_COMMAND_RETIRED", message: RETIRED_MESSAGE, requestId }, 410);
}
