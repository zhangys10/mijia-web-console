import { NextResponse } from "next/server";
import { haRequest, publicEntities } from "../../../../lib/home-assistant";

export async function GET() {
  try {
    const entities = await haRequest("/api/states");
    return NextResponse.json({ entities: publicEntities(entities) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    return NextResponse.json({ error: message }, { status: message === "HOME_ASSISTANT_NOT_CONFIGURED" ? 503 : 502 });
  }
}
