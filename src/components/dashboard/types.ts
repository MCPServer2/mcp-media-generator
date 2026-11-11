"use client";

/** أنواع مشتركة بين بطاقات اللوحة — مطابقة لردود /api/keys و /api/tasks و /api/health */

export interface PublicKeyView {
  id: string;
  provider: string; // kie | cometapi
  label: string;
  maskedKey: string; // مُقنَّع دائمًا — لا مفتاح كامل أبدًا
  status: "active" | "exhausted" | "disabled" | string;
  usageCount: number;
  successCount: number;
  failCount: number;
  lastUsedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface TaskAttemptView {
  provider?: string;
  keyId?: string | null;
  keyLabel?: string;
  ok?: boolean;
  errorClass?: string;
  error?: string;
  at?: string;
}

export interface TaskView {
  id: string;
  type: string; // image | video | merge
  model: string;
  status: string; // pending | processing | completed | failed
  progress: number;
  prompt: string;
  provider: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  urls: string[];
  attemptsCount: number;
  attempts: TaskAttemptView[];
}

export interface TasksResponse {
  stats: { total: number; completed: number; failed: number; processing: number };
  tasks: TaskView[];
}

export interface HealthResponse {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  models: Array<{ canonical: string; type: string; providers: string[] }>;
  merger: { base: string | null; healthy: boolean };
  authRequired: boolean;
}

export const PROVIDER_LABELS: Record<string, string> = {
  kie: "kie.ai",
  cometapi: "CometAPI",
  merger: "خدمة الدمج",
};

/** تنسيق التوقيت القادم من Turso (UTC "YYYY-MM-DD HH:MM:SS") بالعربية المحلية */
export function fmtTime(t: string | null | undefined): string {
  if (!t) return "—";
  const d = new Date(t.includes("T") ? t : t.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return t;
  return d.toLocaleString("ar", { hour12: false, dateStyle: "short", timeStyle: "short" });
}
