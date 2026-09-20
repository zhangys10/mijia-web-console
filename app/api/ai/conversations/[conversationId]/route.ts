import { createDeleteConversationHandler } from "../../../../../edge-functions/api/ai/conversations/[conversationId]";

const handler = createDeleteConversationHandler();

export async function DELETE(request: Request) {
  return handler({ request, env: process.env });
}
