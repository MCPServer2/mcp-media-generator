/** أدوات مشتركة للمسارات — صياغة العنوان الذاتي وهيكل الحالة الموحد */
import type { MergerJob } from "./store";

/** العنوان الذاتي: SELF_BASE_URL إن ضُبط (موصى به على Vercel) وإلا من ترويسات الطلب */
export function selfBase(req: Request): string {
  const envBase = process.env.SELF_BASE_URL;
  if (envBase) return envBase.replace(/\/$/, "");
  const proto = req.headers.get("x-forwarded-proto") ?? "http";
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "localhost:3002";
  return `${proto}://${host}`;
}

/** فحص أن رابط المصدر http/https وعام (حجب localhost والنطاقات الداخلية كي لا نتحول أداة SSRF) */
export function isSourceUrlAllowed(u: string, allowPrivate: boolean): boolean {
  try {
    const url = new URL(u);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (allowPrivate) return true;
    const h = url.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
    if (h === "::1" || h === "0.0.0.0") return false;
    const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
      const [a, b] = [Number(m[1]), Number(m[2])];
      if (a === 10 || a === 127 || a === 0) return false;
      if (a === 192 && b === 168) return false;
      if (a === 172 && b >= 16 && b <= 31) return false;
      if (a === 169 && b === 254) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** هيكل الحالة الموحد لـ GET /api/jobs/{id} — نفس حقول العميل في التطبيق الرئيسي */
export function snapshot(job: MergerJob, base: string) {
  return {
    id: job.id,
    status: job.status, // created | processing | done | failed
    progress: job.progress, // 0..100
    videoUrl: job.videoUrl ?? undefined,
    downloadUrl: job.downloadUrl ?? undefined,
    processUrl: `${base}/api/jobs/${job.id}/process`,
    size: job.sizeBytes ?? undefined,
    duration: job.durationSec ?? undefined,
    resolution: job.resolution ?? undefined,
    error: job.error ?? undefined,
    createdAt: job.createdAt,
    expiresAt: job.expiresAt,
  };
}
