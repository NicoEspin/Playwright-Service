// src/routes/agent.routes.ts
import { Router } from "express";
import { runLinkedInAutonomousAgent } from "../agents/linkedinAgent";
import { getSession } from "../browser/sessions";

const router = Router();

/**
 * POST /api/v1/agent/linkedin/login
 * Body: { sessionId: string, email: string, password: string }
 * 
 * Ejecuta login autónomo en LinkedIn
 */
router.post("/linkedin/login", async (req, res) => {
  const { sessionId, email, password } = req.body;

  if (!sessionId || !email || !password) {
    return res.status(400).json({
      error: "sessionId, email y password son requeridos",
    });
  }

  const session = getSession(sessionId);
  if (!session) {
    return res.status(404).json({
      error: `Sesión ${sessionId} no encontrada`,
    });
  }

  try {
    const result = await runLinkedInAutonomousAgent({
      sessionId,
      task: "login",
      credentials: { email, password },
    });

    return res.json({
      ok: result.success,
      sessionId,
      message: result.text,
      steps: result.steps.length,
      toolCalls: result.toolCalls.map((tc) => tc.toolName),
    });
  } catch (error: any) {
    return res.status(500).json({
      error: "Error ejecutando login autónomo",
      detail: error.message,
    });
  }
});

/**
 * POST /api/v1/agent/linkedin/connect
 * Body: { sessionId: string, profileUrl: string, message?: string }
 * 
 * Envía solicitud de conexión de forma autónoma
 */
router.post("/linkedin/connect", async (req, res) => {
  const { sessionId, profileUrl, message } = req.body;

  if (!sessionId || !profileUrl) {
    return res.status(400).json({
      error: "sessionId y profileUrl son requeridos",
    });
  }

  const session = getSession(sessionId);
  if (!session) {
    return res.status(404).json({
      error: `Sesión ${sessionId} no encontrada`,
    });
  }

  try {
    const result = await runLinkedInAutonomousAgent({
      sessionId,
      task: "send_connection",
      profileUrl,
      message,
    });

    return res.json({
      ok: result.success,
      sessionId,
      profileUrl,
      message: result.text,
      steps: result.steps.length,
      toolCalls: result.toolCalls.map((tc) => tc.toolName),
    });
  } catch (error: any) {
    return res.status(500).json({
      error: "Error enviando conexión autónoma",
      detail: error.message,
    });
  }
});

/**
 * POST /api/v1/agent/linkedin/message
 * Body: { sessionId: string, profileUrl: string, message: string }
 * 
 * Envía mensaje de forma autónoma
 */
router.post("/linkedin/message", async (req, res) => {
  const { sessionId, profileUrl, message } = req.body;

  if (!sessionId || !profileUrl || !message) {
    return res.status(400).json({
      error: "sessionId, profileUrl y message son requeridos",
    });
  }

  const session = getSession(sessionId);
  if (!session) {
    return res.status(404).json({
      error: `Sesión ${sessionId} no encontrada`,
    });
  }

  try {
    const result = await runLinkedInAutonomousAgent({
      sessionId,
      task: "send_message",
      profileUrl,
      message,
    });

    return res.json({
      ok: result.success,
      sessionId,
      profileUrl,
      message: result.text,
      steps: result.steps.length,
      toolCalls: result.toolCalls.map((tc) => tc.toolName),
    });
  } catch (error: any) {
    return res.status(500).json({
      error: "Error enviando mensaje autónomo",
      detail: error.message,
    });
  }
});

/**
 * POST /api/v1/agent/linkedin/batch
 * Body: { 
 *   sessionId: string,
 *   profiles: Array<{ url: string, action: 'connect' | 'message', message?: string }>
 * }
 * 
 * Ejecuta múltiples acciones en batch
 */
router.post("/linkedin/batch", async (req, res) => {
  const { sessionId, profiles } = req.body as {
    sessionId: string;
    profiles: Array<{
      url: string;
      action: "connect" | "message";
      message?: string;
    }>;
  };

  if (!sessionId || !profiles || !Array.isArray(profiles)) {
    return res.status(400).json({
      error: "sessionId y profiles[] son requeridos",
    });
  }

  const session = getSession(sessionId);
  if (!session) {
    return res.status(404).json({
      error: `Sesión ${sessionId} no encontrada`,
    });
  }

  const results = [];

  for (const profile of profiles) {
    try {
      const result = await runLinkedInAutonomousAgent({
        sessionId,
        task: profile.action === "connect" ? "send_connection" : "send_message",
        profileUrl: profile.url,
        message: profile.message,
      });

      results.push({
        profileUrl: profile.url,
        action: profile.action,
        success: result.success,
        message: result.text,
        steps: result.steps.length,
      });

      // Esperar entre perfiles para no ser detectado como spam
      await new Promise((resolve) => setTimeout(resolve, 5000 + Math.random() * 5000));
    } catch (error: any) {
      results.push({
        profileUrl: profile.url,
        action: profile.action,
        success: false,
        error: error.message,
      });
    }
  }

  return res.json({
    ok: true,
    sessionId,
    totalProfiles: profiles.length,
    results,
  });
});

export default router;