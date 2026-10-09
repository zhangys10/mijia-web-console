export function interpretPropertyWriteResponse(response: Record<string, unknown>) {
  const items = response.result;
  if (!Array.isArray(items) || !items.length) throw new Error("XIAOMI_DEVICE_RESPONSE_INVALID");
  const results = items as Record<string, unknown>[];
  if (results.some(result => typeof result?.code !== "number")) throw new Error("XIAOMI_DEVICE_RESPONSE_INVALID");
  const result = results.find(result => result.code !== 0 && result.code !== 1) ?? results[0];
  return {
    // Xiaomi's official integration treats both 0 and 1 as successful device
    // execution acknowledgements for cloud, LAN, and gateway property writes.
    status: result.code === 0 || result.code === 1
      ? "submitted" as const
      : "outcome_unknown" as const,
    result,
  };
}
