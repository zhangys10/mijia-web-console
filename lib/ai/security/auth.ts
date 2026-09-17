import { createHash, timingSafeEqual } from "node:crypto";

export function extractBearerToken(header: string | null): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length);
  return token.length >= 32 ? token : null;
}

export async function verifyShortcutAuth(header: string | null, expectedHash: string): Promise<boolean> {
  const token = extractBearerToken(header);
  if (!token || !expectedHash) return false;
  const actual = createHash("sha256").update(token).digest("hex");
  const actualBuffer = Buffer.from(actual, "hex");
  const expectedBuffer = Buffer.from(expectedHash, "hex");
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}
