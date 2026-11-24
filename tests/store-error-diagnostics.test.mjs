import assert from "node:assert/strict";
import test from "node:test";

import { logStoreError, storeErrorDiagnostic } from "../lib/store-error-diagnostics.ts";
import { readClimateState } from "../lib/ai/climate/climate-store.ts";
import { readSpatialLayout } from "../lib/spatial-layout-store.ts";

test("Blob diagnostics expose bounded STS failure details without exception text", () => {
  const error = Object.assign(new Error('PagesBlob: failed to obtain STS credential: 401 {"message":"expired","token":"secret-token"}'), {
    name: "PagesBlobError",
    code: "CREDENTIAL_ERROR",
  });
  assert.deepEqual(storeErrorDiagnostic({ component: "spatial_layout", operation: "read_layout" }, error), {
    event: "edgeone_blob_call_failed",
    component: "spatial_layout",
    operation: "read_layout",
    category: "BLOB_STS_HTTP_ERROR",
    errorName: "PagesBlobError",
    errorCode: "CREDENTIAL_ERROR",
    upstreamStatus: 401,
    upstreamReason: "CREDENTIAL_EXPIRED",
  });
  assert.doesNotMatch(JSON.stringify(storeErrorDiagnostic({ component: "spatial_layout", operation: "read_layout" }, error)), /expired|secret-token/);
});

test("Blob diagnostics expose COS operation, status and request ID without object paths", () => {
  const error = Object.assign(new Error("PagesBlob: COS returned 403: GET https://tenant.blob-nocache.edgeone.site/private/home/hash/current.json - AccessDenied [request-id: req-12345678]"), {
    name: "PagesBlobError",
    code: "COS_ERROR",
  });
  assert.deepEqual(storeErrorDiagnostic({ component: "climate_memory", operation: "read_state" }, error), {
    event: "edgeone_blob_call_failed",
    component: "climate_memory",
    operation: "read_state",
    category: "BLOB_COS_ERROR",
    errorName: "PagesBlobError",
    errorCode: "COS_ERROR",
    upstreamStatus: 403,
    upstreamOperation: "GET",
    requestId: "req-12345678",
  });
  assert.doesNotMatch(JSON.stringify(storeErrorDiagnostic({ component: "climate_memory", operation: "read_state" }, error)), /tenant|private|current\.json|AccessDenied/);
});

test("Blob diagnostics retain only a bounded credential-exchange rejection code", () => {
  const error = Object.assign(new Error("PagesBlob: credential exchange failed (code=DEPLOY_CREDENTIAL_EXPIRED): private detail"), {
    name: "PagesBlobError",
    code: "CREDENTIAL_ERROR",
  });
  assert.deepEqual(storeErrorDiagnostic({ component: "assistant_exposure", operation: "read_exposure" }, error), {
    event: "edgeone_blob_call_failed",
    component: "assistant_exposure",
    operation: "read_exposure",
    category: "BLOB_STS_EXCHANGE_REJECTED",
    errorName: "PagesBlobError",
    errorCode: "CREDENTIAL_ERROR",
    upstreamCode: "DEPLOY_CREDENTIAL_EXPIRED",
    upstreamReason: "CREDENTIAL_EXPIRED",
  });
  assert.doesNotMatch(JSON.stringify(storeErrorDiagnostic({ component: "assistant_exposure", operation: "read_exposure" }, error)), /private detail/);
});

test("spatial and climate store failures emit diagnostics while keeping stable public errors", async context => {
  const lines = [];
  context.mock.method(console, "error", line => lines.push(line));
  const failure = Object.assign(new Error("PagesBlob: failed to obtain STS credential: 403 forbidden secret"), { name: "PagesBlobError", code: "CREDENTIAL_ERROR" });
  const store = { async get() { throw failure; } };

  await assert.rejects(() => readSpatialLayout("private-home", store), error => error.code === "SPATIAL_STORE_UNAVAILABLE" && error.status === 503);
  await assert.rejects(() => readClimateState("private-home", store), error => error.code === "AI_CLIMATE_STORE_UNAVAILABLE" && error.status === 503);
  assert.deepEqual(lines.map(line => JSON.parse(line)).map(record => [record.component, record.operation, record.upstreamStatus]), [
    ["spatial_layout", "read_layout", 403],
    ["climate_memory", "read_state", 403],
  ]);
  assert.doesNotMatch(lines.join("\n"), /private-home|forbidden secret/);
});

test("logStoreError serializes one structured record", context => {
  const lines = [];
  context.mock.method(console, "error", line => lines.push(line));
  logStoreError({ component: "spatial_layout", operation: "read_layout" }, new SyntaxError("private JSON"));
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).category, "BLOB_INVALID_JSON");
  assert.doesNotMatch(lines[0], /private JSON/);
});
