// src/linkedin/linkedin.service.ts
import type { Page } from "playwright";
import crypto from "crypto";
import OpenAI from "openai";
import { errors } from "playwright";

export type ConnectionStatus = "connected" | "not_connected" | "unknown";

export interface ScreenshotAnalysis {
  isConnection: ConnectionStatus;
  isHumanRequired: boolean;
  isLoggedIn: boolean;
  blockType?:
    | "none"
    | "captcha"
    | "login_required"
    | "rate_limit"
    | "2fa"
    | "unknown";
  reason?: string;
}

export interface ActionStepTrace {
  id: string;
  name: string;
  screenshotBase64: string;
  // Análisis de OpenAI para este paso (opcional)
  aiAnalysis?: ScreenshotAnalysis;
}

export interface ActionTrace {
  actionId: string;
  steps: ActionStepTrace[];
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Setea la cookie li_at en el contexto y va al feed.
 */
export async function loginWithLiAt(page: Page, liAt: string): Promise<void> {
  await page.context().addCookies([
    {
      name: "li_at",
      value: liAt,
      domain: ".linkedin.com",
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30, // 30 días
    },
  ]);

  await page.goto("https://www.linkedin.com/feed/", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
}

/**
 * Saca un screenshot fullPage y lo devuelve en base64 para trazabilidad.
 */
export async function takeTraceScreenshot(
  page: Page,
  name: string
): Promise<ActionStepTrace> {
  const buffer = await page.screenshot({
    type: "png",
    fullPage: true,
  });

  return {
    id: crypto.randomUUID(),
    name,
    screenshotBase64: buffer.toString("base64"),
  };
}

/**
 * Analiza un screenshot (base64) con OpenAI Vision.
 * Responde con la estructura ScreenshotAnalysis.
 */
async function analyzeScreenshotBase64(
  screenshotBase64: string,
  purpose: "login_state" | "profile_state" | "messaging_state"
): Promise<ScreenshotAnalysis> {
  const systemPrompt = `
Eres un analizador de pantallas de LinkedIn para un sistema de automatización.
Siempre respondes SOLO con un JSON válido con esta forma:

{
  "isLoggedIn": boolean,
  "isHumanRequired": boolean,
  "isConnection": "connected" | "not_connected" | "unknown",
  "blockType": "none" | "captcha" | "login_required" | "rate_limit" | "2fa" | "unknown",
  "reason": string
}

Definiciones:

- isLoggedIn:
  true  → se ve un feed, perfil, messaging o cualquier página de una cuenta logueada.
  false → se ve pantalla de login, "Join LinkedIn" o un prompt claro para iniciar sesión.

- isHumanRequired:
  true si ves captchas, verificaciones de teléfono/email, "verify your identity",
  "unusual activity", "are you a human", rate limits o cosas que requieran acción humana.
  false si ves navegación normal sin bloqueos.

- isConnection:
  "connected"      → estás en un perfil y el botón principal es "Message", "Mensaje", etc.
  "not_connected"  → estás en un perfil y ves "Connect", "Conectar", "Follow", "Seguir", etc.
  "unknown"        → no estás en un perfil o no se puede saber.

- blockType:
  "captcha"         → ves un captcha visual o textual.
  "login_required"  → estás en pantalla de login o un diálogo claro de iniciar sesión.
  "rate_limit"      → ves mensajes de demasiadas solicitudes o límites.
  "2fa"             → ves pantalla típica de verificación de código SMS, app, etc.
  "none"            → no ves bloqueos.
  "unknown"         → hay algo raro pero no encaja en lo anterior.

"reason" debe explicar en pocas palabras por qué llegaste a esa conclusión.
`;

  const userText = `Analiza esta captura de pantalla de LinkedIn.
Contexto/purpose: ${purpose}. Devuelve SOLO el JSON, sin texto adicional.`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          { type: "text", text: userText },
          {
            type: "image_url",
            image_url: {
              url: `data:image/png;base64,${screenshotBase64}`,
            },
          },
        ],
      },
    ],
  });

  const rawContent = response.choices[0]?.message?.content;
  if (!rawContent) {
    throw new Error("OpenAI devolvió una respuesta vacía");
  }

  const text =
    typeof rawContent === "string"
      ? rawContent
      : // En la práctica para chat.completions suele ser string, esto es por si viniera como array
        (rawContent as any[]).map((p) => p?.text ?? "").join("");

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `No se pudo parsear la respuesta de OpenAI como JSON. Contenido: ${text}`
    );
  }

  const isConnection: ConnectionStatus =
    parsed.isConnection === "connected" ||
    parsed.isConnection === "not_connected"
      ? parsed.isConnection
      : "unknown";

  const analysis: ScreenshotAnalysis = {
    isConnection,
    isHumanRequired: !!parsed.isHumanRequired,
    isLoggedIn: !!parsed.isLoggedIn,
    blockType:
      parsed.blockType ?? (parsed.isHumanRequired ? "unknown" : "none"),
    reason: parsed.reason ?? "",
  };

  return analysis;
}

/**
 * Helper: toma el screenshot ya guardado en el step, lo manda a OpenAI
 * y guarda el resultado en step.aiAnalysis.
 */
async function analyzeScreenshotWithOpenAIFromStep(
  step: ActionStepTrace,
  purpose: "login_state" | "profile_state" | "messaging_state"
): Promise<ScreenshotAnalysis> {
  try {
    const analysis = await analyzeScreenshotBase64(
      step.screenshotBase64,
      purpose
    );
    step.aiAnalysis = analysis;
    return analysis;
  } catch (err) {
    console.error("Error analizando screenshot con OpenAI:", err);
    const fallback: ScreenshotAnalysis = {
      isConnection: "unknown",
      isHumanRequired: false,
      isLoggedIn: true,
      blockType: "unknown",
      reason: "Fallback sin OpenAI: " + String(err),
    };
    step.aiAnalysis = fallback;
    return fallback;
  }
}

/**
 * Abre un perfil de LinkedIn, espera y analiza si es conexión o no.
 */
export async function checkProfileConnection(
  page: Page,
  profileUrl: string
): Promise<{ trace: ActionTrace; analysis: ScreenshotAnalysis }> {
  const actionId = crypto.randomUUID();
  const steps: ActionStepTrace[] = [];

  try {
    await page.goto(profileUrl, {
      waitUntil: "domcontentloaded", // 👈 en lugar de "networkidle"
      timeout: 60_000, // 👈 más margen que los 30s por defecto
    });
  } catch (err) {
    // Si es un timeout, logueamos y seguimos con lo que haya cargado
    if (err instanceof errors.TimeoutError) {
      console.warn(
        "[checkProfileConnection] Timeout navegando al perfil, sigo con la página parcial...",
        String(err)
      );
    } else {
      // Otros errores sí se re-lanzan
      throw err;
    }
  }

  // Seguimos igual: damos tiempo a que se asienten los elementos
  await page.waitForTimeout(5000);
  await page.waitForTimeout(10000);

  const step = await takeTraceScreenshot(page, "profile_loaded");
  steps.push(step);

  const analysis = await analyzeScreenshotWithOpenAIFromStep(
    step,
    "profile_state"
  );

  return {
    trace: { actionId, steps },
    analysis,
  };
}

/**
 * Envía una connection request con nota (si no es conexión).
 * También detecta si la sesión NO está logueada o si hace falta intervención humana.
 */
export async function sendConnectionRequest(
  page: Page,
  profileUrl: string,
  note?: string
): Promise<{
  trace: ActionTrace;
  analysis: ScreenshotAnalysis;
  status:
    | "already_connected"
    | "invite_sent"
    | "failed"
    | "human_required"
    | "not_logged_in";
  error?: string;
}> {
  const { trace, analysis } = await checkProfileConnection(page, profileUrl);

  if (!analysis.isLoggedIn) {
    return {
      trace,
      analysis,
      status: "not_logged_in",
      error:
        "La sesión de LinkedIn no está logueada (pantalla de login / login_required).",
    };
  }

  if (analysis.isHumanRequired) {
    return {
      trace,
      analysis,
      status: "human_required",
      error: "OpenAI marcó que es necesaria intervención humana.",
    };
  }

  if (analysis.isConnection === "connected") {
    return {
      trace,
      analysis,
      status: "already_connected",
    };
  }

  try {
    // Paso 1: Click en "Conectar / Connect"
    const beforeClick = await takeTraceScreenshot(page, "before_click_connect");
    trace.steps.push(beforeClick);

    const connectButton = page
      .getByRole("button", { name: /conectar|connect/i })
      .first();

    await connectButton.click();

    // Paso 2: si hay opción de "Añadir nota / Add a note"
    try {
      const addNoteButton = page
        .getByRole("button", { name: /añadir nota|add a note/i })
        .first();

      if ((await addNoteButton.count()) > 0) {
        await addNoteButton.click();

        if (note) {
          const textarea = page.locator("textarea");
          await textarea.fill(note);
        }
      }
    } catch {
      // si no hay botón de nota, no pasa nada
    }

    // Paso 3: click en "Enviar / Send"
    const sendButton = page
      .getByRole("button", { name: /enviar|send/i })
      .first();
    await sendButton.click();

    const afterSend = await takeTraceScreenshot(page, "after_send_invite");
    trace.steps.push(afterSend);

    return {
      trace,
      analysis,
      status: "invite_sent",
    };
  } catch (err: any) {
    const errorStep = await takeTraceScreenshot(page, "error_during_connect");
    trace.steps.push(errorStep);

    return {
      trace,
      analysis,
      status: "failed",
      error: String(err),
    };
  }
}

/**
 * Envía un mensaje si ya es conexión.
 */
export async function sendMessageToProfile(
  page: Page,
  profileUrl: string,
  message: string
): Promise<{
  trace: ActionTrace;
  analysis: ScreenshotAnalysis;
  status:
    | "not_connected"
    | "message_sent"
    | "failed"
    | "human_required"
    | "not_logged_in";
  error?: string;
}> {
  const actionId = crypto.randomUUID();
  const steps: ActionStepTrace[] = [];

  await page.goto(profileUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForTimeout(5000);

  const step = await takeTraceScreenshot(page, "profile_loaded_for_message");
  steps.push(step);

  const analysis = await analyzeScreenshotWithOpenAIFromStep(
    step,
    "profile_state"
  );

  if (!analysis.isLoggedIn) {
    return {
      trace: { actionId, steps },
      analysis,
      status: "not_logged_in",
      error:
        "La sesión de LinkedIn no está logueada (pantalla de login / login_required).",
    };
  }

  if (analysis.isHumanRequired) {
    return {
      trace: { actionId, steps },
      analysis,
      status: "human_required",
      error: "OpenAI marcó que es necesaria intervención humana.",
    };
  }

  if (analysis.isConnection !== "connected") {
    return {
      trace: { actionId, steps },
      analysis,
      status: "not_connected",
      error: "El perfil no es conexión, no se puede enviar mensaje.",
    };
  }

  try {
    // Click en "Mensaje / Message"
    const msgButton = page
      .getByRole("button", { name: /mensaj|message/i })
      .first();
    await msgButton.click();

    // Buscar textarea / editor (contenteditable o textarea)
    const editor = page
      .locator("div[contenteditable='true'], textarea")
      .first();

    await editor.click();
    await editor.fill(""); // limpiar si aplica
    await editor.type(message);

    const sendButton = page
      .getByRole("button", { name: /enviar|send/i })
      .first();
    await sendButton.click();

    const afterSend = await takeTraceScreenshot(page, "after_send_message");
    steps.push(afterSend);

    return {
      trace: { actionId, steps },
      analysis,
      status: "message_sent",
    };
  } catch (err: any) {
    const errorStep = await takeTraceScreenshot(
      page,
      "error_during_send_message"
    );
    steps.push(errorStep);

    return {
      trace: { actionId, steps },
      analysis,
      status: "failed",
      error: String(err),
    };
  }
}

/**
 * Stub para ir a /messaging y traer el histórico de un thread.
 * (Esto lo podés completar después con la lógica de búsqueda de thread).
 */
export async function fetchMessagingThreadStub(page: Page) {
  await page.goto("https://www.linkedin.com/messaging/", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  const screenshot = await takeTraceScreenshot(page, "messaging_home");
  const analysis = await analyzeScreenshotWithOpenAIFromStep(
    screenshot,
    "messaging_state"
  );

  return {
    screenshot,
    analysis,
    note: "Stub: acá deberías buscar el thread correcto y scrapear el histórico.",
  };
}
