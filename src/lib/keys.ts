/**
 * نظام المفاتيح المتسلسلة — قلب المشروع.
 *
 * القواعد الجوهرية:
 * 1) الترتيب الصارم: أول مفتاح أُضيف يُجرَّب أولًا (created_at ASC, id ASC) — ليس round-robin وليس «الأقل استخدامًا أولًا».
 * 2) المفتاح المستنزف (exhausted) يبقى في القائمة والقاعدة — الاستثناء الوحيد للتعطيل اليدوي (disabled).
 * 3) تصنيف أخطاء موحّد يقرر: هل نبدّل المفتاح أم نتوقف فورًا (خطأ معطيات).
 * 4) إخفاء المفاتيح إلزامي: maskKey في كل الاستجابات والسجلات.
 */
import {
  listAllKeys,
  updateApiKey,
  type ApiKeyRow,
} from "./turso";
import type { ProviderId } from "./models";

/** مفاتيح المزودات المطلوبة — بالترتيب التسلسلي الصارم حسب الإضافة */
export async function getKeyPool(providers: ProviderId[]): Promise<ApiKeyRow[]> {
  const all = await listAllKeys();
  return all
    .filter((k) => k.status !== "disabled" && providers.includes(k.provider as ProviderId))
    .sort((a, b) => {
      // ترتيب مزدوج للتسلسلية الصارمة: زمن الإضافة ثم المعرف (مطابق لـ ORDER BY created_at ASC, id ASC)
      if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
}

export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

/**
 * تصنيف موحّد لأخطاء المزودين.
 * الترتيب مقصود: نفحص نفاد الرصيد قبل 400 لأن بعض المزودين يرسلون «نفاد رصيد» بحالة 400.
 * ملاحظة مهمة عن kie.ai: قد يعيد HTTP 200 مع رمز الخطأ داخل الجسم — فالمصنِّف يُستدعى بعد دمج
 * حالة HTTP مع رسالة الجسم في مصدر واحد.
 */
export function classifyProviderError(httpStatus: number | null, message: string): ErrorClass {
  const status = httpStatus ?? 0;
  const m = (message || "").toLowerCase();

  // 1) نفاد الرصيد (قبل 400 عمدًا — انظر التعليق أعلاه)
  if (
    status === 402 ||
    /insufficient|quota|balance|credit|out of credits|exhausted|充值|رصيد/.test(m)
  ) {
    return "exhausted";
  }

  // 2) مفتاح مرفوض → يُعطَّل تلقائيًا
  if (
    status === 401 ||
    status === 403 ||
    /invalid api key|invalid_api_key|unauthorized|forbidden|authentication|api key.*(invalid|expired|disabled)/.test(m)
  ) {
    return "disabled";
  }

  // 3) موديل غير مدعوم لدى هذا المزود → ننتقل للمفتاح التالي
  if (
    [400, 404, 422].includes(status) &&
    /model not found|unsupported model|invalid model|unknown model|does not exist|no such model/.test(m)
  ) {
    return "provider";
  }

  // 4) خطأ معطيات — تبديل المفاتيح لن يحلّه → توقف فورًا
  if (status === 400 || status === 422) {
    return "params";
  }

  // 5) مؤقت: 429، 5xx، شبكة، timeout، أو أي شيء آخر غير مفهوم
  return "temporary";
}

export interface AttemptRecord {
  provider: string;
  keyId: string | null;
  keyLabel: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

/** تحديث عدّادات وحالة المفتاح بعد كل محاولة (تُحدَّث دائمًا — نجاح أو فشل) */
export async function recordKeyOutcome(key: ApiKeyRow, ok: boolean, errorClass?: ErrorClass, error?: string): Promise<void> {
  const patch: Parameters<typeof updateApiKey>[1] = {
    usage_count: key.usage_count + 1,
    success_count: key.success_count + (ok ? 1 : 0),
    fail_count: key.fail_count + (ok ? 0 : 1),
    last_used_at: new Date().toISOString().replace("T", " ").slice(0, 19),
    last_checked_at: new Date().toISOString().replace("T", " ").slice(0, 19),
  };
  if (!ok) patch.last_error = (error ?? "").slice(0, 500);
  // علّم المفتاح تلقائيًا حسب الفئة:
  // disabled → مرفوض نهائيًا؛ exhausted → مستنزف (يبقى في القاعدة ولا يُستبعد)
  if (errorClass === "disabled") patch.status = "disabled";
  else if (errorClass === "exhausted") patch.status = "exhausted";
  else if (ok && key.status === "exhausted") patch.status = "active"; // نجح مفتاح كان مستنزفًا (شحن رصيد مثلاً) → أعد تنشيطه
  await updateApiKey(key.id, patch);
}

/** إخفاء المفتاح: أول 7 أحرف + •••••••• + آخر 4 — والقصيرة أول 3 + •••• */
export function maskKey(key: string): string {
  if (key.length <= 10) {
    return key.slice(0, 3) + "••••";
  }
  return key.slice(0, 7) + "••••••••" + key.slice(-4);
}

/** شكل المفتاح كما يُعاد للواجهة — بلا مفتاح كامل أبدًا */
export function publicKeyView(k: ApiKeyRow) {
  return {
    id: k.id,
    provider: k.provider,
    label: k.label,
    maskedKey: maskKey(k.api_key),
    status: k.status,
    usageCount: k.usage_count,
    successCount: k.success_count,
    failCount: k.fail_count,
    lastUsedAt: k.last_used_at,
    lastError: k.last_error,
    createdAt: k.created_at,
  };
}
