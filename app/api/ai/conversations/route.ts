import { createConversationHandler } from "../../../../edge-functions/api/ai/conversations";

const handler = createConversationHandler();

export async function POST(request: Request) {
  return handler({ request, env: process.env });
}
