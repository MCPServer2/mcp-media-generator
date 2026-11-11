/**
 * إدارة المفاتيح للواجهة:
 * - GET  /api/keys — القائمة كاملة مع إخفاء المفاتيح دائمًا (maskKey) — لا يُعاد المفتاح الكامل أبدًا.
 * - POST /api/keys — {provider, api_key, label?} مع رفض التكرار لنفس المزود.
 */
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { listAllKeys, insertApiKey, getApiKey } from "@/lib/turso";
import { publicKeyView } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const keys = await listAllKeys();
  // إخفاء إلزامي — الرد لا يحتوي api_key الخام مطلقًا
  return NextResponse.json({ keys: keys.map(publicKeyView) });
}

export async function POST(req: NextRequest) {
  let body: { provider?: string; api_key?: string; label?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "جسم الطلب غير صالح — المطلوب JSON." }, { status: 400 });
  }

  const provider = body.provider;
  const apiKey = (body.api_key ?? "").trim();
  const label = (body.label ?? "").trim().slice(0, 100);

  if (provider !== "kie" && provider !== "cometapi") {
    return NextResponse.json({ error: "المزود يجب أن يكون kie أو cometapi." }, { status: 400 });
  }
  if (!apiKey || apiKey.length < 8) {
    return NextResponse.json({ error: "المفتاح قصير جدًا أو مفقود." }, { status: 400 });
  }

  // رفض التكرار لنفس المزود
  const existing = await listAllKeys();
  if (existing.some((k) => k.provider === provider && k.api_key === apiKey)) {
    return NextResponse.json({ error: "هذا المفتاح مضاف مسبقًا لنفس المزود — رفض التكرار." }, { status: 409 });
  }

  const id = randomUUID();
  await insertApiKey({ id, provider, label, api_key: apiKey });
  const created = await getApiKey(id);
  if (!created) return NextResponse.json({ error: "تعذر إنشاء المفتاح." }, { status: 500 });
  return NextResponse.json({ key: publicKeyView(created) }, { status: 201 });
}
