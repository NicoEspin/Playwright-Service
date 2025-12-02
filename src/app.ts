// src/app.ts
import express from "express";
import cors from "cors";
import healthRouter from "./routes/health.routes";
import linkedinRouter from "./routes/linkedin.routes";
import agentRouter from "./routes/agent.routes"; // 👈 NUEVO

export function createApp() {
  const app = express();

  // CORS global
  app.use(
    cors({
      origin: true,
      credentials: false,
    })
  );

  // Middleware base
  app.use(express.json());

  // Health checks
  app.use("/health", healthRouter);
  app.use("/api/v1/health", healthRouter);

  // LinkedIn manual endpoints (existentes)
  app.use("/api/v1/linkedin", linkedinRouter);

  // 🤖 LinkedIn autonomous agent endpoints (NUEVO)
  app.use("/api/v1/agent", agentRouter);

  return app;
}