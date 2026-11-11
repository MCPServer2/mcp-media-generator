"use client";

/**
 * ب) لوحة المهام:
 * - شرائح إحصائيات: إجمالي / مكتملة / فاشلة / جارية.
 * - قائمة أحدث المهام تتحدث تلقائيًا كل ~5 ثوانٍ: نوع، شارة حالة، شريط تقدم، موديل،
 *   مقتطف وصف، وقت الإنشاء، أزرار فتح الروابط عند الاكتمال، رسالة الخطأ عند الفشل، وعدد المحاولات.
 */
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { PROVIDER_LABELS, fmtTime, type TasksResponse } from "./types";

function typeLabel(t: string): string {
  return t === "image" ? "صورة" : t === "video" ? "فيديو" : "دمج";
}

function StatusBadge({ status }: { status: string }) {
  if (status === "completed") return <Badge className="bg-emerald-100 text-emerald-800 border border-emerald-300 hover:bg-emerald-100">مكتملة</Badge>;
  if (status === "failed") return <Badge className="bg-red-100 text-red-800 border border-red-300 hover:bg-red-100">فاشلة</Badge>;
  if (status === "pending") return <Badge className="bg-neutral-100 text-neutral-600 border border-neutral-300 hover:bg-neutral-100">معلقة</Badge>;
  return <Badge className="bg-sky-100 text-sky-800 border border-sky-300 hover:bg-sky-100">جارية</Badge>;
}

export function TasksCard({ refreshSignal }: { refreshSignal?: number }) {
  const [data, setData] = useState<TasksResponse | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks?limit=20", { cache: "no-store" });
      const json = (await res.json()) as TasksResponse;
      setData(json);
    } catch {
      /* تحميل صامت */
    }
  }, []);

  useEffect(() => {
    // التحميل الأول مؤجَّل بدقيقة كي لا يكون تحديث حالة متزامنًا داخل effect
    const t0 = setTimeout(load, 0);
    const t = setInterval(load, 5_000); // تحديث تلقائي كل ~5 ثوانٍ
    return () => {
      clearTimeout(t0);
      clearInterval(t);
    };
  }, [load, refreshSignal]);

  const stats = data?.stats ?? { total: 0, completed: 0, failed: 0, processing: 0 };

  return (
    <Card>
      <CardHeader>
        <CardTitle>لوحة المهام</CardTitle>
        <CardDescription>أحدث المهام في قاعدة Turso — تحديث تلقائي كل 5 ثوانٍ.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* شرائح الإحصائيات */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="rounded-lg border p-3 text-center">
            <p className="text-2xl font-bold">{stats.total}</p>
            <p className="text-xs text-muted-foreground">إجمالي</p>
          </div>
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-center">
            <p className="text-2xl font-bold text-emerald-700">{stats.completed}</p>
            <p className="text-xs text-emerald-700/80">مكتملة</p>
          </div>
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-center">
            <p className="text-2xl font-bold text-red-700">{stats.failed}</p>
            <p className="text-xs text-red-700/80">فاشلة</p>
          </div>
          <div className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-center">
            <p className="text-2xl font-bold text-sky-700">{stats.processing}</p>
            <p className="text-xs text-sky-700/80">جارية</p>
          </div>
        </div>

        {/* قائمة المهام */}
        <div className="max-h-96 space-y-3 overflow-y-auto pl-1 [scrollbar-width:thin]">
          {(!data || data.tasks.length === 0) && (
            <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
              لا مهام بعد — أول توليد سيظهر هنا فورًا.
            </p>
          )}
          {data?.tasks.map((t) => (
            <div key={t.id} className="rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{typeLabel(t.type)}</Badge>
                <StatusBadge status={t.status} />
                <code className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-xs text-neutral-600" dir="ltr">
                  {t.model}
                </code>
                {t.provider && (
                  <span className="text-xs text-muted-foreground">عبر {PROVIDER_LABELS[t.provider] ?? t.provider}</span>
                )}
                {t.attemptsCount > 0 && (
                  <span className="text-xs text-amber-700" title={t.attempts.map((a) => `${a.provider}:${a.ok ? "نجح" : a.errorClass ?? ""}`).join(" | ")}>
                    محاولات: {t.attemptsCount}
                  </span>
                )}
                <span className="mr-auto text-xs text-muted-foreground">{fmtTime(t.created_at)}</span>
              </div>
              {t.prompt && (
                <p className="mt-1 truncate text-sm text-muted-foreground" title={t.prompt}>
                  {t.prompt}
                </p>
              )}
              {(t.status === "processing" || t.status === "pending") && (
                <div className="mt-2 flex items-center gap-2">
                  <Progress value={t.progress} className="h-2 flex-1" />
                  <span className="text-xs text-muted-foreground">{t.progress}%</span>
                </div>
              )}
              {t.status === "failed" && t.error_message && (
                <p className="mt-1 text-sm text-red-600">{t.error_message}</p>
              )}
              {t.status === "completed" && t.urls.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {t.urls.map((u, i) => (
                    <a
                      key={i}
                      href={u}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1 text-xs text-emerald-800 hover:bg-emerald-100"
                    >
                      فتح النتيجة {t.urls.length > 1 ? `#${i + 1}` : ""} ↗
                    </a>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
