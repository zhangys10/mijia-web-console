import { onRequest as handler } from "../../../../edge-functions/api/ai/exposure";

async function invoke(request: Request) {
  const context = { request, env: process.env };
  if (process.env.AI_ENVIRONMENT === "development") {
    const { localAssistantExposureStore } = await import("../../../../lib/ai/tools/local-assistant-exposure-store.ts");
    return handler(context, { store: localAssistantExposureStore(process.env.AI_ASSISTANT_EXPOSURE_DIR) });
  }
  return handler(context);
}

export async function GET(request: Request) {
  return invoke(request);
}

export async function PUT(request: Request) {
  return invoke(request);
}
