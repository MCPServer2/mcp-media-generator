/**
 * GET /api/jobs/{id}/video — تسليم الناتج MP4.
 * - ناتج على Vercel Blob → إعادة توجيه 302 للرابط العام الدائم.
 * - ناتج محلي (بلا Blob — تطوير/احتياط) → بث الملف من /tmp مع Content-Disposition عند ?download=1.
 * - غير موجود/منتهي → 404 {error:"output not found or expired"}.
 */
import { NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { getJob } from "@/lib/store";
import { selfBase } from "@/lib/net";
import { outputFilePath } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const job = await getJob(id);
  if (!job || job.status !== "done" || !job.videoUrl) {
    return NextResponse.json({ error: "output not found or expired" }, { status: 404 });
  }

  const base = selfBase(req);
  const isRemote = job.videoUrl.startsWith("http") && !job.videoUrl.startsWith(base);
  if (isRemote) {
    // رابط Blob الدائم
    return NextResponse.redirect(job.videoUrl, 302);
  }

  const file = outputFilePath(id);
  let size = 0;
  try {
    const st = await stat(file);
    if (!st.isFile() || st.size === 0) throw new Error("missing");
    size = st.size;
  } catch {
    return NextResponse.json({ error: "output not found or expired" }, { status: 404 });
  }

  const download = new URL(req.url).searchParams.get("download") === "1";
  const nodeStream = createReadStream(file);
  return new Response(Readable.toWeb(nodeStream) as unknown as ReadableStream, {
    status: 200,
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(size),
      "Cache-Control": "no-store",
      ...(download ? { "Content-Disposition": `attachment; filename="merged-${id}.mp4"` } : {}),
    },
  });
}
