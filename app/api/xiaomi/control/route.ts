import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { unseal, xiaomiRequest, type XiaomiSession } from "../../../../lib/xiaomi-cloud";

export async function POST(request: NextRequest) {
  try {
    const value = (await cookies()).get("xiaomi_session")?.value;
    if (!value) return NextResponse.json({ error: "XIAOMI_NOT_CONNECTED" }, { status: 401 });
    const body = await request.json();
    if (typeof body.did !== "string" || !body.did || typeof body.value !== "boolean") return NextResponse.json({ error: "INVALID_DEVICE_COMMAND" }, { status: 400 });
    const siid = Number(body.siid ?? 2), piid = Number(body.piid ?? 1);
    if (!Number.isInteger(siid) || !Number.isInteger(piid) || siid < 1 || piid < 1) return NextResponse.json({ error: "INVALID_PROPERTY_MAPPING" }, { status: 400 });
    const result = await xiaomiRequest(await unseal<XiaomiSession>(value), "/app/miotspec/prop/set", { params: [{ did: body.did, siid, piid, value: body.value }] });
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "UNKNOWN_ERROR" }, { status: 502 });
  }
}
