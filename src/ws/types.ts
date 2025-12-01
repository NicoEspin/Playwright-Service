// src/ws/types.ts

// Mensajes que el CLIENTE manda al servidor
export type ClientMessage =
  | { type: "click"; x: number; y: number }
  | { type: "type"; text: string }
  | { type: "goto"; url: string }
  | { type: "keydown"; key: string }
  | { type: "keyup"; key: string }
  | { type: "scroll"; deltaX: number; deltaY: number }      // 👈 rueda del ratón
  | { type: "new_tab"; url?: string }                       // 👈 nueva pestaña
  | { type: "switch_tab"; index: number }                   // 👈 cambiar pestaña
  | { type: "close_tab"; index: number }                    // 👈 cerrar pestaña
  | {
      type: "unknown";
      [key: string]: unknown;
    };

// Mensajes que el SERVIDOR manda al cliente (SOLO CONTROL, no frames)
export type ServerMessage =
  | {
      type: "session_started";
      sessionId: string;
      viewport: { width: number; height: number };
    }
  | { type: "error"; message: string }
  | {
      type: "tabs_state";                                   // 👈 estado de pestañas
      activeIndex: number;
      tabs: {
        index: number;
        url: string;
        title: string;
      }[];
    };
