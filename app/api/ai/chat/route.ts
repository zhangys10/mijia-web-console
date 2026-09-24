import { withRouteDiagnostics } from "../../../../lib/ai/api/diagnostics.ts";
import { createChatHandler } from "../../../../lib/ai/api/chat.ts";
const chatHandler = createChatHandler();
const handler = withRouteDiagnostics("/api/ai/chat", request => chatHandler({ request, env: process.env }));
export async function POST(request: Request) { return handler(request); }
