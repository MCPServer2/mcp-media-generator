/**
 * طبقة قاعدة البيانات — Turso (libSQL) عبر HTTP.
 * قرارات معمارية:
 * - عميل واحد يُنشأ مرة واحدة ويُخزَّن على globalThis ليُعاد استخدامه بين الطلبات (serverless-friendly).
 * - ensureSchema() تُنشئ الجداول عند أول وصول (CREATE TABLE IF NOT EXISTS) فلا حاجة لأداة migrations.
 * - لا ملفات SQLite محلية إطلاقًا: الاتصال عبر HTTP فقط للتوافق مع Vercel.
 */
import { createClient, type Client, type InValue } from "@libsql/client";

export interface TaskRow {
  id: string;
  provider: string | null; // kie | cometapi | merger
  provider_task_id: string | null; // معرّف المهمة لدى المزود/خدمة الدمج
  key_id: string | null; // آخر مفتاح استُخدم
  model: string;
  type: string; // image | video | merge
  prompt: string;
  params_json: string;
  status: string; // pending | processing | completed | failed
  progress: number; // 0..100
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface ApiKeyRow {
  id: string;
  provider: string; // kie | cometapi
  label: string;
  api_key: string;
  status: string; // active | exhausted | disabled
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface TaskAttempt {
  provider: string;
  keyId: string | null;
  keyLabel: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

/** محاولة واحدة لكل سجل في attempts_json */
export interface TaskStats {
  total: number;
  completed: number;
  failed: number;
  processing: number;
}

const globalForTurso = globalThis as unknown as {
  __tursoClient?: Client;
  __tursoSchema?: Promise<void>;
};

function getClient(): Client {
  if (!globalForTurso.__tursoClient) {
    // قرارات: نستخدم المتغيرين كما هي — Turso يتصل عبر HTTP (libsql://) وليس ملفًا محليًا.
    globalForTurso.__tursoClient = createClient({
      url: process.env.TURSO_DATABASE_URL!,
      authToken: process.env.TURSO_AUTH_TOKEN!,
    });
  }
  return globalForTurso.__tursoClient;
}

/** إنشاء الجداول عند أول وصول — الوعد يُخزَّن كي لا يتكرر التنفيذ مع كل طلب */
export async function ensureSchema(): Promise<void> {
  if (!globalForTurso.__tursoSchema) {
    globalForTurso.__tursoSchema = (async () => {
      const c = getClient();
      await c.execute(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          provider TEXT,
          provider_task_id TEXT,
          key_id TEXT,
          model TEXT NOT NULL,
          type TEXT NOT NULL,
          prompt TEXT DEFAULT '',
          params_json TEXT DEFAULT '{}',
          status TEXT NOT NULL,
          progress INTEGER DEFAULT 0,
          result_urls_json TEXT,
          error_message TEXT,
          attempts_json TEXT DEFAULT '[]',
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          completed_at TEXT
        )
      `);
      await c.execute(`
        CREATE TABLE IF NOT EXISTS api_keys (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          label TEXT DEFAULT '',
          api_key TEXT NOT NULL,
          status TEXT DEFAULT 'active',
          usage_count INTEGER DEFAULT 0,
          success_count INTEGER DEFAULT 0,
          fail_count INTEGER DEFAULT 0,
          last_used_at TEXT,
          last_checked_at TEXT,
          last_error TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);
    })().catch((e) => {
      // فشل التهيئة لا يجب أن يُخزَّن كوعد مكتمل — نمحو حتى تُعاد المحاولة في الطلب التالي
      globalForTurso.__tursoSchema = undefined;
      throw e;
    });
  }
  return globalForTurso.__tursoSchema;
}

/** فحص جهوزية قاعدة البيانات: SELECT 1 */
export async function dbHealthy(): Promise<boolean> {
  try {
    await ensureSchema();
    const r = await getClient().execute("SELECT 1");
    return r.rows.length > 0;
  } catch {
    return false;
  }
}

function mapTask(r: Record<string, unknown>): TaskRow {
  return {
    id: String(r.id),
    provider: (r.provider as string) ?? null,
    provider_task_id: (r.provider_task_id as string) ?? null,
    key_id: (r.key_id as string) ?? null,
    model: String(r.model),
    type: String(r.type),
    prompt: String(r.prompt ?? ""),
    params_json: String(r.params_json ?? "{}"),
    status: String(r.status),
    progress: Number(r.progress ?? 0),
    result_urls_json: (r.result_urls_json as string) ?? null,
    error_message: (r.error_message as string) ?? null,
    attempts_json: String(r.attempts_json ?? "[]"),
    created_at: String(r.created_at ?? ""),
    updated_at: String(r.updated_at ?? ""),
    completed_at: (r.completed_at as string) ?? null,
  };
}

function mapKey(r: Record<string, unknown>): ApiKeyRow {
  return {
    id: String(r.id),
    provider: String(r.provider),
    label: String(r.label ?? ""),
    api_key: String(r.api_key),
    status: String(r.status ?? "active"),
    usage_count: Number(r.usage_count ?? 0),
    success_count: Number(r.success_count ?? 0),
    fail_count: Number(r.fail_count ?? 0),
    last_used_at: (r.last_used_at as string) ?? null,
    last_checked_at: (r.last_checked_at as string) ?? null,
    last_error: (r.last_error as string) ?? null,
    created_at: String(r.created_at ?? ""),
  };
}

// ---------- عمليات المهام ----------

export async function insertTask(t: {
  id: string;
  model: string;
  type: string;
  prompt?: string;
  params_json?: string;
  status?: string;
  progress?: number;
  provider?: string | null;
  provider_task_id?: string | null;
  key_id?: string | null;
}): Promise<void> {
  await ensureSchema();
  // created_at بزمن ميلي صريح — الترتيب التسلسلي يعتمد عليه فلا يكفي دقة الثانية الواحدة في datetime('now')
  await getClient().execute({
    sql: `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status, progress, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      t.id,
      t.provider ?? null,
      t.provider_task_id ?? null,
      t.key_id ?? null,
      t.model,
      t.type,
      t.prompt ?? "",
      t.params_json ?? "{}",
      t.status ?? "processing",
      t.progress ?? 0,
      new Date().toISOString(),
    ] satisfies InValue[],
  });
}

export async function getTask(id: string): Promise<TaskRow | null> {
  await ensureSchema();
  const r = await getClient().execute({ sql: "SELECT * FROM tasks WHERE id = ? LIMIT 1", args: [id] });
  if (r.rows.length === 0) return null;
  return mapTask(r.rows[0] as unknown as Record<string, unknown>);
}

/**
 * تحديث جزئي للمهمة.
 * - attempts: تُضاف محاولة واحدة إلى سجل المحاولات.
 * - completed_at يُضبط تلقائيًا عند الوصول لحالة completed (ويُفرَّغ عند التراجع عنها).
 */
export async function updateTask(
  id: string,
  patch: {
    provider?: string | null;
    provider_task_id?: string | null;
    key_id?: string | null;
    status?: string;
    progress?: number;
    result_urls?: string[] | null;
    error_message?: string | null;
    params_json?: string;
    attempt?: TaskAttempt;
  },
): Promise<void> {
  await ensureSchema();
  const sets: string[] = [];
  const args: InValue[] = [];

  if (patch.provider !== undefined) { sets.push("provider = ?"); args.push(patch.provider); }
  if (patch.provider_task_id !== undefined) { sets.push("provider_task_id = ?"); args.push(patch.provider_task_id); }
  if (patch.key_id !== undefined) { sets.push("key_id = ?"); args.push(patch.key_id); }
  if (patch.status !== undefined) { sets.push("status = ?"); args.push(patch.status); }
  if (patch.progress !== undefined) { sets.push("progress = ?"); args.push(Math.max(0, Math.min(100, Math.round(patch.progress)))); }
  if (patch.result_urls !== undefined) {
    sets.push("result_urls_json = ?");
    args.push(patch.result_urls === null ? null : JSON.stringify(patch.result_urls));
  }
  if (patch.error_message !== undefined) { sets.push("error_message = ?"); args.push(patch.error_message); }
  if (patch.params_json !== undefined) { sets.push("params_json = ?"); args.push(patch.params_json); }

  // إكمال زمن الإكمال تلقائيًا عند الاكتمال
  if (patch.status === "completed") sets.push("completed_at = datetime('now')");
  else if (patch.status !== undefined) sets.push("completed_at = NULL");

  if (patch.attempt) {
    const current = await getTask(id);
    const attempts: TaskAttempt[] = current ? safeParseAttempts(current.attempts_json) : [];
    attempts.push(patch.attempt);
    sets.push("attempts_json = ?");
    args.push(JSON.stringify(attempts.slice(-50))); // حد أقصى معقول لسجل المحاولات
  }

  if (sets.length === 0) return;

  // updated_at يُضبط دائمًا بدقة ميلي — يُستخدم لحساب تهدئة الـ45 ثانية قبل إعادة محاولة «بانتظار مفتاح صالح»
  sets.push("updated_at = ?");
  args.push(new Date().toISOString());

  args.push(id);
  await getClient().execute({ sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, args });
}

function safeParseAttempts(s: string): TaskAttempt[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export async function listRecentTasks(
  limit = 10,
  filter: { type?: string; status?: string } = {},
): Promise<TaskRow[]> {
  await ensureSchema();
  const where: string[] = [];
  const args: InValue[] = [];
  if (filter.type) { where.push("type = ?"); args.push(filter.type); }
  if (filter.status) { where.push("status = ?"); args.push(filter.status); }
  args.push(limit);
  const r = await getClient().execute({
    sql: `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, id DESC LIMIT ?`,
    args,
  });
  return r.rows.map((row) => mapTask(row as unknown as Record<string, unknown>));
}

export async function taskStats(): Promise<TaskStats> {
  await ensureSchema();
  const r = await getClient().execute(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status = 'processing' OR status = 'pending' THEN 1 ELSE 0 END) AS processing
    FROM tasks
  `);
  const row = r.rows[0] ?? {};
  return {
    total: Number(row.total ?? 0),
    completed: Number(row.completed ?? 0),
    failed: Number(row.failed ?? 0),
    processing: Number(row.processing ?? 0),
  };
}

export async function deleteTask(id: string): Promise<void> {
  await ensureSchema();
  await getClient().execute({ sql: "DELETE FROM tasks WHERE id = ?", args: [id] });
}

// ---------- عمليات المفاتيح (للواجهة وطبقة التجربة) ----------

export async function listAllKeys(): Promise<ApiKeyRow[]> {
  await ensureSchema();
  const r = await getClient().execute("SELECT * FROM api_keys ORDER BY created_at ASC, id ASC");
  return r.rows.map((row) => mapKey(row as unknown as Record<string, unknown>));
}

export async function insertApiKey(k: {
  id: string;
  provider: string;
  label?: string;
  api_key: string;
}): Promise<void> {
  await ensureSchema();
  // created_at بزمن ميلي صريح — «أول مفتاح أُضيف يُجرَّب أولًا» يتطلب ترتيبًا أدق من الثانية
  await getClient().execute({
    sql: "INSERT INTO api_keys (id, provider, label, api_key, created_at) VALUES (?, ?, ?, ?, ?)",
    args: [k.id, k.provider, k.label ?? "", k.api_key, new Date().toISOString()],
  });
}

export async function getApiKey(id: string): Promise<ApiKeyRow | null> {
  await ensureSchema();
  const r = await getClient().execute({ sql: "SELECT * FROM api_keys WHERE id = ? LIMIT 1", args: [id] });
  if (r.rows.length === 0) return null;
  return mapKey(r.rows[0] as unknown as Record<string, unknown>);
}

export async function updateApiKey(
  id: string,
  patch: {
    status?: string;
    usage_count?: number;
    success_count?: number;
    fail_count?: number;
    last_used_at?: string | null;
    last_checked_at?: string | null;
    last_error?: string | null;
  },
): Promise<void> {
  await ensureSchema();
  const sets: string[] = [];
  const args: InValue[] = [];
  if (patch.status !== undefined) { sets.push("status = ?"); args.push(patch.status); }
  if (patch.usage_count !== undefined) { sets.push("usage_count = ?"); args.push(patch.usage_count); }
  if (patch.success_count !== undefined) { sets.push("success_count = ?"); args.push(patch.success_count); }
  if (patch.fail_count !== undefined) { sets.push("fail_count = ?"); args.push(patch.fail_count); }
  if (patch.last_used_at !== undefined) { sets.push("last_used_at = ?"); args.push(patch.last_used_at); }
  if (patch.last_checked_at !== undefined) { sets.push("last_checked_at = ?"); args.push(patch.last_checked_at); }
  if (patch.last_error !== undefined) { sets.push("last_error = ?"); args.push(patch.last_error); }
  if (sets.length === 0) return;
  args.push(id);
  await getClient().execute({ sql: `UPDATE api_keys SET ${sets.join(", ")} WHERE id = ?`, args });
}

export async function deleteApiKey(id: string): Promise<void> {
  await ensureSchema();
  await getClient().execute({ sql: "DELETE FROM api_keys WHERE id = ?", args: [id] });
}
