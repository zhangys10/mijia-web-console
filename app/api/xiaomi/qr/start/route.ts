import { NextRequest, NextResponse } from "next/server";
import { seal, startQrLogin } from "../../../../../lib/xiaomi-cloud";

export async function POST(request: NextRequest) {
  try {
    const { region = "cn" } = await request.json();
    const state = await startQrLogin(String(region));
    const response = NextResponse.json({ ok: true, imageUrl: "/api/xiaomi/qr/image", loginUrl: state.loginUrl, expiresIn: 300, region: state.region });
    response.cookies.set("xiaomi_qr", await seal(state), { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 300 });
    return response;
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "UNKNOWN_ERROR" }, { status: 502 });
  }
}
