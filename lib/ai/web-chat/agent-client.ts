import { withTimeout } from "../../abort-signals.ts";
import type { AgentSceneSummary } from "../tools/agent-scene-catalog.ts";
import type { EnvironmentSnapshot } from "../../home-environment.ts";
import type { DeviceStatus } from "../../device-status.ts";
import type { ModelUsage } from "../types.ts";
import type { QuotaSummary } from "../quota/quota-service.ts";
import type { AgentScope } from "../security/agent-binding.ts";

export type AgentRunResult = {
  requestId: string;
  conversationId: string;
  message: string;
  intent: "none" | "list_scenes" | "get_home_status" | "get_device_status" | "activate_scene";
  scenes?: AgentSceneSummary[];
  homeStatus?: EnvironmentSnapshot;
  deviceStatus?: DeviceStatus;
  tool?: {
    name: "list_scenes" | "get_home_status" | "get_device_status" | "activate_scene";
    status: "success" | "partial_success";
    sceneName?: string;
  };
  usage?: ModelUsage;
};

export type AgentClientRunInput = {
  conversationId: string;
  requestId: string;
  principalId: string;
  homeId: string;
  message: string;
  idempotencyKey: string;
  scopes: AgentScope[];
  automationToken: string;
  locale: string;
  timezone: string;
  signal?: AbortSignal;
};

export type AgentClientDeleteInput = {
  conversationId: string;
  requestId: string;
  principalId: string;
  homeId: string;
  scopes: AgentScope[];
  automationToken: string;
  signal?: AbortSignal;
};

export interface WebAgentClient {
  run(input: AgentClientRunInput): Promise<AgentRunResult & { quota?: QuotaSummary }>;
  deleteConversation(input: AgentClientDeleteInput): Promise<{ deleted: boolean }>;
}

export class AgentClientError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly retryAfterSeconds?: number;
  readonly quota?: { period: string; retryAfter: string };
  readonly usage?: AgentRunResult["usage"];
  readonly usageUnknown: boolean;

  constructor(
    code: string,
    message: string,
    httpStatus: number,
    options: {
      retryAfterSeconds?: number;
      quota?: { period: string; retryAfter: string };
      usage?: AgentRunResult["usage"];
      usageUnknown?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "AgentClientError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.quota = options.quota;
    this.usage = options.usage;
    this.usageUnknown = options.usageUnknown ?? false;
  }
}

type MakersAgentClientOptions = {
  baseUrl: string;
  internalSecret: string | undefined;
  fetchImpl?: typeof fetch;
};

const knownIntent = new Set(["none", "list_scenes", "get_home_status", "get_device_status", "activate_scene"]);
const knownTool = new Set(["list_scenes", "get_home_status", "get_device_status", "activate_scene"]);
const knownToolStatus = new Set(["success", "partial_success"]);
const knownDeviceState = new Set(["on", "off", "unknown"]);
const knownEnvironmentMetric = new Set([
  "temperature",
  "humidity",
  "co2",
  "formaldehyde",
  "pm25",
  "pm10",
  "tvoc",
  "pressure",
  "battery",
]);

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function responseBody(response: Response) {
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > 64 * 1024) return null;
  try {
    return objectRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

function mappedAgentError(body: Record<string, unknown> | null) {
  const code = typeof body?.code === "string" ? body.code : "";
  const retryAfterSeconds = Number.isSafeInteger(body?.retryAfterSeconds)
    ? body?.retryAfterSeconds as number
    : undefined;
  const usage = normalizeUsage(body?.usage);
  const usageUnknown = !usage && [
    "AI_GATEWAY_TIMEOUT",
    "AI_GATEWAY_UNAVAILABLE",
    "AI_AGENT_UNAVAILABLE",
    "AI_AGENT_CANCELLED",
    "AI_SCENE_FAILED",
    "AI_SCENE_TIMEOUT",
  ].includes(code);
  switch (code) {
    case "AI_QUOTA_EXCEEDED": {
      const quota = objectRecord(body?.quota);
      return new AgentClientError(code, "当前 AI 助手额度已用完，请稍后再试。", 429, {
        quota: quota
          && ["minute", "day", "month"].includes(String(quota.period))
          && typeof quota.retryAfter === "string"
          ? { period: String(quota.period), retryAfter: quota.retryAfter }
          : undefined,
      });
    }
    case "AI_QUOTA_STORE_UNAVAILABLE":
      return new AgentClientError(code, "配额存储暂时不可用", 503);
    case "AI_QUOTA_CONFIG_INVALID":
      return new AgentClientError(code, "配额配置无效", 500);
    case "AI_EXECUTION_STATUS_UNKNOWN":
      return new AgentClientError(code, "请求结果不确定，请检查状态", 409);
    case "AI_SCENE_EXECUTION_DISABLED":
      return new AgentClientError(code, "远程场景执行尚未启用", 403);
    case "AI_INVALID_REQUEST":
      return new AgentClientError(code, "AI 请求格式无效", 400);
    case "AI_SCOPE_FORBIDDEN":
      return new AgentClientError(code, "当前请求不允许执行设备动作", 403);
    case "AI_HOME_FORBIDDEN":
      return new AgentClientError(code, "当前账号无权访问该家庭", 403);
    case "AI_PREVIEW_READ_ONLY":
      return new AgentClientError(code, "当前预览环境只允许只读对话", 403);
    case "AI_SCENE_NOT_FOUND":
      return new AgentClientError(code, "未找到可用的审核场景", 400);
    case "AI_IDEMPOTENCY_CONFLICT":
      return new AgentClientError(code, "相同幂等键对应不同请求", 409);
    case "AI_REQUEST_IN_PROGRESS":
      return new AgentClientError(code, "相同请求仍在处理中", 409);
    case "AI_AGENT_STORE_UNAVAILABLE":
      return new AgentClientError(code, "AI 助手状态存储暂时不可用", 503);
    case "AI_GATEWAY_RATE_LIMITED":
      return new AgentClientError(code, "AI Gateway 限流，请稍后重试", 429, {
        retryAfterSeconds,
        usage,
      });
    case "AI_GATEWAY_TIMEOUT":
      return new AgentClientError(code, "AI Gateway 响应超时", 504, { usage, usageUnknown });
    case "AI_SCENE_FAILED":
      return new AgentClientError(code, "米家场景执行失败", 502, { usage, usageUnknown });
    case "AI_SCENE_TIMEOUT":
      return new AgentClientError(code, "米家场景执行超时", 504, { usage, usageUnknown });
    case "AI_AGENT_CANCELLED":
      return new AgentClientError(code, "请求已取消", 499, { usage, usageUnknown });
    default:
      return new AgentClientError(
        code.startsWith("AI_GATEWAY_") ? "AI_GATEWAY_UNAVAILABLE" : "AI_AGENT_UNAVAILABLE",
        code.startsWith("AI_GATEWAY_") ? "AI Gateway 暂时不可用" : "AI 助手暂时不可用",
        502,
        { usage, usageUnknown },
      );
  }
}

function normalizeUsage(value: unknown) {
  const usage = objectRecord(value);
  if (!usage) return undefined;
  const promptTokens = usage.promptTokens;
  const completionTokens = usage.completionTokens;
  const totalTokens = usage.totalTokens;
  if (
    !Number.isSafeInteger(promptTokens)
    || !Number.isSafeInteger(completionTokens)
    || !Number.isSafeInteger(totalTokens)
    || (promptTokens as number) < 0
    || (completionTokens as number) < 0
    || (totalTokens as number) < 0
  ) {
    return undefined;
  }
  return {
    promptTokens: promptTokens as number,
    completionTokens: completionTokens as number,
    totalTokens: totalTokens as number,
    estimated: usage.estimated === true,
  };
}

type NormalizedHomeStatus = NonNullable<AgentRunResult["homeStatus"]>;
type NormalizedHomeStatusReading = NormalizedHomeStatus["groups"][number]["readings"][number];

function normalizeHomeStatusReading(value: unknown): NormalizedHomeStatusReading | null {
  const reading = objectRecord(value);
  if (
    !reading
    || typeof reading.value !== "number"
    || !Number.isFinite(reading.value)
    || typeof reading.unit !== "string"
    || reading.unit.length > 24
    || typeof reading.sourceLabel !== "string"
    || !reading.sourceLabel
    || reading.sourceLabel.length > 200
    || (reading.capturedAt !== undefined && (typeof reading.capturedAt !== "string" || reading.capturedAt.length > 40))
    || (reading.roomName !== undefined && reading.roomName !== null && typeof reading.roomName !== "string")
  ) {
    return null;
  }
  return {
    value: reading.value,
    unit: reading.unit,
    sourceLabel: reading.sourceLabel,
    roomName: typeof reading.roomName === "string" ? reading.roomName : null,
    capturedAt: typeof reading.capturedAt === "string" ? reading.capturedAt : "",
    freshness: reading.freshness === "stale" ? "stale" : "fresh",
  };
}

function normalizeHomeStatus(value: unknown): NormalizedHomeStatus | undefined {
  const status = objectRecord(value);
  if (
    !status
    || typeof status.capturedAt !== "string"
    || status.capturedAt.length > 40
    || typeof status.completeness !== "string"
    || !["complete", "partial", "empty"].includes(status.completeness)
    || !Array.isArray(status.groups)
    || status.groups.length > 16
  ) {
    return undefined;
  }
  const groups = status.groups.flatMap((item): NormalizedHomeStatus["groups"] => {
    const group = objectRecord(item);
    const metric = typeof group?.metric === "string" && knownEnvironmentMetric.has(group.metric)
      ? group.metric as NormalizedHomeStatus["groups"][number]["metric"]
      : null;
    if (
      !group
      || !metric
      || typeof group.label !== "string"
      || !group.label
      || group.label.length > 40
      || typeof group.unit !== "string"
      || group.unit.length > 24
      || !Array.isArray(group.readings)
      || group.readings.length > 20
    ) {
      return [];
    }
    const readings = group.readings.flatMap((entry) => {
      const reading = normalizeHomeStatusReading(entry);
      return reading ? [reading] : [];
    });
    return [{
      metric,
      label: group.label,
      unit: group.unit,
      latest: readings[0] ?? null,
      readings,
    }];
  });
  const warnings = Array.isArray(status.warnings)
    ? status.warnings.flatMap((entry): string[] => (typeof entry === "string" && entry ? [entry.slice(0, 200)] : []))
    : [];
  return {
    capturedAt: status.capturedAt,
    completeness: status.completeness as NormalizedHomeStatus["completeness"],
    groups,
    warnings: warnings.slice(0, 8),
  };
}

type NormalizedDeviceStatus = NonNullable<AgentRunResult["deviceStatus"]>;

function normalizeDeviceStatus(value: unknown): NormalizedDeviceStatus | undefined {
  const status = objectRecord(value);
  if (
    !status
    || typeof status.capturedAt !== "string"
    || status.capturedAt.length > 40
    || typeof status.completeness !== "string"
    || !["complete", "partial", "empty"].includes(status.completeness)
    || !Number.isSafeInteger(status.poweredOn)
    || (status.poweredOn as number) < 0
    || !Array.isArray(status.rooms)
    || status.rooms.length > 20
  ) {
    return undefined;
  }
  const rooms = status.rooms.flatMap((item): NormalizedDeviceStatus["rooms"] => {
    const room = objectRecord(item);
    if (
      !room
      || typeof room.room !== "string"
      || !room.room
      || room.room.length > 200
      || !Array.isArray(room.items)
      || room.items.length > 40
    ) {
      return [];
    }
    const items = room.items.flatMap((entry): NormalizedDeviceStatus["rooms"][number]["items"] => {
      const device = objectRecord(entry);
      if (
        !device
        || typeof device.name !== "string"
        || !device.name
        || device.name.length > 200
        || typeof device.kind !== "string"
        || device.kind.length > 40
        || typeof device.state !== "string"
        || !knownDeviceState.has(device.state)
        || typeof device.online !== "boolean"
      ) {
        return [];
      }
      return [{
        name: device.name,
        kind: device.kind,
        state: device.state as NormalizedDeviceStatus["rooms"][number]["items"][number]["state"],
        online: device.online,
      }];
    });
    return items.length ? [{ room: room.room, items }] : [];
  });
  const warnings = Array.isArray(status.warnings)
    ? status.warnings.flatMap((entry): string[] => (typeof entry === "string" && entry ? [entry.slice(0, 200)] : []))
    : [];
  return {
    capturedAt: status.capturedAt,
    completeness: status.completeness as NormalizedDeviceStatus["completeness"],
    poweredOn: status.poweredOn as number,
    rooms,
    warnings: warnings.slice(0, 8),
  };
}

function normalizeAgentResult(
  body: Record<string, unknown> | null,
  expected: Pick<AgentClientRunInput, "requestId" | "conversationId">,
): AgentRunResult & { quota?: QuotaSummary } {
  if (
    !body
    || body.requestId !== expected.requestId
    || body.conversationId !== expected.conversationId
    || typeof body.message !== "string"
    || typeof body.intent !== "string"
    || !knownIntent.has(body.intent)
  ) {
    throw new AgentClientError("AI_AGENT_UNAVAILABLE", "AI 助手返回无效响应", 502);
  }

  const result: AgentRunResult & { quota?: QuotaSummary } = {
    requestId: body.requestId,
    conversationId: body.conversationId,
    message: body.message.slice(0, 2000),
    intent: body.intent as AgentRunResult["intent"],
    usage: normalizeUsage(body.usage),
    quota: body.quota === undefined ? undefined : normalizeQuota(body.quota),
  };
  if (Array.isArray(body.scenes)) {
    result.scenes = body.scenes.flatMap((item) => {
      const scene = objectRecord(item);
      return scene
        && typeof scene.alias === "string"
        && typeof scene.name === "string"
        && typeof scene.description === "string"
        && Number.isSafeInteger(scene.actionCount)
        && (scene.actionCount as number) >= 0
        ? [{
          alias: scene.alias,
          name: scene.name,
          description: scene.description,
          actionCount: scene.actionCount as number,
        }]
        : [];
    });
  }
  // Malformed status payloads are dropped (undefined), never partially trusted.
  if (body.homeStatus !== undefined) {
    result.homeStatus = normalizeHomeStatus(body.homeStatus);
  }
  if (body.deviceStatus !== undefined) {
    result.deviceStatus = normalizeDeviceStatus(body.deviceStatus);
  }
  const tool = objectRecord(body.tool);
  if (
    tool
    && typeof tool.name === "string"
    && knownTool.has(tool.name)
    && typeof tool.status === "string"
    && knownToolStatus.has(tool.status)
  ) {
    result.tool = {
      name: tool.name as NonNullable<AgentRunResult["tool"]>["name"],
      status: tool.status as NonNullable<AgentRunResult["tool"]>["status"],
      sceneName: typeof tool.sceneName === "string" ? tool.sceneName : undefined,
    };
  }
  return result;
}

export function normalizeQuota(value: unknown, principalId?: string): QuotaSummary {
  const quota = objectRecord(value);
  const remaining = objectRecord(quota?.remaining);
  const validCount = (count: unknown) => count === null
    || (Number.isSafeInteger(count) && (count as number) >= 0);
  if (
    !quota
    || typeof quota.principalId !== "string"
    || (principalId && quota.principalId !== principalId)
    || !["default", "override", "unlimited", "disabled"].includes(String(quota.mode))
    || quota.softLimit !== true
    || !remaining
    || ![
      remaining.requestsThisMinute,
      remaining.requestsToday,
      remaining.tokensThisMonth,
    ].every(validCount)
    || (
      quota.resetAt !== null
      && (typeof quota.resetAt !== "string" || !Number.isFinite(Date.parse(quota.resetAt)))
    )
  ) {
    throw new AgentClientError("AI_QUOTA_STORE_UNAVAILABLE", "配额摘要无效", 503);
  }

  const limits = objectRecord(quota.limits);
  const usage = objectRecord(quota.usage);
  const limitFields = [
    "requestsPerMinute",
    "requestsPerDay",
    "tokensPerMonth",
  ] as const;
  const usageFields = [
    "requestsThisMinute",
    "requestsToday",
    "promptTokensThisMonth",
    "completionTokensThisMonth",
    "estimatedTokensThisMonth",
    "totalTokensThisMonth",
  ] as const;
  if (
    (quota.limits !== null && (
      !limits
      || !limitFields.every((field) => (
        Number.isSafeInteger(limits[field]) && (limits[field] as number) >= 0
      ))
    ))
    || (quota.usage !== null && (
      !usage
      || usage.principalId !== quota.principalId
      || typeof usage.updatedAt !== "string"
      || !usageFields.every((field) => (
        Number.isSafeInteger(usage[field]) && (usage[field] as number) >= 0
      ))
    ))
  ) {
    throw new AgentClientError("AI_QUOTA_STORE_UNAVAILABLE", "配额摘要无效", 503);
  }

  return {
    principalId: quota.principalId,
    mode: quota.mode as QuotaSummary["mode"],
    softLimit: true,
    resetAt: quota.resetAt as string | null,
    limits: limits
      ? {
        requestsPerMinute: limits.requestsPerMinute as number,
        requestsPerDay: limits.requestsPerDay as number,
        tokensPerMonth: limits.tokensPerMonth as number,
      }
      : null,
    usage: usage
      ? {
        principalId: quota.principalId,
        updatedAt: usage.updatedAt as string,
        requestsThisMinute: usage.requestsThisMinute as number,
        requestsToday: usage.requestsToday as number,
        promptTokensThisMonth: usage.promptTokensThisMonth as number,
        completionTokensThisMonth: usage.completionTokensThisMonth as number,
        estimatedTokensThisMonth: usage.estimatedTokensThisMonth as number,
        totalTokensThisMonth: usage.totalTokensThisMonth as number,
      }
      : null,
    remaining: {
      requestsThisMinute: remaining.requestsThisMinute as number | null,
      requestsToday: remaining.requestsToday as number | null,
      tokensThisMonth: remaining.tokensThisMonth as number | null,
    },
  };
}

export class MakersAgentClient implements WebAgentClient {
  private readonly baseUrl: string;
  private readonly internalSecret: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MakersAgentClientOptions) {
    const endpoint = new URL(options.baseUrl);
    const localHttp = endpoint.protocol === "http:"
      && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
    if (
      (endpoint.protocol !== "https:" && !localHttp)
      || endpoint.username
      || endpoint.password
      || endpoint.search
      || endpoint.hash
    ) {
      throw new AgentClientError("AI_AGENT_UNAVAILABLE", "Agent URL 配置无效", 502);
    }
    this.baseUrl = options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`;
    this.internalSecret = options.internalSecret;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async post(path: string, conversationId: string, body: unknown, signal?: AbortSignal, timeoutMilliseconds = 55000) {
    if (!this.internalSecret || this.internalSecret.length < 32) {
      throw new AgentClientError("AI_AGENT_UNAVAILABLE", "AI 助手内部鉴权尚未配置", 502);
    }
    let response: Response;
    try {
      response = await withTimeout(timeoutMilliseconds, deadline => this.fetchImpl(new URL(path, this.baseUrl), {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          "Makers-Conversation-Id": conversationId,
          Authorization: `Bearer ${this.internalSecret}`,
        },
        body: JSON.stringify(body),
        signal: deadline,
      }), signal);
    } catch {
      throw new AgentClientError("AI_AGENT_UNAVAILABLE", "AI 助手暂时不可用", 502);
    }
    const parsed = await responseBody(response);
    if (!response.ok) throw mappedAgentError(parsed);
    return parsed;
  }

  async getQuota(principalId: string) {
    const body = await this.post(
      "api/internal/quota",
      "quota_summary",
      { operation: "summary", principalId },
      undefined,
      5000,
    );
    return normalizeQuota(body?.quota, principalId);
  }

  async run(input: AgentClientRunInput) {
    const body = await this.post("ai-home", input.conversationId, {
      requestId: input.requestId,
      principalId: input.principalId,
      homeId: input.homeId,
      message: input.message,
      idempotencyKey: input.idempotencyKey,
      scopes: input.scopes,
      automationToken: input.automationToken,
      locale: input.locale,
      timezone: input.timezone,
    }, input.signal);
    const result = normalizeAgentResult(body, input);
    if (result.quota) result.quota = normalizeQuota(result.quota, input.principalId);
    return result;
  }

  async deleteConversation(input: AgentClientDeleteInput) {
    const body = await this.post("ai-home/delete", input.conversationId, {
      requestId: input.requestId,
      principalId: input.principalId,
      homeId: input.homeId,
      scopes: input.scopes,
      automationToken: input.automationToken,
    }, input.signal);
    if (!body || body.ok !== true || typeof body.deleted !== "boolean") {
      throw new AgentClientError("AI_AGENT_UNAVAILABLE", "AI 助手返回无效响应", 502);
    }
    return { deleted: body.deleted };
  }
}
