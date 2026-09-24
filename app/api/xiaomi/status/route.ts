import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { readXiaomiSession } from "../../../../lib/xiaomi-cloud";

export async function GET() {
  try {
    const value = (await cookies()).get("xiaomi_session")?.value;
    if (!value) return NextResponse.json({ connected: false });
    const session = await readXiaomiSession(value, process.env.XIAOMI_SESSION_SECRET);
    return NextResponse.json({ connected: true, region: session.region, userId: `••••${session.userId.slice(-4)}` });
  } catch (error) { return NextResponse.json({ connected: false, error: error instanceof Error ? error.message : "INVALID_SESSION" }, { status: 401 }); }
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.delete("xiaomi_session");
  response.cookies.delete("xiaomi_qr");
  return response;
}
