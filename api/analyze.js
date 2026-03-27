export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: "URL requerida" });
    }

    console.log("URL recibida:", url);

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama3-70b-8192",
        messages: [
          {
            role: "user",
            content: `Analiza esta web: ${url} y devuelve un JSON válido con diagnóstico SEO`
          }
        ],
        temperature: 0.3
      })
    });

    // 🔥 LOG CRÍTICO
    const rawText = await response.text();
    console.log("Groq RAW:", rawText);

    if (!response.ok) {
      return res.status(500).json({
        error: "Error en Groq",
        details: rawText
      });
    }

    const data = JSON.parse(rawText);

    const result = data?.choices?.[0]?.message?.content;

    if (!result) {
      return res.status(500).json({
        error: "Respuesta vacía de Groq",
        data
      });
    }

    return res.status(200).json({ result });

  } catch (error) {
    console.error("ERROR BACKEND:", error);

    return res.status(500).json({
      error: "Error interno",
      details: error.message
    });
  }
}
