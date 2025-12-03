// src/agents/linkedinAgent.ts
import type { Page } from "playwright";
import { getActivePage } from "../browser/sessions";

import { generateText, tool, stepCountIs } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";

import {
  checkProfileConnection,
  sendConnectionRequest,
  sendMessageToProfile,
} from "../linkedin/linkedin.service";

const openaiClient = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

type AgentTask = "login" | "send_connection" | "send_message";

export interface RunLinkedInAutonomousAgentInput {
  sessionId: string;
  task: AgentTask;
  credentials?: {
    email: string;
    password: string;
  };
  profileUrl?: string;
  message?: string;
}

/**
 * Helper: obtiene la Page de la sesión o tira error si no existe.
 */
function requirePage(sessionId: string): Page {
  const page = getActivePage(sessionId);
  if (!page) {
    throw new Error(
      `Sesión ${sessionId} no encontrada o sin pestaña activa (Playwright).`
    );
  }
  return page;
}

/**
 * Crea el set de tools que el modelo puede usar.
 * Algunos tools son genéricos (navigate, click, fill, wait),
 * otros son wrappers directos a tus servicios de LinkedIn.
 */
function createLinkedInTools(
  sessionId: string,
  credentials?: { email: string; password: string }
) {
  const tools: Record<string, any> = {};

  const getPage = () => requirePage(sessionId);

  // Navegar a una URL
  tools.navigate = tool({
    description:
      "Navega la pestaña activa del navegador a una URL dada (por ejemplo, login de LinkedIn, un perfil, el feed).",
    inputSchema: z.object({
      url: z
        .string()
        .describe(
          "URL absoluta, por ejemplo 'https://www.linkedin.com/login' o la URL de un perfil."
        ),
    }),
    execute: async ({ url }) => {
      const page = getPage();
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      return {
        currentUrl: page.url(),
        note: `Navegué a ${url}`,
      };
    },
  });

  // Esperar unos milisegundos (mejor para pequeñas pausas, no para todo)
  tools.wait = tool({
    description:
      "Espera una cantidad de milisegundos. Úsalo como pausa corta tras navegaciones o cambios de UI, no abuses de esperas largas.",
    inputSchema: z.object({
      ms: z
        .number()
        .int()
        .min(0)
        .max(30_000)
        .describe("Tiempo en milisegundos (0 - 30000)."),
    }),
    execute: async ({ ms }) => {
      const page = getPage();
      await page.waitForTimeout(ms);
      return { waitedMs: ms };
    },
  });

  // Click por role + texto visible (button/link)
  tools.click = tool({
    description:
      "Hace click en un elemento usando role ARIA (button o link) y el texto visible. Usa nombres parciales (regex, case-insensitive).",
    inputSchema: z.object({
      role: z
        .enum(["button", "link"])
        .describe('Role del elemento. Normalmente "button" o "link".'),
      name: z
        .string()
        .describe(
          "Texto visible del elemento, por ejemplo 'Iniciar sesión', 'Connect', 'Mensaje'. Se hace match case-insensitive."
        ),
    }),
    execute: async ({ role, name }) => {
      const page = getPage();
      const locator = page.getByRole(role as any, {
        name: new RegExp(name, "i"),
      });
      const count = await locator.count();
      if (count === 0) {
        throw new Error(
          `No encontré ningún elemento con role=${role} y texto ~/${name}/i`
        );
      }
      await locator.first().click();
      return {
        clickedRole: role,
        clickedName: name,
      };
    },
  });

  // Rellenar inputs por label/placeholder
  tools.fill = tool({
    description:
      "Rellena un input o textarea en la página actual buscando por label o placeholder (texto visible).",
    inputSchema: z.object({
      selectorType: z
        .enum(["label", "placeholder"])
        .default("label")
        .describe("Usar 'label' o 'placeholder' para encontrar el input."),
      text: z
        .string()
        .describe(
          "Texto a buscar en el label o placeholder. Ej: 'Email', 'Correo electrónico', 'Password', 'Contraseña'."
        ),
      value: z.string().describe("Valor a escribir en el input."),
    }),
    execute: async ({ selectorType, text, value }) => {
      const page = getPage();
      let locator;
      if (selectorType === "label") {
        locator = page.getByLabel(new RegExp(text, "i"));
      } else {
        locator = page.getByPlaceholder(new RegExp(text, "i"));
      }
      const count = await locator.count();
      if (count === 0) {
        throw new Error(
          `No encontré ningún input por ${selectorType} ~/${text}/i`
        );
      }
      await locator.first().fill(value);
      return {
        selectorType,
        text,
        wroteChars: value.length,
      };
    },
  });

  // --- TOOLS DE INTROSPECCIÓN (sin accessibility.snapshot) ---

  // Listado de botones visibles
  tools.list_buttons = tool({
    description:
      "Lista los botones visibles de la página actual con su texto, aria-label y clase. Úsalo para localizar el botón correcto antes de hacer click.",
    inputSchema: z.object({
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(40)
        .describe("Máximo de botones a devolver."),
    }),
    execute: async ({ limit }) => {
      const page = getPage();
      const locator = page.getByRole("button");
      const handles = await locator.elementHandles();
      const items: {
        text: string;
        ariaLabel: string | null;
        className: string | null;
      }[] = [];

      for (const handle of handles.slice(0, limit)) {
        const [text, ariaLabel, className] = await Promise.all([
          handle.innerText().catch(() => ""),
          handle.getAttribute("aria-label"),
          handle.getAttribute("class"),
        ]);

        items.push({
          text: text.trim(),
          ariaLabel: ariaLabel ?? null,
          className: className ?? null,
        });
      }

      return { buttons: items };
    },
  });

  // Listado de inputs / textareas / textboxes
  tools.list_textboxes = tool({
    description:
      "Lista inputs, textareas y elementos tipo textbox donde se puede escribir. Úsalo para decidir dónde escribir antes de llamar a fill.",
    inputSchema: z.object({
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(40)
        .describe("Máximo de elementos a devolver."),
    }),
    execute: async ({ limit }) => {
      const page = getPage();
      const locator = page.locator("input, textarea, [role='textbox']");
      const handles = await locator.elementHandles();
      const items: {
        tagName: string;
        type: string | null;
        ariaLabel: string | null;
        placeholder: string | null;
      }[] = [];

      for (const handle of handles.slice(0, limit)) {
        const [tag, typeAttr, ariaLabel, placeholder] = await Promise.all([
          handle.evaluate((el) => (el as HTMLElement).tagName.toLowerCase()),
          handle.getAttribute("type"),
          handle.getAttribute("aria-label"),
          handle.getAttribute("placeholder"),
        ]);

        items.push({
          tagName: tag,
          type: typeAttr,
          ariaLabel,
          placeholder,
        });
      }

      return { textboxes: items };
    },
  });

  // --- LOGIN CON CREDENCIALES ---

  if (credentials) {
    const { email, password } = credentials;

    tools.login_with_credentials = tool({
      description:
        "Realiza login estándar en LinkedIn usando email y password asociados a esta sesión. No requiere parámetros.",
      inputSchema: z.object({}), // sin parámetros: el modelo solo llama al tool
      execute: async () => {
        const page = getPage();

        // 1) Ir siempre al login (idempotente)
        await page.goto("https://www.linkedin.com/login", {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });

        // 2) Completar email y password usando labels/placeholder en varios idiomas
        const emailCandidates = [
          /email/i,
          /correo/i,
          /correo electr/i,
          /correo electrónico/i,
          /e-mail/i,
          /phone/i,
        ];
        const passwordCandidates = [
          /password/i,
          /contrase/i,
          /clave/i,
          /senha/i,
        ];

        let emailFilled = false;
        for (const pattern of emailCandidates) {
          const locator = page.getByLabel(pattern);
          if ((await locator.count()) > 0) {
            await locator.first().fill(email);
            emailFilled = true;
            break;
          }
        }
        if (!emailFilled) {
          const byPlaceholder = page.getByPlaceholder(/email|correo/i);
          if ((await byPlaceholder.count()) > 0) {
            await byPlaceholder.first().fill(email);
            emailFilled = true;
          }
        }

        let passwordFilled = false;
        for (const pattern of passwordCandidates) {
          const locator = page.getByLabel(pattern);
          if ((await locator.count()) > 0) {
            await locator.first().fill(password);
            passwordFilled = true;
            break;
          }
        }
        if (!passwordFilled) {
          const byPlaceholder = page.getByPlaceholder(
            /password|contrase|senha/i
          );
          if ((await byPlaceholder.count()) > 0) {
            await byPlaceholder.first().fill(password);
            passwordFilled = true;
          }
        }

        // 3) Click en botón de login
        const loginButtons = [
          /sign in/i,
          /iniciar sesi/i,
          /acceder/i,
          /entrar/i,
          /continuar/i,
        ];
        let loginClicked = false;
        for (const pattern of loginButtons) {
          const btn = page.getByRole("button", { name: pattern }).first();
          if ((await btn.count()) > 0) {
            await btn.click();
            loginClicked = true;
            break;
          }
        }

        // 4) Esperar un rato y devolver estado básico
        await page.waitForTimeout(8_000);
        const currentUrl = page.url();

        return {
          emailFilled,
          passwordFilled,
          loginClicked,
          currentUrl,
        };
      },
    });
  }

  // Tool de alto nivel: analizar un perfil usando Vision
  tools.check_profile_connection = tool({
    description:
      "Abre y analiza un perfil de LinkedIn para saber si está logueado, si es conexión, si hay captcha o bloqueos, etc. (no devuelve screenshots).",
    inputSchema: z.object({
      profileUrl: z
        .string()
        .describe("URL completa del perfil de LinkedIn a analizar."),
    }),
    execute: async ({ profileUrl }) => {
      const page = getPage();
      const { analysis } = await checkProfileConnection(page, profileUrl);

      return {
        isLoggedIn: analysis.isLoggedIn,
        isHumanRequired: analysis.isHumanRequired,
        isConnection: analysis.isConnection,
        blockType: analysis.blockType ?? "none",
        reason: analysis.reason ?? "",
      };
    },
  });

  // Tool de alto nivel: enviar request de conexión
  tools.send_connection_request = tool({
    description:
      "Envía una solicitud de conexión a un perfil de LinkedIn. Usa un mensaje opcional como nota.",
    inputSchema: z.object({
      profileUrl: z.string(),
      note: z
        .string()
        .optional()
        .describe("Nota opcional para la solicitud de conexión."),
    }),
    execute: async ({ profileUrl, note }) => {
      const page = getPage();
      const result = await sendConnectionRequest(page, profileUrl, note);

      const { analysis, status, error } = result;

      return {
        status,
        error,
        isLoggedIn: analysis.isLoggedIn,
        isHumanRequired: analysis.isHumanRequired,
        isConnection: analysis.isConnection,
        blockType: analysis.blockType ?? "none",
        reason: analysis.reason ?? "",
      };
    },
  });

  // Tool de alto nivel: enviar mensaje
  tools.send_message = tool({
    description:
      "Envía un mensaje de LinkedIn a un perfil que ya es conexión. Falla si no es conexión.",
    inputSchema: z.object({
      profileUrl: z.string(),
      message: z.string(),
    }),
    execute: async ({ profileUrl, message }) => {
      const page = getPage();
      const result = await sendMessageToProfile(page, profileUrl, message);

      const { analysis, status, error } = result;

      return {
        status,
        error,
        isLoggedIn: analysis.isLoggedIn,
        isHumanRequired: analysis.isHumanRequired,
        isConnection: analysis.isConnection,
        blockType: analysis.blockType ?? "none",
        reason: analysis.reason ?? "",
      };
    },
  });

  return tools;
}

/**
 * Construye el user prompt en función del tipo de tarea.
 */
function buildUserPrompt(input: RunLinkedInAutonomousAgentInput): string {
  const { task, profileUrl, message } = input;

  if (task === "login") {
    return `
Tu objetivo es dejar la sesión actual de navegador logueada en LinkedIn.

Contexto:
- Tienes acceso a un navegador real controlado por Playwright.
- Hay credenciales asociadas a esta sesión (email y password).

Pautas:
- Puedes navegar, inspeccionar la página usando tools como list_buttons y list_textboxes,
  y usar login_with_credentials o rellenar el formulario manualmente.
- Asegúrate al final de estar en una página que represente un usuario logueado
  (por ejemplo el feed de LinkedIn).

Devuélveme un resumen breve en español explicando si el login quedó correcto o no y por qué.
`;
  }

  if (task === "send_connection") {
    return `
Tu objetivo es enviar una solicitud de conexión en LinkedIn a este perfil:

- Perfil objetivo: ${profileUrl ?? "(no proporcionado)"}

Pautas:
- Asegúrate de que la sesión está logueada.
- Puedes usar tools de alto nivel como check_profile_connection y send_connection_request.
- Si detectas bloqueos (captcha, 2FA, rate limit) o que no estás logueado, detente y explícalo.
- Puedes inspeccionar la UI con list_buttons y list_textboxes
  si necesitas localizar botones o inputs.

Devuélveme un resumen breve en español indicando si se envió la solicitud,
si ya estaban conectados o si hubo algún problema.
`;
  }

  if (task === "send_message") {
    return `
Tu objetivo es enviar un mensaje a una conexión de LinkedIn.

- Perfil objetivo: ${profileUrl ?? "(no proporcionado)"}
- Mensaje a enviar (texto sugerido): ${message ?? "(no proporcionado)"}

Pautas:
- Verifica primero que la sesión está logueada y que el perfil es conexión
  (tool check_profile_connection te ayuda con esto).
- Si hay bloqueos o no estás logueado, no sigas e informa el problema.
- Para enviar el mensaje puedes usar el tool de alto nivel send_message,
  y si falla, apoyarte en navigate, click, fill, wait y los tools de introspección
  (list_buttons y list_textboxes) para encontrar el editor y el botón de enviar.

Devuélveme un resumen breve en español indicando si el mensaje se envió o no y por qué.
`;
  }

  // Fallback defensivo (no debería pasar)
  return `
Tarea desconocida: ${task}.
Explica que la tarea no está soportada.
`;
}

const SYSTEM_PROMPT = `
Eres un agente autónomo que controla un navegador Chromium real mediante tools.
Tu misión es automatizar acciones en LinkedIn (login, enviar invitaciones y mensajes)
de forma segura y respetando los límites de la plataforma.

Herramientas clave:
- navigate, click, fill, wait: interacción genérica con la web.
- list_buttons, list_textboxes: para inspeccionar la estructura y los controles de la página
  antes de actuar, parecido a cómo un humano observaría los elementos disponibles.
- login_with_credentials: cuando dispones de credenciales para iniciar sesión.
- check_profile_connection, send_connection_request, send_message: operaciones de alto nivel
  específicas de LinkedIn.

Reglas importantes:
- SOLO puedes interactuar con el navegador usando tools. No inventes APIs ni ejecutes
  acciones que no se puedan lograr con los tools disponibles.
- Antes de hacer clicks importantes, es buena práctica inspeccionar la página con
  list_buttons o list_textboxes para entender qué controles hay.
- Si detectas captchas, 2FA, rate limiting u otras verificaciones que requieran humanos,
  detente y explica que se necesita intervención humana.
- Evita repetir la misma acción muchas veces seguidas; si no funciona tras uno o dos
  intentos razonables, asume que hay un problema estructural.
- Evita esperas muy largas con 'wait'; prefiere apoyarte en el auto-waiting de los locators
  y en checks semánticos (por ejemplo, que aparezca un botón o un textbox).
- Siempre responde en español con un resumen claro y conciso al final.
`;

/**
 * Punto de entrada principal que usan tus endpoints de /api/v1/agent/linkedin/*.
 */
export async function runLinkedInAutonomousAgent(
  input: RunLinkedInAutonomousAgentInput
): Promise<{
  success: boolean;
  text: string;
  steps: any[];
  toolCalls: { toolName: string; args: any; result?: any }[];
}> {
  const { sessionId, task } = input;

  // Validaciones mínimas según tipo de tarea
  if (task === "login" && !input.credentials) {
    throw new Error(
      "Para la tarea 'login' necesitas proporcionar credentials { email, password }."
    );
  }

  if (
    (task === "send_connection" || task === "send_message") &&
    !input.profileUrl
  ) {
    throw new Error(
      `Para la tarea '${task}' necesitas proporcionar 'profileUrl'.`
    );
  }

  if (task === "send_message" && !input.message) {
    throw new Error(
      "Para la tarea 'send_message' necesitas proporcionar 'message'."
    );
  }

  // Crear tools ligados a esta sesión y (opcionalmente) credenciales
  const tools = createLinkedInTools(sessionId, input.credentials);

  const userPrompt = buildUserPrompt(input);

  const result = await generateText({
    model: openaiClient("gpt-5-nano"),
    system: SYSTEM_PROMPT,
    prompt: userPrompt,
    tools,
    stopWhen: stepCountIs(10),
  });

  const steps = result.steps ?? [];
  const toolCalls: { toolName: string; args: any; result?: any }[] =
    steps.flatMap((s: any) =>
      (s.toolCalls ?? []).map((tc: any) => ({
        toolName: tc.toolName,
        args: tc.args,
        result: tc.result,
      }))
    );

  // Buscamos explícitamente los resultados relevantes
  const sendMessageCalls = toolCalls.filter(
    (c) => c.toolName === "send_message"
  );
  const sendConnectionCalls = toolCalls.filter(
    (c) => c.toolName === "send_connection_request"
  );
  const checkConnectionCalls = toolCalls.filter(
    (c) => c.toolName === "check_profile_connection"
  );

  // Flags por status
  const anyMessageSent = sendMessageCalls.some(
    (c) => c.result?.status === "message_sent"
  );
  const anyInviteSent = sendConnectionCalls.some(
    (c) => c.result?.status === "invite_sent"
  );
  const anyAlreadyConnected = [
    ...sendConnectionCalls,
    ...checkConnectionCalls,
  ].some((c) => c.result?.isConnection === "connected");

  const anyHardFailure = [...sendMessageCalls, ...sendConnectionCalls].some(
    (c) =>
      c.result?.status === "failed" ||
      c.result?.status === "not_logged_in" ||
      c.result?.status === "human_required"
  );

  // Heurística de éxito basada en tools
  let success = false;
  if (task === "send_message") {
    success = anyMessageSent;
  } else if (task === "send_connection") {
    success = anyInviteSent || anyAlreadyConnected;
  } else if (task === "login") {
    // para login, mantenemos algo de heurística textual + check_profile_connection
    const lowerText = result.text.toLowerCase();
    const textLooksOk =
      !lowerText.includes("error") &&
      !lowerText.includes("bloqueo") &&
      !lowerText.includes("captcha") &&
      !lowerText.includes("2fa") &&
      !lowerText.includes("intervención humana");

    const anyLoggedIn = checkConnectionCalls.some(
      (c) => c.result?.isLoggedIn === true
    );
    success = textLooksOk && anyLoggedIn;
  }

  if (anyHardFailure) {
    success = false;
  }

  return {
    success,
    text: result.text,
    steps,
    toolCalls,
  };
}
