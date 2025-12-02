// src/routes/linkedin.routes.ts
import { Router } from "express";
import { getActivePage } from "../browser/sessions";
import {
  loginWithLiAt,
  checkProfileConnection,
  sendConnectionRequest,
  sendMessageToProfile,
  fetchMessagingThreadStub,
} from "../linkedin/linkedin.service";

const router = Router();

/**
 * Helper para obtener la Page a partir del sessionId que manda el frontend.
 */
function requirePageOrThrow(sessionId: string) {
  const page = getActivePage(sessionId);
  if (!page) {
    const err = new Error(
      `Sesión ${sessionId} no encontrada o sin pestaña activa`
    );
    (err as any).statusCode = 404;
    throw err;
  }
  return page;
}

/**
 * POST /api/v1/linkedin/session/:sessionId/login-cookie
 * Body: { li_at: string }
 *
 * - Inyecta la cookie li_at en el contexto de Playwright
 * - Navega al feed (logueado) para validar
 */
router.post("/session/:sessionId/login-cookie", async (req, res) => {
  const { sessionId } = req.params;
  const { li_at } = req.body as { li_at?: string };

  if (!li_at) {
    return res.status(400).json({ error: "li_at es requerido" });
  }

  try {
    const page = requirePageOrThrow(sessionId);
    await loginWithLiAt(page, li_at);

    return res.json({
      ok: true,
      sessionId,
      message: "Login con li_at aplicado y feed cargado.",
    });
  } catch (err: any) {
    const status = err?.statusCode ?? 500;
    return res.status(status).json({
      error: "No se pudo aplicar li_at / iniciar sesión en LinkedIn.",
      detail: String(err),
    });
  }
});

/**
 * POST /api/v1/linkedin/session/:sessionId/profile/check-connection
 * Body: { profileUrl: string }
 *
 * - Navega al perfil
 * - Espera (5 + 10 segundos)
 * - Saca screenshot
 * - Devuelve análisis (isConnection, isHumanRequired, isLoggedIn, blockType) + trace básico
 */
router.post(
  "/session/:sessionId/profile/check-connection",
  async (req, res) => {
    const { sessionId } = req.params;
    const { profileUrl } = req.body as { profileUrl?: string };

    if (!profileUrl) {
      return res.status(400).json({ error: "profileUrl es requerido" });
    }

    try {
      const page = requirePageOrThrow(sessionId);

      const { trace, analysis } = await checkProfileConnection(
        page,
        profileUrl
      );

      return res.json({
        ok: true,
        sessionId,
        profileUrl,
        analysis,
        trace,
      });
    } catch (err: any) {
      const status = err?.statusCode ?? 500;
      return res.status(status).json({
        error: "Error analizando el perfil de LinkedIn.",
        detail: String(err),
      });
    }
  }
);

/**
 * POST /api/v1/linkedin/session/:sessionId/profile/connect
 * Body: { profileUrl: string, note?: string }
 *
 * - Chequea si es conexión / login / bloqueos
 * - Si no lo es, envía request de conexión (con nota opcional)
 * - Devuelve trace + estado final
 */
router.post("/session/:sessionId/profile/connect", async (req, res) => {
  const { sessionId } = req.params;
  const { profileUrl, note } = req.body as {
    profileUrl?: string;
    note?: string;
  };

  if (!profileUrl) {
    return res.status(400).json({ error: "profileUrl es requerido" });
  }

  try {
    const page = requirePageOrThrow(sessionId);

    const result = await sendConnectionRequest(page, profileUrl, note);

    // Bloqueos detectados por OpenAI
    if (result.status === "human_required") {
      return res.status(409).json({
        ok: false,
        sessionId,
        profileUrl,
        ...result,
      });
    }

    // No logueado: error 401 para que la UI solicite re-login
    if (result.status === "not_logged_in") {
      return res.status(401).json({
        ok: false,
        sessionId,
        profileUrl,
        ...result,
      });
    }

    // Resto de casos normales
    return res.json({
      ok:
        result.status === "invite_sent" ||
        result.status === "already_connected",
      sessionId,
      profileUrl,
      ...result,
    });
  } catch (err: any) {
    const status = err?.statusCode ?? 500;
    return res.status(status).json({
      error: "Error enviando request de conexión.",
      detail: String(err),
    });
  }
});

/**
 * POST /api/v1/linkedin/session/:sessionId/profile/message
 * Body: { profileUrl: string, message: string }
 *
 * - Solo funciona si el perfil ya es conexión y la sesión está logueada.
 * - Si no, devuelve status "not_connected" o "not_logged_in".
 */
router.post("/session/:sessionId/profile/message", async (req, res) => {
  const { sessionId } = req.params;
  const { profileUrl, message } = req.body as {
    profileUrl?: string;
    message?: string;
  };

  if (!profileUrl || !message) {
    return res
      .status(400)
      .json({ error: "profileUrl y message son requeridos" });
  }

  try {
    const page = requirePageOrThrow(sessionId);

    const result = await sendMessageToProfile(page, profileUrl, message);

    if (result.status === "human_required") {
      return res.status(409).json({
        ok: false,
        sessionId,
        profileUrl,
        ...result,
      });
    }

    if (result.status === "not_logged_in") {
      return res.status(401).json({
        ok: false,
        sessionId,
        profileUrl,
        ...result,
      });
    }

    return res.json({
      ok: result.status === "message_sent",
      sessionId,
      profileUrl,
      ...result,
    });
  } catch (err: any) {
    const status = err?.statusCode ?? 500;
    return res.status(status).json({
      error: "Error enviando mensaje en LinkedIn.",
      detail: String(err),
    });
  }
});

/**
 * GET /api/v1/linkedin/session/:sessionId/messaging/thread
 * Query: (por ahora sin filtros, stub)
 *
 * - Va a /messaging y devuelve un screenshot + análisis + nota.
 * - Después podés ampliar para buscar el thread por nombre, URL, etc.
 */
router.get("/session/:sessionId/messaging/thread", async (req, res) => {
  const { sessionId } = req.params;

  try {
    const page = requirePageOrThrow(sessionId);
    const result = await fetchMessagingThreadStub(page);

    return res.json({
      ok: true,
      sessionId,
      ...result,
    });
  } catch (err: any) {
    const status = err?.statusCode ?? 500;
    return res.status(status).json({
      error: "Error navegando a LinkedIn Messaging.",
      detail: String(err),
    });
  }
});

export default router;
