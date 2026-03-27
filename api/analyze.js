export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: "URL requerida" });
  }

  try {
    // 1. Obtener HTML del sitio
    const response = await fetch(url);
    const html = await response.text();

    // 2. Prompt optimizado
    const prompt = `
Analiza este sitio web basado en su HTML:

${html.substring(0, 8000)}

Responde SOLO con JSON válido:

{
"scores":{"seo":0-100,"mobile":0-100,"velocidad":0-100},
"resumen":"",
"posicionamiento":"",
"publico":{
"edad":"",
"perfil":"",
"geografia":"",
"intereses":"",
"intencion":"",
"dispositivo":""
},
"redes":[],
"seo_criterios":[],
"keywords":[],
"mejoras":[]
}
`;

    // 3. Llamada a Groq
    const groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.3
      })
    });

    const groqData = await groqResponse.json();

    const result = groqData.choices?.[0]?.message?.content || "";

    return res.status(200).json({ result });

  } catch (error) {
    return res.status(500).json({
      error: "Error en análisis",
      detail: error.message
    });
  }
}
