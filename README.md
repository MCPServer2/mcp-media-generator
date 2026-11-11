# MCP Media Generator

خادم MCP لتوليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع + لوحة إدارة عربية (RTL).

أداة واحدة تجمع ثلاث قدرات:

| القدرة | الموديل المدمج | المزودون |
| --- | --- | --- |
| توليد صور من وصف نصي | `gpt-image-2-6/flare-text-to-image` | kie.ai + CometAPI |
| توليد فيديو بصوت متزامن أصلي | `grok-imagine-video-1-5-preview` | kie.ai + CometAPI |
| دمج عدة مقاطع في مقطع واحد | خدمة Video Merger API v2 | بدون مفتاح |

## القواعد الجوهرية

- **روابط فقط** — لا يُنزَّل أي ملف وسائط على السيرفر إطلاقًا؛ تُخزَّن روابط النتائج في قاعدة البيانات فقط.
- **ترتيب تسلسلي صارم للمفاتيح** — أول مفتاح أُضيف يُجرَّب أولًا (`created_at ASC, id ASC`)، وليس round-robin.
- **لا توقف عند نفاد الرصيد** — تبديل فوري تلقائي للمفتاح التالي مع استئناف نفس المهمة بنفس `task_id`.
- **النموذج الذكي لا يرى أخطاء المفاتيح/الأرصدة أبدًا** — التبديل صامت من وجهة نظه.
- **مهمة فشلت على كل المفاتيح تبقى `processing`** وتُعاد محاولتها تلقائيًا مع كل `get_task` (بتهدئة ~45 ثانية).
- **إخفاء المفاتيح إلزامي** — `maskKey` في كل الاستجابات والسجلات، ولا يُعاد مفتاح كامل أبدًا.
- **أخطاء خدمة الدمج المعلنة (HTTP 4xx/5xx) فشل حتمي فوري**؛ أخطاء شبكتنا مؤقتة ويستمر الاستعلام.
- **ملفات الدمج تُحذف بعد ~24 ساعة** — مذكورة في وصف الأداة وتعليمات الخادم ليُنبَّه المستخدم.

## الأدوات الخمس على /mcp

| الأداة | الوصف |
| --- | --- |
| `generate_image` | توليد صورة (aspect_ratio/resolution/background/output_format) — رابط جاهز أو task_id |
| `generate_video` | توليد فيديو بصوت متزامن (image-to-video اختياري، مدة 1–15 ثانية) |
| `merge_videos` | دمج 2–10 مقاطع عبر `urls` أو `task_ids` بالترتيب (الناتج MP4 H.264+AAC) |
| `get_task` | تتبع أي مهمة — يحدّث من المزود حيًا ويعيد صياغة عربية |
| `list_media` | استرجاع أحدث الوسائط المخزنة بروابطها |

التوليد غير متزامن: الأداة تعيد `task_id` فورًا (مع نافذة انتظار قصيرة تبث **إشعارات تقدم حية** كل ~3 ثوانٍ)، والعميل يتابع بـ `get_task` كل ~10 ثوانٍ.

## التشغيل المحلي

```bash
bun install          # أو npm install / pnpm install

# أنشئ قاعدة Turso مجانية ثم املأ .env.local (انظر .env.example)
#   turso db create <name>
#   turso db show <name> --url
#   turso db tokens create <name>
cp .env.example .env.local   # ثم املأ القيم

bun run dev          # http://localhost:3000
```

- الواجهة: `http://localhost:3000` (لوحة عربية RTL)
- خادم MCP: `http://localhost:3000/mcp`
- فحص الجهوزية: `http://localhost:3000/api/health`

## متغيرات البيئة

```bash
# إلزامي
TURSO_DATABASE_URL=libsql://<db-name>-<org>.turso.io
TURSO_AUTH_TOKEN=<Turso token بصلاحيات كتابة>
MERGER_API_BASE=https://xxxxx.vercel.app      # عنوان خدمة الدمج v2

# اختياري
MCP_ACCESS_TOKEN=            # إن ضُبط يُطلب Authorization: Bearer <token> على /mcp
KIE_IMAGE_MODEL=             # تجاوز أسماء الموديلات لدى المزودين
KIE_VIDEO_MODEL=
COMETAPI_IMAGE_MODEL=
COMETAPI_VIDEO_MODEL=
```

> `.env*` مستثنى من Git منذ اليوم الأول — لا ترفع أي سر إلى المستودع.

## النشر على Vercel

1. اربط المستودع في Vercel.
2. أضف المتغيرات: `TURSO_DATABASE_URL` و`TURSO_AUTH_TOKEN` و`MERGER_API_BASE` (و`MCP_ACCESS_TOKEN` إن رغبت بحماية /mcp).
3. Deploy — كل شيء يعمل بلا أي ملف محلي: libSQL يتصل عبر HTTP (مناسب للـ serverless) و`/mcp` يدعم الـ streaming.

## ربط العملاء

**ChatGPT / GPT Agents** — Settings → Connectors → Create → Custom MCP server:

```json
{ "mcpServers": { "media-generator": { "url": "https://<domain>/mcp" } } }
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{ "mcpServers": { "media-generator": { "type": "http", "url": "https://<domain>/mcp" } } }
```

**Cursor / Windsurf / Cline** (`mcp.json`): نفس صيغة ChatGPT.

لوحة الإدارة تولّد هذه الصيغ جاهزة للنسخ من بطاقة «ربط السيرفر».

## الاختبارات

محاكاة e2e كاملة بلا مفاتيح حقيقية عبر مزود وهمي (يحاكي kie.ai Jobs API + CometAPI + خدمة الدمج):

```bash
node tests/e2e-test.mjs   # يتطلب dev server على :3000
node tests/mock-provider.mjs 3310   # تشغيل المحاكي وحده
```

يغطي: التبديل التسلسلي (خاطئ → مستنزف → فشل منتصف المهمة → سليم)، تعطيل المفتاح الخاطئ تلقائيًا، بقاء المستنزف في القاعدة، بث إشعارات التقدم، الدمج عبر task_ids وurls، رفض 1/11 مقطعًا والروابط الداخلية، الفشل الحتمي لخدمة الدمج، وlist_media بالترتيب — مع تنظيف كامل لقاعدة البيانات بعده.

## بنية المشروع

```
src/
  app/
    mcp/route.ts              # خادم MCP (Streamable HTTP، وضع عديم الجلسة)
    api/health/route.ts       # الجهوزية: Turso + الموديلات + خدمة الدمج
    api/keys/route.ts         # قائمة/إضافة المفاتيح (مقنّعة دائمًا)
    api/keys/[id]/route.ts    # تعطيل/تنشيط/حذف
    api/tasks/route.ts        # لوحة المهام (مهام + إحصائيات)
    page.tsx                  # اللوحة العربية RTL
  lib/
    turso.ts                  # عميل Turso + ensureSchema + عمليات المهام والمفاتيح
    keys.ts                   # getKeyPool (ترتيب صارم) + classifyProviderError + maskKey
    models.ts                 # سجل الموديلات (canonical/aliases/providerModel)
    providers/kie.ts          # kie.ai Jobs API (resultJson نص داخل JSON)
    providers/cometapi.ts     # CometAPI (صور متزامنة + فيديو غير متزامن)
    generation.ts             # runGeneration/refreshTask — قلب التبديل التسلسلي
    merger.ts                 # عميل خدمة الدمج v2 + runMerge/refreshMergeTask
    mcp-server.ts             # الأدوات الخمس + SERVER_INSTRUCTIONS
    format.ts                 # صياغات الردود العربية
tests/
  mock-provider.mjs           # مزود وهمي محلي (kie/cometapi/merger)
  e2e-test.mjs                # اختبار e2e متكامل (35 فحصًا)
```

## ملاحظات تقنية

- **MCP SDK رسمية فقط** (`McpServer` + `WebStandardStreamableHTTPServerTransport` — النقل الأساسي الرسمي المتوافق مع Web Request/Response في App Router) وبلا أي JSON-RPC يدوي.
- **وضع عديم الجلسة (stateless)**: كل POST مكتفٍ بذاته — الخيار الصحيح لـ Vercel حيث لا تصمد الجلسات في الذاكرة بين النسخ.
- كل الـ route handlers بـ `runtime = "nodejs"`، و`/mcp` و`/api/health` بـ `dynamic = "force-dynamic"`.
- kie.ai قد يُرجع HTTP 200 مع رمز الخطأ داخل الجسم — المصنّف يفحصهما معًا (ورسالة نفاد الرصيد تُفحص قبل حالة 400).
- مهلة ميلي ثانية في `created_at` للمفاتيح لضمان الترتيب التسلسلي الصارم.

## النشر على Vercel

يُنشر المشروع كمشروعين من نفس المستودع: التطبيق الرئيسي (جذر المستودع) وخدمة الدمج
(Root Directory = `merger` مع Vercel Blob للتخزين الدائم وCron يومي للتنظيف).

الدليل الكامل خطوة بخطوة: **[DEPLOY.ar.md](./DEPLOY.ar.md)**.

```text
merger/                      # خدمة دمج الفيديو v2 — مشروع Vercel مستقل
  src/lib/store.ts           # الذاكرة + Turso (merger_jobs) — تصمد الحالة بين النسخ
  src/lib/pipeline.ts        # تنزيل ≤200MB/مصدر → توحيد 1080p/30fps/CRF18 → concat -c copy → Blob
  src/app/api/jobs/…         # إنشاء/معالجة/حالة/حذف/تسليم الناتج
  src/app/api/cron/cleanup/  # حذف نواتج >24 ساعة (Vercel Cron يومي)
scripts/
  test-merger-suite.mjs      # 29 فحصًا للخدمة الحقيقية (مباشر + عبر MCP)
