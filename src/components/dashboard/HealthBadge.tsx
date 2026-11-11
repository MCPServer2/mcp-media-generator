"use client";

/**
 * شارة الحالة في الهيدر — تُحدَّث كل 10 ثوانٍ من /api/health:
 * «Turso متصل» خضراء / «غير متصل» حمراء + حالة خدمة الدمج + شارة المصادقة.
 */
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import type { HealthResponse } from "./types";

export function HealthBadge() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const data = (await res.json()) as HealthResponse;
        if (alive) {
          setHealth(data);
          setError(false);
        }
      } catch {
        if (alive) setError(true);
      }
    };
    // التحميل الأول مؤجَّل بدقيقة كي لا يكون تحديث حالة متزامنًا داخل effect
    const t0 = setTimeout(load, 0);
    const t = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearTimeout(t0);
      clearInterval(t);
    };
  }, []);

  const connected = health?.database === "turso-connected";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge
        className={
          connected
            ? "bg-emerald-100 text-emerald-800 border border-emerald-300 hover:bg-emerald-100"
            : "bg-red-100 text-red-800 border border-red-300 hover:bg-red-100"
        }
      >
        <span className={`ml-1 inline-block h-2 w-2 rounded-full ${connected ? "bg-emerald-500" : "bg-red-500"}`} />
        {connected ? "Turso متصل" : error ? "تعذر فحص الحالة" : "Turso غير متصل"}
      </Badge>
      {health?.merger.base ? (
        <Badge
          className={
            health.merger.healthy
              ? "bg-emerald-100 text-emerald-800 border border-emerald-300 hover:bg-emerald-100"
              : "bg-amber-100 text-amber-800 border border-amber-300 hover:bg-amber-100"
          }
        >
          خدمة الدمج: {health.merger.healthy ? "جاهزة" : "غير متجاوبة"}
        </Badge>
      ) : (
        <Badge className="bg-amber-100 text-amber-800 border border-amber-300 hover:bg-amber-100">
          خدمة الدمج: غير مهيأة (MERGER_API_BASE)
        </Badge>
      )}
      {health?.authRequired && (
        <Badge className="bg-neutral-100 text-neutral-700 border border-neutral-300 hover:bg-neutral-100">
          /mcp محمي بـ Bearer Token
        </Badge>
      )}
    </div>
  );
}
