/** GET /api/health — فحص صحة عام */
import { NextResponse } from "next/server";
import { ffmpegAvailable } from "@/lib/pipeline";
import { tursoEnabled } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "video-merger",
    database: tursoEnabled() ? "turso-connected" : "memory-only",
    ffmpeg: ffmpegAvailable(),
    blob: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
    time: new Date().toISOString(),
  });
}
