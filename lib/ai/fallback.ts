const fallbackPhrases = new Set([
  "我回家了",
  "我到家了",
  "我回来了",
  "开启回家模式",
  "打开回家模式",
]);

const forbiddenMarkers = /不|别|没|未|如果|假如|假设|是否|吗|呢|什么|怎么|他说|她说|她说|转述|刚才说|问到|听说/;

export function isDeterministicFallback(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, "");
  if (forbiddenMarkers.test(normalized)) return false;
  return fallbackPhrases.has(normalized);
}
