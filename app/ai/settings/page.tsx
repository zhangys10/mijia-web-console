import Home from "../../page";

export const metadata = {
  title: "设置 - 米家 Web 控制台",
  description: "米家控制台系统设置与 AI 自动化配置。",
};

export default function AiSettingsPage() {
  return <Home initialTab="设置" />;
}
