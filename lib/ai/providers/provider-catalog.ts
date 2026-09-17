export interface ProviderCatalogEntry {
  id: "qwen-cn";
  name: string;
  baseUrl: string;
  defaultModel: string;
  allowedModels: readonly string[];
}

export type ProviderCatalogErrorCode =
  | "LLM_PROVIDER_NOT_ALLOWED"
  | "LLM_MODEL_NOT_ALLOWED"
  | "LLM_CREDENTIAL_INVALID"
  | "LLM_TIMEOUT"
  | "LLM_PROVIDER_ERROR";

export class ProviderCatalogError extends Error {
  readonly code: ProviderCatalogErrorCode;

  constructor(code: ProviderCatalogErrorCode, message: string) {
    super(message);
    this.name = "ProviderCatalogError";
    this.code = code;
  }
}

export const PROVIDER_CATALOG: Record<string, ProviderCatalogEntry> = {
  "qwen-cn": {
    id: "qwen-cn",
    name: "通义千问（中国大陆）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen3.7-flash-2026-07-15",
    allowedModels: [
      "qwen3.7-flash-2026-07-15",
      "qwen3.8-flash",
      "qwen-turbo",
      "qwen-plus",
    ],
  },
};

export const DEFAULT_PROVIDER_ID = "qwen-cn";

const API_KEY_MIN_LENGTH = 5;
const API_KEY_ALLOWED_PATTERN = /^[\x21-\x7e]+$/;

/**
 * 复制/粘贴的 Key 常混入空格、换行或全角字符，这些会直接让 HTTP Authorization 头非法，
 * 表现为 fetch 抛异常而不是服务商返回 401。必须在发请求前识别为凭据问题。
 */
function normalizeApiKey(apiKey: unknown): string {
  if (typeof apiKey !== "string") {
    throw new ProviderCatalogError(
      "LLM_CREDENTIAL_INVALID",
      "模型 API Key 格式不正确，请重新复制",
    );
  }
  const trimmed = apiKey.trim();
  if (trimmed.length < API_KEY_MIN_LENGTH) {
    throw new ProviderCatalogError(
      "LLM_CREDENTIAL_INVALID",
      "模型 API Key 长度不足，请确认已完整复制",
    );
  }
  if (/[\s\u3000]/.test(trimmed) || !API_KEY_ALLOWED_PATTERN.test(trimmed)) {
    throw new ProviderCatalogError(
      "LLM_CREDENTIAL_INVALID",
      "模型 API Key 含空格、换行或不可见字符，请确认已完整复制正确的 Key",
    );
  }
  return trimmed;
}

function looksLikeInvalidKeyResponse(status: number, bodyText: string): boolean {
  if (status !== 400 && status !== 401 && status !== 403) return false;
  const normalized = bodyText.toLowerCase();
  return (
    normalized.includes("invalid_api_key") ||
    normalized.includes("invalid apikey") ||
    normalized.includes("invalid api key") ||
    normalized.includes("incorrect api key") ||
    normalized.includes("authentication") ||
    normalized.includes("unauthorized")
  );
}

export function listSupportedProviders() {
  return Object.values(PROVIDER_CATALOG).map((p) => ({
    id: p.id,
    name: p.name,
    defaultModel: p.defaultModel,
    allowedModels: [...p.allowedModels],
  }));
}

export function resolveProvider(
  providerId: string = DEFAULT_PROVIDER_ID,
  modelId?: string,
): { provider: ProviderCatalogEntry; model: string; baseUrl: string } {
  const provider = PROVIDER_CATALOG[providerId];
  if (!provider) {
    throw new ProviderCatalogError(
      "LLM_PROVIDER_NOT_ALLOWED",
      `不支持的模型服务商: ${providerId}`,
    );
  }

  const selectedModel = modelId || provider.defaultModel;
  if (!provider.allowedModels.includes(selectedModel)) {
    throw new ProviderCatalogError(
      "LLM_MODEL_NOT_ALLOWED",
      `服务商 ${provider.name} 不支持所选模型: ${selectedModel}`,
    );
  }

  return {
    provider,
    model: selectedModel,
    baseUrl: provider.baseUrl,
  };
}

export async function validateProviderKey(
  providerId: string,
  apiKey: string,
  modelId?: string,
  options?: { timeoutMs?: number; customFetch?: typeof fetch },
): Promise<{ valid: true }> {
  const normalizedKey = normalizeApiKey(apiKey);

  const resolved = resolveProvider(providerId, modelId);
  const timeoutMs = options?.timeoutMs ?? 6000;
  const fetchFn = options?.customFetch ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `${resolved.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const response = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${normalizedKey}`,
      },
      body: JSON.stringify({
        model: resolved.model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
      signal: controller.signal,
    });

    if (response.ok) {
      return { valid: true };
    }

    const bodyText = await response.text().catch(() => "");

    if (response.status === 401 || response.status === 403) {
      throw new ProviderCatalogError(
        "LLM_CREDENTIAL_INVALID",
        "模型 API Key 无效或已失效，请确认已复制正确、有效的 Key",
      );
    }

    if (looksLikeInvalidKeyResponse(response.status, bodyText)) {
      throw new ProviderCatalogError(
        "LLM_CREDENTIAL_INVALID",
        "模型 API Key 无效或已失效，请确认已复制正确、有效的 Key",
      );
    }

    const detail = bodyText.trim().slice(0, 200);
    throw new ProviderCatalogError(
      "LLM_PROVIDER_ERROR",
      detail
        ? `模型服务商返回异常 (${response.status})：${detail}`
        : `模型服务商返回异常 (${response.status})`,
    );
  } catch (error) {
    if (error instanceof ProviderCatalogError) {
      throw error;
    }
    const isAbort =
      error instanceof Error &&
      (error.name === "AbortError" || error.message.toLowerCase().includes("timeout") || error.message.toLowerCase().includes("aborted"));
    if (isAbort) {
      throw new ProviderCatalogError(
        "LLM_TIMEOUT",
        "验证模型 API Key 超时，请检查网络或稍后重试",
      );
    }
    // 走到这里只剩网络/DNS/TLS 等传输层失败；凭据格式问题已在 normalizeApiKey 拦截。
    throw new ProviderCatalogError(
      "LLM_PROVIDER_ERROR",
      "无法连接模型服务商，请检查网络后重试",
    );
  } finally {
    clearTimeout(timer);
  }
}
