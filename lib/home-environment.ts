// Read-only home environment collector.
//
// Aggregates environmental readings (temperature, humidity, CO2, formaldehyde,
// PM2.5/PM10, TVOC, pressure, battery) from any supported device by resolving each
// device's public MIoT spec and reading only readable sensor properties. All returned
// data is sanitized: no DID, model string, siid/piid, or raw Xiaomi records survive.
// Shared by the browser dashboard API and the read-only get_home_status agent tool.

import { getMiotCapabilities, type MiotCapabilityGroup } from "./miot-spec.ts";
import { listDevices, xiaomiRequest, type XiaomiSession } from "./xiaomi-cloud.ts";

export type EnvironmentMetric =
  | "temperature"
  | "humidity"
  | "co2"
  | "formaldehyde"
  | "pm25"
  | "pm10"
  | "tvoc"
  | "pressure"
  | "battery";

export type EnvironmentReading = {
  value: number;
  unit: string;
  sourceLabel: string;
  roomName: string | null;
  capturedAt: string;
  freshness: "fresh" | "stale";
};

export type EnvironmentGroup = {
  metric: EnvironmentMetric;
  label: string;
  unit: string;
  latest: EnvironmentReading | null;
  readings: EnvironmentReading[];
};

export type EnvironmentSnapshot = {
  capturedAt: string;
  completeness: "complete" | "partial" | "empty";
  groups: EnvironmentGroup[];
  warnings: string[];
};

const metricUnits: Record<EnvironmentMetric, string> = {
  temperature: "°C",
  humidity: "%",
  co2: "ppm",
  formaldehyde: "mg/m³",
  pm25: "μg/m³",
  pm10: "μg/m³",
  tvoc: "mg/m³",
  pressure: "kPa",
  battery: "%",
};

const metricLabels: Record<EnvironmentMetric, string> = {
  temperature: "温度",
  humidity: "湿度",
  co2: "二氧化碳",
  formaldehyde: "甲醛",
  pm25: "PM2.5",
  pm10: "PM10",
  tvoc: "TVOC",
  pressure: "气压",
  battery: "电量",
};

const metricOrder: EnvironmentMetric[] = [
  "temperature",
  "humidity",
  "co2",
  "formaldehyde",
  "pm25",
  "pm10",
  "tvoc",
  "pressure",
  "battery",
];

// Conservative matchers: the property name must be exactly the metric semantic.
// Target/mode properties (e.g. air-conditioner target temperature) never match
// because their names differ, so a setting is never reported as a reading.
const metricMatchers: Array<{ metric: EnvironmentMetric; property: RegExp }> = [
  { metric: "temperature", property: /^(?:temperature|temp)$/i },
  { metric: "humidity", property: /^(?:relative-humidity|humidity)$/i },
  { metric: "co2", property: /^(?:co2|carbon-dioxide)(?:-density)?$/i },
  { metric: "formaldehyde", property: /^(?:formaldehyde|hcho)(?:-density)?$/i },
  { metric: "pm25", property: /^pm2(?:\.5)?(?:-density)?$/i },
  { metric: "pm10", property: /^pm10(?:-density)?$/i },
  { metric: "tvoc", property: /^tvoc(?:-density)?$/i },
  { metric: "pressure", property: /^pressure$/i },
  { metric: "battery", property: /^(?:battery-level|battery)$/i },
];

export function matchEnvironmentMetric(propertyName: string): EnvironmentMetric | null {
  for (const matcher of metricMatchers) {
    if (matcher.property.test(propertyName)) return matcher.metric;
  }
  return null;
}

// A declared unit must be plausible for the metric; undeclared units are accepted
// because many MIoT sensor specs omit them.
const unitAliases: Record<EnvironmentMetric, RegExp> = {
  temperature: /^(?:celsius|℃|°c)$/i,
  humidity: /^(?:percentage|%|rh)$/i,
  co2: /^ppm$/i,
  formaldehyde: /^(?:mg\/m3|mg\/m³|ppm|ppb|μg\/m3|μg\/m³|ug\/m3)$/i,
  pm25: /^(?:μg\/m3|μg\/m³|ug\/m3)$/i,
  pm10: /^(?:μg\/m3|μg\/m³|ug\/m3)$/i,
  tvoc: /^(?:mg\/m3|mg\/m³|ppm|ppb)$/i,
  pressure: /^(?:kpa|pa|hpa)$/i,
  battery: /^(?:percentage|%)$/i,
};

export function environmentUnitMatches(metric: EnvironmentMetric, unit: string | undefined) {
  return unit === undefined || unitAliases[metric].test(unit);
}

// Normalize a raw value into the metric's canonical unit. Formaldehyde sensors
// commonly report ppb (or μg/m³) while the national standard limit is quoted in
// mg/m³ — keep the conversion explicit so a card never shows a raw ppb number
// labelled mg/m³. 甲醛: 1 ppb ≈ 1.247 µg/m³ (25 °C, 101.3 kPa); 1000 µg/m³ = 1 mg/m³.
const unitNormalizers: Partial<Record<EnvironmentMetric, (raw: number, unit: string | undefined) => number>> = {
  formaldehyde: (raw, unit) => {
    const declared = (unit ?? "").trim();
    if (/^ppb$/i.test(declared)) return raw * 1.247 / 1000;
    if (/^(?:μg\/m3|μg\/m³|ug\/m3)$/i.test(declared)) return raw / 1000;
    return raw;
  },
  pressure: (raw, unit) => {
    const declared = (unit ?? "").trim();
    if (/^pa$/i.test(declared)) return raw / 1000;
    if (/^hpa$/i.test(declared)) return raw;
    return raw;
  },
};

function normalizeEnvironmentValue(metric: EnvironmentMetric, raw: number, unit: string | undefined) {
  const normalize = unitNormalizers[metric];
  return normalize ? normalize(raw, unit) : raw;
}

function text(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function deviceModel(device: Record<string, unknown>) {
  return text(device.model);
}

function deviceUrn(device: Record<string, unknown>) {
  const value = device.urn ?? device.spec_type ?? device.miot_type;
  return typeof value === "string" && value.startsWith("urn:") ? value : undefined;
}

function isOnline(device: Record<string, unknown>) {
  const value = device.isOnline ?? device.is_online ?? device.online;
  return value === undefined ? true : Boolean(value);
}

function chunks<T>(values: T[], size: number) {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));
}

function sanitizeNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1_000_000) return null;
  return value;
}

function truncateLabel(value: string, max: number) {
  const clean = value.replace(/[\u0000-\u001f]/g, " ").trim();
  return clean.length > max ? clean.slice(0, max) : clean;
}

// A planned sensor read: which device property feeds which metric.
export type PlannedEnvironmentRead = {
  metric: EnvironmentMetric;
  did: string;
  siid: number;
  piid: number;
  sourceLabel: string;
  roomName: string | null;
  declaredUnit?: string;
};

// Pure: choose one readable property per metric per device from a device's spec.
export function planEnvironmentReads(
  device: Record<string, unknown>,
  groups: MiotCapabilityGroup[],
): PlannedEnvironmentRead[] {
  const did = text(device.did);
  const plans: PlannedEnvironmentRead[] = [];
  if (!did) return plans;
  const used = new Set<EnvironmentMetric>();
  for (const group of groups) {
    for (const property of group.properties) {
      if (!property.readable) continue;
      const metric = matchEnvironmentMetric(property.name);
      if (!metric || used.has(metric)) continue;
      if (!environmentUnitMatches(metric, property.unit)) continue;
      used.add(metric);
      plans.push({
        metric,
        did,
        siid: property.siid,
        piid: property.piid,
        sourceLabel: truncateLabel(text(device.name) || metricLabels[metric], 200),
        roomName: text(device.roomName) ? truncateLabel(text(device.roomName), 200) : null,
        declaredUnit: property.unit,
      });
    }
  }
  return plans;
}

// Pure: assemble the sanitized snapshot. Readings come in already keyed by plan;
// missing/invalid values are reported through counts, never as zero values.
export function buildEnvironmentSnapshot(input: {
  capturedAt: string;
  planned: PlannedEnvironmentRead[];
  values: Array<{ metric: EnvironmentMetric; sourceLabel: string; roomName: string | null; value: number; declaredUnit?: string }>;
  specificationFailureCount: number;
  failedBatchCount: number;
  failedReadCount?: number;
}): EnvironmentSnapshot {
  const warnings: string[] = [];
  if (input.specificationFailureCount > 0) warnings.push("部分设备规格解析失败，相关读数缺失。");
  if (input.failedBatchCount > 0 || (input.failedReadCount ?? 0) > 0) warnings.push("部分设备读数暂时不可用。");

  const grouped = new Map<EnvironmentMetric, EnvironmentReading[]>();
  for (const item of input.values) {
    const reading: EnvironmentReading = {
      // Values are normalized into the metric's canonical unit so a ppb/µg reading
      // never appears under an mg/m³ label.
      value: normalizeEnvironmentValue(item.metric, item.value, item.declaredUnit),
      unit: metricUnits[item.metric],
      sourceLabel: item.sourceLabel,
      roomName: item.roomName,
      capturedAt: input.capturedAt,
      freshness: "fresh",
    };
    const list = grouped.get(item.metric) ?? [];
    list.push(reading);
    grouped.set(item.metric, list);
  }

  const groups: EnvironmentGroup[] = metricOrder
    .filter(metric => grouped.has(metric))
    .map(metric => {
      const readings = grouped.get(metric) ?? [];
      return { metric, label: metricLabels[metric], unit: metricUnits[metric], latest: readings[0] ?? null, readings };
    });

  const completeness = input.values.length === 0
    ? "empty"
    : input.values.length < input.planned.length || warnings.length > 0
      ? "partial"
      : "complete";
  return { capturedAt: input.capturedAt, completeness, groups, warnings };
}

export type HomeEnvironmentDiagnostics = {
  candidateDevices: number;
  specifications: number;
  specificationFailures: number;
  plannedReads: number;
  failedBatches: number;
  missingResults: number;
  nonzeroResults: number;
  nonzeroResultDetails: Array<{ metric: EnvironmentMetric; code: number | null; count: number }>;
  invalidValues: number;
  acceptedValues: number;
};

export type HomeEnvironmentDependencies = {
  listDevices?: typeof listDevices;
  getCapabilities?: typeof getMiotCapabilities;
  readProperties?: (session: XiaomiSession, params: Array<{ did: string; siid: number; piid: number }>) => Promise<Array<Record<string, unknown>>>;
  onDiagnostics?: (diagnostics: HomeEnvironmentDiagnostics) => void;
};

export async function collectHomeEnvironment(
  session: XiaomiSession,
  homeId: string,
  dependencies: HomeEnvironmentDependencies = {},
  filter?: { rooms: readonly string[]; metrics: readonly EnvironmentMetric[]; roomMetrics?: Record<string, readonly EnvironmentMetric[]> },
): Promise<EnvironmentSnapshot> {
  const listDevicesImpl = dependencies.listDevices ?? listDevices;
  const getCapabilitiesImpl = dependencies.getCapabilities ?? getMiotCapabilities;
  const readPropertiesImpl = dependencies.readProperties ?? defaultReadProperties;

  const discovery = await listDevicesImpl(session);
  // Empty homeId means "the account's first home" (browser default); the agent tool
  // always supplies an explicit, membership-checked homeId.
  const targetHomeId = homeId || String(discovery.homes[0]?.id ?? "");
  if (!targetHomeId || !discovery.homes.some(home => home.id === targetHomeId)) {
    throw new Error("AI_HOME_FORBIDDEN");
  }
  const candidates = discovery.devices
    .filter(device => text(device.homeId ?? device.home_id) === targetHomeId)
    .filter(device => !filter || filter.rooms.includes(text(device.roomName) || "未分配"))
    .filter(device => deviceModel(device) && isOnline(device));

  const specKeys = new Map<string, { model: string; urn?: string }>();
  for (const device of candidates) {
    specKeys.set(`${deviceModel(device)}:${deviceUrn(device) ?? ""}`, { model: deviceModel(device), urn: deviceUrn(device) });
  }
  const specifications = new Map<string, MiotCapabilityGroup[]>();
  let specificationFailures = 0;
  await Promise.all([...specKeys.entries()].map(async ([key, item]) => {
    try {
      specifications.set(key, (await getCapabilitiesImpl(item.model, item.urn)).groups);
    } catch {
      specificationFailures += 1;
      specifications.set(key, []);
    }
  }));

  const planned = candidates.flatMap(device =>
    planEnvironmentReads(device, specifications.get(`${deviceModel(device)}:${deviceUrn(device) ?? ""}`) ?? [])
      .filter(read => !filter || filter.metrics.includes(read.metric))
      .filter(read => !filter?.roomMetrics || (filter.roomMetrics[text(device.roomName) || "未分配"] ?? []).includes(read.metric)),
  );
  if (!planned.length) {
    dependencies.onDiagnostics?.({
      candidateDevices: candidates.length,
      specifications: specKeys.size,
      specificationFailures,
      plannedReads: 0,
      failedBatches: 0,
      missingResults: 0,
      nonzeroResults: 0,
      nonzeroResultDetails: [],
      invalidValues: 0,
      acceptedValues: 0,
    });
    return buildEnvironmentSnapshot({
      capturedAt: new Date().toISOString(),
      planned,
      values: [],
      specificationFailureCount: specificationFailures,
      failedBatchCount: 0,
    });
  }

  // Batch-read the planned properties (read-only, batches of 40). A failed batch
  // only means those readings are missing; it never fabricates zero values.
  let failedBatches = 0;
  const batches = chunks(planned.map(({ did, siid, piid }) => ({ did, siid, piid })), 40);
  const results = (await Promise.all(batches.map(async batch => {
    try {
      return await readPropertiesImpl(session, batch);
    } catch {
      failedBatches += 1;
      return [];
    }
  }))).flat();

  const returned = new Map<string, { code: number; value: unknown }>();
  for (const item of results) {
    returned.set(`${text(item.did)}:${Number(item.siid)}:${Number(item.piid)}`, {
      code: Number(item.code ?? 0),
      value: item.value,
    });
  }
  let missingResults = 0;
  let nonzeroResults = 0;
  let invalidValues = 0;
  const nonzeroResultCounts = new Map<string, { metric: EnvironmentMetric; code: number | null; count: number }>();
  const values = planned
    .map(plan => ({ plan, raw: returned.get(`${plan.did}:${plan.siid}:${plan.piid}`) }))
    .flatMap(({ plan, raw }) => {
      if (!raw) { missingResults += 1; return []; }
      if (raw.code !== 0) {
        nonzeroResults += 1;
        const code = Number.isInteger(raw.code) ? raw.code : null;
        const key = `${plan.metric}:${code ?? "unknown"}`;
        const detail = nonzeroResultCounts.get(key) ?? { metric: plan.metric, code, count: 0 };
        detail.count += 1;
        nonzeroResultCounts.set(key, detail);
        return [];
      }
      const value = sanitizeNumber(raw.value);
      if (value === null) { invalidValues += 1; return []; }
      return [{
        metric: plan.metric,
        sourceLabel: plan.sourceLabel,
        roomName: plan.roomName,
        value,
        declaredUnit: plan.declaredUnit,
      }];
    });

  dependencies.onDiagnostics?.({
    candidateDevices: candidates.length,
    specifications: specKeys.size,
    specificationFailures,
    plannedReads: planned.length,
    failedBatches: failedBatches,
    missingResults,
    nonzeroResults,
    nonzeroResultDetails: [...nonzeroResultCounts.values()],
    invalidValues,
    acceptedValues: values.length,
  });

  return buildEnvironmentSnapshot({
    capturedAt: new Date().toISOString(),
    planned,
    values,
    specificationFailureCount: specificationFailures,
    failedBatchCount: failedBatches,
    failedReadCount: missingResults + nonzeroResults + invalidValues,
  });
}

async function defaultReadProperties(session: XiaomiSession, params: Array<{ did: string; siid: number; piid: number }>) {
  const response = await xiaomiRequest(session, "/app/miotspec/prop/get", { params });
  if (!Array.isArray(response.result)) throw new Error("XIAOMI_DEVICE_RESPONSE_INVALID");
  return response.result as Array<Record<string, unknown>>;
}
