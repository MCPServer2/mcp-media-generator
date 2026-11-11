/**
 * واجهة المزودات المشتركة.
 * أي خطأ من مزود يُرمى كـ ProviderError {status, message} ليُصنَّف لاحقًا في classifyProviderError.
 */
import type { MediaType } from "../models";

export interface ProviderKey {
  id: string;
  provider: string;
  label: string;
  apiKey: string;
}

export class ProviderError extends Error {
  status: number | null;
  constructor(status: number | null, message: string) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

export interface CheckResult {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number; // 0..100 إن وفره المزود
}

export interface ProviderAdapter {
  /** مهمة غير متزامنة (فيديو وبعض الصور): تعيد providerTaskId */
  createTask(key: ProviderKey, model: string, input: Record<string, unknown>): Promise<{ providerTaskId: string }>;
  /** صور متزامنة إن كان المزود يدعمها (CometAPI تعيد النتيجة فورًا) */
  createImageSync?(key: ProviderKey, input: Record<string, unknown>): Promise<{ urls: string[] }>;
  /** استعلام حالة مهمة جارية */
  checkTask(key: ProviderKey, providerTaskId: string): Promise<CheckResult>;
  /** هل يدعم هذا المزود النوع بطريقة متزامنة؟ */
  supportsSyncImages?: boolean;
  mediaType: MediaType;
}

/** fetch بمهلة زمنية قصيرة — انقطاع الشبكة/timeout يُصنَّف temporary لاحقًا */
export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** استخراج رسالة الخطأ من جسم استجابة بأي شكل شائع (msg / message / error) */
export function extractErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (typeof b.msg === "string" && b.msg) return b.msg;
    if (typeof b.message === "string" && b.message) return b.message;
    if (typeof b.error === "string" && b.error) return b.error;
    if (b.error && typeof b.error === "object") {
      const e = b.error as Record<string, unknown>;
      if (typeof e.message === "string" && e.message) return e.message;
    }
  }
  return fallback;
}
