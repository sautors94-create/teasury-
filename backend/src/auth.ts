import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { SECRETO_JWT } from "./config.js";
import type { Rol, Usuario } from "./db.js";

export interface Sesion extends Usuario {
  iat?: number;
  exp?: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      usuario?: Sesion;
    }
  }
}

export function firmarToken(usuario: Usuario): string {
  return jwt.sign({ id: usuario.id, username: usuario.username, nombre: usuario.nombre, rol: usuario.rol }, SECRETO_JWT, {
    expiresIn: "12h",
  });
}

export function autenticar(req: Request, res: Response, next: NextFunction): void {
  const encabezado = req.headers.authorization;
  if (!encabezado?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Token de autenticación requerido" });
    return;
  }
  try {
    req.usuario = jwt.verify(encabezado.slice(7), SECRETO_JWT) as Sesion;
    next();
  } catch {
    res.status(401).json({ error: "Token inválido o expirado" });
  }
}

export function requiereRol(...roles: Rol[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.usuario) {
      res.status(401).json({ error: "No autenticado" });
      return;
    }
    if (!roles.includes(req.usuario.rol)) {
      res.status(403).json({
        error: `Requiere el rol: ${roles.join(" o ")}. Tu rol: ${req.usuario.rol}`,
      });
      return;
    }
    next();
  };
}