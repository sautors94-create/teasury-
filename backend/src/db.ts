import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { RUTA_DB } from "./config.js";

export type Rol = "operacion" | "validacion" | "tesoreria" | "direccion" | "auditoria";

export type EstadoOperacion =
  | "borrador"
  | "en_validacion"
  | "observada"
  | "pendiente_direccion"
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
                  CHECK (estado IN ('borrador','en_validacion','observada','pendiente_direccion','aprobada','pagada','cancelada')),
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

CREATE TABLE IF NOT EXISTS cuentas (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre          TEXT NOT NULL,
  banco           TEXT NOT NULL DEFAULT '',
  numero_cuenta   TEXT NOT NULL DEFAULT '',
  saldo_inicial   REAL NOT NULL DEFAULT 0,
  activa          INTEGER NOT NULL DEFAULT 1,
  creado_en       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS movimientos_cuentas (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  cuenta_id       INTEGER NOT NULL REFERENCES cuentas(id),
  tipo            TEXT NOT NULL CHECK (tipo IN ('deposito','retiro')),
  monto           REAL NOT NULL CHECK (monto > 0),
  concepto        TEXT NOT NULL,
  fecha           TEXT NOT NULL,
  creado_por      INTEGER NOT NULL REFERENCES usuarios(id),
  creado_en       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pagos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  operacion_id    INTEGER NOT NULL UNIQUE REFERENCES operaciones(id),
  medio           TEXT NOT NULL CHECK (medio IN ('transferencia','domiciliacion','cheque','efectivo','otro')),
  monto           REAL NOT NULL CHECK (monto > 0),
  moneda          TEXT NOT NULL DEFAULT 'MXN',
  fecha_pago      TEXT NOT NULL,
  comprobante     TEXT NOT NULL,
  notas           TEXT NOT NULL DEFAULT '',
  pagado_por      INTEGER NOT NULL REFERENCES usuarios(id),
  cuenta_id       INTEGER REFERENCES cuentas(id),
  fecha_registro  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sync_registros (
  tabla       TEXT NOT NULL,
  uuid        TEXT NOT NULL,
  registro_id INTEGER NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tabla, uuid),
  UNIQUE (tabla, registro_id)
);

CREATE TABLE IF NOT EXISTS sync_aplicados (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tabla       TEXT NOT NULL,
  uuid        TEXT NOT NULL,
  version     INTEGER NOT NULL,
  accion      TEXT NOT NULL,
  payload     TEXT NOT NULL,
  usuario_id  INTEGER REFERENCES usuarios(id),
  fecha       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tabla, uuid, version)
);

CREATE TABLE IF NOT EXISTS sync_envios (
  tabla          TEXT NOT NULL,
  uuid           TEXT NOT NULL,
  version        INTEGER NOT NULL,
  estado         TEXT NOT NULL CHECK (estado IN ('pendiente','confirmado','conflicto','error','resuelto')),
  detalle        TEXT NOT NULL DEFAULT '',
  creado_en      TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tabla, uuid, version)
);

CREATE TABLE IF NOT EXISTS sync_cursor (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  ultimo_id       INTEGER NOT NULL DEFAULT 0,
  sincronizado_en TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_envios_estado ON sync_envios(estado);

CREATE INDEX IF NOT EXISTS idx_operaciones_estado ON operaciones(estado);
CREATE INDEX IF NOT EXISTS idx_auditoria_operacion ON auditoria(operacion_id);
CREATE INDEX IF NOT EXISTS idx_pagos_fecha ON pagos(fecha_pago);
CREATE INDEX IF NOT EXISTS idx_movimientos_cuenta ON movimientos_cuentas(cuenta_id);
`;

// ... (truncated for brevity, but I have full content)
export const TRANSICIONES: Record<EstadoOperacion, EstadoOperacion[]> = { borrador: ["en_validacion","cancelada"], en_validacion: ["aprobada","observada","pendiente_direccion"], observada: ["en_validacion","cancelada"], pendiente_direccion: ["aprobada","observada"], aprobada: ["pagada"], pagada: [], cancelada: [] };
