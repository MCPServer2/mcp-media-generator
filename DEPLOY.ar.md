# دليل النشر على Vercel — MCP Media Generator

المشروع يُنشر كمشروعين مستقلين على Vercel من **نفس المستودع**:

| المشروع | Root Directory | الوظيفة |
| --- | --- | --- |
| `mcp-media-generator` | `/` (جذر المستودع) | خادم MCP على `/mcp` + لوحة الإدارة العربية |
| `mcp-media-merger` | `merger` | خدمة دمج الفيديو v2 (ffmpeg + Blob) |

---

## الخطوة 0 — ارفع الكود إلى GitHub

```bash
git add -A
git commit -m "أضف خدمة الدمج v2"
git push origin main
```

المستودع: `https://github.com/baloamsm/mcp-media-generator`

---

## الخطوة 1 — انشر خدمة الدمج أولًا

> ابدأ بها لأن التطبيق الرئيسي يحتاج رابطها في `MERGER_API_BASE`.

1. افتح [vercel.com/new](https://vercel.com/new) → **Import** مستودع `baloamsm/mcp-media-generator`.
2. في **Root Directory** اختر `merger` (وإلا سينشر التطبيق الرئيسي بالمistake).
3. اسم المشروع: `mcp-media-merger` (سيصبح الرابط `https://mcp-media-merger.vercel.app`).
4. أضف **متغيرات البيئة** (Settings → Environment Variables):

   | المتغير | القيمة | إلزامي؟ |
   | --- | --- | --- |
   | `TURSO_DATABASE_URL` | نفس قيمة التطبيق الرئيسي (`libsql://mcp-media-generator-baloamsm.aws-eu-west-1.turso.io`) | ✅ |
   | `TURSO_AUTH_TOKEN` | نفس توكن Turso | ✅ |
   | `CRON_SECRET` | أي سلسلة عشوائية طويلة (لحماية `/api/cron/cleanup`) | اختياري |
   | `SELF_BASE_URL` | `https://mcp-media-merger.vercel.app` | اختياري |

5. **فعّل Vercel Blob** لتخزين الناتج برابط عام يدوم بعد انتهاء الدالة:
   - من صفحة المشروع → تبويب **Storage** → **Create Database** → **Blob** → اربطه بمشروع `mcp-media-merger`.
   - سيرفع Vercel تلقائيًا `BLOB_READ_WRITE_TOKEN` — لا تكتبه يدويًا.
   - بدونه تعمل الخدمة لكن الناتج يُقدَّم من ذاكرة الدالة فقط ويضيع بعد أول تبريد (cold start).
6. **Deploy**.
7. تحقق: افتح `https://mcp-media-merger.vercel.app/api/config` — يجب أن ترى
   `"ok": true, "ffmpeg": true, "blob": true, "turso": true`.

> ملاحظة المدة: مسار `/api/jobs/{id}/process` يطلب `maxDuration = 300` ثانية — متاح على خطة
> Hobby مع **Fluid Compute** (مفعّل تلقائيًا للمشاريع الجديدة). الدمج الفعلي لمقاطع قصيرة
> يستغرق 10–30 ثانية. لو رفض Vercel القيمة، خفّضها في
> `merger/src/app/api/jobs/[id]/process/route.ts`.

---

## الخطوة 2 — انشر التطبيق الرئيسي

1. [vercel.com/new](https://vercel.com/new) → **Import** نفس المستودع مرة أخرى.
2. اترك **Root Directory** فارغًا (جذر المستودع).
3. اسم المشروع: `mcp-media-generator`.
4. أضف **متغيرات البيئة**:

   | المتغير | القيمة | إلزامي؟ |
   | --- | --- | --- |
   | `TURSO_DATABASE_URL` | `libsql://mcp-media-generator-baloamsm.aws-eu-west-1.turso.io` | ✅ |
   | `TURSO_AUTH_TOKEN` | توكن Turso | ✅ |
   | `MERGER_API_BASE` | `https://mcp-media-merger.vercel.app` (من الخطوة 1) | ✅ |
   | `MCP_ACCESS_TOKEN` | توكن سرّي يحرس `/mcp` — يصبح الربط يتطلب `Authorization: Bearer` | موصى به |

5. **Deploy**.
6. تحقق: افتح `https://mcp-media-generator.vercel.app/api/health` — يجب
   `"database": "turso-connected"` و `"merger": { "healthy": true }`.

> لا تضف `MERGER_ALLOW_PRIVATE_URLS` على Vercel إطلاقًا — حجب المصادر الداخلية مطلوب أمانيًا.

---

## الخطوة 3 — اربط عملاء MCP

من لوحة الإدارة (`/`) → بطاقة **ربط الخادم** — زر النسخ لكل عميل:

- **ChatGPT (Connectors)**: Settings → Apps & Connectors → Create → ضع رابط
  `https://mcp-media-generator.vercel.app/mcp` (مع ترويسة `Authorization: Bearer <MCP_ACCESS_TOKEN>` إن فعّلت التوكن).
- **Claude Desktop**: استبدل في `claude_desktop_config.json` (اللوحة تولّده جاهزًا عبر mcp-remote).
- **Cursor / Windsurf / Cline**: الصق JSON الذي تولّده اللوحة في `mcp.json`.

ثم أضف مفاتيح الحسابات الحقيقية من بطاقة **إدارة المفاتيح** (kie.ai أولًا ثم CometAPI —
الترتيب هو ترتيب التجربة).

---

## الخطوة 4 — اختبار القبول السريع بعد النشر

```bash
MERGER=https://mcp-media-merger.vercel.app
APP=https://mcp-media-generator.vercel.app

curl -s $MERGER/api/config | grep '"ok":true'          # خدمة الدمج جاهزة
curl -s $APP/api/health | grep 'turso-connected'       # قاعدة البيانات + الدمج
curl -s $APP/api/health | grep '"healthy":true'
```

ثم اختبر من أي عميل MCP:

1. `generate_image` بوصف قصير → صورة خلال نافذة الانتظار أو `task_id` يتابع بـ `get_task`.
2. `merge_videos` بالرابطين العامين:
   - `https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4`
   - `https://download.samplelib.com/mp4/sample-5s.mp4`
   → فيديو MP4 مدموج (H.264+AAC) خلال ~15–40 ثانية.
3. `merge_videos` بمقطع واحد → رفض بالعربية؛ بـ 11 مقطعًا → رفض بالعربية.
4. `list_media` → يعرض أحدث الوسائط المخزنة.

---

## ما الذي يعمل تلقائيًا بعد النشر؟

- **الجداول تُنشأ ذاتيًا** في Turso (`tasks`, `api_keys`, `merger_jobs`) — لا migrations.
- **التنظيف اليومي**: Vercel Cron (`vercel.json` في `merger/`) يستدعي `/api/cron/cleanup`
  الساعة 03:00 UTC فيحذف نواتج الدمج الأقدم من 24 ساعة (من Blob والسجل).
- **توسّط serverless**: كل المسارات `runtime = "nodejs"` + `force-dynamic`، والاتصال بـ Turso عبر HTTP.
- **مكتبة ffmpeg** تُضمَّن آليًا في حزمة دالة المعالجة عبر `outputFileTracingIncludes` (تم التحقق منها).

## حدود الخطة المجانية (Hobby) ذات الصلة

| الحد | القيمة | أثره |
| --- | --- | --- |
| مدة الدالة | 300 ثانية (Fluid) | كافية للدمج حتى 10 مقاطع قصيرة |
| حجم دالة مضغوطة | 250MB | ثنائي ffmpeg ~80MB مستساغ ضمنها |
| تخزين Blob المجاني | ~1GB | نواتج الدمج تُحذف بعد 24 ساعة تلقائيًا |
| Cron | يوميًا فقط | التنظيف يومي — قد تبقى الملفات حتى ~24-48 ساعة |
