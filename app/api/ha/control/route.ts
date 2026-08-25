import { NextRequest, NextResponse } from "next/server";
import { assertEntityId, haRequest } from "../../../../lib/home-assistant";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { entityId, domain } = assertEntityId(body.entityId);
    const service = body.turnOn ? "turn_on" : "turn_off";
    const result = await haRequest(`/api/services/${domain}/${service}`, {
      method: "POST",
      body: JSON.stringify({ entity_id: entityId }),
    });
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    const status = message.startsWith("INVALID_") || message === "DOMAIN_NOT_ALLOWED" ? 400 : message === "HOME_ASSISTANT_NOT_CONFIGURED" ? 503 : 502;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
