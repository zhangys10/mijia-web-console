import { withRouteDiagnostics } from "../../../../lib/ai/api/diagnostics.ts";
import { onRequest as exposureHandler } from "../../../../lib/ai/api/exposure.ts";

async function invoke(request: Request) {
  const context = { request, env: process.env };
  if (process.env.AI_ENVIRONMENT === "development") {
    const { localAssistantExposureStore } = await import("../../../../lib/ai/tools/local-assistant-exposure-store.ts");
    return exposureHandler(context, { store: localAssistantExposureStore(process.env.AI_ASSISTANT_EXPOSURE_DIR) });
  }
  return exposureHandler(context);
}
const handler = withRouteDiagnostics("/api/ai/exposure", invoke);
export async function GET(request: Request) { return handler(request); }
export async function PUT(request: Request) { return handler(request); }
