"use client";

/**
 * ج) ربط السيرفر:
 * - حقل الرابط المطلق <origin>/mcp بزر نسخ.
 * - ثلاثة تبويبات بصيغ JSON جاهزة للنسخ: ChatGPT/GPT Agents، Claude Desktop، Cursor/Windsurf/Cline.
 * - رقائق الأدوات الخمس مع وصف عربي سطر واحد.
 * - ملاحظة كهرمانية عن توقيت الفيديو وبث التقدم.
 */
import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/hooks/use-toast";

const TOOLS: Array<{ name: string; desc: string }> = [
  { name: "generate_image", desc: "توليد صورة من وصف نصي — تعيد الرابط أو task_id." },
  { name: "generate_video", desc: "توليد فيديو بصوت متزامن — يتابَع بـ get_task." },
  { name: "merge_videos", desc: "دمج مقاطع (urls أو task_ids) في فيديو واحد." },
  { name: "get_task", desc: "تتبع أي مهمة بمعرّفها كل ~10 ثوانٍ." },
  { name: "list_media", desc: "استرجاع الوسائط المخزنة سابقًا بروابطها." },
];

export function ConnectCard() {
  const [origin, setOrigin] = useState("");
  const [authRequired, setAuthRequired] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      // origin يُقرأ في المتصفح فقط — داخل تدفّق غير متزامن تجنبًا لتحديث متزامن داخل effect
      const o = window.location.origin;
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const d = await res.json();
        if (alive) {
          setOrigin(o);
          setAuthRequired(Boolean(d.authRequired));
        }
      } catch {
        if (alive) setOrigin(o);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const mcpUrl = `${origin}/mcp`;
  const authHeader = authRequired ? `,\n        "Authorization": "Bearer <MCP_ACCESS_TOKEN>"` : "";

  const chatgptJson = `{
  "mcpServers": {
    "media-generator": {
      "url": "${mcpUrl}"${authHeader}
    }
  }
}`;

  const claudeJson = `{
  "mcpServers": {
    "media-generator": {
      "type": "http",
      "url": "${mcpUrl}"${authHeader}
    }
  }
}`;

  const cursorJson = `{
  "mcpServers": {
    "media-generator": {
      "url": "${mcpUrl}"${authHeader}
    }
  }
}`;

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: `نُسخ ${what}` });
    } catch {
      toast({ title: "تعذر النسخ — انسخ يدويًا", variant: "destructive" });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>ربط السيرفر</CardTitle>
        <CardDescription>اربط أي عميل MCP بنقطة /mcp — انسخ الرابط أو صيغة الإعداد الجاهزة.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* الرابط المطلق */}
        <div className="flex gap-2">
          <Input value={mcpUrl} readOnly dir="ltr" className="flex-1 font-mono text-sm" />
          <Button variant="outline" onClick={() => copy(mcpUrl, "الرابط")}>
            نسخ
          </Button>
        </div>

        {/* تبويبات الصيغ */}
        <Tabs defaultValue="chatgpt" dir="rtl">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="chatgpt">ChatGPT / GPT Agents</TabsTrigger>
            <TabsTrigger value="claude">Claude Desktop</TabsTrigger>
            <TabsTrigger value="cursor">Cursor / Windsurf / Cline</TabsTrigger>
          </TabsList>
          <TabsContent value="chatgpt" className="space-y-2">
            <p className="text-sm text-muted-foreground">
              في ChatGPT: Settings → Connectors → Create → Custom MCP server وضع الرابط في «Server URL».
            </p>
            <pre className="max-h-60 overflow-auto rounded-lg bg-neutral-950 p-3 text-left font-mono text-xs text-neutral-100" dir="ltr">
              {chatgptJson}
            </pre>
            <Button size="sm" variant="outline" onClick={() => copy(chatgptJson, "صيغة ChatGPT")}>
              نسخ JSON
            </Button>
          </TabsContent>
          <TabsContent value="claude" className="space-y-2">
            <p className="text-sm text-muted-foreground">
              ضع الصيغة في ملف claude_desktop_config.json (النوع type: http للنقل الحديث).
            </p>
            <pre className="max-h-60 overflow-auto rounded-lg bg-neutral-950 p-3 text-left font-mono text-xs text-neutral-100" dir="ltr">
              {claudeJson}
            </pre>
            <Button size="sm" variant="outline" onClick={() => copy(claudeJson, "صيغة Claude")}>
              نسخ JSON
            </Button>
          </TabsContent>
          <TabsContent value="cursor" className="space-y-2">
            <p className="text-sm text-muted-foreground">ضع الصيغة في ملف mcp.json لدى Cursor / Windsurf / Cline.</p>
            <pre className="max-h-60 overflow-auto rounded-lg bg-neutral-950 p-3 text-left font-mono text-xs text-neutral-100" dir="ltr">
              {cursorJson}
            </pre>
            <Button size="sm" variant="outline" onClick={() => copy(cursorJson, "صيغة mcp.json")}>
              نسخ JSON
            </Button>
          </TabsContent>
        </Tabs>

        {/* رقائق الأدوات */}
        <div>
          <p className="mb-2 text-sm font-semibold">الأدوات الخمس المعروضة على العملاء</p>
          <div className="flex flex-wrap gap-2">
            {TOOLS.map((t) => (
              <Badge key={t.name} variant="outline" className="h-auto max-w-full whitespace-normal py-1 text-right">
                <span className="font-mono text-xs" dir="ltr">
                  {t.name}
                </span>
                <span className="mx-1 text-neutral-300">|</span>
                <span className="text-xs text-muted-foreground">{t.desc}</span>
              </Badge>
            ))}
          </div>
        </div>

        {/* الملاحظة الكهرمانية */}
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          ⚠️ الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابَع تلقائيًا بـ get_task كل 10 ثوانٍ — وعند اكتمال
          المهمة يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي (Progress notifications) حتى لا تنقطع
          العملية.
        </div>
      </CardContent>
    </Card>
  );
}
