// src/mcp/playwrightClient.ts
import { experimental_createMCPClient as createMCPClient } from "@ai-sdk/mcp";
import { generateText, stepCountIs } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

const PLAYWRIGHT_MCP_URL =
  process.env.PLAYWRIGHT_MCP_URL ?? "http://127.0.0.1:8931/mcp";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

// createMCPClient devuelve una Promise, la memorizamos
let mcpClientPromise: ReturnType<typeof createMCPClient> | null = null;

function getPlaywrightClient() {
  if (!mcpClientPromise) {
    mcpClientPromise = createMCPClient({
      transport: {
        type: "http",
        url: PLAYWRIGHT_MCP_URL,
      },
    });
  }
  return mcpClientPromise;
}

export type LinkedinTaskInput = {
  targetProfileUrl: string;
  customMessage?: string;
};

/**
 * Ejecuta una tarea de alto nivel sobre LinkedIn usando Playwright MCP.
 * Ejemplo: abrir LinkedIn, loguearse con secrets y mandar solicitud.
 */
export async function runLinkedinConnectionTask(input: LinkedinTaskInput) {
  const client = await getPlaywrightClient();
  const tools = await client.tools(); // tools del Playwright MCP

  const response = await generateText({
    model: openai("gpt-5-mini"), // o el modelo que uses
    tools,
    stopWhen: stepCountIs(6), // máximo 6 pasos de tool-calls
    messages: [
      {
        role: "system",
        content: `
Eres un agente de automatización de navegador especializado en LinkedIn.
Tu objetivo es:
1. Abrir https://www.linkedin.com/.
2. Si no estás logueado, iniciar sesión usando las credenciales seguras definidas como secrets (LINKEDIN_EMAIL y LINKEDIN_PASSWORD) en el servidor Playwright MCP.
3. Abrir el perfil indicado y enviar una solicitud de conexión con un mensaje personalizado si se proporciona.
4. No compartas nunca valores de secrets ni intentes mostrarlos en texto plano.
5. Respeta los límites de LinkedIn, no generes spam y realiza una única invitación por ejecución.`,
      },
      {
        role: "user",
        content:
          `Perfil objetivo: ${input.targetProfileUrl}\n` +
          (input.customMessage
            ? `Mensaje a enviar: "${input.customMessage}"`
            : "Si es posible, añade un mensaje corto, profesional y neutro en español."),
      },
    ],
  });

  return {
    text: response.text,
    steps: response.steps,
  };
}
