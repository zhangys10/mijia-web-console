export const QUOTA_TIME_ZONE = "Asia/Shanghai";

export type QuotaPeriodWindows = {
  minuteKey: string;
  dayKey: string;
  monthKey: string;
  minuteResetAt: string;
  dayResetAt: string;
  monthResetAt: string;
};

const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: QUOTA_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function dateParts(now: number) {
  const parts = new Map<string, string>();
  for (const part of dateFormatter.formatToParts(new Date(now))) {
    if (part.type !== "literal") parts.set(part.type, part.value);
  }
  return {
    year: parts.get("year") ?? "",
    month: parts.get("month") ?? "",
    day: parts.get("day") ?? "",
    hour: parts.get("hour") ?? "",
    minute: parts.get("minute") ?? "",
  };
}

function twoDigits(value: number) {
  return String(value).padStart(2, "0");
}

function localIso(year: number, month: number, day: number, hour = 0, minute = 0) {
  return `${year}-${twoDigits(month)}-${twoDigits(day)}T${twoDigits(hour)}:${twoDigits(minute)}:00+08:00`;
}

export function quotaPeriodWindows(now = Date.now()): QuotaPeriodWindows {
  const { year, month, day, hour, minute } = dateParts(now);
  const yearNumber = Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const hourNumber = Number(hour);
  const minuteNumber = Number(minute);

  const nextMinute = new Date(Date.UTC(yearNumber, monthNumber - 1, dayNumber, hourNumber, minuteNumber) + 60_000);
  const nextDay = new Date(Date.UTC(yearNumber, monthNumber - 1, dayNumber) + 86_400_000);
  const nextMonth = new Date(Date.UTC(yearNumber, monthNumber, 1));

  return {
    minuteKey: `${year}${month}${day}${hour}${minute}`,
    dayKey: `${year}${month}${day}`,
    monthKey: `${year}${month}`,
    minuteResetAt: localIso(nextMinute.getUTCFullYear(), nextMinute.getUTCMonth() + 1, nextMinute.getUTCDate(), nextMinute.getUTCHours(), nextMinute.getUTCMinutes()),
    dayResetAt: localIso(nextDay.getUTCFullYear(), nextDay.getUTCMonth() + 1, nextDay.getUTCDate()),
    monthResetAt: localIso(nextMonth.getUTCFullYear(), nextMonth.getUTCMonth() + 1, nextMonth.getUTCDate()),
  };
}

export function sanitizeKeySegment(value: string) {
  const segment = value.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 32);
  return segment || "development";
}

export async function principalKeyFromPrincipalId(principalId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(principalId)));
  return Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function quotaKey(
  env: string,
  principalKey: string,
  period: "min" | "d" | "m",
  stamp: string,
) {
  return `q_v1_${sanitizeKeySegment(env)}_${principalKey}_${period}_${stamp}`;
}
