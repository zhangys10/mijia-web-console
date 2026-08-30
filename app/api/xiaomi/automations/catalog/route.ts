import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { listDevices, listHomes, unseal, type XiaomiSession } from "../../../../../lib/xiaomi-cloud";
import { getMiotCapabilities } from "../../../../../lib/miot-spec";
import { isSceneWritableProperty } from "../../../../../lib/xiaomi-scene-properties";
import { assertHomeAccess } from "../../../../../lib/xiaomi-scenes";
import { listRawAutomations, parseAutomationTrigger, rawAutomationTriggers } from "../../../../../lib/xiaomi-automations";
import { sceneRecordId } from "../../../../../lib/xiaomi-scene-editor";

function text(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function validIdentifier(value: string | null) {
  return Boolean(value && value.length <= 128 && !/[\u0000-\u001f]/.test(value));
}

export async function GET(request: NextRequest) {
  try {
    const value = (await cookies()).get("xiaomi_session")?.value;
    if (!value) return NextResponse.json({ error: "XIAOMI_NOT_CONNECTED" }, { status: 401 });
    const homeId = request.nextUrl.searchParams.get("homeId");
    if (!validIdentifier(homeId)) return NextResponse.json({ error: "INVALID_HOME_ID" }, { status: 400 });
    const session = await unseal<XiaomiSession>(value);
    const homes = await listHomes(session);
    try { assertHomeAccess(homes, homeId!); }
    catch { return NextResponse.json({ error: "XIAOMI_HOME_NOT_FOUND" }, { status: 404 }); }
    const [response, automations] = await Promise.all([listDevices(session), listRawAutomations(session, homeId!)]);
    const devices = response.devices.filter(device => text(device.homeId ?? device.home_id) === homeId && text(device.did) && text(device.model));
    const specifications = new Map<string, Awaited<ReturnType<typeof getMiotCapabilities>>>();
    const catalog = [];
    for (const device of devices) {
      const model = text(device.model);
      const urnValue = device.urn ?? device.spec_type ?? device.miot_type;
      const urn = typeof urnValue === "string" && urnValue.startsWith("urn:") ? urnValue : undefined;
      const key = `${model}:${urn ?? ""}`;
      let specification = specifications.get(key);
      if (!specification) {
        try { specification = await getMiotCapabilities(model, urn); specifications.set(key, specification); }
        catch { continue; }
      }
      const deviceName = text(device.name) || model;
      const room = text(device.roomName ?? device.room_name) || "未分配";
      for (const group of specification.groups) {
        for (const property of group.properties) {
          if (!isSceneWritableProperty(group.name, property)) continue;
          catalog.push({
            key: `${text(device.did)}:${property.siid}.${property.piid}`,
            kind: "set-property",
            did: text(device.did), deviceName, room, model,
            serviceName: group.name, serviceLabel: group.label,
            siid: property.siid, piid: property.piid,
            propertyName: property.name, label: property.label,
            format: property.format,
            ...(property.range ? { range: property.range } : {}),
            ...(property.choices ? { choices: property.choices } : {}),
          });
        }
      }
    }
    const triggerTemplates = automations.flatMap(automation => rawAutomationTriggers(automation).map((trigger, sourceIndex) => ({ trigger, sourceIndex, automationId: sceneRecordId(automation) }))).map(item => {
      const parsed = parseAutomationTrigger(item.trigger);
      return { key: `${item.automationId}:${item.sourceIndex}`, automationId: item.automationId, sourceIndex: item.sourceIndex, kind: parsed.kind, label: parsed.label, ...(parsed.detail ? { detail: parsed.detail } : {}) };
    }).filter((item, index, values) => item.kind !== "schedule" && item.kind !== "unknown" && values.findIndex(candidate => candidate.kind === item.kind && candidate.label === item.label) === index);
    return NextResponse.json({
      ok: true,
      homeId,
      triggerKinds: [
        { kind: "schedule", label: "指定时间", writable: true },
        { kind: "sun", label: "日出或日落", writable: false },
        { kind: "device", label: "设备状态变化", writable: false },
        { kind: "weather", label: "天气变化", writable: false },
        { kind: "location", label: "到达或离开", writable: false },
      ],
      triggerTemplates,
      actions: catalog,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    console.error("[xiaomi-automation-catalog]", JSON.stringify({ error: message }));
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
