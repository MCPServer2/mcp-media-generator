import type { Metadata } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

/**
 * التخطيط الجذري — عربي بالكامل (dir="rtl" + lang="ar") مع خط عربي جيد (Cairo).
 * الخط يُحمَّل من Google Fonts عبر رابط عادي (لا يعتمد على الشبكة وقت البناء).
 */
export const metadata: Metadata = {
  title: "MCP Media Generator — لوحة الإدارة",
  description:
    "خادم MCP لتوليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع — لوحة إدارة عربية لإدارة المفاتيح ومتابعة المهام وربط العملاء.",
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font -- الخط في التخطيط الجذري فيُحمَّل لكل الصفحات */}
        <link
          href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen bg-background font-sans antialiased" style={{ fontFamily: "'Cairo', ui-sans-serif, system-ui, sans-serif" }}>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
