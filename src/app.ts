// src/app.ts
import express from "express";
import healthRouter from "./routes/health.routes";
import linkedinRouter from "./routes/linkedin.routes";

export function createApp() {
  const app = express();

  // Middleware base
  app.use(express.json());

  // Rutas HTTP
  app.use("/health", healthRouter);
  app.use("/linkedin", linkedinRouter);

  return app;
}
