import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { unseal, type XiaomiSession } from "../../../../lib/xiaomi-cloud";

export async function GET() {
  try {
    const value = (await cookies()).get("xiaomi_session")?.value;
    if (!value) return NextResponse.json({ connected: false });
    const session = await unseal<XiaomiSession>(value);
    return NextResponse.json({ connected: true, region: session.region, userId: `••••${session.userId.slice(-4)}` });
  } catch { return NextResponse.json({ connected: false, error: "INVALID_SESSION" }, { status: 401 }); }
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.delete("xiaomi_session");
  response.cookies.delete("xiaomi_qr");
  return response;
}
