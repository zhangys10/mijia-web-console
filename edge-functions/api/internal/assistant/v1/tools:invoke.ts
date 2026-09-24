import { createAssistantV1Handler } from "../../../../../lib/ai/tools/assistant-v1-service.ts";

export const onRequest = createAssistantV1Handler("invoke");
