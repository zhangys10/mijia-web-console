export type XiaomiPropertyAddress = { did: string; siid: number; piid: number };
export type XiaomiPropertyReadRequest = { did: string; properties: Array<{ siid: number; piid: number }> };

const maximumDevices = 64;
const maximumProperties = 200;

export function parseXiaomiPropertyReadBatch(input: unknown): XiaomiPropertyAddress[] {
  if (!input || typeof input !== "object" || !("requests" in input) || !Array.isArray(input.requests)) throw new Error("INVALID_PROPERTY_BATCH");
  if (input.requests.length < 1 || input.requests.length > maximumDevices) throw new Error("INVALID_PROPERTY_BATCH");
  const result: XiaomiPropertyAddress[] = [];
  const seen = new Set<string>();
  for (const raw of input.requests) {
    if (!raw || typeof raw !== "object") throw new Error("INVALID_PROPERTY_BATCH");
    const request = raw as Partial<XiaomiPropertyReadRequest>;
    if (typeof request.did !== "string" || !request.did || request.did.trim() !== request.did || request.did.length > 128 || !Array.isArray(request.properties) || !request.properties.length) throw new Error("INVALID_PROPERTY_BATCH");
    for (const property of request.properties) {
      const siid = property?.siid, piid = property?.piid;
      if (typeof siid !== "number" || !Number.isInteger(siid) || siid < 1 || typeof piid !== "number" || !Number.isInteger(piid) || piid < 1) throw new Error("INVALID_PROPERTY_MAPPING");
      const key = `${request.did}\u0000${siid}.${piid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ did: request.did, siid, piid });
      if (result.length > maximumProperties) throw new Error("INVALID_PROPERTY_BATCH");
    }
  }
  return result;
}

export function chunkXiaomiPropertyReads(properties: XiaomiPropertyAddress[], size = 40) {
  if (!Number.isInteger(size) || size < 1 || size > 40) throw new Error("INVALID_PROPERTY_BATCH_SIZE");
  const chunks: XiaomiPropertyAddress[][] = [];
  for (let index = 0; index < properties.length; index += size) chunks.push(properties.slice(index, index + size));
  return chunks;
}
