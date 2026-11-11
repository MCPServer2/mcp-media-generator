/**
 * GET /api/health — جهوزية السيرفر: قاعدة البيانات، الموديلات، خدمة الدمج، حالة المصادقة.
 * merger.healthy = فحص GET {MERGER_API_BASE}/api/config بمهلة 4 ثوانٍ.
 */
import { NextResponse } from "next/server";
import { dbHealthy } from "@/lib/turso";
import { MODELS } from "@/lib/models";
import { mergerHealthy } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const dbOk = await dbHealthy();
  const merger = await mergerHealthy();

  return NextResponse.json(
    {
      ok: dbOk,
      database: dbOk ? "turso-connected" : "turso-disconnected",
      mcpEndpoint: "/mcp",
      models: MODELS.map((m) => ({
        canonical: m.canonical,
        type: m.type,
        providers: m.providers,
      })),
      merger: { base: merger.base, healthy: merger.healthy },
      authRequired: Boolean(process.env.MCP_ACCESS_TOKEN),
    },
    { status: dbOk ? 200 : 503 },
  );
}
