// src/ws/connection.ts
import type { WebSocket, RawData } from "ws";
import {
  createSession,
  destroySession,
  getSession,
  getActivePage,
  createTab,
  setActiveTab,
  closeTab,
} from "../browser/sessions"; // ajusta la ruta si hace falta
import type { ClientMessage, ServerMessage } from "./types";

const FRAME_INTERVAL_MS = 100; // ~10 fps
const JPEG_QUALITY = 45; // menos peso que 60
const MAX_BUFFERED_BYTES = 512 * 1024; // si el socket tiene >512KB en cola, saltamos frames

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normaliza y valida una URL para usar en page.goto.
 */
function normalizeUrl(rawUrl: string): string {
  let url = rawUrl.trim();

  if (!url) {
    throw new Error("URL vacía");
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
  } catch {
    // ignoramos, intentamos corregir abajo
  }

  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }

  const parsed2 = new URL(url);
  if (!["http:", "https:"].includes(parsed2.protocol)) {
    throw new Error(`Protocolo no soportado: ${parsed2.protocol}`);
  }

  return parsed2.toString();
}

/**
 * Envía al cliente el estado de las pestañas de la sesión.
 */
async function sendTabsState(ws: WebSocket, sessionId: string) {
  const session = getSession(sessionId);
  if (!session) return;

  const tabs = await Promise.all(
    session.pages.map(async (page, index) => {
      let title = "Nueva pestaña";
      try {
        const t = await page.title();
        if (t && t.trim()) title = t;
      } catch {
        // ignoramos
      }

      return {
        index,
        url: page.url(),
        title,
      };
    })
  );

  const msg: ServerMessage = {
    type: "tabs_state",
    activeIndex: session.activeIndex,
    tabs,
  };

  ws.send(JSON.stringify(msg));
}

export async function handleConnection(ws: WebSocket) {
  console.log("Nueva conexión WebSocket");

  let sessionId: string | undefined;
  let closed = false;

  // Crear nueva sesión Playwright
  try {
    const session = await createSession();
    sessionId = session.sessionId;

    const message: ServerMessage = {
      type: "session_started",
      sessionId,
      // opcional: podés leerlo de page.viewportSize()
      viewport: { width: 1024, height: 576 },
    };
    ws.send(JSON.stringify(message));

    // Enviamos estado inicial de pestañas
    void sendTabsState(ws, sessionId);
  } catch (err) {
    console.error("Error creando sesión Playwright:", err);
    const errorMsg: ServerMessage = {
      type: "error",
      message: "No se pudo crear sesión de navegador",
    };
    ws.send(JSON.stringify(errorMsg));
    ws.close();
    return;
  }

  ws.on("close", async () => {
    console.log("WebSocket cerrado, destruyendo sesión", sessionId);
    closed = true;
    if (sessionId) {
      await destroySession(sessionId);
    }
  });

  // Mensajes entrantes desde el frontend
  ws.on("message", async (raw: RawData) => {
    let msg: ClientMessage;

    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch (err) {
      console.error("Mensaje inválido:", raw.toString());
      const errorMsg: ServerMessage = {
        type: "error",
        message: "Mensaje JSON inválido",
      };
      ws.send(JSON.stringify(errorMsg));
      return;
    }

    if (!sessionId) {
      const errorMsg: ServerMessage = {
        type: "error",
        message: "Sesión no inicializada",
      };
      ws.send(JSON.stringify(errorMsg));
      return;
    }

    const session = getSession(sessionId);
    if (!session) {
      const errorMsg: ServerMessage = {
        type: "error",
        message: "Sesión no encontrada",
      };
      ws.send(JSON.stringify(errorMsg));
      return;
    }

    try {
      switch (msg.type) {
        case "click": {
          const page = getActivePage(sessionId);
          if (!page) break;

          const viewport = page.viewportSize();
          if (!viewport) break;

          const absX = msg.x * viewport.width;
          const absY = msg.y * viewport.height;
          await page.mouse.click(absX, absY);
          break;
        }

        case "type": {
          const page = getActivePage(sessionId);
          if (!page) break;
          await page.keyboard.type(msg.text, { delay: 50 });
          break;
        }

        case "goto": {
          const page = getActivePage(sessionId);
          if (!page) break;

          try {
            const normalizedUrl = normalizeUrl(msg.url);
            console.log(`Navegando a: ${normalizedUrl} (original: ${msg.url})`);
            await page.goto(normalizedUrl, { waitUntil: "networkidle" });
          } catch (err) {
            console.error("Error normalizando/navegando a URL", msg.url, err);
            const errorMsg: ServerMessage = {
              type: "error",
              message: `No se pudo navegar a la URL "${msg.url}". Verificá que sea válida.`,
            };
            ws.send(JSON.stringify(errorMsg));
          }

          // Actualizamos título / URL de la pestaña
          await sendTabsState(ws, sessionId);
          break;
        }

        case "keydown": {
          const page = getActivePage(sessionId);
          if (!page) break;
          await page.keyboard.down(msg.key);
          break;
        }

        case "keyup": {
          const page = getActivePage(sessionId);
          if (!page) break;
          await page.keyboard.up(msg.key);
          break;
        }

        // 👇 Nuevo: scroll con rueda
        case "scroll": {
          const page = getActivePage(sessionId);
          if (!page) break;
          await page.mouse.wheel(msg.deltaX, msg.deltaY);
          break;
        }

        // 👇 Nuevo: pestañas
        case "new_tab": {
          const url = msg.url ? normalizeUrl(msg.url) : undefined;
          await createTab(sessionId, url);
          await sendTabsState(ws, sessionId);
          break;
        }

        case "switch_tab": {
          setActiveTab(sessionId, msg.index);
          await sendTabsState(ws, sessionId);
          break;
        }

        case "close_tab": {
          await closeTab(sessionId, msg.index);
          if (getSession(sessionId)) {
            await sendTabsState(ws, sessionId);
          }
          break;
        }

        default: {
          console.log("Tipo de mensaje no soportado:", (msg as any).type);
        }
      }
    } catch (err) {
      console.error("Error manejando mensaje", msg, err);
      const errorMsg: ServerMessage = {
        type: "error",
        message: `Error ejecutando acción: ${String(err)}`,
      };
      ws.send(JSON.stringify(errorMsg));
    }
  });

  // Loop de streaming de screenshots (BINARIO)
  (async () => {
    if (!sessionId) return;

    while (!closed) {
      if (!sessionId) break;

      const page = getActivePage(sessionId);
      if (!page) break;

      try {
        if (page.isClosed()) {
          throw new Error(
            "La página está cerrada, no se puede tomar screenshot"
          );
        }

        if (closed) break;

        // Backpressure: si WebSocket tiene muchos bytes en cola, saltamos frames
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
          await sleep(50);
          continue;
        }

        const buffer = await page.screenshot({
          type: "jpeg",
          quality: JPEG_QUALITY,
          fullPage: false,
        });

        // 💥 Enviamos el Buffer binario, sin JSON ni base64
        ws.send(buffer);

        await sleep(FRAME_INTERVAL_MS);
      } catch (err) {
        console.error("Error creando/enviando frame:", err);
        const errorMsg: ServerMessage = {
          type: "error",
          message:
            "No se pudo generar screenshot de la página actual. Es posible que la pestaña se haya cerrado o la URL sea inválida.",
        };
        try {
          ws.send(JSON.stringify(errorMsg));
        } catch {
          // ignoramos si el socket ya murió
        }
        break;
      }
    }
  })();
}
