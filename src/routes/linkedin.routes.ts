// src/routes/linkedin.routes.ts
import { Router } from "express";
import {
  runLinkedinConnectionTask,
  LinkedinTaskInput,
} from "../mcp/playwrightClient";

const router = Router();

router.post("/connect", async (req, res) => {
  try {
    const { targetProfileUrl, customMessage } = req.body as LinkedinTaskInput;

    if (!targetProfileUrl) {
      return res.status(400).json({ error: "targetProfileUrl es obligatorio" });
    }

    const result = await runLinkedinConnectionTask({
      targetProfileUrl,
      customMessage,
    });

    return res.json({
      ok: true,
      text: result.text,
      steps: result.steps,
    });
  } catch (err) {
    console.error("Error en /linkedin/connect:", err);
    return res.status(500).json({
      ok: false,
      error: "Error ejecutando tarea de LinkedIn",
    });
  }
});

export default router;
