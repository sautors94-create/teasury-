import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { RUTA_DB } from "./config.js";

export type Rol = "operacion" | "validacion" | "tesoreria" | "direccion" | "auditoria";

export type EstadoOperacion =
  | "borrador"
  | "en_validacion"
  | "observada"
  | "aprobada"
  | "pagada"
  | "cancelada";

export interface Usuario {
  id: number;
  username: string;
  nombre: string;
  rol: Rol;
}

export interface Operacion {
  id: number;
  folio: string;
  tipo: "pago" | "cobro" | "financiamiento";
  concepto: string;
  proveedor: string;
  monto: number;
  moneda: string;
  fecha_operacion: string;
  estado: EstadoOperacion;
  creado_por: number;
  creado_en: string;
  actualizado_en: string;
}

export interface Revision {
  id: number;
  operacion_id: number;
  revisor_id: number;
  resultado: "aprobada" | "observada";
  comentario: string;
  fecha: string;
}

export interface EventoAuditoria {
  id: number;
  operacion_id: number | null;
  usuario_id: number;
  accion: string;
  detalle: string;
  fecha: string;
}

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS usuarios (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  nombre        TEXT NOT NULL,
  rol           TEXT NOT NULL CHECK (rol IN ('operacion','validacion','tesoreria','direccion','auditoria')),
  activo        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS operaciones (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  folio           TEXT NOT NULL UNIQUE,
  tipo            TEXT NOT NULL CHECK (tipo IN ('pago','cobro','financiamiento')),
  concepto        TEXT NOT NULL,
  proveedor       TEXT NOT NULL,
  monto           REAL NOT NULL CHECK (monto > 0),
  moneda          TEXT NOT NULL DEFAULT 'MXN',
  fecha_operacion TEXT NOT NULL,
  estado          TEXT NOT NULL DEFAULT 'borrador'
                  CHECK (estado IN ('borrador','en_validacion','observada','aprobada','pagada','cancelada')),
  creado_por      INTEGER NOT NULL REFERENCES usuarios(id),
  creado_en       TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado_en  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS revisiones (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  operacion_id  INTEGER NOT NULL REFERENCES operaciones(id),
  revisor_id    INTEGER NOT NULL REFERENCES usuarios(id),
  resultado     TEXT NOT NULL CHECK (resultado IN ('aprobada','observada')),
  comentario    TEXT NOT NULL,
  fecha         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS auditoria (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  operacion_id  INTEGER REFERENCES operaciones(id),
  usuario_id    INTEGER NOT NULL REFERENCES usuarios(id),
  accion        TEXT NOT NULL,
  detalle       TEXT NOT NULL,
  fecha         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_operaciones_estado ON operaciones(estado);
CREATE INDEX IF NOT EXISTS idx_auditoria_operacion ON auditoria(operacion_id);
`;

export function abrirBase(ruta: string = RUTA_DB): Database.Database {
  if (!ruta.includes(":memory:")) mkdirSync(dirname(ruta), { recursive: true });
  const db = new Database(ruta);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(ESQUEMA);
  sembrarUsuarios(db);
  return db;
}

function sembrarUsuarios(db: Database.Database): void {
  const cuenta = db.prepare("SELECT COUNT(*) AS n FROM usuarios").get() as { n: number };
  if (cuenta.n > 0) return;
  const insertar = db.prepare(
    "INSERT INTO usuarios (username, password_hash, nombre, rol) VALUES (?, ?, ?, ?)"
  );
  const semilla: Array<[string, string, Rol]> = [
    ["operador", "Capturista de Operaciones", "operacion"],
    ["validador", "Validador de Operaciones", "validacion"],
    ["tesoreria", "Analista de Tesorería", "tesoreria"],
    ["direccion", "Dirección", "direccion"],
    ["auditor", "Auditoría", "auditoria"],
  ];
  for (const [username, nombre, rol] of semilla) {
    // Password por defecto igual al username (cambiar en producción).
    insertar.run(username, bcrypt.hashSync(username, 10), nombre, rol);
  }
}

export const TRANSICIONES: Record<EstadoOperacion, EstadoOperacion[]> = {
  borrador: ["en_validacion", "cancelada"],
  en_validacion: ["aprobada", "observada"],
  observada: ["en_validacion", "cancelada"],
  aprobada: ["pagada"],
  pagada: [],
  cancelada: [],
};