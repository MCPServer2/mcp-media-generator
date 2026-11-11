/**
 * مسار خادم MCP — /mcp (نقل Streamable HTTP حسب مواصفات MCP).
 *
 * قرارات مهمة:
 * - SDK الرسمية فقط: McpServer + WebStandardStreamableHTTPServerTransport
 *   (وهو النقل الأساسي الرسمي في الـ SDK الذي يغلّفه StreamableHTTPServerTransport —
 *   يعمل مباشرة بـ Web Request/Response في App Router وبلا أي JSON-RPC يدوي).
 * - وضع عديم الجلسة (sessionIdGenerator: undefined): كل POST مكتفٍ بذاته — الخيار
 *   الصحيح لبيئات serverless كـ Vercel حيث لا تصمد الجلسات في الذاكرة بين النسخ.
 * - runtime="nodejs" و dynamic="force-dynamic" كما تتطلب المواصفة.
 * - إذا ضُبط MCP_ACCESS_TOKEN يُطلب Authorization: Bearer <token> على /mcp.
 */
import { NextRequest, NextResponse } from "next/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "@/lib/mcp-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// يسمح بنوافذ انتظار طويلة مع بث التقدم — يُقيَّد تلقائيًا حسب خطة Vercel
export const maxDuration = 300;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

function checkAuth(req: NextRequest): NextResponse | null {
  const token = process.env.MCP_ACCESS_TOKEN;
  if (!token) return null; // المصادقة غير مفعّلة
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${token}`) {
    return NextResponse.json(
      { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: مطلوب ترويسة Authorization: Bearer <MCP_ACCESS_TOKEN>" }, id: null },
      { status: 401, headers: { ...CORS_HEADERS, "WWW-Authenticate": "Bearer" } },
    );
  }
  return null;
}

async function handleMcpPost(req: NextRequest): Promise<Response> {
  const unauthorized = checkAuth(req);
  if (unauthorized) return unauthorized;

  // خادم + نقل جددان لكل طلب (وضع عديم الجلسة) — النمط الرسمي للـ stateless
  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: false, // SSE افتراضيًا كي تُبث إشعارات التقدم حيًا
  });
  await server.connect(transport);

  try {
    // النقل الرسمي يستقبل Web Request ويعيد Response (قد يكون SSE متدفقًا أثناء تنفيذ الأداة)
    const response = await transport.handleRequest(new Request(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      // @ts-expect-error duplex مطلوب تقنيًا لتدفق الجسم في Request Constructor
      duplex: "half",
    }));
    const res = new NextResponse(response.body, { status: response.status, headers: response.headers });
    for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
    return res;
  } catch (e) {
    return NextResponse.json(
      { jsonrpc: "2.0", error: { code: -32700, message: `Parse error: ${(e as Error).message}` }, id: null },
      { status: 400, headers: CORS_HEADERS },
    );
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  return handleMcpPost(req);
}

// OPTIONS: دعم CORS لعملاء المتصفح
export async function OPTIONS(): Promise<Response> {
  return new NextResponse(null, { status: 200, headers: CORS_HEADERS });
}

// GET (تدفق SSE مستقل) و DELETE (إنهاء جلسة) غير مفعّلين في وضع عديم الجلسة —
// المواصفة تسمح بالرد 405 مع الإفصاح عن الطرق المدعومة
export async function GET(): Promise<Response> {
  return NextResponse.json(
    { jsonrpc: "2.0", error: { code: -32000, message: "Method Not Allowed: هذا الخادم يستقبل POST فقط على /mcp (وضع عديم الجلسة)" }, id: null },
    { status: 405, headers: { ...CORS_HEADERS, Allow: "POST, OPTIONS" } },
  );
}

export async function DELETE(): Promise<Response> {
  return new NextResponse(null, { status: 200, headers: { ...CORS_HEADERS, Allow: "POST, OPTIONS" } });
}
