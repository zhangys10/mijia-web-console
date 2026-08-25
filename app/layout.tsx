import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./cloud.css";
import "./responsive.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#fafbfc",
};

export const metadata: Metadata = {
  title: "米家 Web 控制台",
  description: "集中控制小米智能设备、场景与家庭自动化的 Web 控制台。",
  openGraph: { title: "米家 Web 控制台", description: "一个清晰、快速的智能家庭控制中心。", type: "website", images: ["/og.png"] },
  twitter: { card: "summary_large_image", title: "米家 Web 控制台", description: "一个清晰、快速的智能家庭控制中心。", images: ["/og.png"] },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
