// src/server.ts
import "dotenv/config";

import http from "http";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";

import { createApp } from "./app";
import { handleConnection } from "./ws/connection";

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;

const app = createApp();
const server = http.createServer(app);

// WebSocketServer montado sobre el mismo server HTTP
const wss = new WebSocketServer({
  server,
  path: "/ws", // ws://host:4000/ws
});

wss.on("connection", (ws: WebSocket) => {
  // delegamos la lógica a un handler separado
  void handleConnection(ws);
});

server.listen(PORT, () => {
  console.log(
    `Playwright WebSocket server escuchando en http://localhost:${PORT}`
  );
});
