import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { pollQrLogin, seal, unseal, type XiaomiQrState } from "../../../../../lib/xiaomi-cloud";

export async function GET() {
  try {
    const value = (await cookies()).get("xiaomi_qr")?.value;
    if (!value) return NextResponse.json({ error: "XIAOMI_QR_MISSING" }, { status: 401 });
    const result = await pollQrLogin(await unseal<XiaomiQrState>(value));
    if (result.pending) return NextResponse.json({ pending: true });
    const response = NextResponse.json({ pending: false, connected: true, region: result.session.region, userId: result.session.userId.slice(-4) });
    response.cookies.set("xiaomi_session", await seal(result.session), { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 7 * 24 * 60 * 60 });
    response.cookies.delete("xiaomi_qr");
    return response;
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "UNKNOWN_ERROR" }, { status: 502 });
  }
}
