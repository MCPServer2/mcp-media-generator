/**
 * صياغات الردود العربية لأدوات MCP — كل رسائل الأدوات بالعربية
 * والمصطلحات التقنية (task_id, get_task, أسماء الأدوات) تبقى بالإنجليزية.
 * قاعدة ذهبية: لا رسالة فشل تذكر مفاتيح أو رصيد تخرج للعميل أبدًا.
 */

export function fmtImageCompleted(url: string): string {
  return `✅ تم توليد الصورة بنجاح

![image](${url})

الرابط المباشر: ${url}`;
}

export function fmtVideoCompleted(urls: string[]): string {
  const list = urls.map((u, i) => `${urls.length > 1 ? `${i + 1}. ` : ""}${u}`).join("\n");
  return `✅ تم توليد الفيديو بنجاح

الروابط المباشرة:
${list}`;
}

export function fmtMergeCompleted(urls: string[]): string {
  const list = urls.map((u, i) => `${i + 1}. ${u}`).join("\n");
  return `✅ تم دمج المقاطع بنجاح

الرابط المباشر:
${list}

⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`;
}

export function fmtProcessing(taskId: string): string {
  return `⏳ المهمة قيد المعالجة — task_id: ${taskId}

تابع بـ get_task كل ~10 ثوانٍ حتى تكتمل ثم اعرض الروابط وتوقف عن الاستعلام.`;
}

export function fmtWaitingKeys(): string {
  return `⏳ المهمة قيد المعالجة — بانتظار اكتمال التجهيز على السيرفر.

تابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`;
}

export function fmtFailed(reason: string): string {
  return `❌ فشلت المهمة: ${reason}`;
}

export function fmtNoKeys(model: string): string {
  return `❌ لا توجد مفاتيح نشطة لخدمة ${model}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`;
}

export function fmtUnknownModel(model: string): string {
  return `❌ موديل غير معروف: ${model}. المتاح: ${model ? "" : ""}استخدم أحد الأسماء المدعومة مثل gpt-image-2-6/flare-text-to-image أو grok-imagine-video-1-5-preview.`;
}

export function fmtParamsError(reason: string): string {
  return `❌ معطيات الطلب غير صالحة: ${reason}`;
}

export function fmtMergeNeedTwo(details: string): string {
  return `❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.

${details}`;
}

export function fmtTooManyClips(): string {
  return "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).";
}

export function fmtInvalidUrls(bad: string[]): string {
  return `❌ يجب أن تكون كل الروابط روابط فيديو مباشرة عامة (http/https). روابط غير صالحة:
${bad.map((b) => `- ${b}`).join("\n")}`;
}

export function fmtMergerUnavailable(): string {
  return "❌ خدمة الدمج غير مهيأة على السيرفر (MERGER_API_BASE مفقود) — أضبط المتغير ثم أعد المحاولة.";
}

export function fmtMergeJobNotFound(): string {
  return "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)";
}

export function fmtTaskNotFound(taskId: string): string {
  return `لم يتم العثور على المهمة ${taskId} في قاعدة البيانات.`;
}

/** تنسيق list_media — أحدث الوسائط المخزنة بروابطها (بدون إعادة توليد) */
export function fmtListMedia(
  items: Array<{ id: string; type: string; model: string; status: string; prompt: string; createdAt: string; urls: string[]; progress: number }>,
): string {
  if (items.length === 0) {
    return "لا توجد وسائط مخزنة بعد — استخدم generate_image أو generate_video أولًا.";
  }
  const lines: string[] = [`أحدث ${items.length} وسائط مخزنة (من الأحدث):`, ""];
  for (const it of items) {
    const typeLabel = it.type === "image" ? "صورة" : it.type === "video" ? "فيديو" : "دمج";
    const statusLabel =
      it.status === "completed" ? "مكتملة" : it.status === "failed" ? "فاشلة" : it.status === "pending" ? "معلقة" : "جارية";
    const head = `• [${typeLabel} | ${statusLabel}] task_id: ${it.id} — الموديل: ${it.model} — أُنشئت: ${it.createdAt}`;
    lines.push(head);
    if (it.prompt) lines.push(`  الوصف: ${it.prompt.slice(0, 120)}${it.prompt.length > 120 ? "…" : ""}`);
    if (it.urls.length > 0) {
      for (const u of it.urls) lines.push(`  الرابط: ${u}`);
    } else if (statusLabel === "جارية") {
      lines.push(`  الحالة: قيد المعالجة (${it.progress}%) — تابع بـ get_task`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}
