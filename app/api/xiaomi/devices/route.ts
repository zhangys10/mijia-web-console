import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { errorCode, runtimeDiagnostic, syncXiaomiDevices } from "../../../../lib/device-sync";
import { listDevices, readXiaomiSession, xiaomiErrorInfo } from "../../../../lib/xiaomi-cloud";
import { listRawManualScenes, loadSceneActionCapabilities, parseManualScenes } from "../../../../lib/xiaomi-scenes";

function validIdentifier(value: string | null) {
  return Boolean(value && value.length <= 128 && !/[\u0000-\u001f]/.test(value));
}

export async function GET(request: NextRequest) {
  const startedAt = Date.now();
  try {
    const requestedHomeId = request.nextUrl.searchParams.get("homeId");
    const includeScenes = request.nextUrl.searchParams.get("includeScenes") === "1";
    if (requestedHomeId && !validIdentifier(requestedHomeId)) return NextResponse.json({ error: "INVALID_HOME_ID", retryable: false }, { status: 400 });
    const value = (await cookies()).get("xiaomi_session")?.value;
    if (!value) return NextResponse.json({ error: "XIAOMI_NOT_CONNECTED" }, { status: 401 });
    const session = await readXiaomiSession(value, process.env.XIAOMI_SESSION_SECRET);
    const discoveryStartedAt = Date.now();
    const result = await listDevices(session);
    const discoveryDurationMs = Date.now() - discoveryStartedAt;
    const runtimeStartedAt = Date.now();
    const sync = await syncXiaomiDevices(session, result, process.env.XIAOMI_RUNTIME_DEBUG === "1");
    const runtimeDurationMs = Date.now() - runtimeStartedAt;
    const { runtime } = sync;
    for (const mapped of new Set([...sync.topology.values()])) {
      for (const channel of mapped.channels) {
        runtimeDiagnostic("channel-control-classified", {
          siid: channel.channelSiid,
          modeCapability: channel.modeCapability,
          controlObjectStatus: channel.controlObjectStatus,
          controlObjectComplete: channel.controlObjectComplete,
          objectCount: channel.controlObjects.length,
          classification: channel.classification,
        }, process.env.XIAOMI_RUNTIME_DEBUG === "1");
      }
    }
    const devices = sync.devices;
    const selectedHomeId = result.homes.some(home => home.id === requestedHomeId) ? requestedHomeId! : result.homes[0]?.id ?? null;
    const warnings: Array<{ code: string; scope: "devices" | "properties" | "specifications" | "scenes"; retryable: boolean; retryAfterSeconds?: number }> = [...result.warnings];
    if (sync.groupMembership.error) {
      const failure = xiaomiErrorInfo(sync.groupMembership.error);
      warnings.push({ code: errorCode(sync.groupMembership.error), scope: "devices", retryable: failure.retryable, ...(failure.retryAfterSeconds ? { retryAfterSeconds: failure.retryAfterSeconds } : {}) });
    }
    if (runtime.timedOut) warnings.push({ code: "XIAOMI_RUNTIME_STATE_TIMEOUT", scope: "properties", retryable: true, retryAfterSeconds: 8 });
    if (runtime.failedPropertyBatchCount > 0) warnings.push({ code: "XIAOMI_PROPERTIES_PARTIAL", scope: "properties", retryable: runtime.retryablePropertyBatchCount > 0 });
    if (runtime.specificationFailureCount > 0) warnings.push({ code: "MIOT_SPECIFICATIONS_PARTIAL", scope: "specifications", retryable: false });
    let scenes;
    let sceneDurationMs = 0;
    let sceneAttemptCount = 0;
    let scenesCompleteness: "complete" | "partial" | "not-requested" = "not-requested";
    if (includeScenes && selectedHomeId) {
      const sceneStartedAt = Date.now();
      sceneAttemptCount = 1;
      try {
        const rawScenes = await listRawManualScenes(session, selectedHomeId);
        const sceneCapabilities = await loadSceneActionCapabilities(rawScenes, selectedHomeId, runtime.sceneCapabilities);
        scenes = parseManualScenes({ result: rawScenes }, selectedHomeId, result.devices, sceneCapabilities);
        scenesCompleteness = "complete";
      } catch (error) {
        const failure = xiaomiErrorInfo(error);
        warnings.push({ code: errorCode(error), scope: "scenes", retryable: failure.retryable, ...(failure.retryAfterSeconds ? { retryAfterSeconds: failure.retryAfterSeconds } : {}) });
        scenesCompleteness = "partial";
      } finally {
        sceneDurationMs = Date.now() - sceneStartedAt;
      }
    }
    const capturedAt = new Date().toISOString();
    const diagnostic = {
      vercelRegion: process.env.VERCEL_REGION ?? null,
      sessionRegion: session.region,
      durationMs: Date.now() - startedAt,
      discoveryDurationMs,
      runtimeDurationMs,
      sceneDurationMs,
      deviceRequestAttemptCount: result.requestAttemptCount,
      groupRequestAttemptCount: sync.groupRequestAttemptCount,
      propertyRequestAttemptCount: runtime.propertyBatchCount,
      sceneRequestAttemptCount: sceneAttemptCount,
      totalXiaomiRequestAttemptCount: result.requestAttemptCount + sync.groupRequestAttemptCount + runtime.propertyBatchCount + sceneAttemptCount,
      successfulHomeCount: result.successfulHomeCount,
      failedHomeCount: result.failedHomeCount,
      propertyBatchFailureCount: runtime.failedPropertyBatchCount,
      runtimeTimedOut: runtime.timedOut,
      warningCount: warnings.length,
    };
    console.info("[xiaomi-sync]", JSON.stringify(diagnostic));
    return NextResponse.json({
      homes: result.homes,
      devices,
      selectedHomeId,
      ...(scenes ? { scenes } : {}),
      capturedAt,
      stateCapturedAt: capturedAt,
      completeness: {
        devices: result.completeness,
        properties: runtime.timedOut || runtime.failedPropertyBatchCount > 0 ? "partial" : "complete",
        specifications: runtime.timedOut || runtime.specificationFailureCount > 0 ? "partial" : "complete",
        scenes: scenesCompleteness,
      },
      warnings,
    });
  } catch (error) {
    const failure = xiaomiErrorInfo(error);
    console.error("[xiaomi-devices]", JSON.stringify({
      vercelRegion: process.env.VERCEL_REGION ?? null,
      durationMs: Date.now() - startedAt,
      error: failure.message,
    }));
    if (failure.status === 401) (await cookies()).delete("xiaomi_session");
    const headers = failure.retryAfterSeconds ? { "Retry-After": String(failure.retryAfterSeconds) } : undefined;
    return NextResponse.json({ error: failure.message, retryable: failure.retryable, ...(failure.retryAfterSeconds ? { retryAfterSeconds: failure.retryAfterSeconds } : {}) }, { status: failure.status, headers });
  }
}
