"use client";

/**
 * لوحة الإدارة — صفحة واحدة بثلاث بطاقات:
 * أ) مدير المفاتيح  ب) لوحة المهام  ج) ربط السيرفر
 * الهيدر يعرض حالة /api/health حيًا.
 */
import { useState } from "react";
import { KeysCard } from "@/components/dashboard/KeysCard";
import { TasksCard } from "@/components/dashboard/TasksCard";
import { ConnectCard } from "@/components/dashboard/ConnectCard";
import { HealthBadge } from "@/components/dashboard/HealthBadge";

export default function Dashboard() {
  const [refreshSignal, setRefreshSignal] = useState(0);
  // إضافة/حذف مفتاح يستدعي تحديث فوري للوحة المهام أيضًا (الإشارة فقط)
  const handleKeysChanged = () => setRefreshSignal((s) => s + 1);

  return (
    <div className="mx-auto min-h-screen w-full max-w-5xl px-4 pb-12">
      {/* الهيدر */}
      <header className="sticky top-0 z-10 -mx-4 mb-6 border-b bg-background/95 px-4 py-4 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-extrabold sm:text-2xl">
              MCP Media Generator
              <span className="mr-2 text-sm font-normal text-muted-foreground">لوحة الإدارة</span>
            </h1>
            <p className="text-sm text-muted-foreground">
              توليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع — عبر خادم MCP واحد
            </p>
          </div>
          <HealthBadge />
        </div>
      </header>

      <main className="space-y-6">
        <KeysCard onChanged={handleKeysChanged} />
        <TasksCard refreshSignal={refreshSignal} />
        <ConnectCard />
      </main>

      <footer className="mt-10 text-center text-xs text-muted-foreground">
        روابط فقط — لا تُخزَّن أي وسائط على السيرفر · مفاتيحك مُقنَّعة دائمًا · التبديل بين المفاتيح تسلسلي تلقائي
      </footer>
    </div>
  );
}
