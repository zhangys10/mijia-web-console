import assert from "node:assert/strict";
import test from "node:test";
import { chunkXiaomiPropertyReads, parseXiaomiPropertyReadBatch } from "../lib/xiaomi-property-batch.ts";

test("property batch reads deduplicate addresses while retaining device scope", () => {
  assert.deepEqual(parseXiaomiPropertyReadBatch({ requests: [
    { did: "device-1", properties: [{ siid: 2, piid: 1 }, { siid: 2, piid: 1 }, { siid: 3, piid: 2 }] },
    { did: "device-2", properties: [{ siid: 2, piid: 1 }] },
  ] }), [
    { did: "device-1", siid: 2, piid: 1 },
    { did: "device-1", siid: 3, piid: 2 },
    { did: "device-2", siid: 2, piid: 1 },
  ]);
});

test("property batch reads reject malformed and unbounded requests", () => {
  assert.throws(() => parseXiaomiPropertyReadBatch({ requests: [] }), /INVALID_PROPERTY_BATCH/);
  assert.throws(() => parseXiaomiPropertyReadBatch({ requests: [{ did: "device-1", properties: [{ siid: 0, piid: 1 }] }] }), /INVALID_PROPERTY_MAPPING/);
  assert.throws(() => parseXiaomiPropertyReadBatch({ requests: [{ did: "device-1", properties: [{ siid: "2", piid: 1 }] }] }), /INVALID_PROPERTY_MAPPING/);
  assert.throws(() => parseXiaomiPropertyReadBatch({ requests: [{ did: "device-1", properties: Array.from({ length: 201 }, (_, index) => ({ siid: index + 1, piid: 1 })) }] }), /INVALID_PROPERTY_BATCH/);
});

test("property reads are split into Xiaomi-compatible groups of forty", () => {
  const properties = Array.from({ length: 81 }, (_, index) => ({ did: `device-${index}`, siid: 2, piid: 1 }));
  assert.deepEqual(chunkXiaomiPropertyReads(properties).map(batch => batch.length), [40, 40, 1]);
});
