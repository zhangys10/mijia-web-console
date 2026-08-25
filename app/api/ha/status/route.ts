import { NextResponse } from "next/server";
import { haRequest } from "../../../../lib/home-assistant";

export async function GET() {
  try {
    const config = await haRequest("/api/config");
    return NextResponse.json({ connected: true, name: config.location_name, version: config.version });
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    const status = message === "HOME_ASSISTANT_NOT_CONFIGURED" ? 503 : 502;
    return NextResponse.json({ connected: false, error: message }, { status });
  }
}
