/**
 * تعطيل/تنشيط يدوي وحذف مفتاح:
 * - PATCH  /api/keys/{id} — {status: "active" | "disabled"} (تنشيط مفتاح مستنزف يعيده للعمل بعد الشحن)
 * - DELETE /api/keys/{id}
 * لا يُعاد المفتاح الكامل في أي استجابة.
 */
import { NextRequest, NextResponse } from "next/server";
import { getApiKey, updateApiKey, deleteApiKey } from "@/lib/turso";
import { publicKeyView } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: { status?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "جسم الطلب غير صالح — المطلوب JSON." }, { status: 400 });
  }

  const existing = await getApiKey(id);
  if (!existing) return NextResponse.json({ error: "المفتاح غير موجود." }, { status: 404 });

  if (body.status !== "active" && body.status !== "disabled") {
    return NextResponse.json({ error: 'الحالة المسموحة: "active" أو "disabled".' }, { status: 400 });
  }

  await updateApiKey(id, { status: body.status, last_error: body.status === "active" ? null : existing.last_error });
  const updated = await getApiKey(id);
  return NextResponse.json({ key: updated ? publicKeyView(updated) : null });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const existing = await getApiKey(id);
  if (!existing) return NextResponse.json({ error: "المفتاح غير موجود." }, { status: 404 });
  await deleteApiKey(id);
  return NextResponse.json({ ok: true });
}
