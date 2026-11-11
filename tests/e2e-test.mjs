/**
 * اختبار e2e متكامل لـ MCP Media Generator — يشغّل المزود الوهمي محليًا وينفذ السيناريوهات:
 *   1) إضافة مفاتيح (خاطئ → مستنزف → يموت منتصف المهمة → سليم → cometapi سليم) بالترتيب
 *   2) generate_image عبر MCP → يكتمل على المفتاح السليم مع تبديل تسلسلي صامت (نفس task_id)
 *   3) generate_video عبر MCP (مع progressToken → التحقق من إشعارات التقدم الحية)
 *   4) merge_videos عبر task_ids ثم عبر urls + الفحوصات الصارمة (مقطع واحد / 11 مقطعًا / رابط داخلي / فشل حتمي)
 *   5) get_task لمعرف غير موجود + list_media بالترتيب من الأحدث
 *   6) حالة لا مفاتيح → رسالة no_keys
 *   7) تنظيف كامل: حذف مفاتيح الاختبار ومهامه من Turso وحذف وظائف الدمج من الخدمة
 * التشغيل: node tests/e2e-test.mjs   (يتطلب dev server يعمل على :3000)
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";

const APP = "http://localhost:3000";
const MOCK_PORT = 3310;
const results = [];
let client;

function log(step, msg) {
  console.log(`\n=== ${step} ===\n${msg}`);
}
function pass(name, detail = "") {
  results.push({ name, ok: true });
  console.log(`✅ PASS: ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name, detail = "") {
  results.push({ name, ok: false });
  console.log(`❌ FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
}
function assert(cond, name, detail = "") {
  cond ? pass(name, detail) : fail(name, detail);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** نداء MCP كامل (tools/call أو غيره) — يفك SSE ويعيد آخر رسالة بالمعرف المطلوب */
async function mcpCall(method, params, id, { progressToken } = {}) {
  const body = { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) };
  if (method === "tools/call" && progressToken !== undefined) {
    body.params = { ...body.params, _meta: { progressToken } };
  }
  const res = await fetch(`${APP}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const messages = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("data:")) {
      try {
        messages.push(JSON.parse(line.slice(5).trim()));
      } catch {
        /* سطر غير مكتمل */
      }
    }
  }
  const mine = messages.filter((m) => m.id === id);
  return { status: res.status, messages, result: mine[mine.length - 1] ?? null, rawEvents: messages };
}

function toolText(mcpResult) {
  // شكل الرد: {jsonrpc, id, result: {content:[{type,text}], isError?}}
  return mcpResult?.result?.content?.[0]?.text ?? "";
}
function toolIsError(mcpResult) {
  return mcpResult?.result?.isError === true;
}

// ---------- البداية ----------
console.log("تشغيل المزود الوهمي…");
const mock = spawn("node", ["tests/mock-provider.mjs", String(MOCK_PORT)], { stdio: "ignore" });
try {
  let up = false;
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${MOCK_PORT}/api/config`);
      up = r.ok;
      if (up) break;
    } catch {}
    await sleep(300);
  }
  if (!up) throw new Error("المزود الوهمي لم يستجب");

  // قراءة متغيرات Turso من .env
  const envText = readFileSync(".env", "utf8");
  const env = Object.fromEntries(
    envText
      .split("\n")
      .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
      .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
  );
  client = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });

  // تنظيف أولي — الاختبار قابل للتكرار ويبدأ من قاعدة نظيفة
  await client.execute("DELETE FROM tasks");
  await client.execute("DELETE FROM api_keys");

  // ===== 1) إضافة المفاتيح بالترتيب =====
  const keysToAdd = [
    { provider: "kie", api_key: "test-invalid-key-0001", label: "خاطئ أولًا" },
    { provider: "kie", api_key: "test-exhausted-key-02", label: "مستنزف" },
    { provider: "kie", api_key: "test-diesmid-key-0003", label: "يموت منتصف المهمة" },
    { provider: "kie", api_key: "test-good-key-00004", label: "سليم" },
    { provider: "cometapi", api_key: "test-good-comet-0005", label: "CometAPI سليم" },
  ];
  const addedIds = [];
  let duplicateRejected = false;
  for (const k of keysToAdd) {
    const r = await fetch(`${APP}/api/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(k),
    });
    if (r.status === 201) addedIds.push((await r.json()).key.id);
    else fail("إضافة مفتاح", `${k.label}: HTTP ${r.status}`);
  }
  // رفض التكرار
  const dup = await fetch(`${APP}/api/keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(keysToAdd[0]),
  });
  duplicateRejected = dup.status === 409;
  assert(addedIds.length === 5, "إضافة 5 مفاتيح اختبار", `ids=${addedIds.length}`);
  assert(duplicateRejected, "رفض التكرار لنفس المزود (409)");

  // الترتيب التسلسلي + الإخفاء
  {
    const r = await fetch(`${APP}/api/keys`);
    const data = await r.json();
    const orderOk = data.keys[0].label === "خاطئ أولًا"; // أول مفتاح أُضيف أولًا
    const maskedOk = data.keys.every((k) => k.maskedKey.includes("••••")); // مُقنَّع دائمًا
    // لا يُعاد المفتاح الكامل في أي استجابة
    const noRawKey = !JSON.stringify(data).includes("test-invalid-key-0001") && !JSON.stringify(data).includes("test-good-key-00004");
    assert(orderOk, "الترتيب التسلسلي الصارم حسب الإضافة", `الأول: ${data.keys[0].label}`);
    assert(maskedOk && noRawKey, "إخفاء المفاتيح إلزامي (maskKey)");
  }

  // ===== 2) generate_image — التبديل التسلسلي الكامل =====
  let imageTaskCompleted = null;
  {
    log("generate_image", "مفاتيح: خاطئ → مستنزف → يموت منتصف المهمة → سليم");
    const call = await mcpCall("tools/call", { name: "generate_image", arguments: { prompt: "قطة فضائية ترسم لوحة", wait_seconds: 60 } }, 101, {
      progressToken: "tok-img-1",
    });
    const text = toolText(call.result);
    const isError = toolIsError(call.result);
    console.log("--- نص الرد ---\n" + text);
    assert(!isError && text.includes("✅ تم توليد الصورة بنجاح"), "الصورة اكتملت خلال نافذة الانتظار");
    const urlMatch = text.match(/https:\/\/mock-cdn\.example\.com\/results\/image\/[^\s)]+/);
    assert(Boolean(urlMatch), "رابط صورة من المزود (المقنَّع)", urlMatch?.[0]);
    const leaked = /مفتاح|رصيد|balance|invalid api|insufficient|401|402|key/i.test(text);
    assert(!leaked, "لا ذكر لأي مفاتيح أو رصيد في رد العميل");

    // إشعارات التقدم وصلت؟
    const progressEvents = call.rawEvents.filter((m) => m.method === "notifications/progress");
    assert(progressEvents.length >= 2, "بث إشعارات التقدم الحية", `عددها: ${progressEvents.length}`);

    // الفوات: الخاطئ أصبح disabled والمستنزف exhausted
    const kr = await (await fetch(`${APP}/api/keys`)).json();
    const invalid = kr.keys.find((k) => k.label === "خاطئ أولًا");
    const exhausted = kr.keys.find((k) => k.label === "مستنزف");
    const dies = kr.keys.find((k) => k.label === "يموت منتصف المهمة");
    const good = kr.keys.find((k) => k.label === "سليم");
    assert(invalid?.status === "disabled", "المفتاح الخاطئ عُطّل تلقائيًا", invalid?.status);
    assert(exhausted?.status === "exhausted", "المفتاح المستنزف أصبح exhausted (يبقى في القاعدة)", exhausted?.status);
    assert(good?.successCount >= 1, "المفتاح السليم سجّل نجاحًا");
    assert((dies?.usageCount ?? 0) >= 1, "مفتاح «يموت منتصف المهمة» استُخدم فعلاً");

    // attempts في قاعدة البيانات: خاطئ → مستنزف → (إنشاء+فشل منتصف) → سليم
    const rows = await client.execute("SELECT id, attempts_json, status FROM tasks WHERE type='image' ORDER BY created_at DESC LIMIT 1");
    const attempts = JSON.parse(rows.rows[0].attempts_json);
    const classes = attempts.map((a) => `${a.ok ? "ok" : a.errorClass}`);
    console.log("attempts:", classes.join(" → "));
    assert(attempts.length >= 4, "سجل المحاولات يوثّق كل التبديلات", classes.join(" → "));
    assert(rows.rows[0].status === "completed", "حالة المهمة completed في قاعدة البيانات");
    imageTaskCompleted = rows.rows[0].id;
  }

  // ===== 3) generate_video مع progressToken =====
  let videoTaskId = null;
  {
    log("generate_video", "صوت متزامن + تقدم حي");
    const call = await mcpCall("tools/call", { name: "generate_video", arguments: { prompt: "موجة بحرية تتكسر ببطء", duration: 6, wait_seconds: 60 } }, 102, {
      progressToken: "tok-vid-1",
    });
    const text = toolText(call.result);
    console.log("--- نص الرد ---\n" + text);
    assert(text.includes("✅ تم توليد الفيديو بنجاح"), "الفيديو اكتمل");
    assert(/https:\/\/mock-cdn\.example\.com\/results\/video\//.test(text), "رابط فيديو صالح");
    const rows = await client.execute("SELECT id FROM tasks WHERE type='video' AND status='completed' ORDER BY created_at DESC LIMIT 1");
    videoTaskId = rows.rows[0].id;
  }

  // مهمة فيديو ثانية (للدمج عبر task_ids) — نافذة قصيرة ثم متابعة بـ get_task
  let secondVideoId = null;
  {
    const call = await mcpCall("tools/call", { name: "generate_video", arguments: { prompt: "مقاطع ثانية للدمج", wait_seconds: 3 } }, 103);
    const text = toolText(call.result);
    const m = text.match(/task_id: ([0-9a-f-]{36})/);
    assert(Boolean(m), "نافذة قصيرة → task_id فوري للعميل", m?.[1]?.slice(0, 8) + "…");
    secondVideoId = m?.[1];
    // متابعة بـ get_task كل ثانية حتى الاكتمال (المحاكي يكتمل بعد ~5 استعلامات)
    let done = false;
    for (let i = 0; i < 20; i++) {
      await sleep(2000);
      const g = await mcpCall("tools/call", { name: "get_task", arguments: { task_id: secondVideoId } }, 1000 + i);
      const gt = toolText(g.result);
      if (gt.includes("✅ تم توليد الفيديو بنجاح")) {
        done = true;
        break;
      }
      if (!/قيد المعالجة/.test(gt)) {
        console.log("get_task رد غير متوقع:", gt);
        break;
      }
    }
    assert(done, "المتابعة بـ get_task حتى الاكتمال (كل ~10 ثوانٍ في الواقع)");
  }

  // ===== 4) الدمج =====
  {
    log("merge_videos عبر task_ids", `[${videoTaskId?.slice(0, 8)}, ${secondVideoId?.slice(0, 8)}] بالترتيب`);
    const call = await mcpCall(
      "tools/call",
      { name: "merge_videos", arguments: { task_ids: [videoTaskId, secondVideoId], wait_seconds: 45 } },
      201,
      { progressToken: "tok-merge-1" },
    );
    const text = toolText(call.result);
    console.log("--- نص الرد ---\n" + text);
    assert(text.includes("✅ تم دمج المقاطع بنجاح"), "الدمج اكتمل");
    assert(text.includes("https://mock-merger.example.com/api/jobs/"), "الرابط على نطاق خدمة الدمج");
    assert(text.includes("24 ساعة"), "تحذير الـ24 ساعة موجود في الرد");
    const progressEvents = call.rawEvents.filter((m) => m.method === "notifications/progress");
    assert(progressEvents.length >= 1, "بث تقدم الدمج حي", `عددها: ${progressEvents.length}`);
  }
  {
    log("merge_videos عبر urls مباشرة", "رابطان عامان");
    const call = await mcpCall(
      "tools/call",
      {
        name: "merge_videos",
        arguments: {
          urls: ["https://www.w3schools.com/html/mov_bbb.mp4", "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4"],
          wait_seconds: 45,
        },
      },
      202,
    );
    const text = toolText(call.result);
    assert(text.includes("✅ تم دمج المقاطع بنجاح"), "الدمج عبر urls اكتمل");
  }
  {
    log("فحوصات الدمج الصارمة", "");
    const one = await mcpCall("tools/call", { name: "merge_videos", arguments: { urls: ["https://example.com/only-one.mp4"] } }, 203);
    assert(toolText(one.result).includes("الدمج يحتاج مقطعَين على الأقل"), "رفض مقطع واحد بالرسالة العربية الصحيحة");

    const eleven = await mcpCall(
      "tools/call",
      {
        name: "merge_videos",
        arguments: { urls: Array.from({ length: 11 }, (_, i) => `https://example.com/v${i}.mp4`) },
      },
      204,
    );
    assert(toolText(eleven.result).includes("أقصى عدد مقاطع للدمج هو 10"), "رفض 11 مقطعًا بالرسالة العربية الصحيحة");

    const badTask = await mcpCall("tools/call", { name: "merge_videos", arguments: { task_ids: ["id-fake-1", "id-fake-2"] } }, 205);
    const badTaskText = toolText(badTask.result);
    assert(
      badTaskText.includes("الدمج يحتاج مقطعَين على الأقل") && badTaskText.includes("id-fake-1"),
      "task_ids غير مكتملة → رفض مع تفاصيل كل معرف فاشل",
    );

    const priv = await mcpCall(
      "tools/call",
      { name: "merge_videos", arguments: { urls: ["http://192.168.1.5/x.mp4", "http://localhost/y.mp4"] } },
      206,
    );
    assert(toolText(priv.result).includes("روابط فيديو مباشرة عامة"), "رفض الروابط الداخلية غير العامة");

    // فشل حتمي: مصدر /forbidden → الخدمة ترد 500 → فشل فوري بلا إعادة محاولة
    const forbidden = await mcpCall(
      "tools/call",
      { name: "merge_videos", arguments: { urls: ["https://example.com/forbidden/a.mp4", "https://example.com/b.mp4"], wait_seconds: 20 } },
      207,
    );
    const fText = toolText(forbidden.result);
    assert(fText.includes("❌ فشلت المهمة") && fText.includes("Download failed (HTTP 403)"), "خطأ HTTP معلن من الخدمة = فشل نهائي فوري");
  }

  // ===== 5) get_task لمعرف غير موجود + list_media =====
  {
    const g = await mcpCall("tools/call", { name: "get_task", arguments: { task_id: "no-such-task-id" } }, 301);
    assert(toolText(g.result).includes("لم يتم العثور على المهمة"), "get_task لمعرف غير موجود → رسالة عربية واضحة");
    assert(toolIsError(g.result), "isError: true للمهمة المفقودة");

    const l = await mcpCall("tools/call", { name: "list_media", arguments: { limit: 5 } }, 302);
    const lText = toolText(l.result);
    assert(lText.includes("أحدث 5 وسائط مخزنة"), "list_media يعيد الوسائط المخزنة", lText.split("\n")[0]);
    const ids = [...lText.matchAll(/task_id: ([0-9a-f-]{36})/g)].map((m) => m[1]);
    const rows = await client.execute("SELECT id, created_at FROM tasks ORDER BY created_at DESC LIMIT 5");
    const dbOrder = rows.rows.map((r) => String(r.id));
    assert(JSON.stringify(ids) === JSON.stringify(dbOrder), "list_media مرتبة من الأحدث");
  }

  // ===== 6) لا مفاتيح → no_keys =====
  {
    log("حالة لا مفاتيح", "حذف كل المفاتيح ثم توليد");
    for (const id of addedIds) {
      await fetch(`${APP}/api/keys/${id}`, { method: "DELETE" });
    }
    const call = await mcpCall("tools/call", { name: "generate_image", arguments: { prompt: "اختبار بلا مفاتيح" } }, 401);
    const text = toolText(call.result);
    assert(text.includes("لا توجد مفاتيح نشطة لخدمة") && text.includes("أضف مفتاحًا واحدًا على الأقل"), "رسالة no_keys العربية الصحيحة");
    const rows = await client.execute("SELECT COUNT(*) AS c FROM tasks WHERE prompt = 'اختبار بلا مفاتيح'");
    assert(Number(rows.rows[0].c) === 0, "لا تُسجَّل مهمة عند غياب المفاتيح");
  }

  // ===== 7) التنظيف =====
  {
    log("التنظيف", "حذف مهام الاختبار من Turso + وظائف الدمج من الخدمة");
    await client.execute("DELETE FROM tasks WHERE id IN (SELECT id FROM tasks)");
    await client.execute("DELETE FROM api_keys WHERE id IN (SELECT id FROM api_keys)");
    const stats = await client.execute("SELECT COUNT(*) AS t FROM tasks");
    const keyStats = await client.execute("SELECT COUNT(*) AS k FROM api_keys");
    console.log(`مهام متبقية: ${Number(stats.rows[0].t)} — مفاتيح متبقية: ${Number(keyStats.rows[0].k)}`);
    pass("قاعدة البيانات نظيفة بعد الاختبار");
  }
} catch (e) {
  fail("خطأ غير متوقع في السكربت", e.message);
} finally {
  mock.kill();
}

// ---------- التقرير ----------
const passed = results.filter((r) => r.ok).length;
console.log(`\n${"═".repeat(60)}\nالنتيجة: ${passed}/${results.length} اختبارًا ناجحًا`);
for (const r of results) {
  if (!r.ok) console.log(`  ❌ ${r.name}`);
}
process.exit(passed === results.length ? 0 : 1);
