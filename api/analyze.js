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

      const title     = (html.match(/<title[^>]*>([^<]{1,200})<\/title>/i)||[])[1]?.trim()||"";
      const metaDesc  = (html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']{1,500})["']/i)||
                         html.match(/<meta[^>]*content=["']([^"']{1,500})["'][^>]*name=["']description["']/i)||[])[1]?.trim()||"";
      const metaKw    = (html.match(/<meta[^>]*name=["']keywords["'][^>]*content=["']([^"']{1,300})["']/i)||[])[1]?.trim()||"";
      const canonical = (html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)||[])[1]?.trim()||"";
      const viewport  = /<meta[^>]*name=["']viewport["']/i.test(html);
      const hasSchema = /application\/ld\+json/i.test(html);

      const h1s = [...html.matchAll(/<h1[^>]*>([^<]{1,200})<\/h1>/gi)].map(m=>m[1].replace(/<[^>]+>/g,"").trim()).filter(Boolean);
      const h2s = [...html.matchAll(/<h2[^>]*>([^<]{1,200})<\/h2>/gi)].map(m=>m[1].replace(/<[^>]+>/g,"").trim()).filter(Boolean);
      const h3s = [...html.matchAll(/<h3[^>]*>([^<]{1,200})<\/h3>/gi)].map(m=>m[1].replace(/<[^>]+>/g,"").trim()).filter(Boolean);

      const totalImgs = (html.match(/<img[^>]*>/gi)||[]).length;
      const imgsNoAlt = (html.match(/<img(?![^>]*\balt=["'][^"']+["'])[^>]*>/gi)||[]).length;
      const scripts   = (html.match(/<script[^>]+src=["'][^"']+["']/gi)||[]).length;
      const styles    = (html.match(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi)||[]).length;
      const htmlSize  = Math.round(html.length / 1024);

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
      // PASO 2: Extracción de redes sociales desde el HTML
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
        const matches = [...html.matchAll(pattern)].map(m => m[1]).filter(u =>
          u.startsWith("http") && !u.includes("javascript:") && !u.includes("${")
        );
        const unique = [...new Set(matches)];
        if (unique.length > 0) foundLinks[network] = unique[0];
      }

      // ─────────────────────────────────────────────────────
      // PASO 3: Verificar cada red social encontrada
      // ─────────────────────────────────────────────────────
      const verifiedSocials = {};
      await Promise.allSettled(
        Object.entries(foundLinks).map(async ([network, socialUrl]) => {
          try {
            const r = await fetch(socialUrl, {
              method: "HEAD",
              signal: AbortSignal.timeout(4000),
              headers: { "User-Agent": "Mozilla/5.0 (compatible; AuditBot/1.0)" },
              redirect: "follow"
            });
            verifiedSocials[network] = {
              url: socialUrl,
              status: r.status,
              verified: [200, 301, 302, 403, 405].includes(r.status)
            };
          } catch(e) {
            verifiedSocials[network] = { url: socialUrl, status: null, verified: false };
          }
        })
      );

      const buildSocialData = (network) => {
        if (verifiedSocials[network]) {
          const d = verifiedSocials[network];
          return { encontrado: true, url: d.url, verificado: d.verified, httpStatus: d.status };
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
        totalImgs, imgsNoAlt, scripts, styles,
        hasRobots, hasSitemap,
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
    // PASO 4: Preparar estructura de redes desde scraping REAL
    // La nota de análisis la generará Groq en el Paso 5
    // ─────────────────────────────────────────────────────────
    const labelMap = {
      facebook: "Facebook", instagram: "Instagram", linkedin: "LinkedIn",
      tiktok: "TikTok", twitter: "Twitter/X", youtube: "YouTube",
      whatsapp: "WhatsApp", pinterest: "Pinterest"
    };

    // Construir resumen de redes para pasarlo al prompt de Groq
    const redesResumen = Object.entries(siteData.socials || {}).map(([key, val]) => {
      const nombre = labelMap[key] || key;
      if (val.encontrado && val.verificado) {
        return { red: nombre, estado: "activo",       url: val.url };
      } else if (val.encontrado && !val.verificado) {
        return { red: nombre, estado: "inactivo",     url: val.url };
      } else {
        return { red: nombre, estado: "no detectado", url: null };
      }
    });

    // ─────────────────────────────────────────────────────────
    // PASO 5: Prompt a Groq — solo para análisis SEO/contenido
    // Los nombres de campo son FIJOS con ejemplos explícitos
    // ─────────────────────────────────────────────────────────
    const prompt = `Eres un experto en SEO y marketing digital. Analiza los datos del sitio web ${url}.

REGLAS:
- Usa SOLO los datos proporcionados
- Puedes inferir con lógica basada en title, headings y estructura
- Si algo no se puede deducir, escribe "No detectado"
- NO inventes datos externos

=== DATOS EXTRAÍDOS DEL SITIO ===
${JSON.stringify(siteData, null, 2)}

=== REDES SOCIALES DETECTADAS POR SCRAPING ===
${JSON.stringify(redesResumen, null, 2)}

Para cada red en la lista anterior genera un análisis de presencia y recomendación de marketing:
- Si estado es "activo": analiza su probable posicionamiento, alcance o interacción estimada según el tipo de negocio. Ejemplo: "Perfil activo con buena presencia. Para un negocio de este tipo se recomienda publicar 4-5 veces por semana con contenido educativo."
- Si estado es "inactivo": indica que el enlace existe pero el perfil no responde y sugiere revisarlo.
- Si estado es "no detectado": indica que no tiene presencia en esa red y si sería recomendable crearla según el tipo de negocio.

=== INSTRUCCIÓN DE FORMATO ===
Responde ÚNICAMENTE con un objeto JSON válido puro. Sin markdown. Sin texto adicional. Sin bloques de código.
USA EXACTAMENTE estos nombres de campo (no uses sinónimos ni traducciones):

{
  "scores": {
    "seo": 65,
    "mobile": 70,
    "velocidad": 55
  },
  "analisis_basico": {
    "tipo_negocio": "Agencia de marketing digital",
    "nivel_seo": "medio",
    "claridad_mensaje": "alta",
    "madurez_digital": "media"
  },
  "resumen": "Descripción breve del sitio en 2 oraciones.",
  "posicionamiento": "Descripción de visibilidad y posicionamiento online.",
  "publico": {
    "edad": "25-45 años",
    "perfil": "Emprendedores y gerentes",
    "geografia": "Latinoamérica",
    "intereses": "Marketing, tecnología",
    "intencion": "Buscan agencia digital",
    "dispositivo": "Mobile 60%, Desktop 40%"
  },
  "seo_criterios": [
    { "criterio": "Título y meta descripción", "score": 75, "nota": "El título tiene 60 caracteres, adecuado." },
    { "criterio": "Estructura de encabezados", "score": 60, "nota": "Se detectaron 2 H1 y varios H2." },
    { "criterio": "Palabras clave principales", "score": 55, "nota": "Keywords detectadas en title pero no en meta." },
    { "criterio": "URLs amigables", "score": 80, "nota": "URL limpia y descriptiva." },
    { "criterio": "HTTPS / Seguridad", "score": 90, "nota": "El sitio usa HTTPS correctamente." },
    { "criterio": "Velocidad estimada", "score": 50, "nota": "HTML de 45KB con 8 scripts externos." }
  ],
  "keywords": ["marketing digital", "seo", "agencia", "publicidad", "google ads"],
  "redes": [
    { "nombre": "Facebook", "estado": "activo",       "nota": "Perfil activo. Buen canal para este tipo de negocio. Se recomienda publicar contenido de valor 3-4 veces por semana para mejorar el alcance orgánico." },
    { "nombre": "Instagram", "estado": "activo",      "nota": "Presencia detectada. Ideal para mostrar casos de éxito y contenido visual. Aumentar frecuencia a 5 posts semanales con reels para mayor alcance." },
    { "nombre": "LinkedIn",  "estado": "no detectado","nota": "No se detectó perfil en LinkedIn. Para una agencia B2B es una red clave. Se recomienda crear presencia y publicar contenido profesional." },
    { "nombre": "TikTok",    "estado": "inactivo",    "nota": "Enlace encontrado pero perfil no accesible. Verificar si la cuenta está activa; TikTok tiene alto potencial de alcance orgánico para este sector." }
  ],
  "mejoras": [
    { "impacto": "alto", "texto": "Descripción de la mejora crítica." },
    { "impacto": "alto", "texto": "Otra mejora crítica." },
    { "impacto": "medio", "texto": "Mejora importante." },
    { "impacto": "medio", "texto": "Otra mejora importante." },
    { "impacto": "ok", "texto": "Punto positivo del sitio." },
    { "impacto": "ok", "texto": "Otro punto positivo." }
  ]
}

IMPORTANTE — NOMBRES DE CAMPO OBLIGATORIOS:
- En "seo_criterios": usa EXACTAMENTE "criterio", "score", "nota"
- En "mejoras": usa EXACTAMENTE "impacto", "texto"
- En "scores": usa EXACTAMENTE "seo", "mobile", "velocidad"
- En "analisis_basico": usa EXACTAMENTE "tipo_negocio", "nivel_seo", "claridad_mensaje", "madurez_digital"
- En "publico": usa EXACTAMENTE "edad", "perfil", "geografia", "intereses", "intencion", "dispositivo"
- En "redes": usa EXACTAMENTE "nombre", "estado", "nota" — genera UNA entrada por cada red de la lista de redes detectadas
- "nivel_seo", "claridad_mensaje", "madurez_digital" deben ser: "bajo", "medio" o "alto" / "baja", "media" o "alta"
- "impacto" debe ser exactamente: "alto", "medio" o "ok"
- "estado" en redes debe ser exactamente: "activo", "inactivo" o "no detectado"
NO uses otros nombres de campo. NO omitas ningún campo.`;

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

    const groqData = JSON.parse(text);
    const raw = groqData?.choices?.[0]?.message?.content || "";

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

    // ─────────────────────────────────────────────────────────
    // PASO 6: Normalización defensiva de campos críticos
    // Garantiza que seo_criterios y mejoras siempre tengan
    // los nombres correctos sin importar lo que devolvió Groq
    // ─────────────────────────────────────────────────────────

    // Normalizar seo_criterios
    if (Array.isArray(parsed.seo_criterios)) {
      parsed.seo_criterios = parsed.seo_criterios.map(item => ({
        criterio: item.criterio || item.name || item.label || item.factor || item.titulo || item.title || "—",
        score:    Number(item.score ?? item.value ?? item.puntuacion ?? item.puntaje ?? item.porcentaje ?? 50),
        nota:     item.nota || item.descripcion || item.observacion || item.detalle || item.description || "—"
      }));
    } else {
      parsed.seo_criterios = [];
    }

    // Normalizar mejoras
    if (Array.isArray(parsed.mejoras)) {
      parsed.mejoras = parsed.mejoras.map(item => ({
        impacto: item.impacto || item.prioridad || item.nivel || item.priority || item.impact || "medio",
        texto:   item.texto || item.descripcion || item.recomendacion || item.accion || item.mejora || item.description || item.text || "—"
      }));
    } else {
      parsed.mejoras = [];
    }

    // Normalizar scores
    if (parsed.scores) {
      parsed.scores = {
        seo:       Number(parsed.scores.seo       ?? parsed.scores.SEO       ?? 50),
        mobile:    Number(parsed.scores.mobile     ?? parsed.scores.movil     ?? parsed.scores.Mobile    ?? 50),
        velocidad: Number(parsed.scores.velocidad  ?? parsed.scores.speed     ?? parsed.scores.Velocidad ?? 50)
      };
    } else {
      parsed.scores = { seo: 50, mobile: 50, velocidad: 50 };
    }

    // Normalizar analisis_basico
    if (!parsed.analisis_basico || typeof parsed.analisis_basico !== "object") {
      parsed.analisis_basico = {};
    }

    // Normalizar publico
    if (!parsed.publico || typeof parsed.publico !== "object") {
      parsed.publico = {};
    }

    // ─────────────────────────────────────────────────────────
    // PASO 7: Normalizar redes generadas por Groq
    // Si Groq las devolvió bien, usarlas. Fallback desde scraping.
    // ─────────────────────────────────────────────────────────
    if (Array.isArray(parsed.redes) && parsed.redes.length > 0) {
      parsed.redes = parsed.redes.map(r => ({
        nombre: r.nombre || r.name || r.red || "—",
        estado: String(r.estado || r.status || "no detectado").toLowerCase(),
        nota:   r.nota   || r.descripcion || r.analysis || r.observacion || "—"
      }));
    } else {
      parsed.redes = redesResumen.map(r => ({
        nombre: r.red,
        estado: r.estado,
        nota: r.estado === "activo"
          ? "Perfil detectado en el sitio. Se recomienda mantener actividad regular y revisar métricas de engagement."
          : r.estado === "inactivo"
          ? "Enlace encontrado pero perfil no accesible. Verificar el estado de la cuenta."
          : "No se detectó presencia en esta red. Evaluar si es relevante para el negocio y considerar crear perfil."
      }));
    }

    // Metadata de transparencia
    parsed._meta = {
      scrapedAt:      new Date().toISOString(),
      responseTimeMs: siteData.responseTime,
      htmlSizeKB:     siteData.htmlSize,
      isHttps:        siteData.isHttps,
      socialsFound:   Object.entries(siteData.socials || {})
        .filter(([, v]) => v.encontrado)
        .map(([k, v]) => ({ red: k, url: v.url, verificado: v.verificado }))
    };

    return res.status(200).json({ parsed });

  } catch (error) {
    console.error("ERROR:", error);
    return res.status(500).json({ error: "Error interno", details: error.message });
  }
}
