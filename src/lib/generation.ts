/**
 * منسّق التوليد runGeneration — منطق «لا توقف أبدًا».
 *
 * سلوك التبديل التسلسلي:
 * - تُجرَّب المفاتيح بالترتيب الصارم حتى نجاح الإنشاء؛ كل محاولة تُسجَّل في attempts_json
 *   وتُحدَّث عدّادات المفتاح دائمًا.
 * - فشل في منتصف المهمة برسالة تشبه مشكلات مفتاح/رصيد → يُعاد إنشاء نفس المهمة بنفس task_id
 *   على المفتاح التالي تلقائيًا — العميل يرى «قيد المعالجة» فقط.
 * - فشل الإنشاء على كل المفاتيح → المهمة تبقى processing (ليست failed) وتُعاد المحاولة
 *   تلقائيًا مع كل get_task بعد تهدئة ~45 ثانية — لو شُحن رصيد أي مفتاح اكتملت المهمة وحدها.
 * - نموذج الذكاء الاصطناعي لا يرى أبدًا خطأ مفتاح أو رصيد.
 */
import { randomUUID } from "crypto";
import {
  insertTask,
  getTask,
  updateTask,
  getApiKey,
  type TaskRow,
  type TaskAttempt,
  type ApiKeyRow,
} from "./turso";
import { getKeyPool, classifyProviderError, recordKeyOutcome, type AttemptRecord } from "./keys";
import { resolveModel, defaultModelFor, type ModelDef, type ProviderId } from "./models";
import { ProviderError, type ProviderAdapter, type ProviderKey, type CheckResult } from "./providers/types";
import { kieAdapter } from "./providers/kie";
import { cometapiAdapter } from "./providers/cometapi";
import * as F from "./format";

const POLL_INTERVAL_MS = 3_000;
const RETRY_COOLDOWN_MS = 45_000;
/** نمط رسائل «مشكلة مفتاح/رصيد» التي تستدعي التبديل في منتصف المهمة (قسم 4.3.2) */
const KEY_ISSUE_PATTERN = /insufficient|balance|credit|quota|402|401|unauthorized|forbidden|invalid api key|充值/i;

const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  kie: kieAdapter,
  cometapi: cometapiAdapter,
};

export class ToolParamsError extends Error {}

export interface GenerationArgs {
  type: "image" | "video";
  model?: string;
  params: Record<string, unknown>;
  waitSeconds: number;
  onProgress?: (p: { progress: number; total: number; message: string }) => Promise<void> | void;
}

export type Outcome =
  | { kind: "completed"; text: string; isError?: false }
  | { kind: "processing"; text: string }
  | { kind: "failed"; text: string; isError: true };

interface PoolKey extends ProviderKey {
  row: ApiKeyRow;
  provider: ProviderId;
}

function toPoolKey(row: ApiKeyRow): PoolKey {
  return { id: row.id, provider: row.provider as ProviderId, label: row.label, apiKey: row.api_key, row };
}

function adapterFor(provider: string): ProviderAdapter {
  return ADAPTERS[provider as ProviderId];
}

/** بناء input الخاص بالمزود من معطيات الأداة — تُمرَّر الحقول المعرَّفة فقط */
function buildInput(type: "image" | "video", params: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = { prompt: params.prompt };
  if (type === "image") {
    for (const k of ["aspect_ratio", "resolution", "background", "output_format"] as const) {
      if (params[k] !== undefined && params[k] !== "auto") input[k] = params[k];
      else if (params[k] === "auto" && k === "aspect_ratio") input[k] = "auto";
    }
  } else {
    for (const k of ["aspect_ratio", "resolution"] as const) {
      if (params[k] !== undefined) input[k] = params[k];
    }
    input.enable_audio = params.enable_audio !== false; // الافتراضي true
    if (typeof params.duration === "number") input.duration = params.duration;
    if (typeof params.image_url === "string" && params.image_url) input.image_url = params.image_url;
  }
  return input;
}

function nowIso(): string {
  return new Date().toISOString();
}

function attemptEntry(key: PoolKey | null, provider: string, ok: boolean, errorClass?: string, error?: string): AttemptRecord {
  return {
    provider,
    keyId: key?.id ?? null,
    keyLabel: key?.label ?? "",
    ok,
    ...(errorClass ? { errorClass } : {}),
    ...(error ? { error: error.slice(0, 300) } : {}),
    at: nowIso(),
  };
}

/**
 * تجربة الإنشاء على مجموعة المفاتيح بالترتيب بدءًا من startIndex.
 * النتائج:
 * - {syncUrls} → صورة متزامنة اكتملت فورًا
 * - {providerTaskId} → مهمة أُنشئت لدى مزود
 * - "awaiting" → فشل كل المفاتيح → تبقى processing بانتظار مفتاح صالح
 * - {paramsError} → خطأ معطيات → توقف فورًا (التبديل لن يحلّه)
 */
async function tryCreateOnPool(
  task: TaskRow,
  def: ModelDef,
  pool: PoolKey[],
  startIndex: number,
): Promise<
  | { ok: true; provider: ProviderId; key: PoolKey; providerTaskId?: string; syncUrls?: string[] }
  | { ok: false; awaiting: true }
  | { ok: false; paramsError: string }
> {
  for (let i = startIndex; i < pool.length; i++) {
    const key = pool[i];
    const adapter = adapterFor(key.provider);
    const modelForProvider = def.providerModel[key.provider] ?? def.canonical;
    const input = buildInput(def.type as "image" | "video", safeParse(task.params_json));

    try {
      // الصور المتزامنة (CometAPI): النتيجة فورية بلا مهمة لدى المزود
      if (def.type === "image" && adapter.supportsSyncImages && adapter.createImageSync) {
        const { urls } = await adapter.createImageSync(key, {
          model: modelForProvider,
          ...input,
        });
        await recordKeyOutcome(key.row, true);
        return { ok: true, provider: key.provider, key, syncUrls: urls };
      }
      const { providerTaskId } = await adapter.createTask(key, modelForProvider, input);
      await recordKeyOutcome(key.row, true);
      return { ok: true, provider: key.provider, key, providerTaskId };
    } catch (e) {
      const cls = classify(e);
      const errMsg = e instanceof Error ? e.message : String(e);
      // كل محاولة (نجاحًا أو فشلًا + الفئة) تُسجَّل في attempts_json
      await updateTask(task.id, { attempt: attemptEntry(key, key.provider, false, cls, errMsg) });
      await recordKeyOutcome(key.row, false, cls, errMsg);
      if (cls === "params") {
        return { ok: false, paramsError: errMsg };
      }
      // disabled/exhausted/provider/temporary → ننتقل للمفتاح التالي فورًا
      continue;
    }
  }
  return { ok: false, awaiting: true };
}

function classify(e: unknown): ReturnType<typeof classifyProviderError> {
  if (e instanceof ProviderError) return classifyProviderError(e.status, e.message);
  const msg = e instanceof Error ? e.message : String(e);
  return classifyProviderError(null, msg);
}

function safeParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

interface PollOutcome {
  kind: "completed" | "failed" | "processing" | "switch";
  urls?: string[];
  error?: string;
  nextIndex?: number;
}

/**
 * نافذة الانتظار: استعلام كل 3 ثوانٍ + بث تقدم حي.
 * أي فشل من نوع مفتاح/رصيد أثناء التنفيذ → switch (نفس المهمة تُستأنف على المفتاح التالي).
 * أي خطأ HTTP معلن من خدمة الدمج = حتمي (يُعالج في merger.ts).
 */
async function pollWindow(
  task: TaskRow,
  def: ModelDef,
  provider: ProviderId,
  key: PoolKey,
  pool: PoolKey[],
  providerTaskId: string,
  waitSeconds: number,
  startedAt: number,
  onProgress?: GenerationArgs["onProgress"],
): Promise<PollOutcome> {
  const adapter = adapterFor(provider);
  const deadline = Date.now() + waitSeconds * 1000;
  let first = true;

  while (first || Date.now() < deadline) {
    if (!first) await sleep(POLL_INTERVAL_MS);
    first = false;
    if (waitSeconds > 0 && Date.now() > deadline) break;

    let check: CheckResult;
    try {
      check = await adapter.checkTask(key, providerTaskId);
    } catch (e) {
      const cls = classify(e);
      if (cls === "disabled" || cls === "exhausted" || cls === "provider") {
        // المفتاح رُفض أو استُنزف أو الموديل غير مدعوم → استئناف نفس المهمة على المفتاح التالي
        await recordKeyOutcome(key.row, false, cls, e instanceof Error ? e.message : String(e));
        await updateTask(task.id, {
          attempt: attemptEntry(key, provider, false, cls, e instanceof Error ? e.message : String(e)),
        });
        return { kind: "switch", nextIndex: poolIndexOf(pool, key) + 1 };
      }
      // params/temporary أثناء الاستعلام → نستمر بالاستعلام حتى نهاية النافذة
      continue;
    }
    if (check.status === "completed" && check.urls && check.urls.length > 0) {
      await updateTask(task.id, { status: "completed", progress: 100, result_urls: check.urls });
      return { kind: "completed", urls: check.urls };
    }
    if (check.status === "failed") {
      const msg = check.error ?? "فشل غير معروف لدى المزود";
      if (KEY_ISSUE_PATTERN.test(msg)) {
        // فشل بسببه مفتاح/رصيد → تبديل صامت لنفس المهمة (ونعلّم المفتاح مستنزفًا)
        await recordKeyOutcome(key.row, false, "exhausted", msg);
        await updateTask(task.id, { attempt: attemptEntry(key, provider, false, "exhausted", msg) });
        return { kind: "switch", nextIndex: poolIndexOf(pool, key) + 1 };
      }
      await updateTask(task.id, { status: "failed", error_message: msg });
      return { kind: "failed", error: msg };
    }

    // قيد المعالجة — نكتب التقدم في Turso فورًا ونبثه حيًا
    const progress = resolveProgress(check, startedAt, waitSeconds);
    await updateTask(task.id, { status: "processing", progress });
    if (onProgress) {
      try {
        await onProgress({ progress, total: 100, message: `قيد التوليد… ${progress}%` });
      } catch {
        // فشل بث التقدم لا يوقف المهمة
      }
    }
  }
  return { kind: "processing" };
}

function poolIndexOf(pool: PoolKey[], key: PoolKey): number {
  const idx = pool.findIndex((k) => k.id === key.id);
  return idx < 0 ? 0 : idx;
}

function resolveProgress(check: CheckResult, startedAt: number, waitSeconds: number): number {
  if (typeof check.progress === "number" && check.progress > 0) {
    return Math.min(95, Math.max(1, Math.round(check.progress)));
  }
  if (waitSeconds <= 0) return 50;
  const elapsed = Date.now() - startedAt;
  return Math.min(95, Math.max(1, Math.round((elapsed / (waitSeconds * 1000)) * 90)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** وضع «بانتظار مفتاح صالح» — المهمة تبقى processing وتُعاد محاولتها بعد تهدئة 45 ثانية */
async function enterAwaitingState(taskId: string): Promise<Outcome> {
  await updateTask(taskId, { status: "processing", error_message: "بانتظار توفر مفتاح صالح…" });
  return { kind: "processing", text: F.fmtWaitingKeys() };
}

/**
 * القيادة الكاملة لمهمة توليد: إنشاء بالتبديل التسلسلي ← نافذة انتظار ببث تقدم ←
 * استئناف على المفتاح التالي عند أي فشل مفتاح/رصيد.
 */
async function driveTask(
  task: TaskRow,
  def: ModelDef,
  waitSeconds: number,
  fromIndex: number,
  onProgress?: GenerationArgs["onProgress"],
): Promise<Outcome> {
  const pool = (await getKeyPool(def.providers)).map(toPoolKey);
  const startedAt = Date.now();
  let idx = fromIndex;

  while (true) {
    if (idx >= pool.length) return await enterAwaitingState(task.id);

    const created = await tryCreateOnPool(task, def, pool, idx);

    if (!created.ok) {
      if ("paramsError" in created) {
        const msg = F.fmtParamsError(created.paramsError);
        await updateTask(task.id, { status: "failed", error_message: msg });
        return { kind: "failed", text: msg, isError: true };
      }
      // كل المفاتيح فشلت — المهمة تبقى processing (وليست failed)
      return await enterAwaitingState(task.id);
    }

    // ربط المهمة بالمزود والمفتاح الناجحين — وكل محاولة (حتى الناجحة) تُوثَّق في السجل
    await updateTask(task.id, {
      provider: created.provider,
      provider_task_id: created.providerTaskId ?? null,
      key_id: created.key.id,
      status: "processing",
      attempt: attemptEntry(created.key, created.provider, true),
    });

    if (created.syncUrls) {
      // صورة متزامنة — اكتملت فورًا
      await updateTask(task.id, { status: "completed", progress: 100, result_urls: created.syncUrls });
      return { kind: "completed", text: F.fmtImageCompleted(created.syncUrls[0]) };
    }

    const poll = await pollWindow(task, def, created.provider, created.key, pool, created.providerTaskId!, waitSeconds, startedAt, onProgress);

    if (poll.kind === "completed") return { kind: "completed", text: completedText(def.type, poll.urls!) };
    if (poll.kind === "failed") return { kind: "failed", text: F.fmtFailed(poll.error ?? "سبب غير معروف"), isError: true };
    if (poll.kind === "switch") {
      // نفس المهمة بنفس task_id تُستأنف على المفتاح التالي — العميل لا يعلم بشيء
      idx = poll.nextIndex ?? poolIndexOf(pool, created.key) + 1;
      continue;
    }
    // انتهت النافذة والنتيجة لم تظهر → يتابع العميل بـ get_task
    return { kind: "processing", text: F.fmtProcessing(task.id) };
  }
}

function completedText(type: "image" | "video" | "merge", urls: string[]): string {
  if (type === "image") return F.fmtImageCompleted(urls[0]);
  if (type === "merge") return F.fmtMergeCompleted(urls);
  return F.fmtVideoCompleted(urls);
}

/** نقطة الدخول لأداتي generate_image / generate_video */
export async function runGeneration(args: GenerationArgs): Promise<Outcome> {
  // 1) توحيد اسم الموديل — غير معروف → خطأ معطيات فوري
  const def = args.model ? resolveModel(args.model) : defaultModelFor(args.type);
  if (!def) {
    throw new ToolParamsError(F.fmtUnknownModel(args.model ?? ""));
  }

  // 2) مجموعة المفاتيح بالترتيب الصارم — فارغة → رد no_keys (بلا إنشاء مهمة)
  const pool = await getKeyPool(def.providers);
  if (pool.length === 0) {
    return { kind: "failed", text: F.fmtNoKeys(def.canonical), isError: true };
  }

  // 3) تسجيل المهمة في Turso قبل أي نداء خارجي (تبقى قابلة للتتبع حتى لو انقطع الاتصال)
  const taskId = randomUUID();
  const paramsWithModel = { ...args.params, model: def.canonical };
  await insertTask({
    id: taskId,
    model: def.canonical,
    type: def.type,
    prompt: typeof args.params.prompt === "string" ? args.params.prompt : "",
    params_json: JSON.stringify(paramsWithModel),
    status: "processing",
  });
  const task = (await getTask(taskId))!;

  // 4+5) الإنشاء بالتبديل + نافذة الانتظار
  return driveTask(task, def, args.waitSeconds, 0, args.onProgress);
}

/**
 * get_task — يحدّث المهمة الجارية حيًا من المزود (أو خدمة الدمج) ثم يعيد صياغة عربية.
 * يشمل نفس منطق إعادة المحاولة/التبديل: مهمة بلا مزود تُعاد محاولتها بعد تهدئة 45 ثانية.
 */
export async function refreshTask(taskId: string): Promise<Outcome> {
  const row = await getTask(taskId);
  if (!row) {
    return { kind: "failed", text: F.fmtTaskNotFound(taskId), isError: true };
  }

  if (row.status === "completed") {
    const urls = safeParseUrls(row.result_urls_json);
    return { kind: "completed", text: completedText(row.type as "image" | "video" | "merge", urls) };
  }
  if (row.status === "failed") {
    return { kind: "failed", text: F.fmtFailed(row.error_message ?? "سبب غير معروف"), isError: true };
  }

  // دمج → منطق خاص في merger.ts
  if (row.type === "merge") {
    const { refreshMergeTask } = await import("./merger");
    return refreshMergeTask(row);
  }

  const def = resolveModel(row.model);
  if (!def) {
    const msg = F.fmtParamsError(`موديل مخزّن غير معروف: ${row.model}`);
    await updateTask(row.id, { status: "failed", error_message: msg });
    return { kind: "failed", text: F.fmtFailed("موديل مخزّن غير معروف"), isError: true };
  }

  const pool = (await getKeyPool(def.providers)).map(toPoolKey);

  // حالة أ: المهمة جارية لدى مزود — نستعلم حالتها بالمفتاح المخزّن
  if (row.provider_task_id && row.provider && row.provider !== "merger") {
    const keyRow = row.key_id ? await getApiKey(row.key_id) : null;
    if (!keyRow || keyRow.status === "disabled") {
      // المفتاح حُذف أو عُطّل يدويًا → أعد إنشاء نفس المهمة من بداية القائمة
      return driveTask(row, def, 0, 0);
    }
    const key = toPoolKey(keyRow);
    const adapter = adapterFor(row.provider);
    try {
      const check = await adapter.checkTask(key, row.provider_task_id);
      if (check.status === "completed" && check.urls && check.urls.length > 0) {
        await updateTask(row.id, { status: "completed", progress: 100, result_urls: check.urls });
        return { kind: "completed", text: completedText(row.type as "image" | "video", check.urls) };
      }
      if (check.status === "failed") {
        const msg = check.error ?? "فشل غير معروف لدى المزود";
        if (KEY_ISSUE_PATTERN.test(msg)) {
          // استئناف نفس المهمة على المفتاح التالي — صامت تمامًا
          const idx = pool.findIndex((k) => k.id === key.id) + 1;
          return driveTask(row, def, 0, idx);
        }
        await updateTask(row.id, { status: "failed", error_message: msg });
        return { kind: "failed", text: F.fmtFailed(msg), isError: true };
      }
      const progress = resolveProgress(check, Date.parse(row.created_at.replace(" ", "T") + "Z"), 60);
      await updateTask(row.id, { status: "processing", progress });
      return { kind: "processing", text: F.fmtProcessing(row.id) };
    } catch (e) {
      const cls = classify(e);
      if (cls === "disabled" || cls === "exhausted" || cls === "provider") {
        const idx = pool.findIndex((k) => k.id === key.id) + 1;
        return driveTask(row, def, 0, idx);
      }
      // temporary → ننتظر الاستعلام القادم (بعد ~10 ثوانٍ)
      return { kind: "processing", text: F.fmtProcessing(row.id) };
    }
  }

  // حالة ب: لم ينجح الإنشاء بعد (بانتظار مفتاح) — تهدئة ~45 ثانية ثم إعادة المحاولة
  const updatedMs = Date.parse(row.updated_at.replace(" ", "T") + "Z");
  if (Number.isFinite(updatedMs) && Date.now() - updatedMs < RETRY_COOLDOWN_MS) {
    return { kind: "processing", text: F.fmtWaitingKeys() };
  }
  return driveTask(row, def, 0, 0);
}

function safeParseUrls(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((u): u is string => typeof u === "string") : [];
  } catch {
    return [];
  }
}
