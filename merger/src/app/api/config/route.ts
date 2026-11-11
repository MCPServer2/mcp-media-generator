/**
 * GET /api/config — فحص الجهوزية والقيود (يستخدمه التطبيق الرئيسي في mergerHealthy).
 * بلا مفاتيح ولا توثيق — الخدمة داخلية وتُنشر بعنوان غير معلن.
 */
import { NextResponse } from "next/server";
import { MAX_CLIPS, MAX_SOURCE_BYTES, MAX_OUTPUT_BYTES, MAX_TOTAL_SEC, ffmpegAvailable } from "@/lib/pipeline";
import { tursoEnabled, activeCount } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "video-merger",
    version: "2.0.0",
    limits: {
      maxClips: MAX_CLIPS,
      maxSourceMB: Math.round(MAX_SOURCE_BYTES / 1024 / 1024),
      maxOutputMB: Math.round(MAX_OUTPUT_BYTES / 1024 / 1024),
      maxTotalSeconds: MAX_TOTAL_SEC,
      retentionHours: 24,
    },
    ffmpeg: ffmpegAvailable(),
    blob: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
    turso: tursoEnabled(),
    active: activeCount(),
  });
}
