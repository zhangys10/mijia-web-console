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
  if (!apiKey || typeof apiKey !== "string" || apiKey.trim().length < 5) {
    throw new ProviderCatalogError(
      "LLM_CREDENTIAL_INVALID",
      "模型 API Key 格式不正确",
    );
  }

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
        Authorization: `Bearer ${apiKey.trim()}`,
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

    if (response.status === 401 || response.status === 403) {
      throw new ProviderCatalogError(
        "LLM_CREDENTIAL_INVALID",
        "模型 API Key 验证失败，服务商拒绝鉴权",
      );
    }

    throw new ProviderCatalogError(
      "LLM_PROVIDER_ERROR",
      `模型服务商验证响应异常 (${response.status})`,
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
    throw new ProviderCatalogError(
      "LLM_PROVIDER_ERROR",
      "连接模型服务商失败，请检查网络",
    );
  } finally {
    clearTimeout(timer);
  }
}
