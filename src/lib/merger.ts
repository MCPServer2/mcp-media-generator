/**
 * عميل خدمة دمج الفيديو — Video Merger API v2.
 *
 * قواعد جوهرية:
 * - بلا مفاتيح أو توثيق؛ العنوان من MERGER_API_BASE.
 * - المخرج ثابت: MP4 (H.264 + AAC) — لا معاملات resolution/fps.
 * - القيود: ≤10 مقاطع، 200MB لكل مصدر، 150MB للناتج، 600 ثانية مجموع المدد، حذف تلقائي بعد 24 ساعة.
 * - POST /api/jobs/{id}/process يُطلَق مرة واحدة فقط (قفل في الذاكرة + علم في قاعدة البيانات).
 * - أي خطأ HTTP معلن من الخدمة (4xx/5xx بجسم error) = فشل نهائي فوري — لا إعادة محاولة.
 *   أخطاء شبكتنا نحن (timeout/fetch) = مؤقتة → يستمر الاستعلام حتى نهاية النافذة.
 * - روابط فقط: لا ننزّل أي وسائط على سيرفرنا إطلاقًا.
 */
import { randomUUID } from "crypto";
import { insertTask, getTask, updateTask, type TaskRow } from "./turso";
import * as F from "./format";

const MERGER_BASE = (process.env.MERGER_API_BASE || "").replace(/\/$/, "");
const POLL_INTERVAL_MS = 3_000;
const RETRY_COOLDOWN_MS = 45_000;

// قفل في الذاكرة كي لا يتزامن نداء process مع get_task (يُخزَّن على globalThis ليصمد مع HMR)
const g = globalThis as unknown as { __mergeProcessInFlight?: Set<string>; __mergeProcessFired?: Map<string, boolean> };
const processInFlight = (g.__mergeProcessInFlight ??= new Set<string>());
const processFired = (g.__mergeProcessFired ??= new Map<string, boolean>());

export interface MergeJobResponse {
  jobId: string;
  status: string;
  statusUrl?: string;
  processUrl?: string;
  expiresAt?: string;
}

export interface MergeStatusResponse {
  status: string; // قد يغيب — نحلله دفاعيًا
  progress?: number; // قد يأتي كسرًا 0..1
  videoUrl?: string;
  downloadUrl?: string;
  processUrl?: string;
  error?: string;
}

async function mergerFetch(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${MERGER_BASE}${path}`, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** فحص جهوزية الخدمة: GET /api/config بمهلة 4 ثوانٍ */
export async function mergerHealthy(): Promise<{ base: string | null; healthy: boolean }> {
  if (!MERGER_BASE) return { base: null, healthy: false };
  try {
    const res = await mergerFetch("/api/config", { method: "GET" }, 4_000);
    return { base: MERGER_BASE, healthy: res.ok };
  } catch {
    return { base: MERGER_BASE, healthy: false };
  }
}

/** تحليل حالة الدمج دفاعيًا — أكمل/فشل بأنماط متعددة، والتقدم قد يأتي كسرًا */
export function parseMergeStatus(body: MergeStatusResponse): { status: "processing" | "completed" | "failed"; progress: number; error?: string } {
  const raw = String(body.status ?? "").toLowerCase();
  const done = ["done", "completed", "complete", "success", "succeeded", "finished"];
  const failed = ["error", "failed", "failure", "cancelled", "canceled"];

  // الجسم قد يحتوي error بلا status → فشل فورًا
  if (!raw && body.error) return { status: "failed", progress: 0, error: body.error };

  let status: "processing" | "completed" | "failed" = "processing";
  if (done.includes(raw)) status = "completed";
  else if (failed.includes(raw)) status = "failed";

  // التقدم كسر 0..1 → اضربه في 100
  let progress = typeof body.progress === "number" ? body.progress : 0;
  if (progress > 0 && progress <= 1) progress *= 100;
  progress = Math.max(0, Math.min(100, Math.round(progress)));

  return { status, progress, error: body.error };
}

/** رابط النتيجة: فضّل videoUrl ثم downloadUrl ثم صياغته من jobId */
export function mergeResultUrl(jobId: string, body: { videoUrl?: string; downloadUrl?: string }): string {
  if (body.videoUrl && /^https?:\/\//i.test(body.videoUrl)) return body.videoUrl;
  if (body.downloadUrl && /^https?:\/\//i.test(body.downloadUrl)) return body.downloadUrl;
  return `${MERGER_BASE}/api/jobs/${jobId}/video`;
}

/** فحص أن الرابط http/https مباشر وعام (لا localhost ولا شبكات داخلية) */
export function isPublicHttpUrl(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const h = url.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
    if (h === "::1" || h === "0.0.0.0") return false;
    // نطاقات IPv4 داخلية
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

/** إطلاق POST .../process مرة واحدة فقط — بقفل في الذاكرة + علم في params_json */
async function fireProcessOnce(row: TaskRow, jobId: string, processUrl?: string): Promise<void> {
  if (processInFlight.has(jobId)) return; // قفل التزامن: process لا يعمل مرتين معًا
  if (processFired.get(jobId)) return;
  const params = readRowParams(row);
  if (params._processFired === true) return; // علم دائم يصمد حتى بعد إعادة تشغيل السيرفر

  processInFlight.add(jobId);
  processFired.set(jobId, true);
  void runProcess(jobId, processUrl ?? `${MERGER_BASE}/api/jobs/${jobId}/process`).finally(() => {
    processInFlight.delete(jobId);
  });
}

async function runProcess(jobId: string, processUrl: string): Promise<void> {
  // يستغرق ~10-15 ثانية (blocking) — نجاحه يظهر عبر GET /api/jobs/{id}
  try {
    await mergerFetch(processUrl.replace(MERGER_BASE, ""), { method: "POST" }, 120_000);
  } catch {
    // خطأ شبكتنا — يبقى الاستعلام جارياً؛ الخدمة نفسها تكمل المعالجة إن وصلها الطلب
  }
}

function readRowParams(row: TaskRow): Record<string, unknown> {
  try {
    const v = JSON.parse(row.params_json || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export interface MergeArgs {
  urls?: string[];
  task_ids?: string[];
  waitSeconds: number;
  onProgress?: (p: { progress: number; total: number; message: string }) => Promise<void> | void;
}

export type MergeOutcome =
  | { kind: "completed"; text: string; isError?: false }
  | { kind: "processing"; text: string }
  | { kind: "failed"; text: string; isError: true };

/** نقطة الدخول لأداة merge_videos */
export async function runMerge(args: MergeArgs): Promise<MergeOutcome> {
  // حل روابط task_ids أولًا (بالترتيب) ثم إلحاق urls المباشرة بنفس ترتيبها
  const resolved: string[] = [];
  const failedDetails: string[] = [];
  for (const tid of args.task_ids ?? []) {
    const t = await getTask(tid);
    let url: string | null = null;
    if (t && t.type === "video" && t.status === "completed") {
      try {
        const urls = JSON.parse(t.result_urls_json ?? "[]") as string[];
        if (Array.isArray(urls) && typeof urls[0] === "string" && urls[0]) url = urls[0];
      } catch {
        url = null;
      }
    }
    if (url) resolved.push(url);
    else failedDetails.push(`task_id غير صالح أو غير مكتمل: ${tid}`);
  }
  resolved.push(...(args.urls ?? []).filter((u) => typeof u === "string"));

  // تحقق صارم: ≥2 و ≤10 وكلها روابط عامة مباشرة
  if (resolved.length < 2) {
    const details = failedDetails.length ? failedDetails.join("\n") : `استلمت ${resolved.length} مقطعًا فقط`;
    return { kind: "failed", text: F.fmtMergeNeedTwo(details), isError: true };
  }
  if (resolved.length > 10) {
    return { kind: "failed", text: F.fmtTooManyClips(), isError: true };
  }
  const bad = resolved.filter((u) => !isPublicHttpUrl(u));
  if (bad.length > 0) {
    return { kind: "failed", text: F.fmtInvalidUrls(bad), isError: true };
  }

  // الفحوصات الصارمة نجحت — الآن فقط نفحص تهيئة خدمة الدمج
  if (!MERGER_BASE) return { kind: "failed", text: F.fmtMergerUnavailable(), isError: true };

  // تسجيل مهمة الدمج في Turso أولًا
  const taskId = randomUUID();
  await insertTask({
    id: taskId,
    provider: "merger",
    model: "video-merger",
    type: "merge",
    prompt: "",
    params_json: JSON.stringify({ urls: resolved }),
    status: "processing",
  });

  return createAndDriveMerge(taskId, resolved, args.waitSeconds, args.onProgress);
}

/** إنشاء مهمة الدمج لدى الخدمة + إطلاق process + نافذة انتظار بالاستعلام */
async function createAndDriveMerge(
  taskId: string,
  urls: string[],
  waitSeconds: number,
  onProgress?: MergeArgs["onProgress"],
): Promise<MergeOutcome> {
  let jobId: string;
  let processUrl: string | undefined;
  try {
    const res = await mergerFetch(
      "/api/jobs",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videos: urls }) },
      30_000,
    );
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      // خطأ HTTP معلن من الخدمة = فشل نهائي فوري — لا إعادة محاولة
      const msg = typeof body.error === "string" ? body.error : `خدمة الدمج ردّت HTTP ${res.status}`;
      await updateTask(taskId, { status: "failed", error_message: msg });
      return { kind: "failed", text: F.fmtFailed(msg), isError: true };
    }
    jobId = String(body.jobId ?? "");
    if (!jobId) {
      const msg = "خدمة الدمج لم تعرّف jobId";
      await updateTask(taskId, { status: "failed", error_message: msg });
      return { kind: "failed", text: F.fmtFailed(msg), isError: true };
    }
    processUrl = typeof body.processUrl === "string" ? body.processUrl : undefined;
  } catch (e) {
    // خطأ شبكتنا نحن (timeout/fetch) = مؤقت → المهمة تبقى processing وتُعاد مع get_task بعد تهدئة
    const msg = `تعذر الاتصال بخدمة الدمج: ${(e as Error).message}`;
    await updateTask(taskId, { status: "processing", error_message: msg });
    return { kind: "processing", text: F.fmtProcessing(taskId) };
  }

  await updateTask(taskId, { provider_task_id: jobId, status: "processing" });
  const row = (await getTask(taskId))!;

  // إطلاق process خلفيًا وبمرة واحدة فقط
  await fireProcessOnce(row, jobId, processUrl);

  return pollMergeWindow(taskId, jobId, waitSeconds, onProgress);
}

/** نافذة انتظار الدمج: استعلام GET /api/jobs/{id} كل 3 ثوانٍ + كتابة الحالة في Turso فورًا */
async function pollMergeWindow(
  taskId: string,
  jobId: string,
  waitSeconds: number,
  onProgress?: MergeArgs["onProgress"],
): Promise<MergeOutcome> {
  const deadline = Date.now() + waitSeconds * 1000;
  let first = true;
  while (first || Date.now() < deadline) {
    if (!first) await sleep(POLL_INTERVAL_MS);
    first = false;
    if (waitSeconds > 0 && Date.now() > deadline) break;

    let res: Response;
    try {
      res = await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "GET" }, 15_000);
    } catch {
      // خطأ شبكتنا — مؤقت → استمر بالاستعلام حتى نهاية النافذة
      continue;
    }

    if (res.status === 404) {
      // فشل نهائي: المهمة غير موجودة في الخدمة
      const msg = F.fmtMergeJobNotFound();
      await updateTask(taskId, { status: "failed", error_message: msg });
      return { kind: "failed", text: F.fmtFailed(msg), isError: true };
    }

    if (!res.ok) {
      // أي خطأ HTTP معلن (4xx/5xx بجسم error) = فشل نهائي فوري
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      const msg = body.error ?? `خدمة الدمج ردّت HTTP ${res.status}`;
      await updateTask(taskId, { status: "failed", error_message: msg });
      return { kind: "failed", text: F.fmtFailed(msg), isError: true };
    }

    const body = (await res.json().catch(() => ({}))) as MergeStatusResponse;
    const parsed = parseMergeStatus(body);

    if (parsed.status === "completed") {
      const url = mergeResultUrl(jobId, body);
      await updateTask(taskId, { status: "completed", progress: 100, result_urls: [url] });
      return { kind: "completed", text: F.fmtMergeCompleted([url]) };
    }
    if (parsed.status === "failed") {
      const msg = parsed.error ?? "فشل الدمج لدى الخدمة";
      await updateTask(taskId, { status: "failed", error_message: msg });
      return { kind: "failed", text: F.fmtFailed(msg), isError: true };
    }

    await updateTask(taskId, { status: "processing", progress: parsed.progress });
    if (onProgress) {
      try {
        await onProgress({ progress: parsed.progress, total: 100, message: `قيد الدمج… ${parsed.progress}%` });
      } catch {
        /* بث التقدم لا يوقف المهمة */
      }
    }
  }
  return { kind: "processing", text: F.fmtProcessing(taskId) };
}

/** get_task لمهمة دمج — يحدّث من GET /api/jobs/{id} ويطلق process إن لم يُنفَّذ بعد */
export async function refreshMergeTask(row: TaskRow): Promise<MergeOutcome> {
  if (!MERGER_BASE) return { kind: "failed", text: F.fmtMergerUnavailable(), isError: true };

  const params = readRowParams(row);
  const urls = Array.isArray(params.urls) ? (params.urls as string[]) : [];

  // لم يُنشأ jobId بعد (فشل اتصال سابق) → أعد المحاولة بعد تهدئة ~45 ثانية
  if (!row.provider_task_id) {
    const updatedMs = Date.parse(row.updated_at.replace(" ", "T") + "Z");
    if (Number.isFinite(updatedMs) && Date.now() - updatedMs < RETRY_COOLDOWN_MS) {
      return { kind: "processing", text: F.fmtWaitingKeys() };
    }
    if (urls.length >= 2) {
      return createAndDriveMerge(row.id, urls, 0);
    }
    const msg = F.fmtMergeNeedTwo("المعطيات المخزنة لا تكفي لإعادة الإنشاء");
    await updateTask(row.id, { status: "failed", error_message: msg });
    return { kind: "failed", text: F.fmtFailed(msg), isError: true };
  }

  const jobId = row.provider_task_id;
  let res: Response;
  try {
    res = await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "GET" }, 15_000);
  } catch {
    // خطأ شبكتنا — مؤقت
    return { kind: "processing", text: F.fmtProcessing(row.id) };
  }

  if (res.status === 404) {
    const msg = F.fmtMergeJobNotFound();
    await updateTask(row.id, { status: "failed", error_message: msg });
    return { kind: "failed", text: F.fmtFailed(msg), isError: true };
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    const msg = body.error ?? `خدمة الدمج ردّت HTTP ${res.status}`;
    await updateTask(row.id, { status: "failed", error_message: msg });
    return { kind: "failed", text: F.fmtFailed(msg), isError: true };
  }

  const body = (await res.json().catch(() => ({}))) as MergeStatusResponse;
  const parsed = parseMergeStatus(body);

  if (parsed.status === "completed") {
    const url = mergeResultUrl(jobId, body);
    await updateTask(row.id, { status: "completed", progress: 100, result_urls: [url] });
    return { kind: "completed", text: F.fmtMergeCompleted([url]) };
  }
  if (parsed.status === "failed") {
    const msg = parsed.error ?? "فشل الدمج لدى الخدمة";
    await updateTask(row.id, { status: "failed", error_message: msg });
    return { kind: "failed", text: F.fmtFailed(msg), isError: true };
  }

  // لا تزال قيد المعالجة — إن لم يُنفَّذ process بعد فنفّذه الآن
  const fresh = (await getTask(row.id))!;
  await fireProcessOnce(fresh, jobId, typeof body.processUrl === "string" ? body.processUrl : undefined);

  await updateTask(row.id, { status: "processing", progress: parsed.progress });
  return { kind: "processing", text: F.fmtProcessing(row.id) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** حذف مهمة دمج من خدمة الدمج — أداة تنظيف اختيارية (تحذف الملف نهائيًا) */
export async function deleteMergeJob(jobId: string): Promise<boolean> {
  if (!MERGER_BASE) return false;
  try {
    const res = await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" }, 10_000);
    return res.ok;
  } catch {
    return false;
  }
}
