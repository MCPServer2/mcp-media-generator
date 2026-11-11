import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "خدمة دمج الفيديو v2",
  description: "Video Merger API v2 — دمج مقاطع الفيديو العامة في MP4 واحد",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, background: "#0b1120", color: "#e2e8f0" }}>
        {children}
      </body>
    </html>
  );
}
