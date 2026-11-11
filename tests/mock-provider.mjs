/**
 * مزود وهمي محلي للاختبارات (e2e بدون مفاتيح حقيقية).
 * يحاكي:
 *  - kie.ai Jobs API:  POST /api/v1/jobs/createTask + GET /api/v1/jobs/recordInfo
 *  - CometAPI:         POST /v1/images/generations (متزامن) + POST /v1/videos + GET /v1/videos/{id}
 *  - خدمة الدمج v2:    POST /api/jobs + POST /api/jobs/{id}/process + GET /api/jobs/{id} + DELETE + GET /api/config
 *
 * سلوك المفاتيح:
 *  - test-invalid      → 401 "invalid api key" (يُعطَّل تلقائيًا)
 *  - test-exhausted    → kie: HTTP 200 مع {code:402, msg:"insufficient balance"} (الاستجابة الكاذبة الواقعية)
 *                        cometapi: HTTP 402 {error:{message:"insufficient balance"}}
 *  - test-dies-midtask → الإنشاء ينجح ثم الاستعلام يفشل برسالة رصيد → يختبر التبديل في منتصف المهمة
 *  - أي مفتاح آخر      → نجاح كامل (آلة حالات: waiting → queuing → generating → success)
 *
 * رابط مصدر يحتوي "/forbidden" يجعل عملية الدمج تفشل نهائيًا بخطأ HTTP 500 (اختبار الفشل الحتمي).
 * التشغيل: node tests/mock-provider.mjs [port=3310]
 */
import http from "node:http";

const PORT = Number(process.argv[2] ?? 3310);

// حالات المهام الوهمية
const kieTasks = new Map(); // taskId -> { kind: "good"|"dies", polls: number, media: "image"|"video" }
const cometTasks = new Map();
const mergeJobs = new Map(); // jobId -> { videos, processStarted, processDone, failed }
let counters = { kie: 0, comet: 0, merge: 0 };

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function keyOf(req) {
  const h = req.headers["authorization"] ?? "";
  return h.replace(/^Bearer\s+/i, "").trim();
}

function classifyKey(key) {
  if (key.startsWith("test-invalid")) return "invalid";
  if (key.startsWith("test-exhausted")) return "exhausted";
  if (key.startsWith("test-diesmid")) return "dies";
  return "good";
}

const RESULT_BASE = "https://mock-cdn.example.com/results";

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const key = keyOf(req);
  const kind = classifyKey(key);

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    return res.end();
  }

  // ============ kie.ai Jobs API ============
  if (path === "/api/v1/jobs/createTask" && req.method === "POST") {
    const body = await readBody(req);
    const isVideo = String(body?.model ?? "").includes("video");
    if (kind === "invalid") return send(res, 401, { code: 401, msg: "invalid api key" });
    if (kind === "exhausted") return send(res, 200, { code: 402, msg: "insufficient balance" }); // الاستجابة الكاذبة: HTTP 200 مع خطأ داخل الجسم
    counters.kie += 1;
    const id = `tk_${counters.kie}_${Date.now()}`;
    kieTasks.set(id, { kind, polls: 0, media: isVideo ? "video" : "image" });
    return send(res, 200, { code: 200, data: { taskId: id } });
  }

  if (path === "/api/v1/jobs/recordInfo" && req.method === "GET") {
    const id = url.searchParams.get("taskId") ?? "";
    const t = kieTasks.get(id);
    if (!t) return send(res, 200, { code: 422, msg: "taskId does not exist" });
    if (t.kind === "dies") {
      return send(res, 200, { code: 200, data: { taskId: id, state: "fail", failMsg: "insufficient balance, please 充值", resultJson: "" } });
    }
    t.polls += 1;
    const states = ["waiting", "queuing", "generating", "generating", "success"];
    const state = states[Math.min(t.polls - 1, states.length - 1)];
    const ext = t.media === "video" ? "mp4" : "png";
    const data = {
      taskId: id,
      state,
      progress: state === "success" ? 100 : Math.min(90, t.polls * 18),
      resultJson: state === "success" ? JSON.stringify({ resultUrls: [`${RESULT_BASE}/${t.media}/${id}.${ext}`] }) : "",
      failMsg: "",
    };
    return send(res, 200, { code: 200, data });
  }

  // ============ CometAPI ============
  if (path === "/v1/images/generations" && req.method === "POST") {
    if (kind === "invalid") return send(res, 401, { error: { message: "invalid api key" } });
    if (kind === "exhausted") return send(res, 402, { error: { message: "insufficient balance" } });
    return send(res, 200, { data: [{ url: `${RESULT_BASE}/image/comet-${Date.now()}.png` }] });
  }

  if (path === "/v1/videos" && req.method === "POST") {
    if (kind === "invalid") return send(res, 401, { error: { message: "invalid api key" } });
    if (kind === "exhausted") return send(res, 402, { error: { message: "insufficient balance" } });
    counters.comet += 1;
    const id = `cv_${counters.comet}_${Date.now()}`;
    cometTasks.set(id, { kind, polls: 0 });
    return send(res, 200, { id, task_id: id, object: "video", status: "queued", progress: 0 });
  }

  if (path.startsWith("/v1/videos/") && req.method === "GET") {
    const id = path.split("/").pop() ?? "";
    const t = cometTasks.get(id);
    if (!t) return send(res, 404, { error: { message: "task not found" } });
    t.polls += 1;
    if (t.polls >= 4) {
      return send(res, 200, { id, status: "completed", progress: 100, video_url: `${RESULT_BASE}/video/${id}.mp4` });
    }
    return send(res, 200, { id, status: t.polls === 1 ? "queued" : "in_progress", progress: t.polls * 20 });
  }

  // ============ خدمة الدمج v2 ============
  if (path === "/api/config" && req.method === "GET") {
    return send(res, 200, { ok: true, limits: { maxClips: 10, maxSourceMB: 200, maxOutputMB: 150, maxTotalSeconds: 600 } });
  }

  if (path === "/api/jobs" && req.method === "POST") {
    const body = await readBody(req);
    const videos = Array.isArray(body?.videos) ? body.videos : [];
    if (videos.length < 2) return send(res, 400, { error: "Need at least 2 videos" });
    counters.merge += 1;
    const jobId = `mj_${counters.merge}_${Date.now()}`;
    mergeJobs.set(jobId, { videos, processStarted: false, processDone: false, failed: videos.some((v) => String(v).includes("/forbidden")) });
    return send(res, 200, {
      jobId,
      status: "queued",
      statusUrl: `http://127.0.0.1:${PORT}/api/jobs/${jobId}`,
      processUrl: `http://127.0.0.1:${PORT}/api/jobs/${jobId}/process`,
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    });
  }

  if (path.endsWith("/process") && req.method === "POST") {
    const jobId = path.split("/")[3];
    const job = mergeJobs.get(jobId);
    if (!job) return send(res, 404, { error: "job not found" });
    job.processStarted = true;
    await new Promise((r) => setTimeout(r, 4000)); // المعالجة تستغرق ثوانٍ
    if (job.failed) return send(res, 500, { error: "Download failed (HTTP 403)" });
    job.processDone = true;
    return send(res, 200, {
      status: "done",
      videoUrl: `https://mock-merger.example.com/api/jobs/${jobId}/video`,
      downloadUrl: `https://mock-merger.example.com/api/jobs/${jobId}/video?download=1`,
      size: 1234567,
      duration: 30.2,
      resolution: "640x360",
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    });
  }

  if (path.startsWith("/api/jobs/") && req.method === "GET" && !path.endsWith("/video")) {
    const jobId = path.split("/")[3];
    const job = mergeJobs.get(jobId);
    if (!job) return send(res, 404, { error: "job not found" });
    if (job.failed && job.processStarted) return send(res, 200, { status: "failed", error: "Download failed (HTTP 403)" });
    if (job.processDone) {
      return send(res, 200, {
        status: "done",
        progress: 100,
        videoUrl: `https://mock-merger.example.com/api/jobs/${jobId}/video`,
        downloadUrl: `https://mock-merger.example.com/api/jobs/${jobId}/video?download=1`,
      });
    }
    if (job.processStarted) return send(res, 200, { status: "processing", progress: 0.5 });
    return send(res, 200, { status: "queued", progress: 0 });
  }

  if (path.startsWith("/api/jobs/") && req.method === "DELETE") {
    const jobId = path.split("/")[3];
    const existed = mergeJobs.delete(jobId);
    return send(res, existed ? 200 : 404, existed ? { ok: true } : { error: "job not found" });
  }

  return send(res, 404, { error: `unknown mock route: ${req.method} ${path}` });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-provider] listening on http://127.0.0.1:${PORT}`);
});
