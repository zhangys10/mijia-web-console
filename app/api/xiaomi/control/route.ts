import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { unseal, xiaomiRequest, type XiaomiSession } from "../../../../lib/xiaomi-cloud";

function propertyResult(response: Record<string, unknown>) {
  const items = response.result;
  if (!Array.isArray(items) || !items.length) throw new Error("XIAOMI_DEVICE_RESPONSE_INVALID");
  const item = items[0] as Record<string, unknown>;
  if (typeof item.code === "number" && item.code !== 0) throw new Error(`XIAOMI_PROPERTY_CODE_${item.code}`);
  return item;
}

export async function GET(request: NextRequest) {
  try {
    const value = (await cookies()).get("xiaomi_session")?.value;
    if (!value) return NextResponse.json({ error: "XIAOMI_NOT_CONNECTED" }, { status: 401 });
    const did = request.nextUrl.searchParams.get("did");
    const siid = Number(request.nextUrl.searchParams.get("siid") ?? 2);
    const piid = Number(request.nextUrl.searchParams.get("piid") ?? 1);
    if (!did || !Number.isInteger(siid) || !Number.isInteger(piid) || siid < 1 || piid < 1) return NextResponse.json({ error: "INVALID_DEVICE_COMMAND" }, { status: 400 });
    const response = await xiaomiRequest(await unseal<XiaomiSession>(value), "/app/miotspec/prop/get", { params: [{ did, siid, piid }] });
    const result = propertyResult(response);
    return NextResponse.json({ ok: true, value: result.value, siid, piid });
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    console.error("[xiaomi-control-read]", JSON.stringify({ error: message }));
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const value = (await cookies()).get("xiaomi_session")?.value;
    if (!value) return NextResponse.json({ error: "XIAOMI_NOT_CONNECTED" }, { status: 401 });
    const body = await request.json();
    if (typeof body.did !== "string" || !body.did) return NextResponse.json({ error: "INVALID_DEVICE_COMMAND" }, { status: 400 });
    const siid = Number(body.siid ?? 2);
    if (!Number.isInteger(siid) || siid < 1) return NextResponse.json({ error: "INVALID_PROPERTY_MAPPING" }, { status: 400 });
    if (body.action === true) {
      const aiid = Number(body.aiid);
      if (!Number.isInteger(aiid) || aiid < 1) return NextResponse.json({ error: "INVALID_PROPERTY_MAPPING" }, { status: 400 });
      const response = await xiaomiRequest(await unseal<XiaomiSession>(value), "/app/miotspec/action", { did: body.did, siid, aiid, in: Array.isArray(body.params) ? body.params : [] });
      const result = response.result as Record<string, unknown> | undefined;
      if (result && typeof result.code === "number" && result.code !== 0) throw new Error(`XIAOMI_PROPERTY_CODE_${result.code}`);
      return NextResponse.json({ ok: true, result });
    }
    if (!["boolean", "number", "string"].includes(typeof body.value) || (typeof body.value === "number" && !Number.isFinite(body.value))) return NextResponse.json({ error: "INVALID_DEVICE_COMMAND" }, { status: 400 });
    const piid = Number(body.piid ?? 1);
    if (!Number.isInteger(piid) || piid < 1) return NextResponse.json({ error: "INVALID_PROPERTY_MAPPING" }, { status: 400 });
    const response = await xiaomiRequest(await unseal<XiaomiSession>(value), "/app/miotspec/prop/set", { params: [{ did: body.did, siid, piid, value: body.value }] });
    const result = propertyResult(response);
    return NextResponse.json({ ok: true, value: body.value, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    console.error("[xiaomi-control-write]", JSON.stringify({ error: message }));
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
