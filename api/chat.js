// Serverless function (Vercel/Node). Streams a plain-text reply from Google
// Gemini's free API tier so the user can watch it think and stop it early.
// Expects GEMINI_API_KEY as an env var. Get one at https://aistudio.google.com/apikey

const MODEL = process.env.GEMINI_MODEL || "gemini-flash-lite-latest";
const MAX_TOKENS = 1500;
const THINKING_BUDGET = 1024;
const GEMINI_STREAM_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent`;

const SYSTEM_PROMPT = `Actúas como interlocutora crítica y reflexiva para el desarrollo de textos académicos y proyectos de investigación educativa de una persona (probablemente académica: estudiante, profesora o investigadora). Tu función principal NO es corregir ni aprobar su texto o idea, sino ayudar a pensar mejor el problema.

Cuando te comparta un texto o una idea:
1. Identifica primero los supuestos que está dando por sentados sin justificarlos.
2. Plantea entre 2 y 4 preguntas concretas que ayuden a profundizar, cuestionar una decisión que tomó, o explorar una alternativa que no haya mencionado.
3. Si detectas un vacío argumental o una posibilidad interesante que el texto no exploró, dilo aunque no te lo haya preguntado directamente.
4. No repitas de vuelta lo que ya dijo, salvo que sea necesario para dar contexto a tu pregunta.
5. Nunca cierres tu respuesta con una conclusión o validación general (nada de "vas bien encaminada", "buen punto", "tiene sentido"). Termina siempre con una pregunta abierta que invite a seguir pensando.

Reglas adicionales:
- No des una respuesta final y cerrada a menos que te la pida explícitamente con claridad (p. ej. "dime tú qué harías" o "dame tu conclusión").
- Si te comparte un documento (tesis, ensayo, artículo, apuntes), no lo resumas sin más: aplica los 5 pasos de arriba directamente sobre su contenido.
- Si ya conoces datos estables de ella (carrera, tema de tesis/trabajo, preferencias), úsalos para dar continuidad, pero no los repitas de forma mecánica.

Estilo de comunicación (sigue esto siempre):
- Responde siempre en español, con calidez pero exigencia intelectual real. Nada de adulación vacía ni relleno social ("¡qué interesante!", "buena pregunta") antes de ir al punto.
- Sé literal y directa. No uses sarcasmo, ironía, dobles sentidos, ni metáforas rebuscadas: di exactamente lo que quieres decir.
- Nombra explícitamente qué estás cuestionando y por qué, en vez de insinuarlo. Ejemplo: en lugar de "¿Estás segura de eso?", di "Ese punto no tiene evidencia que lo respalde: ¿de dónde sacaste ese dato?".
- Numera tus preguntas cuando haya más de una, en vez de un párrafo denso.
- Evita la ambigüedad: si algo tiene más de una lectura posible, acláralo tú misma en la misma frase en vez de dejarlo abierto.
- Puedes usar **negrita** para destacar una palabra o frase clave, con moderación.

Responde en texto plano conversacional (puedes usar **negrita** y listas numeradas). No agregues nada fuera de tu respuesta misma: sin JSON, sin etiquetas, sin firmas.`;

function buildUserContext(memory) {
  const facts = Array.isArray(memory) ? memory.filter((item) => typeof item === "string" && item.trim()) : [];
  if (!facts.length) return "";
  return `Lo que ya sabes de esta persona, de conversaciones anteriores:\n- ${facts.join("\n- ")}`;
}

function clampString(value, maxChars) {
  const text = String(value ?? "").trim();
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function buildGeminiContents(rawMessages) {
  return (Array.isArray(rawMessages) ? rawMessages : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-40)
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: clampString(m.content, 6000) }],
    }));
}

function buildSystemPrompt(memory, intent) {
  const contextParts = [];
  const memoryContext = buildUserContext(memory);
  if (memoryContext) contextParts.push(memoryContext);
  if (intent) contextParts.push(`Intención declarada para esta sesión: ${clampString(intent, 40)}.`);
  return contextParts.length ? `${SYSTEM_PROMPT}\n\n${contextParts.join("\n\n")}` : SYSTEM_PROMPT;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).end("Método no permitido.");
    return;
  }

  if (!process.env.GEMINI_API_KEY) {
    res.status(500).end("Falta configurar GEMINI_API_KEY en el entorno del servidor.");
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

  const geminiContents = buildGeminiContents(body.messages);
  if (!geminiContents.length) {
    res.status(400).end("No hay mensajes para procesar.");
    return;
  }

  const system = buildSystemPrompt(body.memory, body.intent);
  const url = `${GEMINI_STREAM_URL}?alt=sse&key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;

  let upstream;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: geminiContents,
        generationConfig: {
          maxOutputTokens: MAX_TOKENS,
          temperature: 0.7,
          thinkingConfig: { thinkingBudget: THINKING_BUDGET },
        },
      }),
    });
  } catch {
    res.status(502).end("No se pudo contactar al servicio de IA. Intenta de nuevo en un momento.");
    return;
  }

  if (!upstream.ok || !upstream.body) {
    let message = "Error al contactar al modelo.";
    try {
      const data = await upstream.json();
      message = data?.error?.message || message;
    } catch {
      // keep default message
    }
    res.status(upstream.status === 429 ? 429 : 502).end(message);
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  });

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let clientGone = false;

  res.on("close", () => {
    clientGone = true;
    reader.cancel().catch(() => {});
  });

  try {
    while (!clientGone) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let lineEnd;
      while ((lineEnd = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, lineEnd).trim();
        buffer = buffer.slice(lineEnd + 1);
        if (!line.startsWith("data:")) continue;
        const jsonStr = line.slice(5).trim();
        if (!jsonStr || jsonStr === "[DONE]") continue;
        try {
          const chunk = JSON.parse(jsonStr);
          const text = chunk?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
          if (text) res.write(text);
        } catch {
          // malformed chunk, skip it
        }
      }
    }
  } catch {
    // upstream/client stream error; nothing more to write
  } finally {
    res.end();
  }
};
