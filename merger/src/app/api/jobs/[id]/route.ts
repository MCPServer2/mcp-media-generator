/**
 * GET    /api/jobs/{id} — حالة الوظيفة (يستعلم عنها التطبيق الرئيسي كل ~3 ثوانٍ).
 * DELETE /api/jobs/{id} — حذف نهائي فوري (الناتج من Blob أو /tmp + السجل).
 * 404 {error:"job not found"} إن لم توجد (التطبيق الرئيسي يفسر 404 كفشل نهائي بعد 24 ساعة).
 */
import { NextResponse } from "next/server";
import { rm } from "node:fs/promises";
import { getJob, removeJob } from "@/lib/store";
import { selfBase, snapshot } from "@/lib/net";
import { outputFilePath } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const job = await getJob(id);
  if (!job) return NextResponse.json({ error: "job not found" }, { status: 404 });
  return NextResponse.json(snapshot(job, selfBase(req)));
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const job = await getJob(id);
  if (!job) return NextResponse.json({ error: "job not found" }, { status: 404 });

  // حذف الناتج من Vercel Blob إن كان مرفوعًا هناك
  if (job.videoUrl && job.videoUrl.includes("blob.vercel-storage.com")) {
    try {
      const { del } = await import("@vercel/blob");
      await del(job.videoUrl);
    } catch {
      // أفضل جهد — الحذف من السجل هو الأساس
    }
  }
  await rm(outputFilePath(id), { force: true });
  await removeJob(id);
  return NextResponse.json({ ok: true, deleted: true });
}
