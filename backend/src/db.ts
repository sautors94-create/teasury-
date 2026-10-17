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

CREATE INDEX IF NOT EXISTS idx_operaciones_estado ON operaciones(estado);
CREATE INDEX IF NOT EXISTS idx_auditoria_operacion ON auditoria(operacion_id);
CREATE INDEX IF NOT EXISTS idx_pagos_fecha ON pagos(fecha_pago);
CREATE INDEX IF NOT EXISTS idx_movimientos_cuenta ON movimientos_cuentas(cuenta_id);
`;

export function abrirBase(ruta: string = RUTA_DB): Database.Database {
  if (!ruta.includes(":memory:")) mkdirSync(dirname(ruta), { recursive: true });
  const db = new Database(ruta);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(ESQUEMA);
  migrarEsquema(db);
  migrarPagos(db);
  sembrarUsuarios(db);
  return db;
}

/** Añade `pagos.cuenta_id` a bases creadas antes de la fase de recursos. */
function migrarPagos(db: Database.Database): void {
  const columnas = (db.pragma("table_info(pagos)") as Array<{ name: string }>).map((c) => c.name);
  if (columnas.length > 0 && !columnas.includes("cuenta_id")) {
    db.exec("ALTER TABLE pagos ADD COLUMN cuenta_id INTEGER REFERENCES cuentas(id)");
    console.log("[migración] pagos.cuenta_id añadida");
  }
}

/**
 * Reconstruye `operaciones` si la base proviene de una versión anterior
 * (CHECK de estado sin `pendiente_direccion`). Los hijos conservan su FK
 * porque `legacy_alter_table` evita que el RENAME reescriba sus referencias.
 */
function migrarEsquema(db: Database.Database): void {
  const tabla = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'operaciones'")
    .get() as { sql: string } | undefined;
  if (!tabla || tabla.sql.includes("pendiente_direccion")) return;

  db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");
  try {
    db.exec(`
      ALTER TABLE operaciones RENAME TO operaciones_old;
      CREATE TABLE operaciones (
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
      INSERT INTO operaciones (id, folio, tipo, concepto, proveedor, monto, moneda, fecha_operacion, estado, creado_por, creado_en, actualizado_en)
        SELECT id, folio, tipo, concepto, proveedor, monto, moneda, fecha_operacion, estado, creado_por, creado_en, actualizado_en FROM operaciones_old;
      DROP TABLE operaciones_old;
    `);
    db.pragma("legacy_alter_table = OFF");
    db.pragma("foreign_keys = ON");
    console.log("[migración] operaciones reconstruida con estado 'pendiente_direccion'");
  } catch (e) {
    db.pragma("legacy_alter_table = OFF");
    db.pragma("foreign_keys = ON");
    throw e;
  }
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

export const MEDIOS_PAGO = ["transferencia", "domiciliacion", "cheque", "efectivo", "otro"] as const;
export type MedioPago = (typeof MEDIOS_PAGO)[number];

export interface Pago {
  id: number;
  operacion_id: number;
  medio: MedioPago;
  monto: number;
  moneda: string;
  fecha_pago: string;
  comprobante: string;
  notas: string;
  pagado_por: number;
  cuenta_id: number | null;
  fecha_registro: string;
}

export interface Cuenta {
  id: number;
  nombre: string;
  banco: string;
  numero_cuenta: string;
  saldo_inicial: number;
  activa: number;
  creado_en: string;
}

export interface MovimientoCuenta {
  id: number;
  cuenta_id: number;
  tipo: "deposito" | "retiro";
  monto: number;
  concepto: string;
  fecha: string;
  creado_por: number;
  creado_en: string;
}

/** Tablas incluidas en el protocolo de sincronización (fase actual). */
export const TABLAS_SYNC = ["operaciones"] as const;
export type TablaSync = (typeof TABLAS_SYNC)[number];

/**
 * Emite un cambio local al log de sincronización: asigna/avanza la versión del
 * registro (uuid + version) y agrega el registro al log de "aplicados", que es
 * lo que otros clientes leen vía GET /api/sync/pull (cursor por id).
 */
export function emitir(db: Database.Database, tabla: TablaSync, registroId: number, usuarioId: number): void {
  const fila = db.prepare(`SELECT * FROM ${tabla} WHERE id = ?`).get(registroId) as
    | Record<string, unknown>
    | undefined;
  if (!fila) return;
  const mapa = db
    .prepare("SELECT * FROM sync_registros WHERE tabla = ? AND registro_id = ?")
    .get(tabla, registroId) as { uuid: string; version: number } | undefined;
  const uuid = mapa?.uuid ?? randomUUID();
  const version = (mapa?.version ?? 0) + 1;
  db.prepare(
    `INSERT INTO sync_registros (tabla, uuid, registro_id, version) VALUES (?, ?, ?, ?)
     ON CONFLICT (tabla, uuid) DO UPDATE SET version = excluded.version`
  ).run(tabla, uuid, registroId, version);
  db.prepare(
    `INSERT OR IGNORE INTO sync_aplicados (tabla, uuid, version, accion, payload, usuario_id)
     VALUES (?, ?, ?, 'upsert', ?, ?)`
  ).run(tabla, uuid, version, JSON.stringify(fila), usuarioId);
}

export const TRANSICIONES: Record<EstadoOperacion, EstadoOperacion[]> = {
  borrador: ["en_validacion", "cancelada"],
  en_validacion: ["aprobada", "observada", "pendiente_direccion"],
  observada: ["en_validacion", "cancelada"],
  pendiente_direccion: ["aprobada", "observada"],
  aprobada: ["pagada"],
  pagada: [],
  cancelada: [],
};