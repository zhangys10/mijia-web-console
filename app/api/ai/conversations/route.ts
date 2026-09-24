import { withRouteDiagnostics } from "../../../../lib/ai/api/diagnostics.ts";
import { createConversationHandler } from "../../../../lib/ai/api/conversations.ts";
const conversationHandler = createConversationHandler();
const handler = withRouteDiagnostics("/api/ai/conversations", request => conversationHandler({ request, env: process.env }));
export async function POST(request: Request) { return handler(request); }
