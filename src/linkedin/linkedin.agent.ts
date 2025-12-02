// src/linkedin/linkedin.agent.ts
import OpenAI from "openai";
import { getActivePage } from "../browser/sessions";
import {
  checkProfileConnection,
  sendConnectionRequest,
  sendMessageToProfile,
  type ScreenshotAnalysis,
  type ActionTrace,
} from "./linkedin.service";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

/**
 * Modo de trabajo del agente:
 * - connect_or_message: si no es conexión → hace request; si ya es conexión → manda mensaje.
 * - connect_only: sólo intenta request de conexión (si ya es conexión, no manda mensaje).
 * - message_only: sólo intenta mensaje (si no es conexión, falla).
 */
export type LinkedinAgentMode =
  | "connect_or_message"
  | "connect_only"
  | "message_only";

export type LinkedinAgentStatus =
  | "invite_sent"
  | "message_sent"
  | "already_connected"
  | "not_connected"
  | "not_logged_in"
  | "human_required"
  | "failed";

export interface LinkedinAgentTaskInput {
  sessionId: string;
  profileUrl: string;
  /**
   * Nota de conexión opcional. Si no la pasás, el agente genera una nota corta con OpenAI.
   */
  connectionNoteTemplate?: string;
  /**
   * Mensaje de chat opcional. Si no lo pasás, el agente genera un mensaje corto con OpenAI.
   */
  messageTemplate?: string;
  mode?: LinkedinAgentMode;
}

export interface LinkedinAgentResult {
  status: LinkedinAgentStatus;
  analysis: ScreenshotAnalysis;
  traces: ActionTrace[];
  finalConnectionNote?: string;
  finalMessageText?: string;
  error?: string;
}

/**
 * Helper: obtiene la Page de la sesión o tira error si no existe.
 */
function requirePageOrThrow(sessionId: string) {
  const page = getActivePage(sessionId);
  if (!page) {
    const err = new Error(
      `Sesión ${sessionId} no encontrada o sin pestaña activa (Playwright).`
    );
    (err as any).statusCode = 404;
    throw err;
  }
  return page;
}

/**
 * Genera una nota de conexión genérica si no pasás template.
 */
async function buildConnectionNote(
  profileUrl: string,
  template?: string
): Promise<string> {
  const trimmed = template?.trim();
  if (trimmed) return trimmed;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.5,
    messages: [
      {
        role: "system",
        content:
          "Eres un asistente que escribe notas de conexión de LinkedIn profesionales, breves y neutras en español.",
      },
      {
        role: "user",
        content:
          "Escribe una nota corta (máx 280 caracteres) para enviar solicitud de conexión en LinkedIn, sin hacer referencia al perfil específico.",
      },
    ],
  });

  const content = completion.choices[0]?.message?.content ?? "";
  if (typeof content === "string") return content.trim();
  return content.map((c: any) => c.text ?? "").join("").trim();
}

/**
 * Genera un mensaje de chat si no pasás template.
 */
async function buildMessageText(
  profileUrl: string,
  template?: string
): Promise<string> {
  const trimmed = template?.trim();
  if (trimmed) return trimmed;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.6,
    messages: [
      {
        role: "system",
        content:
          "Eres un asistente que escribe mensajes de LinkedIn cortos, profesionales y neutros en español.",
      },
      {
        role: "user",
        content:
          "Escribe un mensaje breve para un primer contacto en LinkedIn tras aceptar una solicitud de conexión. No más de 400 caracteres.",
      },
    ],
  });

  const content = completion.choices[0]?.message?.content ?? "";
  if (typeof content === "string") return content.trim();
  return content.map((c: any) => c.text ?? "").join("").trim();
}

/**
 * AGENTE PRINCIPAL:
 * - Usa tu Page de la sesión actual.
 * - Chequea estado del perfil.
 * - Según el modo, decide si conectar o mandar mensaje.
 * - Se apoya en tus servicios (que ya hacen screenshots + Vision + trazas).
 */
export async function runLinkedinAgentTask(
  input: LinkedinAgentTaskInput
): Promise<LinkedinAgentResult> {
  const {
    sessionId,
    profileUrl,
    connectionNoteTemplate,
    messageTemplate,
  } = input;
  const mode: LinkedinAgentMode = input.mode ?? "connect_or_message";

  const page = requirePageOrThrow(sessionId);

  // 1) Chequear estado del perfil (ya hace screenshot + Vision + trace)
  const traces: ActionTrace[] = [];
  const { trace: checkTrace, analysis } = await checkProfileConnection(
    page,
    profileUrl
  );
  traces.push(checkTrace);

  // 2) Cortes tempranos por login / bloqueos
  if (!analysis.isLoggedIn) {
    return {
      status: "not_logged_in",
      analysis,
      traces,
      error:
        "La sesión de LinkedIn no está logueada (pantalla de login / login_required).",
    };
  }

  if (analysis.isHumanRequired) {
    return {
      status: "human_required",
      analysis,
      traces,
      error:
        analysis.reason ||
        "OpenAI detectó que hace falta intervención humana (captcha, 2FA, rate limit, etc.).",
    };
  }

  // 3) Lógica según si ya es conexión o no
  // ------------------------------------------------
  // Caso A: el perfil YA es conexión
  if (analysis.isConnection === "connected") {
    // Si el modo es "connect_only", no mandamos mensaje.
    if (mode === "connect_only") {
      return {
        status: "already_connected",
        analysis,
        traces,
      };
    }

    // En el resto de modos, intentamos mandar mensaje
    const message = await buildMessageText(profileUrl, messageTemplate);
    const msgResult = await sendMessageToProfile(page, profileUrl, message);
    traces.push(msgResult.trace);

    if (msgResult.status === "message_sent") {
      return {
        status: "message_sent",
        analysis: msgResult.analysis,
        traces,
        finalMessageText: message,
      };
    }

    if (msgResult.status === "human_required") {
      return {
        status: "human_required",
        analysis: msgResult.analysis,
        traces,
        finalMessageText: message,
        error:
          msgResult.error ||
          "Se requiere intervención humana al intentar enviar mensaje.",
      };
    }

    if (msgResult.status === "not_logged_in") {
      return {
        status: "not_logged_in",
        analysis: msgResult.analysis,
        traces,
        finalMessageText: message,
        error:
          msgResult.error ||
          "La sesión parece haber perdido el login durante el envío del mensaje.",
      };
    }

    // Cualquier otra cosa = fallo genérico
    return {
      status: "failed",
      analysis: msgResult.analysis,
      traces,
      finalMessageText: message,
      error: msgResult.error || "Fallo inesperado al enviar mensaje.",
    };
  }

  // ------------------------------------------------
  // Caso B: NO es conexión (o estado desconocido)
  if (mode === "message_only") {
    // Si sólo querías mensaje, pero no es conexión, cortamos acá.
    return {
      status: "not_connected",
      analysis,
      traces,
      error:
        "El perfil no es conexión y el modo está configurado como 'message_only'.",
    };
  }

  // En connect_only o connect_or_message → intentamos enviar request
  const note = await buildConnectionNote(profileUrl, connectionNoteTemplate);
  const connResult = await sendConnectionRequest(page, profileUrl, note);
  traces.push(connResult.trace);

  if (
    connResult.status === "invite_sent" ||
    connResult.status === "already_connected"
  ) {
    return {
      status: connResult.status === "invite_sent"
        ? "invite_sent"
        : "already_connected",
      analysis: connResult.analysis,
      traces,
      finalConnectionNote: note,
    };
  }

  if (connResult.status === "human_required") {
    return {
      status: "human_required",
      analysis: connResult.analysis,
      traces,
      finalConnectionNote: note,
      error:
        connResult.error ||
        "Se requiere intervención humana al intentar enviar la invitación.",
    };
  }

  if (connResult.status === "not_logged_in") {
    return {
      status: "not_logged_in",
      analysis: connResult.analysis,
      traces,
      finalConnectionNote: note,
      error:
        connResult.error ||
        "La sesión parece haber perdido el login durante el envío de la invitación.",
    };
  }

  // Fallback general
  return {
    status: "failed",
    analysis: connResult.analysis,
    traces,
    finalConnectionNote: note,
    error: connResult.error || "Fallo inesperado al enviar la invitación.",
  };
}

/**
 * Alias para mantener el nombre “viejo” (si quieres reutilizarlo desde otros módulos).
 * Ahora SÍ usa tu propio Chromium y tu sesión Playwright, no el MCP externo.
 */
export async function runLinkedinConnectionTask(
  input: LinkedinAgentTaskInput
) {
  return runLinkedinAgentTask(input);
}
