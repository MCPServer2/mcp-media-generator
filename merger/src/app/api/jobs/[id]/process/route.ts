/**
 * POST /api/jobs/{id}/process — تنفيذ المعالجة كاملة (blocking ~10-60 ثانية).
 *
 * قرارات:
 * - قفل تزامن في الذاكرة: النداء المتزامن الثاني يعيد اللقطة الحالية فورًا بدل تشغيل مزدوج.
 * - الوظيفة done/failed → نعيد اللقطة فورًا (idempotent — لا إعادة معالجة).
 * - كل خطأ داخلي (تنزيل/ترميز/رفع) يُسجَّل كحالة failed في الوظيفة — النتيجة تُقرأ من GET دائمًا،
 *   لذلك نعيد 200 حتى عند الفشل (هناك تُقرأ status=failed+error) ونحتفظ بـ 404 للمجهول فقط.
 * - maxDuration 300: مع Fluid Compute على Vercel تسمح الخطة المجانية بـ 300 ثانية.
 * - على Vercel قد تستقبل نسختان process في آنٍ واحد (باردتان): قفل Turso غير موجود عمدًا —
 *   النتيجة النهائية واحدة (رفع Blob بنفس المسname يكتب فوقه) والهدر مقبول نادر الحدوث.
 */
import { NextResponse } from "next/server";
import { runPipeline } from "@/lib/pipeline";
import { getJob, saveJob, processLocks } from "@/lib/store";
import { selfBase, snapshot } from "@/lib/net";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const job = await getJob(id);
  if (!job) return NextResponse.json({ error: "job not found" }, { status: 404 });

  // إنهاء مبكر: منتهية بالفعل أو قيد المعالجة على هذه النسخة
  if (job.status === "done" || job.status === "failed" || processLocks.has(id)) {
    return NextResponse.json(snapshot(job, selfBase(req)));
  }

  processLocks.add(id);
  try {
    job.status = "processing";
    job.progress = 2;
    job.processStarted = true;
    job.error = null;
    await saveJob(job);

    try {
      const result = await runPipeline({
        jobId: id,
        videos: job.videos,
        selfBase: selfBase(req),
        onProgress: async (p) => {
          job.progress = Math.max(job.progress, p);
          await saveJob(job);
        },
      });
      job.status = "done";
      job.progress = 100;
      job.videoUrl = result.videoUrl;
      job.downloadUrl = result.downloadUrl;
      job.sizeBytes = result.sizeBytes;
      job.durationSec = result.durationSec;
      job.resolution = result.resolution;
      job.error = null;
      await saveJob(job);
    } catch (e) {
      // فشل نهائي معلن — يظهر في GET /api/jobs/{id} كـ status=failed + error
      job.status = "failed";
      job.error = (e as Error).message || "merging failed";
      await saveJob(job);
    }
  } finally {
    processLocks.delete(id);
  }

  return NextResponse.json(snapshot(job, selfBase(req)));
}
