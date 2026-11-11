/**
 * بناء خادم MCP — media-generator-mcp v1.2.0.
 *
 * قرارات:
 * - SDK الرسمية فقط (McpServer) — بلا JSON-RPC يدوي.
 * - وضع عديم الجلسة (stateless): كل POST مكتفٍ بذاته — ضروري للتوافق مع Vercel serverless
 *   حيث لا تصمد الجلسات في الذاكرة بين النسخ.
 * - أوصاف الأدوات بالإنجليزية (يقرأها عميل MCP) — أما نتائج الاستدعاء فكلها بالعربية.
 * - إشعارات التقدم (progress notifications) تُبث كل ~3 ثوانٍ عند تزويد العميل progressToken.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { runGeneration, refreshTask, ToolParamsError } from "./generation";
import { runMerge } from "./merger";
import { listRecentTasks, type TaskRow } from "./turso";
import * as F from "./format";

export const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" } as const;

export const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

/** بث إشعار تقدم إذا زوّد العميل الطلب بـ progressToken */
async function sendProgress(
  extra: Pick<ToolExtra, "_meta" | "sendNotification">,
  progress: number,
  total: number,
  message: string,
): Promise<void> {
  const token = extra._meta?.progressToken;
  if (token === undefined || token === null) return;
  try {
    await extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken: token, progress, total, message },
    } as Parameters<ToolExtra["sendNotification"]>[0]);
  } catch {
    // فشل البث لا يوقف المهمة
  }
}

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type ToolResult = CallToolResult;

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }] , ...(isError ? { isError: true } : {}) };
}

/** غلاف موحّد: يمرر المعطيات وextra، وأخطاء غير متوقعة تُصاغ عربيًا دون أي تسريب داخلي */
function wrapTool<A>(handler: (args: A, extra: ToolExtra) => Promise<ToolResult>) {
  return async (args: A, extra: ToolExtra): Promise<ToolResult> => {
    try {
      return await handler(args, extra);
    } catch (e) {
      if (e instanceof ToolParamsError) {
        return textResult(e.message, true);
      }
      // لا نذكر أبدًا تفاصيل المفاتيح أو الأرصدة — رسالة عامة فقط
      return textResult(F.fmtFailed("حدث خطأ غير متوقع على السيرفر — أعد المحاولة أو تابع بـ get_task لاحقًا."), true);
    }
  };
}

export function createMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });

  // ---------- 1) generate_image ----------
  server.registerTool(
    "generate_image",
    {
      title: "Generate Image",
      description:
        "توليد صورة بـ gpt-image-2-6/flare-text-to-image (تبديل تلقائي عبر كل المفاتيح النشطة). تعيد رابط الصورة جاهزًا إذا اكتملت خلال نافذة الانتظار، وإلا تعيد task_id — استدعِ get_task كل ~10 ثوانٍ حتى completed ثم اعرض الرابط وتوقف.",
      inputSchema: {
        prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
        model: z
          .enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"])
          .default("gpt-image-2-6/flare-text-to-image"),
        aspect_ratio: z
          .enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"])
          .default("auto"),
        resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
        background: z.enum(["auto", "transparent", "opaque"]).default("auto").describe("Only applied at 1K."),
        output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
        wait_seconds: z.number().int().min(0).max(240).default(90),
      },
    },
    wrapTool(async (args: {
      prompt: string;
      model: string;
      aspect_ratio: string;
      resolution: string;
      background: string;
      output_format: string;
      wait_seconds: number;
    }, extra: ToolExtra) => {
      const outcome = await runGeneration({
        type: "image",
        model: args.model,
        params: {
          prompt: args.prompt,
          aspect_ratio: args.aspect_ratio,
          resolution: args.resolution,
          background: args.background,
          output_format: args.output_format,
        },
        waitSeconds: args.wait_seconds,
        onProgress: (p) => sendProgress(extra, p.progress, p.total, p.message),
      });
      if (outcome.kind === "failed") return textResult(outcome.text, true);
      return textResult(outcome.text);
    }),
  );

  // ---------- 2) generate_video ----------
  server.registerTool(
    "generate_video",
    {
      title: "Generate Video",
      description:
        "توليد فيديو بـ grok-imagine-video-1-5-preview (صوت متزامن أصلي، image-to-video اختياري). الفيديو يحتاج دقائق: انتظار قصير مع بث تقدم ثم task_id — تابع بـ get_task كل ~10 ثوانٍ.",
      inputSchema: {
        prompt: z.string().max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
        image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
        model: z.enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"]).default("grok-imagine-video-1-5-preview"),
        aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
        resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
        enable_audio: z.boolean().default(true),
        duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
        wait_seconds: z.number().int().min(0).max(240).default(25),
      },
    },
    wrapTool(async (args: {
      prompt: string;
      image_url?: string;
      model: string;
      aspect_ratio: string;
      resolution: string;
      enable_audio: boolean;
      duration: number;
      wait_seconds: number;
    }, extra: ToolExtra) => {
      const outcome = await runGeneration({
        type: "video",
        model: args.model,
        params: {
          prompt: args.prompt,
          ...(args.image_url ? { image_url: args.image_url } : {}),
          aspect_ratio: args.aspect_ratio,
          resolution: args.resolution,
          enable_audio: args.enable_audio,
          duration: args.duration,
        },
        waitSeconds: args.wait_seconds,
        onProgress: (p) => sendProgress(extra, p.progress, p.total, p.message),
      });
      if (outcome.kind === "failed") return textResult(outcome.text, true);
      return textResult(outcome.text);
    }),
  );

  // ---------- 3) merge_videos ----------
  server.registerTool(
    "merge_videos",
    {
      title: "Merge Videos",
      description:
        "دمج عدة مقاطع في فيديو واحد نهائي بالترتيب المعطى. مرر urls (روابط فيديو مباشرة عامة — مثل روابط generate_video) أو task_ids (لمهام فيديو مكتملة تُحل روابطها من قاعدة البيانات بالترتيب — مثالي بعد توليد عدة مقاطع). الدمج سريع عادةً: انتظار قصير مع بث تقدم ثم task_id للدمج — تابعه بـ get_task. ملاحظة حرفية: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly. لا توجد resolution/fps — خدمة الدمج تثبّت المخرج (MP4 H.264+AAC).",
      inputSchema: {
        urls: z
          .array(z.string())
          .min(2, { message: "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة." })
          .max(10, { message: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى)." })
          .optional()
          .describe("Public direct video URLs (http/https) in merge order — the first clip starts the final video."),
        task_ids: z
          .array(z.string())
          .min(2, { message: "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة." })
          .max(10, { message: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى)." })
          .optional()
          .describe("Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order."),
        wait_seconds: z.number().int().min(0).max(240).default(60),
      },
    },
    wrapTool(async (args: { urls?: string[]; task_ids?: string[]; wait_seconds: number }, extra: ToolExtra) => {
      if (!args.urls && !args.task_ids) {
        return textResult(F.fmtMergeNeedTwo("لم يُمرَّر urls ولا task_ids"), true);
      }
      const outcome = await runMerge({
        urls: args.urls,
        task_ids: args.task_ids,
        waitSeconds: args.wait_seconds,
        onProgress: (p) => sendProgress(extra, p.progress, p.total, p.message),
      });
      if (outcome.kind === "failed") return textResult(outcome.text, true);
      return textResult(outcome.text);
    }),
  );

  // ---------- 4) get_task ----------
  server.registerTool(
    "get_task",
    {
      title: "Get Task",
      description:
        "تتبع أي مهمة بمعرّفها — توليد صور/فيديو ودمج (يقرأ قاعدة Turso ويحدّث من المزود/الخدمة إن كانت جارية). استعلمه كل ~10 ثوانٍ؛ عند completed ستجد روابط النتائج — اعرضها للمستخدم وتوقف عن الاستعلام.",
      inputSchema: {
        task_id: z.string().min(1),
      },
    },
    wrapTool(async (args: { task_id: string }) => {
      const outcome = await refreshTask(args.task_id);
      if (outcome.kind === "failed") return textResult(outcome.text, true);
      return textResult(outcome.text);
    }),
  );

  // ---------- 5) list_media ----------
  server.registerTool(
    "list_media",
    {
      title: "List Media",
      description:
        "أحدث الصور/الفيديوهات/الدمجات المخزنة بروابطها من قاعدة البيانات (بدون إعادة توليد) — لاسترجاع نتائج سابقة.",
      inputSchema: {
        type: z.enum(["image", "video", "merge"]).optional(),
        status: z.enum(["completed", "failed", "processing"]).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    wrapTool(async (args: { type?: "image" | "video" | "merge"; status?: "completed" | "failed" | "processing"; limit: number }) => {
      const rows: TaskRow[] = await listRecentTasks(args.limit, { type: args.type, status: args.status });
      const items = rows.map((r) => {
        let urls: string[] = [];
        try {
          const v = JSON.parse(r.result_urls_json ?? "[]");
          if (Array.isArray(v)) urls = v.filter((u): u is string => typeof u === "string");
        } catch {
          urls = [];
        }
        return {
          id: r.id,
          type: r.type,
          model: r.model,
          status: r.status,
          prompt: r.prompt,
          createdAt: r.created_at,
          urls,
          progress: r.progress,
        };
      });
      return textResult(F.fmtListMedia(items));
    }),
  );

  return server;
}
