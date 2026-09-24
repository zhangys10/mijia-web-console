import { withRouteDiagnostics } from "../../../../../lib/ai/api/diagnostics.ts";
import { createDeleteConversationHandler } from "../../../../../lib/ai/api/delete-conversation.ts";
const deleteHandler = createDeleteConversationHandler();
const handler = withRouteDiagnostics("/api/ai/conversations/:conversationId", request => deleteHandler({ request, env: process.env }));
export async function DELETE(request: Request) { return handler(request); }
