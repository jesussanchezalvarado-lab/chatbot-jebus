// Serverless function (Vercel/Node). Extracts plain text from an uploaded
// PDF or Word (.docx) file so it can be used as chat context.

const MAX_TEXT_CHARS = 18000;

function clampText(text) {
  const trimmed = String(text || "").trim();
  if (trimmed.length <= MAX_TEXT_CHARS) return { text: trimmed, truncated: false };
  return { text: trimmed.slice(0, MAX_TEXT_CHARS), truncated: true };
}

function extensionOf(filename) {
  const match = /\.([a-z0-9]+)$/i.exec(String(filename || ""));
  return match ? match[1].toLowerCase() : "";
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método no permitido." });
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

  const filename = String(body.filename || "archivo");
  const base64 = String(body.base64 || "");
  const ext = extensionOf(filename);

  if (!base64) {
    res.status(400).json({ error: "No se recibió contenido de archivo." });
    return;
  }

  let buffer;
  try {
    buffer = Buffer.from(base64, "base64");
  } catch {
    res.status(400).json({ error: "El archivo no pudo decodificarse." });
    return;
  }

  const MAX_BYTES = 4 * 1024 * 1024;
  if (buffer.length > MAX_BYTES) {
    res.status(413).json({ error: "El archivo supera el límite de 4 MB. Prueba con uno más liviano." });
    return;
  }

  try {
    if (ext === "pdf") {
      const pdfParse = require("pdf-parse");
      const data = await pdfParse(buffer);
      const { text, truncated } = clampText(data.text);
      res.status(200).json({ filename, text, truncated, charCount: text.length });
      return;
    }

    if (ext === "docx") {
      const mammoth = require("mammoth");
      const result = await mammoth.extractRawText({ buffer });
      const { text, truncated } = clampText(result.value);
      res.status(200).json({ filename, text, truncated, charCount: text.length });
      return;
    }

    if (ext === "doc") {
      res.status(415).json({
        error: "El formato .doc (Word antiguo) no se puede leer directamente. Guarda el archivo como .docx o .pdf y vuelve a subirlo.",
      });
      return;
    }

    res.status(415).json({ error: `Formato .${ext || "desconocido"} no soportado. Usa PDF o Word (.docx).` });
  } catch (err) {
    res.status(500).json({ error: "No se pudo extraer el texto de ese archivo." });
  }
};
