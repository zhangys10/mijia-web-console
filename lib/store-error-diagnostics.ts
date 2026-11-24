const SAFE_CODE = /^[A-Z0-9_:-]{1,64}$/;
const SAFE_REQUEST_ID = /^[A-Za-z0-9-]{8,128}$/;

type StoreErrorContext = {
  component: "spatial_layout" | "climate_memory" | "assistant_exposure" | "action_ledger";
  operation: string;
};

type ErrorLike = {
  name?: unknown;
  code?: unknown;
  message?: unknown;
};

function errorLike(error: unknown): ErrorLike {
  return error && typeof error === "object" ? error as ErrorLike : {};
}

function safeCode(value: unknown) {
  return typeof value === "string" && SAFE_CODE.test(value) ? value : undefined;
}

function safeUpstreamCode(value: unknown) {
  return typeof value === "string" && /^[A-Za-z0-9_:-]{1,64}$/.test(value) ? value : undefined;
}

/**
 * Builds a bounded Blob failure record without logging exception text, object keys,
 * home identifiers, URLs, request bodies, or credentials.
 */
export function storeErrorDiagnostic(context: StoreErrorContext, error: unknown) {
  const detail = errorLike(error);
  const message = typeof detail.message === "string" ? detail.message : "";
  const errorCode = safeCode(detail.code);
  const errorName = typeof detail.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(detail.name)
    ? detail.name
    : undefined;

  const stsStatusMatch = /failed to obtain STS credential:\s*(\d{3})\b/i.exec(message);
  const exchangeCodeMatch = /credential exchange failed \(code=([A-Za-z0-9_:-]{1,64})\)/i.exec(message);
  const responseCodeMatch = /(?:["']code["']\s*:\s*["']?([A-Za-z0-9_:-]{1,64})|<Code>([A-Za-z0-9_:-]{1,64})<\/Code>)/i.exec(message);
  const cosStatusMatch = /COS returned\s+(\d{1,3}):/i.exec(message);
  const operationMatch = /\b(GET|PUT|HEAD|DELETE|LIST)\s+https?:\/\//i.exec(message);
  const requestIdMatch = /\[request-id:\s*([^\]\s]+)\]/i.exec(message);
  const upstreamStatus = Number(stsStatusMatch?.[1] ?? cosStatusMatch?.[1]);
  const requestId = requestIdMatch && SAFE_REQUEST_ID.test(requestIdMatch[1]) ? requestIdMatch[1] : undefined;
  const upstreamCode = safeUpstreamCode(exchangeCodeMatch?.[1] ?? responseCodeMatch?.[1] ?? responseCodeMatch?.[2]);
  const upstreamReason = /expir(?:ed|y)/i.test(message) ? "CREDENTIAL_EXPIRED"
    : /revoked?/i.test(message) ? "CREDENTIAL_REVOKED"
      : /\binvalid\b.{0,32}\bcredential\b|\bcredential\b.{0,32}\binvalid\b/i.test(message) ? "CREDENTIAL_INVALID"
        : /\bunauthorized\b/i.test(message) ? "UNAUTHORIZED"
          : /\bforbidden\b/i.test(message) ? "FORBIDDEN"
            : undefined;

  let category = "UNKNOWN_STORE_ERROR";
  if (errorCode === "CREDENTIAL_ERROR") {
    if (stsStatusMatch) category = "BLOB_STS_HTTP_ERROR";
    else if (exchangeCodeMatch) category = "BLOB_STS_EXCHANGE_REJECTED";
    else if (/invalid STS credential response/i.test(message)) category = "BLOB_STS_INVALID_RESPONSE";
    else if (/rate limited/i.test(message)) category = "BLOB_STS_RATE_LIMITED";
    else if (/storage quota exceeded/i.test(message)) category = "BLOB_QUOTA_EXCEEDED";
    else category = "BLOB_STS_TRANSPORT_ERROR";
  } else if (errorCode === "COS_ERROR") {
    category = "BLOB_COS_ERROR";
  } else if (errorCode === "MISSING_ENVIRONMENT" || errorCode === "MISSING_PROJECT_ID") {
    category = "BLOB_CONFIGURATION_ERROR";
  } else if (errorCode === "QUOTA_EXCEEDED") {
    category = "BLOB_QUOTA_EXCEEDED";
  } else if (errorCode === "RATE_LIMITED") {
    category = "BLOB_RATE_LIMITED";
  } else if (errorName === "SyntaxError") {
    category = "BLOB_INVALID_JSON";
  }

  return {
    event: "edgeone_blob_call_failed",
    component: context.component,
    operation: context.operation,
    category,
    ...(errorName ? { errorName } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(Number.isInteger(upstreamStatus) && upstreamStatus >= 0 && upstreamStatus <= 599 ? { upstreamStatus } : {}),
    ...(operationMatch ? { upstreamOperation: operationMatch[1].toUpperCase() } : {}),
    ...(upstreamCode ? { upstreamCode } : {}),
    ...(upstreamReason ? { upstreamReason } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

export function logStoreError(context: StoreErrorContext, error: unknown) {
  console.error(JSON.stringify(storeErrorDiagnostic(context, error)));
}
