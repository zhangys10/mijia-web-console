import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { readXiaomiSession, xiaomiRequest } from "../../../../../lib/xiaomi-cloud";
import { chunkXiaomiPropertyReads, parseXiaomiPropertyReadBatch, type XiaomiPropertyAddress } from "../../../../../lib/xiaomi-property-batch";

type DeviceResult = { values: Record<string, unknown>; errors: Record<string, number | null> };
const responseHeaders = { "Cache-Control": "no-store" };

function invalidRequest(error: unknown) {
  return error instanceof SyntaxError || error instanceof Error && ["INVALID_PROPERTY_BATCH", "INVALID_PROPERTY_MAPPING"].includes(error.message);
}

export async function POST(request: NextRequest) {
  try {
    const value = (await cookies()).get("xiaomi_session")?.value;
    if (!value) return NextResponse.json({ error: "XIAOMI_NOT_CONNECTED" }, { status: 401, headers: responseHeaders });
    let properties: XiaomiPropertyAddress[];
    try { properties = parseXiaomiPropertyReadBatch(await request.json()); }
    catch (error) {
      if (invalidRequest(error)) return NextResponse.json({ error: error instanceof SyntaxError ? "INVALID_PROPERTY_BATCH" : (error as Error).message }, { status: 400, headers: responseHeaders });
      throw error;
    }
    const session = await readXiaomiSession(value, process.env.XIAOMI_SESSION_SECRET);
    const batches = chunkXiaomiPropertyReads(properties);
    let failedBatches = 0;
    const results = await Promise.all(batches.map(async batch => {
      try {
        const response = await xiaomiRequest(session, "/app/miotspec/prop/get", { params: batch });
        if (!Array.isArray(response.result)) throw new Error("XIAOMI_DEVICE_RESPONSE_INVALID");
        return { batch, entries: response.result as Array<Record<string, unknown>> };
      } catch {
        failedBatches += 1;
        return { batch, entries: [] };
      }
    }));
    const devices = Object.create(null) as Record<string, DeviceResult>;
    const deviceResult = (did: string) => devices[did] ??= { values: {}, errors: {} };
    for (const { batch, entries } of results) {
      if (!entries.length) {
        for (const property of batch) deviceResult(property.did).errors[`${property.siid}.${property.piid}`] = null;
        continue;
      }
      for (let index = 0; index < batch.length; index += 1) {
        const requested = batch[index], entry = entries[index] ?? {};
        const did = typeof entry.did === "string" && entry.did ? entry.did : requested.did;
        const siid = Number.isInteger(Number(entry.siid)) ? Number(entry.siid) : requested.siid;
        const piid = Number.isInteger(Number(entry.piid)) ? Number(entry.piid) : requested.piid;
        const key = `${siid}.${piid}`, code = Number(entry.code ?? 0);
        if (code !== 0) deviceResult(did).errors[key] = Number.isFinite(code) ? code : null;
        else deviceResult(did).values[key] = entry.value;
      }
    }
    if (failedBatches) console.warn("[xiaomi-control-batch-read]", JSON.stringify({ requestedProperties: properties.length, batchCount: batches.length, failedBatches }));
    return NextResponse.json({ ok: failedBatches === 0, partial: failedBatches > 0, devices, capturedAt: new Date().toISOString() }, { headers: responseHeaders });
  } catch (error) {
    console.error("[xiaomi-control-batch-read]", JSON.stringify({ errorName: error instanceof Error ? error.name : "UnknownError" }));
    return NextResponse.json({ ok: false, error: "XIAOMI_PROPERTY_BATCH_READ_FAILED" }, { status: 502, headers: responseHeaders });
  }
}
