/**
 * مخزن وظائف الدمج — Video Merger API v2.
 *
 * قرارات معمارية:
 * - الذاكرة هي المصدر الفوري (Map على globalThis تصمد مع HMR) والسرعة أولًا.
 * - Turso (نفس قاعدة التطبيق، جدول merger_jobs منفصل) لتخزين دائم اختياري:
 *   على Vercel serverless قد يستقبل GET نسخة جديدة بلا ذاكرة → نحمّل الحالة من Turso
 *   بدل إعادة 404 (الذي يفسره التطبيق الرئيسي كفشل نهائي). بلا متغيرات Turso يعمل المخزن بالذاكرة فقط.
 * - الملفات الناتجة تُحذف دائمًا بعد 24 ساعة (retention) — التنظيف عبر /api/cron/cleanup.
 */
import { createClient, type Client, type InValue } from "@libsql/client";

export type MergerStatus = "created" | "processing" | "done" | "failed";

export interface MergerJob {
  id: string;
  status: MergerStatus;
  progress: number; // 0..100
  videos: string[];
  error: string | null;
  videoUrl: string | null;
  downloadUrl: string | null;
  sizeBytes: number | null;
  durationSec: number | null;
  resolution: string | null;
  processStarted: boolean;
  createdAt: string;
  expiresAt: string;
}

export const RETENTION_HOURS = 24;

const g = globalThis as unknown as {
  __mergerJobs?: Map<string, MergerJob>;
  __mergerLocks?: Set<string>;
  __mergerTurso?: Client | null;
  __mergerSchema?: Promise<void>;
};

const jobs = (g.__mergerJobs ??= new Map<string, MergerJob>());
/** قفل التزامن: منع تشغيل process مرتين لنفس الوظيفة في نفس النسخة */
export const processLocks = (g.__mergerLocks ??= new Set<string>());

function turso(): Client | null {
  if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) return null;
  if (g.__mergerTurso === undefined) {
    try {
      g.__mergerTurso = createClient({
        url: process.env.TURSO_DATABASE_URL,
        authToken: process.env.TURSO_AUTH_TOKEN,
      });
    } catch {
      g.__mergerTurso = null;
    }
  }
  return g.__mergerTurso;
}

export function tursoEnabled(): boolean {
  return turso() !== null;
}

async function ensureSchema(): Promise<void> {
  const c = turso();
  if (!c) return;
  if (!g.__mergerSchema) {
    g.__mergerSchema = (async () => {
      await c.execute(`
        CREATE TABLE IF NOT EXISTS merger_jobs (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          progress INTEGER DEFAULT 0,
          videos_json TEXT DEFAULT '[]',
          error TEXT,
          video_url TEXT,
          size_bytes INTEGER,
          duration_sec REAL,
          process_started INTEGER DEFAULT 0,
          created_at TEXT,
          expires_at TEXT,
          updated_at TEXT DEFAULT (datetime('now'))
        )
      `);
    })().catch((e) => {
      g.__mergerSchema = undefined;
      throw e;
    });
  }
  await g.__mergerSchema;
}

function rowToJob(r: Record<string, unknown>): MergerJob {
  let videos: string[] = [];
  try {
    const v = JSON.parse(String(r.videos_json ?? "[]"));
    if (Array.isArray(v)) videos = v.filter((u): u is string => typeof u === "string");
  } catch {
    videos = [];
  }
  return {
    id: String(r.id),
    status: (String(r.status) as MergerStatus) ?? "created",
    progress: Number(r.progress ?? 0),
    videos,
    error: (r.error as string) ?? null,
    videoUrl: (r.video_url as string) ?? null,
    downloadUrl: null,
    sizeBytes: r.size_bytes === null || r.size_bytes === undefined ? null : Number(r.size_bytes),
    durationSec: r.duration_sec === null || r.duration_sec === undefined ? null : Number(r.duration_sec),
    resolution: null,
    processStarted: Number(r.process_started ?? 0) === 1,
    createdAt: String(r.created_at ?? ""),
    expiresAt: String(r.expires_at ?? ""),
  };
}

function jobToArgs(j: MergerJob): InValue[] {
  return [
    j.id,
    j.status,
    Math.max(0, Math.min(100, Math.round(j.progress))),
    JSON.stringify(j.videos),
    j.error,
    j.videoUrl,
    j.sizeBytes,
    j.durationSec,
    j.processStarted ? 1 : 0,
    j.createdAt,
    j.expiresAt,
  ];
}

/** حفظ الوظيفة: ذاكرة فورًا + Turso (أخطاء التخزين الدائم لا تكسر المعالجة) */
export async function saveJob(job: MergerJob): Promise<void> {
  jobs.set(job.id, job);
  const c = turso();
  if (!c) return;
  try {
    await ensureSchema();
    await c.execute({
      sql: `INSERT INTO merger_jobs (id, status, progress, videos_json, error, video_url, size_bytes, duration_sec, process_started, created_at, expires_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(id) DO UPDATE SET
              status = excluded.status,
              progress = excluded.progress,
              videos_json = excluded.videos_json,
              error = excluded.error,
              video_url = excluded.video_url,
              size_bytes = excluded.size_bytes,
              duration_sec = excluded.duration_sec,
              process_started = excluded.process_started,
              expires_at = excluded.expires_at,
              updated_at = datetime('now')`,
      args: jobToArgs(job),
    });
  } catch {
    // بلا تخزين دائم — الذاكرة تكفي محليًا
  }
}

/** جلب الوظيفة: الذاكرة أولًا ثم Turso (بعد بارد على Vercel) */
export async function getJob(id: string): Promise<MergerJob | null> {
  const mem = jobs.get(id);
  if (mem) return mem;
  const c = turso();
  if (!c) return null;
  try {
    await ensureSchema();
    const r = await c.execute({ sql: "SELECT * FROM merger_jobs WHERE id = ? LIMIT 1", args: [id] });
    if (r.rows.length === 0) return null;
    const job = rowToJob(r.rows[0] as unknown as Record<string, unknown>);
    jobs.set(job.id, job);
    return job;
  } catch {
    return null;
  }
}

export async function removeJob(id: string): Promise<boolean> {
  const existedMem = jobs.delete(id);
  const c = turso();
  let existedDb = false;
  if (c) {
    try {
      await ensureSchema();
      const r = await c.execute({ sql: "DELETE FROM merger_jobs WHERE id = ?", args: [id] });
      existedDb = Number(r.rowsAffected) > 0;
    } catch {
      existedDb = false;
    }
  }
  return existedMem || existedDb;
}

export async function listExpired(nowIso: string): Promise<MergerJob[]> {
  const c = turso();
  if (!c) {
    return [...jobs.values()].filter((j) => j.expiresAt < nowIso);
  }
  try {
    await ensureSchema();
    const r = await c.execute({ sql: "SELECT * FROM merger_jobs WHERE expires_at < ?", args: [nowIso] });
    return r.rows.map((row) => rowToJob(row as unknown as Record<string, unknown>));
  } catch {
    return [];
  }
}

export function activeCount(): number {
  return processLocks.size;
}

/** آخر الوظائف من الذاكرة (مراقبة يدوية فقط) */
export async function listMemoryJobs(): Promise<{ id: string; status: MergerStatus; progress: number }[]> {
  return [...jobs.values()]
    .slice(-50)
    .map((j) => ({ id: j.id, status: j.status, progress: j.progress }));
}

export function newJobId(): string {
  return `mj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
