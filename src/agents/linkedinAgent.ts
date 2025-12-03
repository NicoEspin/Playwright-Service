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
          "URL absoluta, por ejemplo 'https://www.linkedin.com/login' o un perfil."
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

  // Esperar unos milisegundos
  tools.wait = tool({
    description:
      "Espera una cantidad de milisegundos. Úsalo después de navegar o de hacer clicks que cambian la UI.",
    inputSchema: z.object({
      ms: z
        .number()
        .int()
        .min(0)
        .max(60_000)
        .describe("Tiempo en milisegundos (0 - 60000)."),
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

  // Tool especializado para login con credenciales
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
        await page.waitForTimeout(8000);
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

      // ⚠️ No devolvemos trace ni screenshots al modelo
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

    // ⚠️ NO devolvemos trace ni screenshots al modelo
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
Tarea: iniciar sesión en LinkedIn para esta sesión de navegador.

Instrucciones:
- Usa el tool "login_with_credentials" UNA sola vez al inicio para hacer login con el email y password asociados a esta sesión.
- Después de hacer login, si es posible, navega a 'https://www.linkedin.com/feed/' para confirmar que la sesión está logueada.
- Si detectas pantallas de verificación humana (captcha, 2FA, bloqueos), no intentes resolverlas: explica claramente que se necesita intervención humana.
- Termina tu respuesta con un resumen breve en español indicando si el login fue exitoso o no y por qué.
`;
  }

  if (task === "send_connection") {
    return `
Tarea: enviar una solicitud de conexión en LinkedIn.

Perfil objetivo: ${profileUrl ?? "(no proporcionado)"}

Instrucciones:
- Primero usa "check_profile_connection" con el profileUrl para entender si:
  - estás logueado,
  - ya eres conexión,
  - hay captchas o bloqueos.
- Si el análisis indica que no estás logueado o hay bloqueo humano, no sigas; explica la situación.
- Si no eres conexión y no hay bloqueos, usa "send_connection_request" para enviar la solicitud. Puedes pasar una nota si lo consideras útil.
- Si ya eres conexión, no envíes otra solicitud; simplemente informa que ya están conectados.
- Usa "wait" cuando haga falta después de navegar o de hacer clics importantes.
- Termina con un resumen breve en español indicando:
  - si se envió la solicitud,
  - si ya estaban conectados,
  - o si hubo algún bloqueo o error.
`;
  }

  if (task === "send_message") {
    return `
Tarea: enviar un mensaje a una conexión de LinkedIn.

Perfil objetivo: ${profileUrl ?? "(no proporcionado)"}
Mensaje a enviar (texto sugerido): ${message ?? "(no proporcionado)"}

Instrucciones:
- Primero usa "check_profile_connection" para ver si:
  - estás logueado,
  - el perfil es conexión,
  - hay bloqueos o captchas.
- Si no estás logueado o hay bloqueo humano, no sigas; explica la situación.
- Si el perfil NO es conexión, no intentes forzar el mensaje: informa que no es posible porque no son conexión.
- Si el perfil es conexión, usa "send_message" pasando el profileUrl y el mensaje que te proporcioné. Puedes adaptar ligeramente el mensaje si es necesario.
- Usa "wait" cuando haga falta tras navegar o abrir diálogos.
- Termina con un resumen breve en español indicando si el mensaje fue enviado o no y por qué.
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
Tu misión es automatizar acciones en LinkedIn (login, enviar invitaciones y mensajes) de forma segura y respetando los límites de la plataforma.

Reglas importantes:
- SOLO puedes interactuar con el navegador usando tools. No inventes APIs ni ejecutes acciones que no se puedan lograr con los tools disponibles.
- Usa tools de alto nivel (check_profile_connection, send_connection_request, send_message, login_with_credentials) siempre que sea posible.
- Usa los tools genéricos (navigate, click, fill, wait) solo cuando lo consideres necesario para completar la tarea.
- Si detectas captchas, 2FA, rate limiting u otras verificaciones que requieran humanos, detente y explica que se necesita intervención humana.
- No intentes adivinar passwords ni modificar credenciales.
- Evita repetir la misma acción muchas veces seguidas; si no funciona tras un par de intentos, asume que hay un problema.
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
    // multi-step agentic loop: máximo 20 pasos (tool calls + respuestas)
    stopWhen: stepCountIs(10),
  });

  // Heurística simple de éxito: no encontró error obvio en la descripción final
  const lowerText = result.text.toLowerCase();
  const success =
    !lowerText.includes("error") &&
    !lowerText.includes("bloqueo") &&
    !lowerText.includes("captcha") &&
    !lowerText.includes("2fa") &&
    !lowerText.includes("intervención humana");

  const steps = result.steps ?? [];
  const toolCalls = steps.flatMap((s: any) => s.toolCalls ?? []);

  return {
    success,
    text: result.text,
    steps,
    toolCalls,
  };
}
