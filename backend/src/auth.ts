import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { SECRETO_JWT } from "./config.js";
import { CARGO_A_ROL } from "./db.js";
import type { Cargo, Rol, Usuario } from "./db.js";

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
  return jwt.sign(
    { id: usuario.id, username: usuario.username, nombre: usuario.nombre, rol: usuario.rol, cargos: usuario.cargos ?? [] },
    SECRETO_JWT,
    {
      expiresIn: "12h",
    }
  );
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

/**
 * Guarda de autorización por rol. Un acceso se concede si el rol del usuario
 * está en la lista pedida, o si alguno de sus CARGOS de Tesorería equivale a
 * un rol pedido (p. ej. el cargo 'fondeador' otorga las funciones del rol
 * 'fondeador'): así un tesorero puede acumular uno o varios cargos
 * (validador, altas, confirmador, fondeador) sin cambiar su rol base.
 */
export function requiereRol(...roles: Rol[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.usuario) {
      res.status(401).json({ error: "No autenticado" });
      return;
    }
    const cargos = (req.usuario.cargos ?? []) as Cargo[];
    const porCargo = cargos.some((c) => roles.includes(CARGO_A_ROL[c]));
    if (!roles.includes(req.usuario.rol) && !porCargo) {
      res.status(403).json({
        error: `Requiere el rol: ${roles.join(" o ")}. Tu rol: ${req.usuario.rol}`,
      });
      return;
    }
    next();
  };
}