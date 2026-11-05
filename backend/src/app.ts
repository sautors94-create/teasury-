import express from "express";
import cors from "cors";
import type { Database } from "better-sqlite3";
import { crearRouter } from "./rutas.js";

export function crearApp(db: Database): express.Express {
  const app = express();
  app.use(cors());
  // Los comprobantes viajan en base64 dentro del JSON: el límite por defecto
  // de express (100 KB) rechazaba en silencio casi cualquier archivo real.
  app.use(express.json({ limit: "50mb" }));
  app.use("/api", crearRouter(db));
  app.use((_req, res) => res.status(404).json({ error: "Ruta no encontrada" }));
  return app;
}