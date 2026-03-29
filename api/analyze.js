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

    // ─────────────────────────────────────────────────────────
    // PASO 1: Scraping del HTML principal
    // ─────────────────────────────────────────────────────────
    let siteData = {};

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 9000);
      const t0 = Date.now();

      const fetchRes = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; AuditBot/1.0)",
          "Accept": "text/html,application/xhtml+xml"
        }
      });
      const responseTime = Date.now() - t0;
      clearTimeout(timer);

      const html = await fetchRes.text();
      const finalUrl = fetchRes.url;
      const base = new URL(finalUrl).origin;
      const isHttps = finalUrl.startsWith("https://");

      // ── Metadatos básicos ────────────────────────────────
      const title     = (html.match(/<title[^>]*>([^<]{1,200})<\/title>/i)||[])[1]?.trim()||"";
      const metaDesc  = (html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']{1,500})["']/i)||
                         html.match(/<meta[^>]*content=["']([^"']{1,500})["'][^>]*name=["']description["']/i)||[])[1]?.trim()||"";
      const metaKw    = (html.match(/<meta[^>]*name=["']keywords["'][^>]*content=["']([^"']{1,300})["']/i)||[])[1]?.trim()||"";
      const canonical = (html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)||[])[1]?.trim()||"";
      const viewport  = /<meta[^>]*name=["']viewport["']/i.test(html);
      const hasSchema = /application\/ld\+json/i.test(html);

      // ── Encabezados ──────────────────────────────────────
      const h1s = [...html.matchAll(/<h1[^>]*>([^<]{1,200})<\/h1>/gi)].map(m=>m[1].replace(/<[^>]+>/g,"").trim()).filter(Boolean);
      const h2s = [...html.matchAll(/<h2[^>]*>([^<]{1,200})<\/h2>/gi)].map(m=>m[1].replace(/<[^>]+>/g,"").trim()).filter(Boolean);
      const h3s = [...html.matchAll(/<h3[^>]*>([^<]{1,200})<\/h3>/gi)].map(m=>m[1].replace(/<[^>]+>/g,"").trim()).filter(Boolean);

      // ── Imágenes ─────────────────────────────────────────
      const totalImgs = (html.match(/<img[^>]*>/gi)||[]).length;
      const imgsNoAlt = (html.match(/<img(?![^>]*\balt=["'][^"']+["'])[^>]*>/gi)||[]).length;

      // ── Scripts / CSS ────────────────────────────────────
      const scripts  = (html.match(/<script[^>]+src=["'][^"']+["']/gi)||[]).length;
      const styles   = (html.match(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi)||[]).length;
      const htmlSize = Math.round(html.length / 1024);

      // ── Robots.txt y sitemap ─────────────────────────────
      let hasSitemap = /sitemap/i.test(html);
      let hasRobots  = false;
      try {
        const [rRes, sRes] = await Promise.allSettled([
          fetch(`${base}/robots.txt`,  { signal: AbortSignal.timeout(3000) }),
          fetch(`${base}/sitemap.xml`, { signal: AbortSignal.timeout(3000) })
        ]);
        hasRobots  = rRes.status === "fulfilled" && rRes.value.ok;
        hasSitemap = hasSitemap || (sRes.status === "fulfilled" && sRes.value.ok);
      } catch(_) {}

      // ─────────────────────────────────────────────────────
      // PASO 2: Extracción de links de redes sociales del HTML
      // Busca TODOS los href que contengan dominios de redes
      // ─────────────────────────────────────────────────────
      const socialPatterns = {
        facebook:  /href=["']([^"']*facebook\.com[^"']*)["']/gi,
        instagram: /href=["']([^"']*instagram\.com[^"']*)["']/gi,
        linkedin:  /href=["']([^"']*linkedin\.com[^"']*)["']/gi,
        tiktok:    /href=["']([^"']*tiktok\.com[^"']*)["']/gi,
        twitter:   /href=["']([^"']*(?:twitter|x)\.com[^"']*)["']/gi,
        youtube:   /href=["']([^"']*youtube\.com[^"']*)["']/gi,
        whatsapp:  /href=["']([^"']*(?:wa\.me|whatsapp\.com)[^"']*)["']/gi,
        pinterest: /href=["']([^"']*pinterest\.com[^"']*)["']/gi,
      };

      const foundLinks = {};
      for (const [network, pattern] of Object.entries(socialPatterns)) {
        const matches = [...html.matchAll(pattern)].map(m => m[1]).filter(u => {
          // Filtrar solo links válidos (no scripts, no variables JS)
          return u.startsWith("http") && !u.includes("javascript:") && !u.includes("${");
        });
        // Deduplicar
        const unique = [...new Set(matches)];
        if (unique.length > 0) foundLinks[network] = unique[0]; // tomar el primero/más relevante
      }

      // ─────────────────────────────────────────────────────
      // PASO 3: Verificar cada link de red social encontrado
      // Hace HEAD request para confirmar que la URL existe
      // ─────────────────────────────────────────────────────
      const verifiedSocials = {};

      await Promise.allSettled(
        Object.entries(foundLinks).map(async ([network, socialUrl]) => {
          try {
            const r = await fetch(socialUrl, {
              method: "HEAD",
              signal: AbortSignal.timeout(4000),
              headers: {
                "User-Agent": "Mozilla/5.0 (compatible; AuditBot/1.0)"
              },
              redirect: "follow"
            });
            // Considerar válido si responde 200, 301, 302, 403 (perfil privado) o 405
            const validStatuses = [200, 301, 302, 403, 405];
            verifiedSocials[network] = {
              url: socialUrl,
              status: r.status,
              verified: validStatuses.includes(r.status)
            };
          } catch(e) {
            verifiedSocials[network] = {
              url: socialUrl,
              status: null,
              verified: false,
              error: e.message
            };
          }
        })
      );

      // ─────────────────────────────────────────────────────
      // Construir objeto de redes con datos verificados
      // ─────────────────────────────────────────────────────
      const buildSocialData = (network) => {
        if (verifiedSocials[network]) {
          const d = verifiedSocials[network];
          return {
            encontrado: true,
            url: d.url,
            verificado: d.verified,
            httpStatus: d.status
          };
        }
        return { encontrado: false, url: null, verificado: false, httpStatus: null };
      };

      siteData = {
        url, isHttps, responseTime, htmlSize,
        title, titleLength: title.length,
        metaDesc, metaDescLength: metaDesc.length,
        metaKw, canonical, viewport, hasSchema,
        h1s: h1s.slice(0, 5), h1Count: h1s.length,
        h2s: h2s.slice(0, 6), h2Count: h2s.length,
        h3Count: h3s.length,
        totalImgs, imgsNoAlt,
        scripts, styles,
        hasRobots, hasSitemap,
        // Redes verificadas con URL real o no encontradas
        socials: {
          facebook:  buildSocialData("facebook"),
          instagram: buildSocialData("instagram"),
          linkedin:  buildSocialData("linkedin"),
          tiktok:    buildSocialData("tiktok"),
          twitter:   buildSocialData("twitter"),
          youtube:   buildSocialData("youtube"),
          whatsapp:  buildSocialData("whatsapp"),
          pinterest: buildSocialData("pinterest"),
        }
      };

    } catch (scrapeErr) {
      console.error("Scraping error:", scrapeErr.message);
      siteData = { url, scrapeError: scrapeErr.message };
    }

    // ─────────────────────────────────────────────────────────
    // PASO 4: Prompt a Groq con instrucción estricta de no inventar
    // ─────────────────────────────────────────────────────────
    const socialsJson = JSON.stringify(siteData.socials || {}, null, 2);

const prompt = `Eres un experto en SEO y marketing digital.

Analiza los datos REALES extraídos del sitio web ${url}.

REGLA CLAVE:
- Usa los datos proporcionados como base
- Puedes inferir información SOLO si está directamente relacionada con esos datos
- NO inventes datos externos
- Si algo no puede deducirse, indica "No detectado"

TIPOS DE RESPUESTA:

1. DATOS OBJETIVOS:
→ Usa exactamente lo detectado

2. ANÁLISIS (permitido):
→ Puedes inferir usando lógica basada en:
   - title
   - headings
   - estructura
   - dominio

→ Usa lenguaje como:
   "Probablemente"
   "Se sugiere que"
   "Podría estar orientado a"

INCLUYE ANÁLISIS BÁSICO:

- Tipo de negocio detectado
- Nivel de optimización SEO (bajo, medio, alto)
- Claridad del mensaje principal
- Nivel de madurez digital

PÚBLICO OBJETIVO:

- Inferir de contenido y estructura
- NO inventar datos demográficos exactos
- Sí estimar perfiles generales

MEJORAS:

- Basadas en datos reales detectados
- Complementadas con buenas prácticas SEO estándar

=== DATOS REALES EXTRAÍDOS ===
${JSON.stringify(siteData, null, 2)}

=== REDES SOCIALES VERIFICADAS ===
${JSON.stringify(siteData.socials || {}, null, 2)}

Responde ÚNICAMENTE con JSON válido puro, sin markdown, sin bloques de código:

{
  "scores": {...},
  "resumen": "...",
  "posicionamiento": "...",
  "publico": {...},
  "redes": [...],
  "seo_criterios": [...],
  "keywords": [...],
  "mejoras": [...]
}
`;

    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 2000
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
      console.error("Parse error:", e.message, "Raw:", raw.slice(0, 400));
    }

    if (!parsed) {
      return res.status(500).json({
        error: "No se pudo parsear respuesta de Groq",
        raw: raw.slice(0, 500)
      });
    }

    // Adjuntar metadata de scraping para transparencia
    parsed._meta = {
      scrapedAt: new Date().toISOString(),
      responseTimeMs: siteData.responseTime,
      htmlSizeKB: siteData.htmlSize,
      isHttps: siteData.isHttps,
      socialsFound: Object.entries(siteData.socials || {})
        .filter(([, v]) => v.encontrado)
        .map(([k, v]) => ({ red: k, url: v.url, verificado: v.verificado }))
    };

    return res.status(200).json({ parsed });

  } catch (error) {
    console.error("ERROR:", error);
    return res.status(500).json({ error: "Error interno", details: error.message });
  }
}
