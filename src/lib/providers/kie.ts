/**
 * محوّل kie.ai — Jobs API الموحّد (المزود الأساسي).
 *
 * الأشكال الحقيقية المقاسة من التوثيق الرسمي (docs.kie.ai):
 * - POST /api/v1/jobs/createTask  {model, input} → {code:200, data:{taskId}}
 * - GET  /api/v1/jobs/recordInfo?taskId=...      → {code, data:{state, resultJson, failMsg, progress}}
 *   - state: waiting | queuing | generating | success | fail
 *   - resultJson نص JSON داخل JSON يحتاج JSON.parse ثانيًا ({"resultUrls":["..."]}).
 *
 * تحذير عملي: kie.ai قد يعيد HTTP 200 مع رمز الخطأ داخل الجسم (code != 200) — لذا نفحص
 * حالة HTTP ورمز الجسم معًا ونرميهما كـ ProviderError ليُصنَّفا في classifyProviderError.
 */
import { ProviderError, fetchWithTimeout, extractErrorMessage, type ProviderAdapter, type ProviderKey, type CheckResult } from "./types";

const BASE = (process.env.KIE_API_BASE || "https://api.kie.ai").replace(/\/$/, "");
const CREATE_TIMEOUT_MS = 30_000;
const CHECK_TIMEOUT_MS = 20_000;

/** فحص مشترك: HTTP غير ناجح أو code داخل الجسم != 200 → خطأ مصنَّف */
function assertKieOk(httpStatus: number, body: Record<string, unknown>): void {
  const code = typeof body.code === "number" ? body.code : httpStatus;
  const ok = httpStatus >= 200 && httpStatus < 300 && (typeof body.code !== "number" || code === 200);
  if (!ok) {
    throw new ProviderError(code || httpStatus, extractErrorMessage(body, `kie.ai HTTP ${httpStatus}`));
  }
}

async function kieRequest(key: ProviderKey, path: string, init: RequestInit, timeoutMs: number): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${BASE}${path}`,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${key.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(init.headers ?? {}),
        },
      },
      timeoutMs,
    );
  } catch (e) {
    // انقطاع شبكتنا نحن — يُصنَّف temporary (نمرر رمزًا غير معروف)
    throw new ProviderError(null, `network: ${(e as Error).message}`);
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // جسم غير JSON — نستخدم الحالة فقط
  }
  assertKieOk(res.status, body);
  return body;
}

export const kieAdapter: ProviderAdapter = {
  mediaType: "video", // يدعم النوعين — يُحدَّد لكل نداء
  supportsSyncImages: false, // صور kie عبر Jobs API غير متزامنة دائمًا

  async createTask(key: ProviderKey, model: string, input: Record<string, unknown>) {
    const body = await kieRequest(key, "/api/v1/jobs/createTask", {
      method: "POST",
      body: JSON.stringify({ model, input }),
    }, CREATE_TIMEOUT_MS);
    const data = body.data as Record<string, unknown> | undefined;
    const taskId = data?.taskId;
    if (typeof taskId !== "string" || !taskId) {
      throw new ProviderError(null, "kie.ai: استجابة createTask بلا taskId");
    }
    return { providerTaskId: taskId };
  },

  async checkTask(key: ProviderKey, providerTaskId: string): Promise<CheckResult> {
    const body = await kieRequest(
      key,
      `/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`,
      { method: "GET" },
      CHECK_TIMEOUT_MS,
    );
    const data = (body.data ?? {}) as Record<string, unknown>;
    const state = String(data.state ?? "waiting");
    // resultJson نص JSON داخل JSON — تحليل دفاعي
    const resultUrls = parseResultUrls(data.resultJson);
    const progress = typeof data.progress === "number" ? data.progress : undefined;

    switch (state) {
      case "success":
        if (resultUrls.length === 0) {
          return { status: "failed", error: "kie.ai: المهمة نجحت بلا روابط نتائج" };
        }
        return { status: "completed", urls: resultUrls, progress: 100 };
      case "fail":
        return { status: "failed", error: String(data.failMsg || "kie.ai: فشلت المهمة لدى المزود") };
      case "waiting":
        return { status: "processing", progress: progress ?? 5 };
      case "queuing":
        return { status: "processing", progress: progress ?? 15 };
      case "generating":
        return { status: "processing", progress: progress ?? 50 };
      default:
        // حالة غير معروفة — نعاملها كمعالجة جارية ولا نخترع حقولًا
        return { status: "processing", progress };
    }
  },
};

export function parseResultUrls(resultJson: unknown): string[] {
  if (typeof resultJson !== "string" || !resultJson) return [];
  try {
    const parsed = JSON.parse(resultJson) as Record<string, unknown>;
    const urls = parsed.resultUrls;
    if (Array.isArray(urls)) return urls.filter((u): u is string => typeof u === "string" && u.length > 0);
    return [];
  } catch {
    return [];
  }
}
