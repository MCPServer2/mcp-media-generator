/**
 * خط معالجة الدمج — تنزيل → توحيد → دمج → رفع.
 *
 * قرارات جوهرية:
 * - ffmpeg فقط (ffmpeg-static أو FFMPEG_PATH) وبلا ffprobe: نقرأ Duration من stderr لسطر -i.
 * - توحيد كل مقطع على نفس المعاملات (لوحة 1080p, 30fps, H.264 CRF 18 veryfast, AAC 160k/48kHz ستيريو)
 *   حتى يعمل دمج concat بـ -c copy بدون إعادة ترميز نهائية (أسرع وأخف على serverless).
 * - مصدر بلا صوت؟ نضيف مسار صمت anullsrc دائمًا حتى تبقى كل المقاطع ببنية متطابقة.
 * - القيود: 200MB لكل مصدر أثناء البث، 150MB للناتج، 600 ثانية مجموع المدد — تجاوزها = فشل نهائي.
 * - المخرج: Vercel Blob إن توفر BLOB_READ_WRITE_TOKEN (رابط عام يدوم) وإلا يُخزن في /tmp
 *   ويُقدَّم عبر GET /api/jobs/{id}/video من نفس النسخة.
 * - لا يُنزَّل أي شيء إلى التطبيق الرئيسي — الروابط فقط.
 */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import ffmpegStatic from "ffmpeg-static";

export const MAX_CLIPS = 10;
export const MAX_SOURCE_BYTES = 200 * 1024 * 1024; // 200MB لكل مصدر
export const MAX_OUTPUT_BYTES = 150 * 1024 * 1024; // 150MB للناتج
export const MAX_TOTAL_SEC = 600; // 600 ثانية مجموع مدد المقاطع

const TMP_ROOT = "/tmp/merger";
const OUT_DIR = "/tmp/merger-outputs";

export class PipelineError extends Error {}

function ffmpegPath(): string {
  const p = process.env.FFMPEG_PATH || (ffmpegStatic as unknown as string) || "/usr/bin/ffmpeg";
  return p;
}

export function ffmpegAvailable(): boolean {
  try {
    return !!ffmpegPath();
  } catch {
    return false;
  }
}

/** تشغيل ffmpeg بجمع stderr — فشل غير صفري أو مهلة = PipelineError برسالة مقتضبة */
function ffmpegRun(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // turbopackIgnore: المسار ديناميكي عمدًا (ffmpeg-static أو FFMPEG_PATH) — لا تحاول تتبعه
    const child = spawn(/*turbopackIgnore: true*/ ffmpegPath(), args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new PipelineError(`ffmpeg timeout after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000); // نحتفظ بالذيل فقط
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new PipelineError(`ffmpeg spawn failed: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stderr);
      else {
        const tail = stderr.split("\n").slice(-4).join(" ").slice(0, 400);
        reject(new PipelineError(`ffmpeg exited ${code}: ${tail}`));
      }
    });
  });
}

/** مدة المقطع من سطر Duration في stderr (بديل ffprobe) */
function parseDuration(stderr: string): number {
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** تنزيل مصدر واحد بحد 200MB أثناء البث (لا ننتظر Content-Length وحده) */
async function downloadSource(url: string, dest: string, index: number): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; VideoMergerService/2.0)" },
      redirect: "follow",
    });
    if (!res.ok || !res.body) {
      throw new PipelineError(`Download failed (HTTP ${res.status}) for source #${index + 1}`);
    }
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_SOURCE_BYTES) {
      throw new PipelineError(`Source #${index + 1} exceeds the 200MB limit`);
    }
    let received = 0;
    const nodeStream = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    nodeStream.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_SOURCE_BYTES) {
        nodeStream.destroy(new PipelineError(`Source #${index + 1} exceeds the 200MB limit`));
        controller.abort();
      }
    });
    try {
      await pipeline(nodeStream, createWriteStream(dest));
    } catch (e) {
      throw new PipelineError((e as Error).message);
    }
  } catch (e) {
    if (e instanceof PipelineError) throw e;
    throw new PipelineError(`Download failed for source #${index + 1}: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * توحيد مقطع على اللوحة الموحدة. يعيد مدة المقطع بالثواني (من stderr).
 * الخريطة الثابتة: 1920x1080 مع الحفاظ على النسبة + حواف سوداء، 30fps، H.264 CRF18، AAC 48kHz.
 */
async function normalizeClip(src: string, dest: string): Promise<number> {
  const stderr = await ffmpegRun(
    [
      "-y",
      "-i", src,
      "-f", "lavfi",
      "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
      "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,fps=30,setsar=1",
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-c:v", "libx264",
      "-crf", "18",
      "-preset", "veryfast",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "160k",
      "-ar", "48000",
      "-ac", "2",
      "-shortest",
      "-movflags", "+faststart",
      dest,
    ],
    240_000,
  );
  return parseDuration(stderr);
}

/** دمج المقاطع الموحدة بـ concat demuxer ونسخ تدفقات — بلا إعادة ترميز */
async function concatClips(dir: string, count: number, out: string): Promise<void> {
  const listPath = path.join(dir, "list.txt");
  const lines: string[] = [];
  for (let i = 0; i < count; i++) lines.push(`file '${path.join(dir, `mid_${i}.mp4`)}'`);
  await (await import("node:fs/promises")).writeFile(listPath, lines.join("\n") + "\n", "utf8");
  await ffmpegRun(
    ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", out],
    180_000,
  );
}

async function uploadToBlob(filePath: string, jobId: string): Promise<string | null> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  const { put } = await import("@vercel/blob");
  const { createReadStream } = await import("node:fs");
  const stream = Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream;
  const res = await put(`merger-outputs/${jobId}.mp4`, stream, {
    access: "public",
    addRandomSuffix: false,
    contentType: "video/mp4",
  });
  return res.url;
}

export interface PipelineResult {
  videoUrl: string;
  downloadUrl: string;
  sizeBytes: number;
  durationSec: number;
  resolution: string;
}

export interface PipelineHooks {
  jobId: string;
  videos: string[]; // روابط المصادر بالترتيب
  selfBase: string; // مثل https://merger-x.vercel.app — لصياغة روابط الخدمة ذاتها
  onProgress: (progress: number) => Promise<void> | void;
}

/** تنفيذ المهمة كاملة — يرمي PipelineError عند أي فشل نهائي */
export async function runPipeline(hooks: PipelineHooks): Promise<PipelineResult> {
  const { jobId, selfBase, onProgress } = hooks;
  const dir = path.join(TMP_ROOT, jobId);
  const outFile = path.join(OUT_DIR, `${jobId}.mp4`);
  await mkdir(dir, { recursive: true });
  await mkdir(OUT_DIR, { recursive: true });

  try {
    const n = hooks.videos.length;
    // 1) التنزيل: 5 → 25
    const sources: string[] = [];
    for (let i = 0; i < n; i++) {
      const dest = path.join(dir, `src_${i}.mp4`);
      await downloadSource(hooks.videos[i], dest, i);
      sources.push(dest);
      await onProgress(5 + Math.round(((i + 1) / n) * 20));
    }

    // 2) التوحيد: 25 → 70 (نقرأ المدة من كل مقطع لفرض حد 600 ثانية)
    const mids: string[] = [];
    let totalSec = 0;
    for (let i = 0; i < sources.length; i++) {
      const mid = path.join(dir, `mid_${i}.mp4`);
      const dur = await normalizeClip(sources[i], mid);
      totalSec += dur;
      mids.push(mid);
      if (totalSec > MAX_TOTAL_SEC) {
        throw new PipelineError(`Total duration ${Math.round(totalSec)}s exceeds the 600s limit`);
      }
      await onProgress(25 + Math.round(((i + 1) / sources.length) * 45));
    }

    // 3) الدمج: 80
    await onProgress(80);
    await concatClips(dir, mids.length, outFile);

    // 4) فحص حجم الناتج: ≤150MB
    const st = await stat(outFile);
    if (st.size > MAX_OUTPUT_BYTES) {
      throw new PipelineError(`Output ${(st.size / 1024 / 1024).toFixed(1)}MB exceeds the 150MB limit`);
    }

    // 5) الرفع: 90 — Blob إن توفر وإلا يبقى الملف في /tmp ويُقدَّم عبر /video
    await onProgress(90);
    const blobUrl = await uploadToBlob(outFile, jobId);
    if (blobUrl) {
      await rm(outFile, { force: true }); // الملف على Blob — لا نحتاج النسخة المحلية
    }
    await onProgress(100);

    const base = blobUrl ?? `${selfBase}/api/jobs/${jobId}/video`;
    return {
      videoUrl: base,
      downloadUrl: blobUrl ? base : `${selfBase}/api/jobs/${jobId}/video?download=1`,
      sizeBytes: st.size,
      durationSec: Math.round(totalSec * 10) / 10,
      resolution: "1920x1080-canvas",
    };
  } finally {
    // تنظيف الملفات المؤقتة دائمًا (المصادر والمقاطع الموحدة) — الناتج يُدار صراحة
    await rm(dir, { recursive: true, force: true });
  }
}

/** مسار الناتج المحلي (يُستخدم في /video وحذف الوظيفة) */
export function outputFilePath(jobId: string): string {
  return path.join(OUT_DIR, `${jobId}.mp4`);
}

export async function outputExists(jobId: string): Promise<boolean> {
  try {
    const st = await stat(outputFilePath(jobId));
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}
