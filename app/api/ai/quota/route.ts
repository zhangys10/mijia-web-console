import { onRequest as quotaHandler } from "../../../../edge-functions/api/ai/quota";

export async function GET(request: Request) {
  return quotaHandler({ request, env: process.env });
}
