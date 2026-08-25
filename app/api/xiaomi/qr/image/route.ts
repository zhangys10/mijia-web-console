import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { loadQrImage, unseal, type XiaomiQrState } from "../../../../../lib/xiaomi-cloud";

export async function GET() {
  try {
    const value = (await cookies()).get("xiaomi_qr")?.value;
    if (!value) return NextResponse.json({ error: "XIAOMI_QR_MISSING" }, { status: 401 });
    const image = await loadQrImage(await unseal<XiaomiQrState>(value));
    return new Response(image.data, { headers: { "Content-Type": image.contentType, "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "UNKNOWN_ERROR" }, { status: 502 });
  }
}
