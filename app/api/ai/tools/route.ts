import { authorizeRemoteTool, RemoteToolError, runRemoteTool } from "../../../../lib/ai/tools/remote-tool-service";

export async function POST(request: Request) {
  const headers = { "Cache-Control": "no-store", "Content-Type": "application/json" };
  const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
  if (!await authorizeRemoteTool(request.headers.get("Authorization"), process.env.AI_TOOLS_INTERNAL_SECRET)) return respond({ code: "AI_UNAUTHENTICATED" }, 401);
  try {
    let raw = "";
    let bytes = 0;
    const decoder = new TextDecoder();
    const reader = request.body?.getReader();
    if (!reader) return respond({ code: "AI_INVALID_REQUEST" }, 400);
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 32768) { await reader.cancel(); return respond({ code: "AI_INVALID_REQUEST" }, 400); }
        raw += decoder.decode(next.value, { stream: true });
      }
      raw += decoder.decode();
    } finally { reader.releaseLock(); }
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return respond({ code: "AI_INVALID_REQUEST" }, 400); }
    return respond(await runRemoteTool(body, process.env, {}, request.headers.get("X-Ai-User-Token") ?? undefined));
  } catch (error) {
    return error instanceof RemoteToolError
      ? respond({ code: error.message }, error.status)
      : respond({ code: "AI_AGENT_UNAVAILABLE" }, 502);
  }
}
