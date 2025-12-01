// src/sessions.ts
import { chromium, Browser, Page } from "playwright";
import crypto from "crypto";

export interface SessionData {
  browser: Browser;
  pages: Page[];
  activeIndex: number; // índice de pestaña activa
}

const sessions = new Map<string, SessionData>();

/**
 * Crea una nueva sesión de navegador (Chromium + primera page).
 */
export async function createSession(): Promise<{
  sessionId: string;
  browser: Browser;
  page: Page;
}> {
  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== "false",
  });

  const page = await browser.newPage();

  await page.setViewportSize({ width: 1024, height: 576 });

  await page.goto("https://www.linkedin.com/login", {
    waitUntil: "domcontentloaded",
  });

  const sessionId = crypto.randomUUID();

  const session: SessionData = {
    browser,
    pages: [page],
    activeIndex: 0,
  };

  sessions.set(sessionId, session);

  // Devolvemos page para mantener compatibilidad con código existente
  return { sessionId, browser, page };
}

/**
 * Devuelve la sesión guardada para un id.
 */
export function getSession(sessionId: string): SessionData | undefined {
  return sessions.get(sessionId);
}

/**
 * Devuelve la pestaña activa de una sesión.
 */
export function getActivePage(sessionId: string): Page | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  return session.pages[session.activeIndex];
}

/**
 * Cierra navegador + todas las pestañas y elimina la sesión.
 */
export async function destroySession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;

  try {
    for (const page of session.pages) {
      if (!page.isClosed()) {
        await page.close();
      }
    }
    await session.browser.close();
  } catch (err) {
    console.error("Error al cerrar sesión:", err);
  }

  sessions.delete(sessionId);
}

/**
 * Crea una nueva pestaña dentro de la sesión.
 */
export async function createTab(
  sessionId: string,
  url?: string
): Promise<Page | null> {
  const session = sessions.get(sessionId);
  if (!session) return null;

  const page = await session.browser.newPage();
  await page.setViewportSize({ width: 1024, height: 576 });

  if (url) {
    await page.goto(url, { waitUntil: "domcontentloaded" });
  }

  session.pages.push(page);
  session.activeIndex = session.pages.length - 1;

  return page;
}

/**
 * Cambia la pestaña activa.
 */
export function setActiveTab(sessionId: string, index: number): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (index < 0 || index >= session.pages.length) return;

  session.activeIndex = index;
}

/**
 * Cierra una pestaña.
 */
export async function closeTab(
  sessionId: string,
  index: number
): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (index < 0 || index >= session.pages.length) return;

  const [page] = session.pages.splice(index, 1);

  try {
    if (!page.isClosed()) {
      await page.close();
    }
  } catch (err) {
    console.error("Error al cerrar pestaña:", err);
  }

  if (session.pages.length === 0) {
    // Si no quedan pestañas, destruimos toda la sesión
    await destroySession(sessionId);
    return;
  }

  // Acomodamos activeIndex
  if (session.activeIndex >= session.pages.length) {
    session.activeIndex = session.pages.length - 1;
  }
}
