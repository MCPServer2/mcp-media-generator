/**
 * مجموعة اختبارات خدمة الدمج الحقيقية (v2) — تُشغَّل والخدمة حية في نفس الجلسة.
 * المرحلة A — اختبار مباشر للخدمة: config/إنشاء/تحقق/معالجة/حالة/تسليم/حذف.
 * المرحلة B — اختبار عبر التطبيق الرئيسي (MCP): دمج حقيقي + الفحوصات الصارمة + list_media.
 * المرحلة C — تنظيف: حذف مهام الاختبار من Turso ووظائف الدمج من الخدمة.
 * التشغيل: node scripts/test-merger-suite.mjs
 */
import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";

const MERGER = "http://127.0.0.1:3002";
const APP = "http://localhost:3000";
const U1 = "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4";
const U2 = "https://download.samplelib.com/mp4/sample-5s.mp4";

const results = [];
const pass = (n, d = "") => { results.push({ n, ok: true }); console.log(`✅ PASS: ${n}${d ? " — " + d : ""}`); };
const fail = (n, d = "") => { results.push({ n, ok: false }); console.log(`❌ FAIL: ${n}${d ? " — " + d : ""}`); };
const assert = (c, n, d = "") => (c ? pass(n, d) : fail(n, d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** نداء MCP كامل مع فك SSE */
async function mcpCall(method, params, id, progressToken) {
  const body = { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) };
  if (progressToken !== undefined && method === "tools/call") {
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
      try { messages.push(JSON.parse(line.slice(5).trim())); } catch {}
    }
  }
  const mine = messages.filter((m) => m.id === id);
  return {
    status: res.status,
    result: mine[mine.length - 1] ?? null,
    events: messages.filter((m) => m.method === "notifications/progress"),
  };
}
const toolText = (r) => r?.result?.content?.[0]?.text ?? "";
const toolIsError = (r) => r?.result?.isError === true;

// ================= المرحلة A — اختبار مباشر =================
console.log("\n════════ المرحلة A: اختبار مباشر لخدمة الدمج ════════");
let jobId = null;
try {
  const cfg = await (await fetch(`${MERGER}/api/config`)).json();
  assert(cfg.ok === true && cfg.service === "video-merger", "GET /api/config — الجهوزية", JSON.stringify(cfg.limits));
  assert(cfg.ffmpeg === true, "ffmpeg متوفر داخل الخدمة");

  // تحققات الإدخال
  const one = await fetch(`${MERGER}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videos: [U1] }) });
  assert(one.status === 400, "رفض مقطع واحد (400)", `HTTP ${one.status}`);
  const eleven = await fetch(`${MERGER}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videos: Array.from({ length: 11 }, (_, i) => `https://example.com/v${i}.mp4`) }) });
  assert(eleven.status === 400, "رفض 11 مقطعًا (400)", `HTTP ${eleven.status}`);
  const ftp = await fetch(`${MERGER}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videos: ["ftp://example.com/a.mp4", "https://example.com/b.mp4"] }) });
  assert(ftp.status === 400, "رفض بروتوكول غير http(s) (400)", `HTTP ${ftp.status}`);

  // إنشاء سليمة
  const create = await fetch(`${MERGER}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videos: [U1, U2] }) });
  const cbody = await create.json();
  assert(create.status === 201 && cbody.jobId, "POST /api/jobs — إنشاء وظيفة", cbody.jobId);
  assert(!!cbody.processUrl && !!cbody.statusUrl && !!cbody.expiresAt, "الاستجابة تحتوي processUrl/statusUrl/expiresAt");
  jobId = cbody.jobId;

  // معالجة كاملة (blocking)
  const t0 = Date.now();
  const proc = await fetch(`${MERGER}/api/jobs/${jobId}/process`, { method: "POST", signal: AbortSignal.timeout(280_000) });
  const pbody = await proc.json();
  const took = ((Date.now() - t0) / 1000).toFixed(1);
  assert(proc.status === 200 && pbody.status === "done", "POST .../process — اكتمل الدمج", `${took}s`);
  assert(typeof pbody.size === "number" && pbody.size > 0, "حجم الناتج مسجل", `${(pbody.size / 1024 / 1024).toFixed(2)}MB`);
  assert(typeof pbody.duration === "number" && pbody.duration > 5, "مجموع المدد مسجل", `${pbody.duration}s`);
  assert(String(pbody.videoUrl ?? "").startsWith("http"), "رابط ناتج مطلق", pbody.videoUrl);

  // idempotency: process مرة أخرى يعيد نفس النتيجة فورًا
  const t1 = Date.now();
  const proc2 = await fetch(`${MERGER}/api/jobs/${jobId}/process`, { method: "POST" });
  const p2 = await proc2.json();
  assert(proc2.status === 200 && p2.status === "done" && Date.now() - t1 < 3000, "إعادة process = idempotent فوري");

  // الحالة
  const st = await (await fetch(`${MERGER}/api/jobs/${jobId}`)).json();
  assert(st.status === "done" && st.progress === 100, "GET /api/jobs/{id} — done/100");

  // تسليم الناتج (محلي: بث مباشر من /tmp)
  const vres = await fetch(`${MERGER}/api/jobs/${jobId}/video`);
  const buf = Buffer.from(await vres.arrayBuffer());
  assert(vres.status === 200 && vres.headers.get("content-type") === "video/mp4" && buf.length > 100_000, "GET .../video — بث MP4", `${(buf.length / 1024 / 1024).toFixed(2)}MB`);
  const ftyp = buf.slice(4, 8).toString("ascii");
  assert(ftyp === "ftyp", "الناتج ملف MP4 صالح (ftyp box)", ftyp);
  const dl = await fetch(`${MERGER}/api/jobs/${jobId}/video?download=1`);
  assert((dl.headers.get("content-disposition") ?? "").includes("attachment"), "?download=1 → Content-Disposition attachment");

  // 404 لوظيفة مجهولة (يفسرها العيل كحذف بعد 24 ساعة)
  const nf = await fetch(`${MERGER}/api/jobs/mj_unknown_123`);
  assert(nf.status === 404, "GET وظيفة مجهولة → 404");
} catch (e) {
  fail("المرحلة A — خطأ غير متوقع", e.message);
}

// ================= المرحلة B — عبر التطبيق الرئيسي (MCP) =================
console.log("\n════════ المرحلة B: الدمج عبر MCP في التطبيق الرئيسي ════════");
let mergeTaskId = null;
try {
  const call = await mcpCall("tools/call", { name: "merge_videos", arguments: { urls: [U1, U2], wait_seconds: 100 } }, 501, "tok-m1");
  const text = toolText(call.result);
  console.log("--- رد الأداة ---\n" + text);
  assert(!toolIsError(call.result) && text.includes("✅ تم دمج المقاطع بنجاح"), "merge_videos عبر urls اكتمل");
  const urlMatch = text.match(/https?:\/\/[^\s)]+/);
  assert(!!urlMatch && /\/api\/jobs\/.+\/video/.test(urlMatch[0]), "رابط الناتج في الرد", urlMatch?.[0]);
  assert(text.includes("24"), "تحذير الـ24 ساعة موجود");
  assert(call.events.length >= 1, "بث إشعارات التقدم حي", `عددها: ${call.events.length}`);
  // معرّف مهمة الدمج من قاعدة البيانات (رسالة النجاح تعرض الرابط مباشرة بلا task_id)
  {
    const envText = readFileSync(".env", "utf8");
    const env = Object.fromEntries(
      envText.split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
        .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
    );
    const client = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
    const r = await client.execute("SELECT id FROM tasks WHERE type='merge' AND status='completed' ORDER BY created_at DESC LIMIT 1");
    mergeTaskId = r.rows[0] ? String(r.rows[0].id) : null;
  }
  assert(!!mergeTaskId, "مهمة الدمج مسجلة في Turso كمكتملة", mergeTaskId?.slice(0, 8));

  // متابعة بـ get_task
  const g = await mcpCall("tools/call", { name: "get_task", arguments: { task_id: mergeTaskId } }, 502);
  assert(toolText(g.result).includes("مكتملة") || toolText(g.result).includes("✅"), "get_task تعيد حالة مكتملة", toolText(g.result).split("\n")[0]);

  // الفحوصات الصارمة عبر MCP (رسائل عربية)
  const oneMcp = await mcpCall("tools/call", { name: "merge_videos", arguments: { urls: [U1] } }, 503);
  assert(toolIsError(oneMcp.result) && toolText(oneMcp.result).includes("الدمج يحتاج مقطعَين على الأقل"), "رفض مقطع واحد برسالة عربية");
  const elevenMcp = await mcpCall("tools/call", { name: "merge_videos", arguments: { urls: Array.from({ length: 11 }, (_, i) => `https://example.com/v${i}.mp4`) } }, 504);
  assert(toolText(elevenMcp.result).includes("أقصى عدد مقاطع للدمج هو 10"), "رفض 11 مقطعًا برسالة عربية");
  const privMcp = await mcpCall("tools/call", { name: "merge_videos", arguments: { urls: ["http://192.168.1.5/x.mp4", "http://localhost/y.mp4"] } }, 505);
  assert(toolText(privMcp.result).includes("روابط فيديو مباشرة عامة"), "رفض الروابط الداخلية");

  // list_media يشمل الدمج
  const lm = await mcpCall("tools/call", { name: "list_media", arguments: { limit: 5 } }, 506);
  const lmText = toolText(lm.result);
  assert(lmText.includes("merge") && lmText.includes(mergeTaskId), "list_media تعرض مهمة الدمج الجديدة");
} catch (e) {
  fail("المرحلة B — خطأ غير متوقع", e.message);
}

// ================= المرحلة C — التنظيف =================
console.log("\n════════ المرحلة C: التنظيف ════════");
try {
  const envText = readFileSync(".env", "utf8");
  const env = Object.fromEntries(
    envText.split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
      .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
  );
  const client = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
  // تنظيف شامل لمهام الدمج التجريبية المحلية (الحالية وأي بقايا سابقة)
  const del = await client.execute("DELETE FROM tasks WHERE type='merge' AND (result_urls_json LIKE '%127.0.0.1:3002%' OR id = ?)", [mergeTaskId ?? ""]);
  pass("حذف مهام الدمج التجريبية من Turso", `rowsAffected=${Number(del.rowsAffected)}`);
  if (jobId) {
    const d = await fetch(`${MERGER}/api/jobs/${jobId}`, { method: "DELETE" });
    const after = await fetch(`${MERGER}/api/jobs/${jobId}`);
    assert(d.ok && after.status === 404, "حذف وظيفة الدمج من الخدمة (ثم 404)");
  }
} catch (e) {
  fail("المرحلة C — خطأ تنظيف", e.message);
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${"═".repeat(60)}\nالنتيجة: ${passed}/${results.length} اختبارًا ناجحًا`);
for (const r of results) if (!r.ok) console.log(`  ❌ ${r.n}`);
process.exit(passed === results.length ? 0 : 1);
