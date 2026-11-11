"use client";

/**
 * أ) مدير المفاتيح:
 * - نموذج إضافة (مزود + تسمية + مفتاح) مع رفض التكرار.
 * - قائمة المفاتيح مُقنَّعة دائمًا مع شارة حالة ملونة وعدّادات وآخر خطأ وأزرار تعطيل/تنشيط/حذف.
 * - نص توضيحي ثابت أعلى القائمة يشرح التجربة التسلسلية والتبديل الفوري.
 */
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/hooks/use-toast";
import { PROVIDER_LABELS, type PublicKeyView } from "./types";

function statusBadge(status: string) {
  if (status === "active") return <Badge className="bg-emerald-100 text-emerald-800 border border-emerald-300 hover:bg-emerald-100">نشط</Badge>;
  if (status === "exhausted") return <Badge className="bg-amber-100 text-amber-800 border border-amber-300 hover:bg-amber-100">مستنزف</Badge>;
  return <Badge className="bg-neutral-100 text-neutral-600 border border-neutral-300 hover:bg-neutral-100">معطّل</Badge>;
}

export function KeysCard({ onChanged }: { onChanged?: () => void }) {
  const [keys, setKeys] = useState<PublicKeyView[]>([]);
  const [provider, setProvider] = useState("kie");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/keys", { cache: "no-store" });
      const data = (await res.json()) as { keys: PublicKeyView[] };
      setKeys(data.keys ?? []);
    } catch {
      /* تحميل صامت */
    }
  }, []);

  useEffect(() => {
    // التحميل الأول مؤجَّل بدقيقة كي لا يكون تحديث حالة متزامنًا داخل effect
    const t0 = setTimeout(load, 0);
    return () => clearTimeout(t0);
  }, [load]);

  const addKey = async () => {
    if (!apiKey.trim()) {
      toast({ title: "أدخل المفتاح أولًا", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey.trim(), label: label.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: data.error ?? "تعذرت إضافة المفتاح", variant: "destructive" });
      } else {
        toast({ title: "أُضيف المفتاح — سيُجرَّب أولًا لأنه آخر مفتاح أُضيف" });
        setApiKey("");
        setLabel("");
        await load();
        onChanged?.();
      }
    } catch {
      toast({ title: "خطأ شبكة أثناء الإضافة", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (k: PublicKeyView) => {
    const next = k.status === "disabled" ? "active" : "disabled";
    const res = await fetch(`/api/keys/${k.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    if (res.ok) {
      toast({ title: next === "disabled" ? "عُطّل المفتاح" : "نُشّط المفتاح" });
      await load();
    } else {
      const d = await res.json().catch(() => ({}));
      toast({ title: d.error ?? "تعذر تنفيذ العملية", variant: "destructive" });
    }
  };

  const remove = async (k: PublicKeyView) => {
    const res = await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
    if (res.ok) {
      toast({ title: "حُذف المفتاح" });
      await load();
      onChanged?.();
    } else {
      const d = await res.json().catch(() => ({}));
      toast({ title: d.error ?? "تعذر الحذف", variant: "destructive" });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>مدير المفاتيح</CardTitle>
        <CardDescription>
          أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي عند أي
          خطأ أو نفاد رصيد دون توقف.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* نموذج الإضافة */}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Select value={provider} onValueChange={setProvider}>
            <SelectTrigger className="sm:w-40">
              <SelectValue placeholder="المزود" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="kie">kie.ai</SelectItem>
              <SelectItem value="cometapi">CometAPI</SelectItem>
            </SelectContent>
          </Select>
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="تسمية اختيارية (مثل: حساب رئيسي)"
            className="sm:w-56"
          />
          <Input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="الصق مفتاح API هنا"
            type="password"
            className="flex-1 font-mono"
            dir="ltr"
          />
          <Button onClick={addKey} disabled={busy}>
            {busy ? "جارٍ الإضافة…" : "إضافة"}
          </Button>
        </div>

        {/* القائمة */}
        <div className="max-h-96 space-y-3 overflow-y-auto pl-1 [scrollbar-width:thin]">
          {keys.length === 0 && (
            <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
              لا مفاتيح بعد — أضف أول مفتاح لتبدأ التوليد.
            </p>
          )}
          {keys.map((k, i) => (
            <div key={k.id} className="rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500">#{i + 1}</span>
                <span className="text-sm font-semibold">{PROVIDER_LABELS[k.provider] ?? k.provider}</span>
                {k.label && <span className="text-sm text-muted-foreground">— {k.label}</span>}
                {statusBadge(k.status)}
                <code className="mr-auto rounded bg-neutral-100 px-2 py-1 font-mono text-xs" dir="ltr">
                  {k.maskedKey}
                </code>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                <span>استخدام: {k.usageCount}</span>
                <span className="text-emerald-700">نجاح: {k.successCount}</span>
                <span className="text-red-700">فشل: {k.failCount}</span>
                <span>آخر استخدام: {k.lastUsedAt ? k.lastUsedAt.slice(0, 16).replace("T", " ") : "—"}</span>
              </div>
              {k.lastError && (
                <p className="mt-1 truncate text-xs text-red-600" title={k.lastError}>
                  آخر خطأ: {k.lastError}
                </p>
              )}
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="outline" onClick={() => toggle(k)}>
                  {k.status === "disabled" ? "تنشيط" : "تعطيل"}
                </Button>
                <Button size="sm" variant="outline" className="text-red-700 hover:bg-red-50 hover:text-red-800" onClick={() => remove(k)}>
                  حذف
                </Button>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
