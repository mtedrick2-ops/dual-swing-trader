export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    const { messages, apiKey } = req.body || {};
    const key = apiKey || process.env.ANTHROPIC_API_KEY;

    if (!key) return res.status(400).json({ error: "No API key" });
    if (!messages) return res.status(400).json({ error: "No messages" });

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages,
      }),
    });

    const responseText = await response.text();
    
    if (!response.ok) {
      return res.status(response.status).json({ error: responseText });
    }

    // Parse and re-send to ensure clean JSON
    const parsed = JSON.parse(responseText);
    return res.status(200).json(parsed);
    
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
