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

  try {

    return res.status(200).json({
    test: "backend funcionando"
    });
    
    console.log("KEY EXISTS:", !!process.env.GROQ_API_KEY);

    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: "URL requerida" });
    }

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
            content: `Devuelve SOLO JSON válido. Analiza: ${url}`
          }
        ],
        temperature: 0.3
      })
    });

    const text = await response.text();
    console.log("Groq:", text);

    if (!response.ok) {
      return res.status(500).json({
        error: "Groq error",
        details: text
      });
    }


    const raw = data?.choices?.[0]?.message?.content || "";

let parsed = null;

try {
  const match = raw.match(/\{[\s\S]*\}/);
  parsed = match ? JSON.parse(match[0]) : null;
} catch (e) {
  console.error("Parse error:", e);
}

return res.status(200).json({
  raw,
  parsed
});
  // const data = JSON.parse(text);

  //  return res.status(200).json({
  //    result: data?.choices?.[0]?.message?.content
  //  });

  } catch (error) {
    console.error("ERROR:", error);

    return res.status(500).json({
      error: "Error interno",
      details: error.message
    });
  }
}
