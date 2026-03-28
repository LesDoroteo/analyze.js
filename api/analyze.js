export default async function handler(req, res) {

  // Al inicio del handler, ANTES de cualquier lógica:
console.log("GROQ_API_KEY existe:", !!process.env.GROQ_API_KEY);
console.log("Body recibido:", req.body);
  
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { url } = req.body;

    // ─── Validaciones ────────────────────────────────────────────
    if (!url) return res.status(400).json({ error: "URL requerida" });
    if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: "GROQ_API_KEY no configurada" });

    // ─── Prompt completo con estructura JSON esperada ─────────────
    const prompt = `Eres un experto en SEO y marketing digital. Analiza el sitio web: ${url}

Basándote en tu conocimiento sobre este dominio y sitio web, genera un diagnóstico digital.

Responde ÚNICAMENTE con un objeto JSON válido, sin markdown, sin bloques de código, sin texto antes ni después. Solo el JSON puro:

{"scores":{"seo":62,"mobile":74,"velocidad":55},"resumen":"Descripción breve del sitio en 2 oraciones.","posicionamiento":"Descripción de visibilidad online y posicionamiento en buscadores.","publico":{"edad":"25-45 años","perfil":"Tipo de usuario principal","geografia":"Mercados principales","intereses":"Intereses y necesidades del público","intencion":"Qué buscan al llegar al sitio","dispositivo":"Desktop 60% / Mobile 40%"},"redes":[{"nombre":"Facebook","estado":"activo","nota":"Observación breve"},{"nombre":"Instagram","estado":"activo","nota":"Observación breve"},{"nombre":"LinkedIn","estado":"no detectado","nota":"Observación breve"},{"nombre":"TikTok","estado":"inactivo","nota":"Observación breve"}],"seo_criterios":[{"criterio":"Título y meta descripción","score":70,"nota":"Observación específica"},{"criterio":"Estructura de encabezados","score":65,"nota":"Observación específica"},{"criterio":"Palabras clave principales","score":60,"nota":"Observación específica"},{"criterio":"URLs amigables","score":80,"nota":"Observación específica"},{"criterio":"HTTPS / Seguridad","score":90,"nota":"Observación específica"},{"criterio":"Velocidad estimada","score":55,"nota":"Observación específica"}],"keywords":["keyword1","keyword2","keyword3","keyword4","keyword5","keyword6"],"mejoras":[{"impacto":"alto","texto":"Punto de mejora crítico 1"},{"impacto":"alto","texto":"Punto de mejora crítico 2"},{"impacto":"medio","texto":"Punto de mejora importante 1"},{"impacto":"medio","texto":"Punto de mejora importante 2"},{"impacto":"ok","texto":"Aspecto positivo 1"},{"impacto":"ok","texto":"Aspecto positivo 2"}]}

Reemplaza todos los valores de ejemplo con datos reales y específicos para el sitio ${url}.`;

    // ─── Llamada a Groq ───────────────────────────────────────────
    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 1500
      })
    });

    const text = await groqRes.text();

    if (!groqRes.ok) {
      console.error("Groq error:", text);
      return res.status(500).json({ error: "Error de Groq", details: text });
    }

    // ─── Parsear respuesta ────────────────────────────────────────
    const data = JSON.parse(text); // ahora sí parseamos el texto
    const raw = data?.choices?.[0]?.message?.content || "";

    let parsed = null;
    try {
      // Limpiar posibles bloques markdown ```json ... ```
      const clean = raw.replace(/```json|```/g, "").trim();
      const match = clean.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : null;
    } catch (e) {
      console.error("Parse error:", e.message);
      console.error("Raw content:", raw);
    }

    if (!parsed) {
      return res.status(500).json({
        error: "No se pudo parsear la respuesta de Groq",
        raw // devolvemos el raw para debug
      });
    }

    return res.status(200).json({ parsed });

  } catch (error) {
    console.error("ERROR:", error);
    return res.status(500).json({ error: "Error interno", details: error.message });
  }
}
