/**
 * سجل الموديلات والمزودون.
 * - canonical: الاسم الذي يراه عميل MCP.
 * - aliases: صيغ بديلة نقبلها ونوحّدها (شرطات/نقاط) قبل التحقق.
 * - providers: المزودون القادرون على خدمة الموديل — تُجرَّب مفاتيحهم كلها بالترتيب التسلسلي.
 * - providerModel: اسم الموديل كما يُرسَل فعليًا لكل مزود (قابل للتجاوز بمتغيرات البيئة).
 */
export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string;
  aliases: string[];
  type: MediaType;
  providers: ProviderId[];
  providerModel: Record<ProviderId, string>;
}

/** توحيد الاسم: شرطات بدل النقاط + حروف صغيرة — كي نقبل gpt-image-2.6/... و gpt-image-2-6/... */
function unify(name: string): string {
  return name.trim().toLowerCase().replace(/\./g, "-");
}

function buildProviderModel(type: MediaType, kieDefault: string, cometDefault: string): Record<ProviderId, string> {
  // تجاوز أسماء الموديلات عبر متغيرات البيئة إن لزم (KIE_IMAGE_MODEL / KIE_VIDEO_MODEL / ...)
  const envKie = type === "image" ? process.env.KIE_IMAGE_MODEL : process.env.KIE_VIDEO_MODEL;
  const envComet = type === "image" ? process.env.COMETAPI_IMAGE_MODEL : process.env.COMETAPI_VIDEO_MODEL;
  return {
    kie: envKie?.trim() || kieDefault,
    cometapi: envComet?.trim() || cometDefault,
  };
}

const IMAGE_CANONICAL = "gpt-image-2-6/flare-text-to-image";
const VIDEO_CANONICAL = "grok-imagine-video-1-5-preview";

export const MODELS: ModelDef[] = [
  {
    // canonical ثابت دائمًا — التجاوز بمتغيرات البيئة يخص أسماء الموديل لدى المزودين فقط
    canonical: IMAGE_CANONICAL,
    aliases: [
      "gpt-image-2.6/flare-text-to-image",
      "gpt-image-2.6-flare-text-to-image", // صيغة CometAPI بشرطات بدل الشرطة المائلة
      "gpt-image-2-6-flare-text-to-image",
      "flare-text-to-image",
    ],
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: buildProviderModel("image", IMAGE_CANONICAL, "gpt-image-2.6-flare-text-to-image"),
  },
  {
    canonical: VIDEO_CANONICAL,
    aliases: ["grok-imagine-video-1.5-preview"],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: buildProviderModel("video", VIDEO_CANONICAL, VIDEO_CANONICAL),
  },
];

/** البحث عن موديل بالاسم الموحَّد — يعيد null إن كان غير معروف (خطأ معطيات) */
export function resolveModel(raw: string | undefined | null): ModelDef | null {
  if (!raw) return null;
  const u = unify(raw);
  for (const m of MODELS) {
    if (unify(m.canonical) === u) return m;
    if (m.aliases.some((a) => unify(a) === u)) return m;
    // مطابقة بأسماء المزودين نفسها (كي يعمل العميل حتى لو مرّر اسم المزود)
    if (Object.values(m.providerModel).some((pm) => unify(pm) === u)) return m;
  }
  return null;
}

/** الموديل الافتراضي لكل نوع أداة */
export function defaultModelFor(type: MediaType): ModelDef {
  const m = MODELS.find((x) => x.type === type);
  if (!m) throw new Error(`لا يوجد موديل افتراضي للنوع ${type}`);
  return m;
}

/** قائمة الأسماء المعروفة — تُستخدم في رسائل الخطأ العربية */
export function knownModelNames(): string[] {
  return MODELS.map((m) => m.canonical);
}
