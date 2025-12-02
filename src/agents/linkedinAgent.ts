// src/agents/linkedinAgent.ts
import { generateText, tool, stepCountIs } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import OpenAI from "openai";
import { z } from "zod";

import { getActivePage } from "../browser/sessions";

// AI SDK provider (para generateText, tools, etc.)
const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

// Cliente oficial de OpenAI (para Vision / chat.completions)
const openaiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

/**
 * Analiza un screenshot con OpenAI Vision usando el cliente oficial
 */
async function analyzeScreenshot(base64Image: string): Promise<{
  isLoggedIn: boolean;
  isConnectionButton: boolean;
  isMessageButton: boolean;
  needsHumanIntervention: boolean;
  pageDescription: string;
}> {
  const response = await openaiClient.chat.completions.create({
    model: "gpt-5-nano",
    messages: [
      {
        role: "system",
        content: `Analyze this LinkedIn screenshot and return ONLY a JSON object with:
{
  "isLoggedIn": boolean,
  "isConnectionButton": boolean,
  "isMessageButton": boolean,
  "needsHumanIntervention": boolean,
  "pageDescription": "Brief description of what you see"
}`,
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Analyze this LinkedIn page:" },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${base64Image}` },
          },
        ],
      },
    ],
    temperature: 0,
  });

  const rawContent = response.choices[0]?.message?.content as any;

  // content puede ser string o array de partes, lo normalizamos a string
  const content =
    typeof rawContent === "string"
      ? rawContent
      : Array.isArray(rawContent)
      ? rawContent
          .filter((p) => p?.type === "text" && typeof p.text === "string")
          .map((p) => p.text)
          .join("\n")
      : "";

  if (!content) {
    throw new Error("No response from vision API");
  }

  return JSON.parse(content);
}

/**
 * Helper para obtener la Page o lanzar error
 */
function requirePage(sessionId: string) {
  const page = getActivePage(sessionId);
  if (!page) throw new Error("Session not found");
  return page;
}

/**
 * Tools que el agente puede usar (usando AI SDK tool() + zod)
 */
function createLinkedInTools(sessionId: string) {
  return {
    playwright_navigate: tool({
      description: "Navigate to a URL",
      inputSchema: z.object({
        url: z.string().describe("URL to navigate to"),
      }),
      execute: async ({ url }) => {
        const page = requirePage(sessionId);
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });
        await page.waitForTimeout(3000);
        return `Navigated to ${url}`;
      },
    }),

    playwright_click: tool({
      description: "Click an element by selector (CSS, text, role, etc.)",
      inputSchema: z.object({
        selector: z.string().describe("Element selector"),
      }),
      execute: async ({ selector }) => {
        const page = requirePage(sessionId);
        await page.click(selector, { timeout: 30000 });
        await page.waitForTimeout(2000);
        return `Clicked: ${selector}`;
      },
    }),

    playwright_fill: tool({
      description: "Fill a text input",
      inputSchema: z.object({
        selector: z.string().describe("Input selector"),
        value: z.string().describe("Text to fill"),
      }),
      execute: async ({ selector, value }) => {
        const page = requirePage(sessionId);
        await page.fill(selector, value);
        await page.waitForTimeout(1000);
        return `Filled ${selector}`;
      },
    }),

    playwright_screenshot: tool({
      description:
        "Take a screenshot and analyze with vision (returns analysis)",
      inputSchema: z.object({
        fullPage: z
          .boolean()
          .optional()
          .describe("Whether to capture a full page screenshot"),
      }),
      execute: async ({ fullPage = false }) => {
        const page = requirePage(sessionId);

        const buffer = await page.screenshot({
          type: "png",
          fullPage,
        });

        const analysis = await analyzeScreenshot(buffer.toString("base64"));
        return `Screenshot analysis: ${JSON.stringify(analysis)}`;
      },
    }),

    playwright_get_page_info: tool({
      description: "Get current page URL and title",
      inputSchema: z.object({}), // sin parámetros
      execute: async () => {
        const page = requirePage(sessionId);
        const url = page.url();
        const title = await page.title();
        return `Current page: ${title} (${url})`;
      },
    }),

    playwright_wait: tool({
      description:
        "Wait for a specific time (for page to load, etc.). Use this to wait between actions.",
      inputSchema: z.object({
        ms: z.number().describe("Milliseconds to wait"),
      }),
      execute: async ({ ms }) => {
        const page = requirePage(sessionId);
        await page.waitForTimeout(ms);
        return `Waited ${ms}ms`;
      },
    }),

    playwright_press_key: tool({
      description: "Press a keyboard key",
      inputSchema: z.object({
        key: z.string().describe("Key to press (Enter, Tab, Escape, etc.)"),
      }),
      execute: async ({ key }) => {
        const page = requirePage(sessionId);
        await page.keyboard.press(key);
        await page.waitForTimeout(1000);
        return `Pressed key: ${key}`;
      },
    }),
  };
}

/**
 * Agente principal de LinkedIn
 */
export async function runLinkedInAutonomousAgent(params: {
  sessionId: string;
  task: "login" | "send_connection" | "send_message";
  profileUrl?: string;
  message?: string;
  credentials?: {
    email: string;
    password: string;
  };
}) {
  const { sessionId, task, profileUrl, message, credentials } = params;

  const tools = createLinkedInTools(sessionId);

  const systemPrompt = `You are an autonomous LinkedIn automation agent using Playwright.

**YOUR CAPABILITIES:**
- Navigate pages
- Click elements (use specific selectors like 'button:has-text("Connect")', 'input[name="session_key"]')
- Fill forms
- Take screenshots and analyze them
- Press keys

**IMPORTANT RULES:**
1. ALWAYS take a screenshot first to understand current state
2. Use SPECIFIC selectors (CSS, text, role)
3. Wait between actions (use playwright_wait)
4. If you see CAPTCHA or verification → stop and report human intervention needed
5. Be patient: LinkedIn is slow, wait 3-5 seconds after navigation
6. Never share credentials in responses

**LINKEDIN SELECTORS (common patterns):**
- Login email: 'input[name="session_key"]' or 'input[id="username"]'
- Login password: 'input[name="session_password"]' or 'input[id="password"]'
- Login button: 'button[type="submit"]' or 'button:has-text("Sign in")'
- Connect button: 'button:has-text("Connect")' or 'button:has-text("Conectar")'
- Message button: 'button:has-text("Message")' or 'button:has-text("Mensaje")'
- Add note: 'button:has-text("Add a note")'
- Send button: 'button:has-text("Send")' or 'button:has-text("Enviar")'

**WORKFLOW:**
1. Take screenshot → analyze state
2. Navigate if needed
3. Interact with elements
4. Take screenshot → verify success
5. Report result`;

  let userPrompt = "";

  switch (task) {
    case "login":
      if (!credentials) throw new Error("Credentials required for login");
      userPrompt = `Log into LinkedIn with these credentials:
Email: ${credentials.email}
Password: [provided]

Steps:
1. Take screenshot to see current state
2. If not on login page, navigate to https://www.linkedin.com/login
3. Fill email and password
4. Click sign in
5. Wait and verify you're logged in
6. Report success`;
      break;

    case "send_connection":
      if (!profileUrl) throw new Error("Profile URL required");
      userPrompt = `Send a connection request to: ${profileUrl}

Steps:
1. Take screenshot of current state
2. Navigate to the profile URL
3. Wait for page to load (5 seconds)
4. Take screenshot to analyze
5. If you see "Connect" button → click it
6. If dialog appears with "Add a note" → click it and add: "${
        message || "Me gustaría conectar contigo"
      }"
7. Click "Send"
8. Verify success with screenshot
9. Report result`;
      break;

    case "send_message":
      if (!profileUrl) throw new Error("Profile URL required");
      if (!message) throw new Error("Message required");
      userPrompt = `Send a message to: ${profileUrl}

Message: "${message}"

Steps:
1. Navigate to profile
2. Verify it's a connection (should see "Message" button)
3. Click "Message" button
4. Fill the message box
5. Click "Send"
6. Verify success`;
      break;
  }

  const result = await generateText({
    model: openai("gpt-5-nano"),
    tools,
    stopWhen: stepCountIs(15), // antes: maxSteps: 15
    system: systemPrompt,
    prompt: userPrompt,
  });

  return {
    success: !result.text.toLowerCase().includes("error"),
    text: result.text,
    steps: result.steps,
    toolCalls: result.steps.flatMap((s) => s.toolCalls || []),
  };
}
