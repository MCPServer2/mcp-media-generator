/**
 * POST /api/jobs — إنشاء وظيفة دمج (body: { videos: string[] }).
 * التحقق الصارم هنا أيضًا (دفاعًا عن نفسها، لا يكفي فحص العميل):
 *   2..10 مقاطع، روابط http/https عامة مباشرة (حجب localhost/الداخلية ما لم MERGER_ALLOW_PRIVATE_URLS=1).
 * 201 → { jobId, status, statusUrl, processUrl, expiresAt }
 * GET  → قائمة آخر الوظائف من الذاكرة (للمراقبة اليدوية فقط).
 */
import { NextResponse } from "next/server";
import { MAX_CLIPS } from "@/lib/pipeline";
import { newJobId, saveJob, processLocks } from "@/lib/store";
import { selfBase, isSourceUrlAllowed } from "@/lib/net";
import { RETENTION_HOURS, type MergerJob } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { videos?: unknown };
  const videos = Array.isArray(body?.videos) ? body.videos.filter((v): v is string => typeof v === "string" && v.length > 0) : [];

  if (videos.length < 2) {
    return NextResponse.json({ error: "Need at least 2 videos (max 10)" }, { status: 400 });
  }
  if (videos.length > MAX_CLIPS) {
    return NextResponse.json({ error: `Too many videos: max ${MAX_CLIPS} sources per job` }, { status: 400 });
  }

  const allowPrivate = process.env.MERGER_ALLOW_PRIVATE_URLS === "1";
  const bad = videos.filter((u) => !isSourceUrlAllowed(u, allowPrivate));
  if (bad.length > 0) {
    return NextResponse.json(
      { error: "Non-public or invalid source URL(s)", detail: bad },
      { status: 400 },
    );
  }

  const now = new Date();
  const job: MergerJob = {
    id: newJobId(),
    status: "created",
    progress: 0,
    videos,
    error: null,
    videoUrl: null,
    downloadUrl: null,
    sizeBytes: null,
    durationSec: null,
    resolution: null,
    processStarted: false,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + RETENTION_HOURS * 3600 * 1000).toISOString(),
  };
  await saveJob(job);

  const base = selfBase(req);
  return NextResponse.json(
    {
      jobId: job.id,
      status: job.status,
      statusUrl: `${base}/api/jobs/${job.id}`,
      processUrl: `${base}/api/jobs/${job.id}/process`,
      expiresAt: job.expiresAt,
    },
    { status: 201 },
  );
}

export async function GET() {
  const { listMemoryJobs } = await import("@/lib/store");
  const jobs = await listMemoryJobs();
  return NextResponse.json({ jobs });
}
