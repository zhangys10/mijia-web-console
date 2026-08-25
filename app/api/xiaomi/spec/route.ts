import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { getMiotCapabilities } from "../../../../lib/miot-spec";
import { analyzeSwitchBindingCapabilities } from "../../../../lib/switch-bindings";

export async function GET(request: NextRequest) {
  const session = (await cookies()).get("xiaomi_session")?.value;
  if (!session) return NextResponse.json({ error: "XIAOMI_NOT_CONNECTED" }, { status: 401 });
  const model = request.nextUrl.searchParams.get("model") ?? "";
  const urn = request.nextUrl.searchParams.get("urn") ?? undefined;
  try {
    const specification = await getMiotCapabilities(model, urn);
    return NextResponse.json({ ok: true, ...specification, binding: analyzeSwitchBindingCapabilities(specification.model, specification.groups) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "MIOT_SPEC_UNAVAILABLE";
    console.error("[xiaomi-spec]", JSON.stringify({ model, error: message }));
    return NextResponse.json({ ok: false, error: message }, { status: message === "INVALID_DEVICE_MODEL" ? 400 : 502 });
  }
}
