import { createChatHandler } from "../../../../edge-functions/api/ai/chat";

const handler = createChatHandler();

export async function POST(request: Request) {
  return handler({ request, env: process.env });
}
