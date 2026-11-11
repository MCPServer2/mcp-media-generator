/**
 * GET /api/tasks — أحدث المهام + الإحصائيات (تستهلكها لوحة المهام، تحديث كل ~5 ثوانٍ).
 * المفاتيح مُقنَّعة دائمًا وروابط النتائج فقط تُعاد.
 */
import { NextRequest, NextResponse } from "next/server";
import { listRecentTasks, taskStats } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const limit = Math.min(50, Math.max(1, Number(searchParams.get("limit") ?? 20) || 20));
  const type = searchParams.get("type") ?? undefined;
  const status = searchParams.get("status") ?? undefined;

  const [rows, stats] = await Promise.all([
    listRecentTasks(limit, { type: type ?? undefined, status: status ?? undefined }),
    taskStats(),
  ]);

  return NextResponse.json({
    stats,
    tasks: rows.map((r) => {
      let urls: string[] = [];
      let attempts: unknown[] = [];
      try {
        const v = JSON.parse(r.result_urls_json ?? "[]");
        if (Array.isArray(v)) urls = v.filter((u): u is string => typeof u === "string");
      } catch { urls = []; }
      try {
        const a = JSON.parse(r.attempts_json ?? "[]");
        if (Array.isArray(a)) attempts = a;
      } catch { attempts = []; }
      return {
        id: r.id,
        type: r.type,
        model: r.model,
        status: r.status,
        progress: r.progress,
        prompt: r.prompt,
        provider: r.provider,
        error_message: r.error_message,
        created_at: r.created_at,
        updated_at: r.updated_at,
        completed_at: r.completed_at,
        urls,
        attemptsCount: attempts.length,
        attempts: attempts.slice(-5), // آخر المحاولات فقط للعرض
      };
    }),
  });
}
