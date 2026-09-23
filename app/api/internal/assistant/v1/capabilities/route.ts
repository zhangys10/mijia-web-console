import { onRequest as edgeHandler } from "../../../../../../edge-functions/api/internal/assistant/v1/capabilities";
import { createAssistantV1Handler } from "../../../../../../lib/ai/tools/assistant-v1-service.ts";

export async function POST(request: Request) {
  const context = { request, env: process.env };
  if (process.env.AI_ENVIRONMENT === "development") {
    const { localAssistantExposureStore } = await import("../../../../../../lib/ai/tools/local-assistant-exposure-store.ts");
    return createAssistantV1Handler("capabilities", { exposureStore: localAssistantExposureStore() })(context);
  }
  return edgeHandler(context);
}
