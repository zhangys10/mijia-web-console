import { withRouteDiagnostics } from "../../../../../../lib/ai/api/diagnostics.ts";
import { isLocalAssistantExposureRuntime } from "../../../../../../lib/ai/config.ts";
import { createAssistantV1Handler } from "../../../../../../lib/ai/tools/assistant-v1-service.ts";

async function invoke(request: Request) {
  const context = { request, env: process.env };
  if (isLocalAssistantExposureRuntime(process.env)) {
    const { localAssistantExposureStore } = await import("../../../../../../lib/ai/tools/local-assistant-exposure-store.ts");
    return createAssistantV1Handler("capabilities", { exposureStore: localAssistantExposureStore(process.env.AI_ASSISTANT_EXPOSURE_DIR) })(context);
  }
  return createAssistantV1Handler("capabilities")(context);
}

const handler = withRouteDiagnostics("/api/internal/assistant/v1/capabilities", invoke);
export async function POST(request: Request) { return handler(request); }
