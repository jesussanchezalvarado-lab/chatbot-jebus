# Mi Tutor de Pensamiento Crítico

Chatbot personal que reflexiona contigo, te cuestiona y te orienta en tus trabajos. Permite subir PDF y Word, guarda tus conversaciones y va recordando datos sobre ti entre sesiones.

Es una carpeta independiente dentro de este repositorio (`chatbot/`); no toca el sitio de los Talleres de Análisis de Datos.

## Qué hace y qué no hace

- **Sí**: te hace preguntas, señala supuestos y puntos débiles, te ayuda a aterrizar ideas para tus trabajos, lee el contenido de un PDF o Word que subas, guarda tus conversaciones en el navegador y recuerda datos estables sobre ti (carrera, tema de tesis, preferencias).
- **No**: no te escribe el trabajo por ti, no reemplaza a tu profesor(a) o comité, no guarda tus conversaciones en un servidor (viven solo en tu navegador, en `localStorage`).

## Cómo funciona (arquitectura)

- `index.html` — interfaz. Guarda tus conversaciones y tu "memoria" en el `localStorage` de tu navegador (no hay base de datos ni login).
- `api/chat.js` — función serverless que llama a la API de Claude (Anthropic) con tu clave, para que esta nunca quede expuesta en el navegador.
- `api/upload.js` — función serverless que extrae el texto de un PDF o Word (.docx) que subas, para dárselo como contexto al modelo.

## Puesta en marcha (Vercel, recomendado)

1. Crea una cuenta gratuita en [vercel.com](https://vercel.com) si no tienes una.
2. Sube este repositorio a GitHub (ya lo está) y en Vercel elige "Import Project" desde ese repo.
3. En la configuración del proyecto, define el **Root Directory** como `chatbot`.
4. En "Environment Variables" agrega:
   - `ANTHROPIC_API_KEY`: tu clave de [console.anthropic.com](https://console.anthropic.com/settings/keys).
5. Despliega. Vercel instalará `pdf-parse` y `mammoth` automáticamente y publicará `index.html` junto con las funciones en `/api`.

## Uso local (opcional, para probar)

Necesitas la [CLI de Vercel](https://vercel.com/docs/cli) porque `index.html` llama a `/api/chat` y `/api/upload`, que solo funcionan como funciones serverless (no puedes simplemente abrir el HTML con doble clic):

```bash
cd chatbot
npm install
npx vercel dev
```

Te pedirá vincular el proyecto y configurar `ANTHROPIC_API_KEY` (puedes copiarla desde `.env.example` a `.env`).

## Límites conocidos

- Archivos de hasta ~4 MB (límite de las funciones serverless).
- Solo `.pdf` y `.docx`. El formato `.doc` antiguo no se puede leer: conviértelo a `.docx` o `.pdf` primero.
- Las conversaciones y la memoria viven en el navegador donde las uses. Si cambias de computador o borras el historial del navegador, se pierden. No hay sincronización entre dispositivos.
