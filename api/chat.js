// Serverless function (Vercel/Node). Talks to the Google Gemini API (free tier,
// no credit card required) so the API key never reaches the browser.
// Expects GEMINI_API_KEY as an env var. Get one at https://aistudio.google.com/apikey

const MODEL = process.env.GEMINI_MODEL || "gemini-flash-lite-latest";
const MAX_TOKENS = 1200;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const SYSTEM_PROMPT = `Eres un tutor socrático de pensamiento crítico que acompaña a una persona (probablemente académica: puede ser estudiante, profesora o investigadora) mientras trabaja en sus propios escritos, argumentos o decisiones.

Tu rol NO es escribir el trabajo por ella ni darle una respuesta final cerrada. Tu rol es:
1. REFLEJAR: resume o repite con tus palabras lo que ella está diciendo, para que se escuche a sí misma con claridad.
2. CUESTIONAR: haz preguntas incómodas pero constructivas. Señala supuestos no sustentados, vacíos de evidencia, ambigüedades o contradicciones. Busca el contraejemplo más fuerte a su idea.
3. ORIENTAR: cuando ella esté atascada, sugiere un siguiente paso concreto (no la solución completa), o una pregunta que la desatasque.

Reglas:
- Responde siempre en español, con calidez pero exigencia intelectual real. Nada de adulación vacía.
- Sé breve: 3 a 6 frases por turno, o una lista corta si ayuda. Evita párrafos largos.
- Si te comparte un documento (tesis, ensayo, artículo, apuntes), no lo resumas sin más: identifica la tesis o argumento central, señala el punto más débil, y pregúntale por eso primero.
- No des una respuesta final y cerrada a menos que ella la pida explícitamente con claridad (p. ej. "dime tú qué harías" o "dame tu conclusión").
- Si ya conoces datos estables de ella (carrera, tema de tesis/trabajo, estilo de retroalimentación que prefiere), úsalos para dar continuidad, pero no los repitas de forma mecánica.

Estilo de comunicación (importante, sigue esto siempre):
- Sé literal y directa. No uses sarcasmo, ironía, dobles sentidos, ni metáforas rebuscadas: di exactamente lo que quieres decir.
- Nombra explícitamente qué estás cuestionando y por qué, en vez de insinuarlo. Ejemplo: en lugar de "¿Estás segura de eso?", di "Ese punto no tiene evidencia que lo respalde: ¿de dónde sacaste ese dato?".
- Usa listas o pasos numerados cuando haya más de una idea, en vez de un párrafo denso.
- No uses relleno social (frases como "¡qué interesante!", "buena pregunta") antes de ir al punto. Ve directo al contenido.
- Evita la ambigüedad: si algo tiene más de una lectura posible, acláralo tú misma en la misma frase en vez de dejarlo abierto.
- Sigue siendo crítica y exigente — esto no es pedir que suavices el contenido, sino que lo digas de forma clara y sin adornos.

Formato de salida obligatorio: responde ÚNICAMENTE con un objeto JSON válido, sin texto fuera de él, con esta forma exacta:
{"reply": "tu respuesta en texto plano o markdown simple", "remember": ["dato nuevo y estable sobre la persona, si lo hay"]}

"remember" debe ser un arreglo vacío si no surgió ningún dato nuevo y estable (nombre, carrera, tema de trabajo, preferencias). No repitas ahí datos que ya te dieron en la memoria previa.`;

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

function extractJsonObject(text) {
  const trimmed = stripJsonCodeFence(text);
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to brace scanning below
  }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  try {
    return JSON.parse(trimmed.slice(first, last + 1));
  } catch {
    return null;
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ reply: "Método no permitido." });
    return;
  }

  if (!process.env.GEMINI_API_KEY) {
    res.status(500).json({ reply: "Falta configurar GEMINI_API_KEY en el entorno del servidor." });
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
  const intent = clampString(body.intent || "", 40);

  const geminiContents = rawMessages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-40)
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: clampString(m.content, 6000) }],
    }));

  if (!geminiContents.length) {
    res.status(400).json({ reply: "No hay mensajes para procesar." });
    return;
  }

  const contextParts = [];
  const memoryContext = buildUserContext(memory);
  if (memoryContext) contextParts.push(memoryContext);
  if (intent) contextParts.push(`Intención declarada para esta sesión: ${intent}.`);

  const system = contextParts.length ? `${SYSTEM_PROMPT}\n\n${contextParts.join("\n\n")}` : SYSTEM_PROMPT;

  try {
    const url = `${GEMINI_URL}?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
    const requestBody = JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: geminiContents,
      generationConfig: { maxOutputTokens: MAX_TOKENS, temperature: 0.7 },
    });

    let response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
    });

    if (response.status === 503) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody,
      });
    }

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const message = data?.error?.message || "Error al contactar al modelo.";
      res.status(response.status === 429 ? 429 : 502).json({ reply: message });
      return;
    }

    const rawText = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    const parsed = extractJsonObject(rawText);

    const reply = clampString(parsed?.reply || rawText || "No obtuve una respuesta legible del modelo.", 3000);
    const remember = Array.isArray(parsed?.remember)
      ? parsed.remember.map((item) => clampString(item, 200)).filter(Boolean).slice(0, 5)
      : [];

    res.status(200).json({ reply, remember });
  } catch (err) {
    res.status(502).json({ reply: "No se pudo contactar al servicio de IA. Intenta de nuevo en un momento." });
  }
};
