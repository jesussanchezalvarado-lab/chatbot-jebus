// Serverless function (Vercel/Node). Lightweight, non-streaming call that
// looks at the latest exchange and extracts any new stable fact worth
// remembering about the user across sessions. Runs in the background in
// parallel with the main streamed chat reply — failures here are silent
// and never surface to the user (this feature is a nice-to-have, not core).

const MODEL = process.env.GEMINI_MODEL || "gemini-flash-lite-latest";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const REMEMBER_SYSTEM_PROMPT = `Analizas el último intercambio de una conversación entre una persona y su tutora de pensamiento crítico. Tu única tarea es detectar si en el ÚLTIMO mensaje de la persona (el más reciente con role "user") apareció algún dato nuevo y estable sobre ella: su nombre, carrera, tema de tesis o trabajo, o una preferencia de retroalimentación que haya expresado. No inventes nada. No repitas datos que ya aparecen en "Lo que ya sabes de esta persona". Si no hay nada nuevo y estable, responde con un arreglo vacío.

Responde ÚNICAMENTE con un arreglo JSON de strings, sin texto fuera de él. Ejemplo válido: ["Está escribiendo su seminario de grado sobre formación docente inicial"]. Ejemplo si no hay nada nuevo: []`;

function buildUserContext(memory) {
  const facts = Array.isArray(memory) ? memory.filter((item) => typeof item === "string" && item.trim()) : [];
  if (!facts.length) return "";
  return `Lo que ya sabes de esta persona, de conversaciones anteriores:\n- ${facts.join("\n- ")}`;
}

function clampString(value, maxChars) {
  const text = String(value ?? "").trim();
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function stripJsonCodeFence(text) {
  return String(text || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function extractJsonArray(text) {
  const trimmed = stripJsonCodeFence(text);
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    // fall through to bracket scanning below
  }
  const first = trimmed.indexOf("[");
  const last = trimmed.lastIndexOf("]");
  if (first === -1 || last === -1 || last <= first) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(first, last + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST" || !process.env.GEMINI_API_KEY) {
    res.status(200).json({ remember: [] });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  body = body || {};

  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const memory = Array.isArray(body.memory) ? body.memory : [];

  const geminiContents = rawMessages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-10)
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: clampString(m.content, 2000) }],
    }));

  if (!geminiContents.length) {
    res.status(200).json({ remember: [] });
    return;
  }

  const memoryContext = buildUserContext(memory);
  const system = memoryContext ? `${REMEMBER_SYSTEM_PROMPT}\n\n${memoryContext}` : REMEMBER_SYSTEM_PROMPT;

  try {
    const url = `${GEMINI_URL}?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: geminiContents,
        generationConfig: { maxOutputTokens: 250, temperature: 0.2, thinkingConfig: { thinkingBudget: 0 } },
      }),
    });

    if (!response.ok) {
      res.status(200).json({ remember: [] });
      return;
    }

    const data = await response.json().catch(() => null);
    const rawText = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    const parsed = extractJsonArray(rawText);
    const remember = Array.isArray(parsed)
      ? parsed.map((item) => clampString(item, 200)).filter(Boolean).slice(0, 5)
      : [];

    res.status(200).json({ remember });
  } catch {
    res.status(200).json({ remember: [] });
  }
};
