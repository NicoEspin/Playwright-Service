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

  // Snapshot de accesibilidad (similar a browser_snapshot del MCP oficial de Playwright)
  // Snapshot ligero de la página (sin usar page.accessibility)
  tools.dom_snapshot = tool({
    description:
      "Devuelve un snapshot ligero de la página actual (HTML y texto plano). Úsalo para entender la estructura de la UI antes de interactuar.",
    inputSchema: z.object({
      interestingOnly: z
        .boolean()
        .default(true)
        .describe(
          "Campo solo para compatibilidad; actualmente no cambia el comportamiento."
        ),
    }),
    execute: async ({ interestingOnly }) => {
      const page = getPage();

      const [html, text] = await Promise.all([
        page.content(),
        page.evaluate(() => document.body?.innerText || ""),
      ]);

      return {
        url: page.url(),
        snapshot: {
          html,
          text,
        },
      };
    },
  });

  // Ejecución genérica de código Playwright: máxima flexibilidad
  tools.playwright_run_code = tool({
    description:
      "Ejecuta un snippet de código Playwright asíncrono sobre la pestaña actual. El snippet debe usar la variable 'page'. Devuelve lo que retorne tu código.",
    inputSchema: z.object({
      code: z
        .string()
        .describe(
          "Código JS/TS asíncrono. Ejemplo: `await page.getByRole('button', { name: /mensaje|message/i }).click();`"
        ),
    }),
    execute: async ({ code }) => {
      const page = getPage();

      // Constructor de funciones async dinámicas
      const AsyncFunction = Object.getPrototypeOf(async function () {})
        .constructor as any;

      const fn = new AsyncFunction(
        "page",
        `
        try {
          ${code}
        } catch (err) {
          return { __error: String(err) };
        }
      `
      );

      const result = await fn(page);
      return result ?? null;
    },
  });

  // Tool para que el modelo marque explícitamente el resultado final de la tarea
  tools.report_task_result = tool({
    description:
      "Úsalo UNA sola vez al final para declarar el resultado de la tarea (login / conexión / mensaje) de forma estructurada.",
    inputSchema: z.object({
      status: z.enum([
        "login_ok",
        "invite_sent",
        "already_connected",
        "message_sent",
        "not_connected",
        "not_logged_in",
        "human_required",
        "failed",
      ]),
      reason: z
        .string()
        .describe("Resumen breve en español de lo que ocurrió."),
    }),
    execute: async ({ status, reason }) => {
      return { status, reason };
    },
  });

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
  // Click flexible: role+name, texto, selector CSS o aria-label
  tools.click = tool({
    description:
      "Hace click en un elemento usando diferentes estrategias: role+name (ARIA), texto visible, selector CSS o aria-label. Usa index para elegir entre varias coincidencias.",
    inputSchema: z
      .object({
        strategy: z
          .enum(["role", "text", "selector", "ariaLabel"])
          .default("role")
          .describe(
            "Estrategia para localizar el elemento: 'role', 'text', 'selector' o 'ariaLabel'."
          ),

        // role
        role: z
          .enum(["button", "link"])
          .optional()
          .describe("Role del elemento cuando strategy='role'."),
        name: z
          .string()
          .optional()
          .describe(
            "Texto visible (regex case-insensitive) cuando strategy='role'."
          ),

        // text
        text: z
          .string()
          .optional()
          .describe(
            "Texto visible (regex case-insensitive) cuando strategy='text'."
          ),

        // selector CSS puro
        selector: z
          .string()
          .optional()
          .describe(
            "Selector CSS cuando strategy='selector', por ejemplo '.msg-form__send-button' o 'button[aria-label*=\"Mensaje\"]'."
          ),

        // aria-label
        ariaLabel: z
          .string()
          .optional()
          .describe(
            "Texto parcial a buscar en aria-label cuando strategy='ariaLabel'."
          ),

        // cuál coincidencia usar
        index: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe(
            "Índice (0-based) de la coincidencia a clickear si hay varias."
          ),
      })
      .refine(
        (data) => {
          switch (data.strategy) {
            case "role":
              return !!data.role && !!data.name;
            case "text":
              return !!data.text;
            case "selector":
              return !!data.selector;
            case "ariaLabel":
              return !!data.ariaLabel;
            default:
              return false;
          }
        },
        {
          message:
            "Debes proporcionar los campos correctos para la estrategia elegida (role+name, text, selector o ariaLabel).",
        }
      ),
    execute: async ({
      strategy,
      role,
      name,
      text,
      selector,
      ariaLabel,
      index,
    }) => {
      const page = getPage();
      let locator;

      if (strategy === "role") {
        locator = page.getByRole(role as any, {
          name: new RegExp(name!, "i"),
        });
      } else if (strategy === "text") {
        locator = page.getByText(new RegExp(text!, "i"));
      } else if (strategy === "selector") {
        locator = page.locator(selector!);
      } else if (strategy === "ariaLabel") {
        // aria-label parcial, case-insensitive
        locator = page.locator(`[aria-label*="${ariaLabel!}"]`);
      } else {
        throw new Error(`Estrategia de click desconocida: ${strategy}`);
      }

      const count = await locator.count();

      if (count === 0) {
        throw new Error(
          `click: no encontré elementos usando strategy=${strategy}.`
        );
      }

      const safeIndex = Math.min(index!, count - 1);
      await locator.nth(safeIndex).click();

      return {
        strategy,
        role: role ?? null,
        name: name ?? null,
        text: text ?? null,
        selector: selector ?? null,
        ariaLabel: ariaLabel ?? null,
        matchesFound: count,
        clickedIndex: safeIndex,
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

  // Tool de alto nivel: enviar mensaje usando la lógica robusta de linkedin.service
  tools.send_message = tool({
    description:
      "Envía un mensaje a un perfil de LinkedIn que ya es conexión, usando Playwright con selectores robustos. Úsalo como PRIMER intento para enviar mensajes.",
    inputSchema: z.object({
      profileUrl: z
        .string()
        .describe(
          "URL completa del perfil de LinkedIn al que quieres escribir."
        ),
      message: z.string().describe("Texto del mensaje que quieres enviar."),
    }),
    execute: async ({ profileUrl, message }) => {
      const page = getPage();
      const result = await sendMessageToProfile(page, profileUrl, message);

      return {
        status: result.status,
        error: result.error ?? null,
        isConnection: result.analysis.isConnection,
        isLoggedIn: result.analysis.isLoggedIn,
        isHumanRequired: result.analysis.isHumanRequired,
        blockType: result.analysis.blockType,
      };
    },
  });

  // Tool de alto nivel: enviar invitación de conexión
  tools.send_connection_request = tool({
    description:
      "Envía una solicitud de conexión a un perfil de LinkedIn (con o sin nota) usando lógica robusta.",
    inputSchema: z.object({
      profileUrl: z
        .string()
        .describe(
          "URL completa del perfil de LinkedIn al que quieres conectar."
        ),
      note: z
        .string()
        .optional()
        .describe("Nota opcional para acompañar la invitación."),
    }),
    execute: async ({ profileUrl, note }) => {
      const page = getPage();
      const result = await sendConnectionRequest(page, profileUrl, note);

      return {
        status: result.status,
        error: result.error ?? null,
        isConnection: result.analysis.isConnection,
        isLoggedIn: result.analysis.isLoggedIn,
        isHumanRequired: result.analysis.isHumanRequired,
        blockType: result.analysis.blockType,
      };
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
- PRIORIDAD: intenta usar el tool de alto nivel send_message con profileUrl y message.
- Solo si send_message falla de forma clara puedes apoyarte en navigate, click, fill, wait
  y los tools de introspección (list_buttons y list_textboxes) o playwright_run_code.
- Si hay bloqueos o no estás logueado, no sigas e informa el problema.

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
- list_buttons, list_textboxes: para inspeccionar la estructura y los controles de la página.
- dom_snapshot: para ver el árbol de accesibilidad completo y encontrar elementos por rol y nombre.
- playwright_run_code: para ejecutar código Playwright arbitrario sobre la página actual usando la API oficial (page.getByRole, page.locator, etc.).
- login_with_credentials: cuando dispones de credenciales para iniciar sesión.
- check_profile_connection: operación de alto nivel que te dice si la sesión está logueada, si el perfil es conexión y si hay bloqueos.
- send_message: cuando ya sabes el perfil y el texto del mensaje, ÚSALO COMO PRIMERA OPCIÓN para enviar el mensaje.
- send_connection_request: cuando quieres enviar una invitación de conexión a un perfil.
- report_task_result: úsalo UNA vez al final para declarar el resultado estructurado (login_ok, invite_sent, message_sent, etc).

Reglas importantes:
- Cuando tu objetivo sea enviar un mensaje a un perfil concreto y ya tienes profileUrl y message,
  primero intenta usar el tool de alto nivel send_message.
- Solo si send_message falla claramente puedes apoyarte en playwright_run_code, click, fill, etc.
...
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
  const reportCalls = toolCalls.filter(
    (c) => c.toolName === "report_task_result"
  );
  const lastReport = reportCalls.length
    ? reportCalls[reportCalls.length - 1].result
    : null;

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

  if (lastReport) {
    const status = lastReport.status;
    if (task === "send_message") {
      success = status === "message_sent";
    } else if (task === "send_connection") {
      success = status === "invite_sent" || status === "already_connected";
    } else if (task === "login") {
      success = status === "login_ok";
    }
  } else {
    // Fallback defensivo: si el modelo no llamó report_task_result,
    // podés dejar success=false o mantener tu heurística textual antigua.
    success = false;
  }

  return {
    success,
    text: result.text,
    steps,
    toolCalls,
  };
}
