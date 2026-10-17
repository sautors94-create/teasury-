import type { Database } from "better-sqlite3";
import type { EstadoOperacion, Operacion } from "./db.js";
import { TRANSICIONES } from "./db.js";

export class ErrorDominio extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export function registrarAuditoria(
  db: Database,
  usuarioId: number,
  accion: string,
  detalle: string,
  operacionId: number | null = null
): void {
  db.prepare(
    "INSERT INTO auditoria (operacion_id, usuario_id, accion, detalle) VALUES (?, ?, ?, ?)"
  ).run(operacionId, usuarioId, accion, detalle);
}

export function cambiarEstado(
  db: Database,
  operacion: Operacion,
  destino: EstadoOperacion,
  usuarioId: number
): Operacion {
  const permitidos = TRANSICIONES[operacion.estado];
  if (!permitidos.includes(destino)) {
    throw new ErrorDominio(
      409,
      `Transición inválida: '${operacion.estado}' → '${destino}'. Permitidas: ${permitidos.join(", ") || "ninguna"}`
    );
  }
  db.prepare("UPDATE operaciones SET estado = ?, actualizado_en = datetime('now') WHERE id = ?").run(
    destino,
    operacion.id
  );
  registrarAuditoria(
    db,
    usuarioId,
    "cambio_estado",
    `Estado '${operacion.estado}' → '${destino}'`,
    operacion.id
  );
  return obtenerOperacion(db, operacion.id);
}

export function obtenerOperacion(db: Database, id: number): Operacion {
  const op = db.prepare("SELECT * FROM operaciones WHERE id = ?").get(id) as Operacion | undefined;
  if (!op) {
    throw new ErrorDominio(404, "Operación no encontrada");
  }
  return op;
}