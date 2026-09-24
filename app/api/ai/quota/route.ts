import { withRouteDiagnostics } from "../../../../lib/ai/api/diagnostics.ts";
import { onRequest as quotaHandler } from "../../../../lib/ai/api/quota.ts";
const handler = withRouteDiagnostics("/api/ai/quota", request => quotaHandler({ request, env: process.env }));
export async function GET(request: Request) { return handler(request); }
