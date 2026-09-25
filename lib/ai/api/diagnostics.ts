const NO_STORE_HEADERS = { "Cache-Control": "no-store", "Content-Type": "application/json" };
const SAFE_REQUEST_ID = /^(?:req_[a-f0-9]{32}|[a-f0-9-]{36})$/i;
const SAFE_CATEGORY = /^[A-Z0-9_]{1,64}$/;

type RouteHandler = (request: Request) => Promise<Response>;

function requestId(request: Request) {
  const supplied = request.headers.get("x-request-id")?.trim();
  return supplied && SAFE_REQUEST_ID.test(supplied) ? supplied : crypto.randomUUID();
}

async function responseCategory(response: Response) {
  try {
    const body = await response.clone().json() as { code?: unknown; diagnosticCode?: unknown };
    return {
      category: typeof body?.code === "string" && SAFE_CATEGORY.test(body.code) ? body.code : "HTTP_ERROR",
      diagnosticCode: typeof body?.diagnosticCode === "string" && SAFE_CATEGORY.test(body.diagnosticCode) ? body.diagnosticCode : undefined,
    };
  } catch {
    return { category: "HTTP_ERROR", diagnosticCode: undefined };
  }
}

/** Logs bounded API outcome metadata without request bodies, headers, or exception text. */
export function withRouteDiagnostics(route: string, handler: RouteHandler): RouteHandler {
  return async request => {
    const id = requestId(request);
    try {
      const response = await handler(request);
      if (!response.ok) {
        const { category, diagnosticCode } = await responseCategory(response);
        const record = {
          event: "console_api_response_error",
          requestId: id,
          route,
          stage: "ROUTE_HANDLER",
          httpStatus: response.status,
          category,
          ...(diagnosticCode ? { diagnosticCode } : {}),
        };
        const line = JSON.stringify(record);
        if (response.status >= 500) console.error(line);
        else console.warn(line);
      }
      return response;
    } catch {
      console.error(JSON.stringify({
        event: "console_api_exception",
        requestId: id,
        route,
        stage: "ROUTE_HANDLER",
        httpStatus: 502,
        category: "UNEXPECTED_EXCEPTION",
      }));
      return new Response(JSON.stringify({ code: "AI_AGENT_UNAVAILABLE", message: "AI 助手暂时不可用" }), {
        status: 502,
        headers: NO_STORE_HEADERS,
      });
    }
  };
}
