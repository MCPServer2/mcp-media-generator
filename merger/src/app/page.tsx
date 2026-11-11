/** صفحة حالة بسيطة — الخدمة واجهة API بلا واجهة إدارية */
const limits = [
  ["أقصى عدد مقاطع", "10"],
  ["حجم المصدر", "200MB لكل مقطع"],
  ["حجم الناتج", "150MB"],
  ["مجموع المدد", "600 ثانية"],
  ["الاحتفاظ بالناتج", "24 ساعة ثم يُحذف"],
  ["صيغة المخرج", "MP4 — H.264 + AAC، لوحة ≤1080p، CRF 18"],
];

export default function Home() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "48px 24px" }}>
      <h1 style={{ fontSize: 28, fontWeight: 700 }}>🎬 خدمة دمج الفيديو — v2</h1>
      <p style={{ color: "#94a3b8", marginTop: 8 }}>
        واجهة API بلا مفاتيح ولا توثيق. تُستدعى من تطبيق MCP Media Generator فقط.
      </p>

      <section style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600 }}>المسارات</h2>
        <ul style={{ lineHeight: 2, color: "#cbd5e1" }}>
          <li><code>GET /api/config</code> — الجهوزية والقيود</li>
          <li><code>POST /api/jobs</code> — إنشاء وظيفة دمج (body: {"{ videos: [...] }"})</li>
          <li><code>POST /api/jobs/{"{id}"}/process</code> — تنفيذ المعالجة (blocking)</li>
          <li><code>GET /api/jobs/{"{id}"}</code> — حالة الوظيفة والتقدم</li>
          <li><code>GET /api/jobs/{"{id}"}/video</code> — الناتج MP4</li>
          <li><code>DELETE /api/jobs/{"{id}"}</code> — حذف نهائي فوري</li>
          <li><code>GET /api/health</code> — فحص صحة</li>
          <li><code>GET /api/cron/cleanup</code> — تنظيف المنتهية (&gt;24 ساعة)</li>
        </ul>
      </section>

      <section style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600 }}>القيود</h2>
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 8 }}>
          <tbody>
            {limits.map(([k, v]) => (
              <tr key={k} style={{ borderTop: "1px solid #1e293b" }}>
                <td style={{ padding: "8px 0", color: "#94a3b8" }}>{k}</td>
                <td style={{ padding: "8px 0", fontWeight: 600 }}>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
