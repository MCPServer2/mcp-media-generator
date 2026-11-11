/**
 * تنظيف الوظائف المنتهية (أكثر من 24 ساعة) — يُستدعى من Vercel Cron يوميًا (vercel.json)
 * ويمكن استدعاؤه يدويًا. إن ضُبط CRON_SECRET فالنداء يتطلب Authorization: Bearer <CRON_SECRET>
 * (Vercel Cron يرسله تلقائيًا) أو ?secret=.
 * يحذف: الناتج من Vercel Blob + الملف المحلي إن وجد + السجل من الذاكرة وTurso.
 */
import { NextResponse } from "next/server";
import { rm } from "node:fs/promises";
import { listExpired, removeJob } from "@/lib/store";
import { outputFilePath } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization") ?? "";
    const q = new URL(req.url).searchParams.get("secret");
    if (auth !== `Bearer ${secret}` && q !== secret) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const now = new Date().toISOString();
  const expired = await listExpired(now);
  let deleted = 0;
  for (const job of expired) {
    if (job.videoUrl && job.videoUrl.includes("blob.vercel-storage.com")) {
      try {
        const { del } = await import("@vercel/blob");
        await del(job.videoUrl);
      } catch {
        // أفضل جهد
      }
    }
    await rm(outputFilePath(job.id), { force: true });
    await removeJob(job.id);
    deleted++;
  }

  return NextResponse.json({ ok: true, deleted, at: now });
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
