// src/mcp/server.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { getActivePage, getSession } from "../browser/sessions";
import type { Page } from "playwright";

// Definimos los tools que expondremos
const TOOLS: Tool[] = [
  {
    name: "playwright_navigate",
    description: "Navigate to a URL in the active browser page",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "Browser session ID",
        },
        url: {
          type: "string",
          description: "URL to navigate to",
        },
      },
      required: ["sessionId", "url"],
    },
  },
  {
    name: "playwright_click",
    description: "Click an element using a selector (CSS, text, role, etc.)",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "Browser session ID",
        },
        selector: {
          type: "string",
          description: "Element selector (CSS, text:..., role:button, etc.)",
        },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds (default: 30000)",
        },
      },
      required: ["sessionId", "selector"],
    },
  },
  {
    name: "playwright_fill",
    description: "Fill a text input field",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "Browser session ID",
        },
        selector: {
          type: "string",
          description: "Input field selector",
        },
        value: {
          type: "string",
          description: "Text to fill",
        },
      },
      required: ["sessionId", "selector", "value"],
    },
  },
  {
    name: "playwright_screenshot",
    description: "Take a screenshot of the current page (returns base64)",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "Browser session ID",
        },
        fullPage: {
          type: "boolean",
          description: "Take full page screenshot (default: false)",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "playwright_evaluate",
    description: "Execute JavaScript in the page context and return the result",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "Browser session ID",
        },
        script: {
          type: "string",
          description: "JavaScript code to execute",
        },
      },
      required: ["sessionId", "script"],
    },
  },
  {
    name: "playwright_get_text",
    description: "Get text content from an element",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "Browser session ID",
        },
        selector: {
          type: "string",
          description: "Element selector",
        },
      },
      required: ["sessionId", "selector"],
    },
  },
  {
    name: "playwright_wait_for_selector",
    description: "Wait for an element to appear on the page",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "Browser session ID",
        },
        selector: {
          type: "string",
          description: "Element selector to wait for",
        },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds (default: 30000)",
        },
      },
      required: ["sessionId", "selector"],
    },
  },
  {
    name: "playwright_press_key",
    description: "Press a keyboard key",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "Browser session ID",
        },
        key: {
          type: "string",
          description: "Key to press (e.g., 'Enter', 'Tab', 'Escape')",
        },
      },
      required: ["sessionId", "key"],
    },
  },
];

/**
 * Crea y retorna el servidor MCP configurado
 */
export function createMCPServer() {
  const server = new Server(
    {
      name: "playwright-automation-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Handler: listar tools disponibles
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  // Handler: ejecutar un tool
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case "playwright_navigate": {
          const { sessionId, url } = args as {
            sessionId: string;
            url: string;
          };
          const page = getActivePage(sessionId);
          if (!page) {
            throw new Error(`Session ${sessionId} not found`);
          }

          await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: 60000,
          });

          return {
            content: [
              {
                type: "text",
                text: `Navigated to ${url}`,
              },
            ],
          };
        }

        case "playwright_click": {
          const { sessionId, selector, timeout = 30000 } = args as {
            sessionId: string;
            selector: string;
            timeout?: number;
          };
          const page = getActivePage(sessionId);
          if (!page) {
            throw new Error(`Session ${sessionId} not found`);
          }

          await page.click(selector, { timeout });

          return {
            content: [
              {
                type: "text",
                text: `Clicked element: ${selector}`,
              },
            ],
          };
        }

        case "playwright_fill": {
          const { sessionId, selector, value } = args as {
            sessionId: string;
            selector: string;
            value: string;
          };
          const page = getActivePage(sessionId);
          if (!page) {
            throw new Error(`Session ${sessionId} not found`);
          }

          await page.fill(selector, value);

          return {
            content: [
              {
                type: "text",
                text: `Filled ${selector} with text`,
              },
            ],
          };
        }

        case "playwright_screenshot": {
          const { sessionId, fullPage = false } = args as {
            sessionId: string;
            fullPage?: boolean;
          };
          const page = getActivePage(sessionId);
          if (!page) {
            throw new Error(`Session ${sessionId} not found`);
          }

          const buffer = await page.screenshot({
            type: "png",
            fullPage,
          });

          return {
            content: [
              {
                type: "text",
                text: `Screenshot taken (${buffer.length} bytes)`,
              },
              {
                type: "resource",
                resource: {
                  uri: `data:image/png;base64,${buffer.toString("base64")}`,
                  mimeType: "image/png",
                },
              },
            ],
          };
        }

        case "playwright_evaluate": {
          const { sessionId, script } = args as {
            sessionId: string;
            script: string;
          };
          const page = getActivePage(sessionId);
          if (!page) {
            throw new Error(`Session ${sessionId} not found`);
          }

          const result = await page.evaluate(script);

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case "playwright_get_text": {
          const { sessionId, selector } = args as {
            sessionId: string;
            selector: string;
          };
          const page = getActivePage(sessionId);
          if (!page) {
            throw new Error(`Session ${sessionId} not found`);
          }

          const text = await page.textContent(selector);

          return {
            content: [
              {
                type: "text",
                text: text || "",
              },
            ],
          };
        }

        case "playwright_wait_for_selector": {
          const { sessionId, selector, timeout = 30000 } = args as {
            sessionId: string;
            selector: string;
            timeout?: number;
          };
          const page = getActivePage(sessionId);
          if (!page) {
            throw new Error(`Session ${sessionId} not found`);
          }

          await page.waitForSelector(selector, { timeout });

          return {
            content: [
              {
                type: "text",
                text: `Element found: ${selector}`,
              },
            ],
          };
        }

        case "playwright_press_key": {
          const { sessionId, key } = args as {
            sessionId: string;
            key: string;
          };
          const page = getActivePage(sessionId);
          if (!page) {
            throw new Error(`Session ${sessionId} not found`);
          }

          await page.keyboard.press(key);

          return {
            content: [
              {
                type: "text",
                text: `Pressed key: ${key}`,
              },
            ],
          };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

/**
 * Inicia el servidor MCP con transporte stdio
 * (para uso con Claude Desktop o similar)
 */
export async function runMCPServer() {
  const server = createMCPServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Playwright MCP Server running on stdio");
}