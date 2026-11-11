import type { NextConfig } from "next";

/**
 * قرارات:
 * - turbopack.root: المشروع داخل مستودع فيه bun.lock أعلى في الشجرة — نثبّت الجذر صراحة
 *   كي لا يخطئ Turbopack في استنتاج جذر مساحة العمل (يفسد تتبع الملفات).
 * - serverExternalPackages: ffmpeg-static يبقى require خارجيًا كي لا يحاول Webpack تعبئة الملف الثنائي.
 * - outputFileTracingIncludes: نسخ ثنائي ffmpeg ضمن حزمة الدالة على Vercel (وإلا يسقط التتبع تلقائيًا).
 * - يمكن تجاوز مسار ffmpeg عبر FFMPEG_PATH في بيئات لا يمكنها تنزيل الحزمة.
 * - MERGER_STANDALONE_TEST=1: بناء اختباري للتحقق محليًا من تضمين الثنائي في أثر التتبع.
 */
const nextConfig: NextConfig = {
  turbopack: { root: __dirname },
  ...(process.env.MERGER_STANDALONE_TEST === "1" ? { output: "standalone" as const } : {}),
  serverExternalPackages: ["ffmpeg-static"],
  outputFileTracingIncludes: {
    "/api/jobs/[id]/process": ["./node_modules/ffmpeg-static/**"],
  },
};

export default nextConfig;
