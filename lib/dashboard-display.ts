const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

export function formatDashboardDate(date: Date) {
  if (Number.isNaN(date.getTime())) return "今天";
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 · ${WEEKDAYS[date.getDay()]}`;
}

export function dashboardGreeting(date: Date) {
  const hour = date.getHours();
  if (hour < 5) return "夜深了";
  if (hour < 11) return "早上好";
  if (hour < 14) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

export function dashboardAccountLabel(connected: boolean, userId?: string) {
  if (!connected) return "访客";
  return userId ? `米家账号 ${userId}` : "米家账号";
}
