export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "URL requerida" });
    if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: "GROQ_API_KEY no configurada" });

    // ─── PASO 1: Scraping real del sitio ─────────────────────────
    let siteData = {};
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      const t0 = Date.now();
      const fetchRes = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; AuditBot/1.0)",
          "Accept": "text/html,application/xhtml+xml"
        }
      });
      const responseTime = Date.now() - t0;
      clearTimeout(timeout);

      const html = await fetchRes.text();
      const finalUrl = fetchRes.url;
      const isHttps = finalUrl.startsWith("https://");

      // Metadatos
      const title      = (html.match(/<title[^>]*>([^<]*)<\/title>/i)||[])[1]?.trim()||"";
      const metaDesc   = (html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i)||
                          html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i)||[])[1]?.trim()||"";
      const metaKw     = (html.match(/<meta[^>]*name=["']keywords["'][^>]*content=["']([^"']*)["']/i)||[])[1]?.trim()||"";
      const canonical  = (html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)["']/i)||[])[1]?.trim()||"";
      const ogTitle    = (html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']*)["']/i)||[])[1]?.trim()||"";
      const viewport   = /<meta[^>]*name=["']viewport["']/i.test(html);
      const robotsMeta = (html.match(/<meta[^>]*name=["']robots["'][^>]*content=["']([^"']*)["']/i)||[])[1]?.trim()||"";

      // Encabezados
      const h1s = [...html.matchAll(/<h1[^>]*>([^<]*)<\/h1>/gi)].map(m=>m[1].trim()).filter(Boolean);
      const h2s = [...html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/gi)].map(m=>m[1].trim()).filter(Boolean);
      const h3s = [...html.matchAll(/<h3[^>]*>([^<]*)<\/h3>/gi)].map(m=>m[1].trim()).filter(Boolean);

      // Imágenes
      const totalImgs = (html.match(/<img[^>]*>/gi)||[]).length;
      const imgsNoAlt = (html.match(/<img(?![^>]*alt=["'][^"']+["'])[^>]*>/gi)||[]).length;

      // Links
      const domain        = new URL(url).hostname;
      const allLinks      = [...html.matchAll(/href=["']([^"'#?]+)["']/gi)].map(m=>m[1]);
      const internalLinks = allLinks.filter(l=>l.startsWith("/")||l.includes(domain)).length;
      const externalLinks = allLinks.filter(l=>l.startsWith("http")&&!l.includes(domain)).length;

      // Rendimiento
      const scripts   = (html.match(/<script[^>]*src=/gi)||[]).length;
      const styles    = (html.match(/<link[^>]*rel=["']stylesheet["']/gi)||[]).length;
      const htmlSize  = Math.round(html.length/1024);

      // Redes sociales
      const hasFacebook  = /facebook\.com/i.test(html);
      const hasInstagram = /instagram\.com/i.test(html);
      const hasLinkedIn  = /linkedin\.com/i.test(html);
      const hasTiktok    = /tiktok\.com/i.test(html);
      const hasWhatsapp  = /wa\.me|whatsapp\.com/i.test(html);
      const hasYoutube   = /youtube\.com/i.test(html);

      // Schema
      const hasSchema = /application\/ld\+json/i.test(html);

      // Robots.txt y sitemap
      let hasSitemap = /sitemap/i.test(html);
      let hasRobots  = false;
      try {
        const base = new URL(url).origin;
        const [rRes, sRes] = await Promise.all([
          fetch(`${base}/robots.txt`,  { signal: AbortSignal.timeout(3000) }),
          fetch(`${base}/sitemap.xml`, { signal: AbortSignal.timeout(3000) })
        ]);
        hasRobots  = rRes.ok;
        hasSitemap = hasSitemap || sRes.ok;
      } catch(_) {}

      siteData = {
        url, isHttps, responseTime, htmlSize,
        title, titleLength: title.length,
        metaDesc, metaDescLength: metaDesc.length,
        metaKw, canonical, ogTitle, viewport, robotsMeta,
        h1s, h1Count: h1s.length,
        h2s: h2s.slice(0,5), h2Count: h2s.length,
        h3Count: h3s.length,
        totalImgs, imgsNoAlt,
        internalLinks, externalLinks,
        scripts, styles,
        hasFacebook, hasInstagram, hasLinkedIn, hasTiktok, hasWhatsapp, hasYoutube,
        hasSchema, hasSitemap, hasRobots
      };

    } catch (scrapeErr) {
      console.error("Scraping error:", scrapeErr.message);
      siteData = { url, scrapeError: scrapeErr.message };
    }

    // ─── PASO 2: Groq analiza los datos reales ────────────────────
    const prompt = `Eres un experto en SEO y marketing digital. Analiza estos datos REALES extraídos del sitio ${url}:

${JSON.stringify(siteData, null, 2)}

Genera un diagnóstico basado ÚNICAMENTE en estos datos. Responde SOLO con JSON válido puro, sin markdown:

{"scores":{"seo":<0-100 basado en title/metaDesc/h1/robots/sitemap/canonical/schema>,"mobile":<0-100 basado en viewport=${siteData.viewport}>,"velocidad":<0-100 basado en responseTime=${siteData.responseTime}ms scripts=${siteData.scripts} htmlSize=${siteData.htmlSize}KB>},"resumen":"<describe el sitio usando el title real: '${siteData.title}' y los h1s reales>","posicionamiento":"<analiza visibilidad basándote en: canonical=${!!siteData.canonical}, schema=${siteData.hasSchema}, robots.txt=${siteData.hasRobots}, sitemap=${siteData.hasSitemap}>","publico":{"edad":"<infiere del contenido real>","perfil":"<infiere del tipo de sitio>","geografia":"<infiere del dominio ${new URL(url).hostname}>","intereses":"<infiere del title y h1s>","intencion":"<infiere del contenido>","dispositivo":"<${siteData.viewport?'Mobile optimizado':'Sin optimización mobile'}>"},"redes":[{"nombre":"Facebook","estado":"${siteData.hasFacebook?'activo':'no detectado'}","nota":"<observación real>"},{"nombre":"Instagram","estado":"${siteData.hasInstagram?'activo':'no detectado'}","nota":"<observación real>"},{"nombre":"LinkedIn","estado":"${siteData.hasLinkedIn?'activo':'no detectado'}","nota":"<observación real>"},{"nombre":"TikTok","estado":"${siteData.hasTiktok?'activo':'no detectado'}","nota":"<observación real>"}],"seo_criterios":[{"criterio":"Título y meta descripción","score":<basado en titleLength=${siteData.titleLength} metaDescLength=${siteData.metaDescLength}>,"nota":"Title: '${siteData.title?.slice(0,60)}' (${siteData.titleLength} chars). Meta desc: ${siteData.metaDescLength} chars."},{"criterio":"Estructura de encabezados","score":<basado en h1Count=${siteData.h1Count} h2Count=${siteData.h2Count}>,"nota":"${siteData.h1Count} H1(s): '${siteData.h1s?.slice(0,2).join(' / ')}'. ${siteData.h2Count} H2s."},{"criterio":"Imágenes optimizadas","score":<100 si imgsNoAlt=0, penaliza proporcionalmente>,"nota":"${siteData.imgsNoAlt} de ${siteData.totalImgs} imágenes sin atributo alt"},{"criterio":"URLs y canonical","score":<90 si canonical presente, 50 si no>,"nota":"${siteData.canonical?'Canonical configurado: '+siteData.canonical:'Sin etiqueta canonical'}"},{"criterio":"HTTPS / Seguridad","score":${siteData.isHttps?95:10},"nota":"${siteData.isHttps?'HTTPS activo y correcto':'Sin HTTPS - crítico para SEO y confianza'}"},{"criterio":"Velocidad de carga","score":<basado en responseTime=${siteData.responseTime}ms>,"nota":"Servidor respondió en ${siteData.responseTime}ms. ${siteData.scripts} scripts externos, ${siteData.styles} hojas CSS, HTML: ${siteData.htmlSize}KB"}],"keywords":[<extrae 6 keywords reales del title='${siteData.title}' metaKw='${siteData.metaKw}' h1s='${siteData.h1s?.join(", ")}'>],"mejoras":[{"impacto":"alto","texto":"<mejora crítica basada en dato real>"},{"impacto":"alto","texto":"<mejora crítica basada en dato real>"},{"impacto":"medio","texto":"<mejora importante con dato real>"},{"impacto":"medio","texto":"<mejora importante con dato real>"},{"impacto":"ok","texto":"<aspecto positivo real del sitio>"},{"impacto":"ok","texto":"<aspecto positivo real del sitio>"}]}`;

    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens: 1800
      })
    });

    const text = await groqRes.text();
    if (!groqRes.ok) {
      console.error("Groq error:", text);
      return res.status(500).json({ error: "Error de Groq", details: text });
    }

    const data = JSON.parse(text);
    const raw  = data?.choices?.[0]?.message?.content || "";

    let parsed = null;
    try {
      const clean = raw.replace(/```json|```/g, "").trim();
      const match = clean.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : null;
    } catch (e) {
      console.error("Parse error:", e.message);
    }

    if (!parsed) {
      return res.status(500).json({ error: "No se pudo parsear respuesta", raw: raw.slice(0, 500) });
    }

    parsed._meta = {
      scrapedAt: new Date().toISOString(),
      responseTimeMs: siteData.responseTime,
      htmlSizeKB: siteData.htmlSize,
      isHttps: siteData.isHttps
    };

    return res.status(200).json({ parsed });

  } catch (error) {
    console.error("ERROR:", error);
    return res.status(500).json({ error: "Error interno", details: error.message });
  }
}
