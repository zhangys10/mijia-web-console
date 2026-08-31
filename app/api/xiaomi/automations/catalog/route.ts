import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { listDevices, listHomeContexts, unseal, type XiaomiSession } from "../../../../../lib/xiaomi-cloud";
import { parseDerivedDeviceId } from "../../../../../lib/device-topology";
import { getMiotCapabilities, listMiotAutomationTriggerCapabilities } from "../../../../../lib/miot-spec";
import { isSceneWritableProperty } from "../../../../../lib/xiaomi-scene-properties";
import { assertHomeAccess } from "../../../../../lib/xiaomi-scenes";
import { buildAutomationTriggerCatalog, listRawAutomations } from "../../../../../lib/xiaomi-automations";
import { discoverDeviceAutomationCatalog } from "../../../../../lib/xiaomi-automation-catalog";

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
    const homes = await listHomeContexts(session);
    try { assertHomeAccess(homes, homeId!); }
    catch { return NextResponse.json({ error: "XIAOMI_HOME_NOT_FOUND" }, { status: 404 }); }
    const home = homes.find(item => item.id === homeId)!;
    const [response, automations] = await Promise.all([listDevices(session), listRawAutomations(session, homeId!)]);
    const devices = response.devices
      .filter(device => text(device.homeId ?? device.home_id) === homeId && text(device.did) && text(device.model))
      .filter((device, deviceIndex, candidates) => candidates.findIndex(candidate => text(candidate.did) === text(device.did)) === deviceIndex);
    const automationCatalogRequest = discoverDeviceAutomationCatalog(session, homeId!, home.ownerUid, devices.map((device, deviceIndex) => ({
      key: `device-${deviceIndex + 1}`,
      homeId: text(device.homeId ?? device.home_id),
      did: text(device.did),
      model: text(device.model),
      deviceName: text(device.name) || text(device.model) || "未命名设备",
      room: text(device.roomName ?? device.room_name) || "未分配",
    }))).catch(() => []);
    const specifications = new Map<string, Awaited<ReturnType<typeof getMiotCapabilities>>>();
    const catalog = [];
    const propertyDescriptions = [];
    const specificationTriggerDevices = [];
    for (const [deviceIndex, device] of devices.entries()) {
      const model = text(device.model);
      const urnValue = device.urn ?? device.spec_type ?? device.miot_type;
      const urn = typeof urnValue === "string" && urnValue.startsWith("urn:") ? urnValue : undefined;
      const key = `${model}:${urn ?? ""}`;
      let specification = specifications.get(key);
      if (!specification) {
        try { specification = await getMiotCapabilities(model, urn); specifications.set(key, specification); }
        catch {
          if (!parseDerivedDeviceId(text(device.did))) specificationTriggerDevices.push({
            key: `device-${deviceIndex + 1}`,
            deviceName: text(device.name) || model,
            room: text(device.roomName ?? device.room_name) || "未分配",
            capabilities: [],
            actions: [],
            discovery: "unavailable",
          });
          continue;
        }
      }
      const deviceName = text(device.name) || model;
      const room = text(device.roomName ?? device.room_name) || "未分配";
      if (!parseDerivedDeviceId(text(device.did))) specificationTriggerDevices.push({
        key: `device-${deviceIndex + 1}`,
        deviceName,
        room,
        capabilities: listMiotAutomationTriggerCapabilities(specification.groups).map(capability => ({ ...capability, source: "miot-spec" as const })),
        actions: [],
        discovery: "miot-spec",
      });
      for (const group of specification.groups) {
        for (const property of group.properties) {
          const editable = isSceneWritableProperty(group.name, property);
          propertyDescriptions.push({
            did: text(device.did),
            serviceLabel: group.label,
            siid: property.siid,
            piid: property.piid,
            label: property.label,
            format: property.format,
            editable,
            ...(property.range ? { range: property.range } : {}),
            ...(property.choices ? { choices: property.choices } : {}),
          });
          if (!editable) continue;
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
    const discoveredDevices = await automationCatalogRequest;
    const specificationDevicesByKey = new Map(specificationTriggerDevices.map(device => [device.key, device]));
    const discoveredKeys = new Set(discoveredDevices.map(device => device.key));
    const triggerDevices = [
      ...discoveredDevices.map(device => {
        const specificationDevice = specificationDevicesByKey.get(device.key);
        return device.discovery === "unavailable" && specificationDevice?.capabilities.length
          ? { ...device, capabilities: specificationDevice.capabilities, discovery: "miot-spec" as const }
          : device;
      }),
      ...specificationTriggerDevices.filter(device => !discoveredKeys.has(device.key)),
    ];
    const triggerTemplates = buildAutomationTriggerCatalog(automations, devices, homeId!);
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
      triggerDevices,
      actions: catalog,
      propertyDescriptions,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    console.error("[xiaomi-automation-catalog]", JSON.stringify({ error: message }));
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
