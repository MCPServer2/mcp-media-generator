/**
 * محوّل CometAPI (المزود الثاني).
 *
 * الأشكال الحقيقية من التوثيق الرسمي (apidoc.cometapi.com):
 * - صور متزامنة: POST /v1/images/generations (متوافق مع OpenAI) → {data:[{url | b64_json}]} فورًا.
 * - فيديو غير متزامن: POST /v1/videos (multipart/form-data) → {id, task_id, status:"queued", progress}
 *   ثم GET /v1/videos/{id} حتى status:"completed" حيث تظهر video_url.
 *
 * ملاحظة: إذا تغيّرت أشكال الاستجابات لاحقًا نلتزم بالتوثيق الحالي — لا اختراع حقول.
 */
import {
  ProviderError,
  fetchWithTimeout,
  extractErrorMessage,
  type ProviderAdapter,
  type ProviderKey,
  type CheckResult,
} from "./types";

const BASE = (process.env.COMETAPI_API_BASE || "https://api.cometapi.com").replace(/\/$/, "");
const CREATE_TIMEOUT_MS = 30_000;
const CHECK_TIMEOUT_MS = 20_000;

function headers(key: ProviderKey): Record<string, string> {
  return { Authorization: `Bearer ${key.apiKey}` };
}

async function parseBody(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export const cometapiAdapter: ProviderAdapter = {
  mediaType: "video",
  supportsSyncImages: true, // صور CometAPI متزامنة عبر نقطة images المتوافقة مع OpenAI

  /** صور متزامنة — تعيد الروابط فورًا (b64_json تُحوَّل إلى data URI لأننا لا نخزن ملفات) */
  async createImageSync(key: ProviderKey, input: Record<string, unknown>) {
    let res: Response;
    try {
      res = await fetchWithTimeout(
        `${BASE}/v1/images/generations`,
        {
          method: "POST",
          headers: { ...headers(key), "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
        CREATE_TIMEOUT_MS,
      );
    } catch (e) {
      throw new ProviderError(null, `network: ${(e as Error).message}`);
    }
    const body = await parseBody(res);
    if (!res.ok) throw new ProviderError(res.status, extractErrorMessage(body, `CometAPI HTTP ${res.status}`));

    const data = body.data as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(data) || data.length === 0) {
      throw new ProviderError(res.status, "CometAPI: استجابة الصور بلا بيانات");
    }
    const urls: string[] = [];
    for (const item of data) {
      if (typeof item.url === "string" && item.url) {
        urls.push(item.url);
      } else if (typeof item.b64_json === "string" && item.b64_json) {
        // قاعدة «روابط فقط»: نحوّل b64 إلى data URI بدل تخزين أي ملف على سيرفرنا
        urls.push(`data:image/png;base64,${item.b64_json}`);
      }
    }
    if (urls.length === 0) throw new ProviderError(res.status, "CometAPI: لا روابط ولا b64 في الاستجابة");
    return { urls };
  },

  /** فيديو غير متزامن — multipart/form-data كما في التوثيق */
  async createTask(key: ProviderKey, model: string, input: Record<string, unknown>) {
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", String(input.prompt ?? ""));
    if (typeof input.duration === "number") form.append("seconds", String(input.duration));
    if (typeof input.image_url === "string" && input.image_url) {
      // صورة مرجعية كأول إطار (image-to-video) — رابط عام واحد حسب التوثيق
      form.append("input_reference", input.image_url);
    }
    let res: Response;
    try {
      res = await fetchWithTimeout(`${BASE}/v1/videos`, { method: "POST", headers: headers(key), body: form }, CREATE_TIMEOUT_MS);
    } catch (e) {
      throw new ProviderError(null, `network: ${(e as Error).message}`);
    }
    const body = await parseBody(res);
    if (!res.ok) throw new ProviderError(res.status, extractErrorMessage(body, `CometAPI HTTP ${res.status}`));

    const taskId = body.task_id ?? body.id;
    if (typeof taskId !== "string" || !taskId) {
      throw new ProviderError(res.status, "CometAPI: استجابة إنشاء الفيديو بلا معرف مهمة");
    }
    return { providerTaskId: taskId };
  },

  async checkTask(key: ProviderKey, providerTaskId: string): Promise<CheckResult> {
    let res: Response;
    try {
      res = await fetchWithTimeout(
        `${BASE}/v1/videos/${encodeURIComponent(providerTaskId)}`,
        { method: "GET", headers: headers(key) },
        CHECK_TIMEOUT_MS,
      );
    } catch (e) {
      throw new ProviderError(null, `network: ${(e as Error).message}`);
    }
    const body = await parseBody(res);
    if (!res.ok) throw new ProviderError(res.status, extractErrorMessage(body, `CometAPI HTTP ${res.status}`));

    const status = String(body.status ?? body.state ?? "").toLowerCase();
    const progress = typeof body.progress === "number" ? body.progress : undefined;

    switch (status) {
      case "completed":
      case "succeeded": {
        // استخراج دفاعي للرابط — التوثيق يذكر video_url عند الاكتمال
        const urls = extractVideoUrls(body);
        if (urls.length === 0) return { status: "failed", error: "CometAPI: المهمة اكتملت بلا رابط فيديو" };
        return { status: "completed", urls, progress: 100 };
      }
      case "failed":
      case "error":
        return { status: "failed", error: extractErrorMessage(body, "CometAPI: فشلت المهمة لدى المزود") };
      case "queued":
        return { status: "processing", progress: progress ?? 10 };
      case "in_progress":
      case "processing":
        return { status: "processing", progress: progress ?? 50 };
      default:
        return { status: "processing", progress };
    }
  },
};

/** استخراج روابط الفيديو بأي شكل شائع — بترتيب فضّل واضح (video_url أولًا) */
function extractVideoUrls(body: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && /^https?:\/\//i.test(v)) out.push(v);
  };
  push(body.video_url);
  push(body.videoUrl);
  push(body.url);
  if (typeof body.output === "string") push(body.output);
  if (Array.isArray(body.output)) body.output.forEach(push);
  if (body.data && typeof body.data === "object") {
    const d = body.data as Record<string, unknown>;
    if (Array.isArray(d.videos)) {
      for (const v of d.videos as Array<Record<string, unknown>>) push(v?.url ?? v?.video_url);
    }
    push(d.video_url);
    push(d.url);
  }
  return [...new Set(out)];
}
