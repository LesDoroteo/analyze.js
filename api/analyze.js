export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: "URL requerida" });
  }

  try {
    const prompt = `
Analiza este sitio web: ${url}

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

    const groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "user", content: prompt }
        ]
      })
    });

    const data = await groqResponse.json();

    // 👇 DEBUG CLAVE
    console.log("GROQ:", data);

    if (!data.choices) {
      return res.status(500).json({
        error: "Groq error",
        detail: data
      });
    }

    const result = data.choices[0].message.content;

    return res.status(200).json({ result });

  } catch (error) {
    return res.status(500).json({
      error: "Error en análisis",
      detail: error.message
    });
  }
}
