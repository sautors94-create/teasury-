import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { RUTA_DB } from "./config.js";
import { SEMILLA_BANCOS } from "./semilla-bancos.js";

export type Rol =
  | "admin"
  | "admin_operaciones"
  | "admin_validacion"
  | "admin_tesoreria"
  | "operacion"
  | "validacion"
  | "validador_tesoreria"
  | "confirmador"
  | "tesoreria"
  | "fondeador"
  | "altas"
  | "direccion"
  | "auditoria";

/** Todos los roles válidos del sistema (docs/roles: 01-ROLES.md §3-§8 + Fondeador y Altas). */
export const ROLES: Rol[] = [
  "admin",
  "admin_operaciones",
  "admin_validacion",
  "admin_tesoreria",
  "operacion",
  "validacion",
  "validador_tesoreria",
  "confirmador",
  "tesoreria",
  "fondeador",
  "altas",
  "direccion",
  "auditoria",
];

/** Tipos de cuenta de Tesorería (el negocio opera flujos, frentes, préstamos,
 *  anticipos a rendimientos, SOFOM y asimilados). Sólo el Administrador crea
 *  cuentas; el tipo determina a qué bolsa pertenece el dinero. */
export const TIPOS_CUENTA = [
  "flujo",
  "frente",
  "prestamo",
  "anticipo_rendimiento",
  "sofom",
  "asimilado",
] as const;
export type TipoCuenta = (typeof TIPOS_CUENTA)[number];

export type EstadoOperacion =
  | "borrador"
  | "en_validacion"
  | "observada"
  | "pendiente_direccion"
  | "aprobada"
  | "en_pago"
  | "pagada"
  | "cancelada";

export type TipoOperacion = "pago" | "cobro" | "financiamiento" | "flujo" | "pago_especial";

export interface Usuario {
  id: number;
  username: string;
  nombre: string;
  rol: Rol;
}

export interface Operacion {
  id: number;
  folio: string;
  tipo: TipoOperacion;
  concepto: string;
  proveedor: string;
  monto: number;
  moneda: string;
  fecha_operacion: string;
  estado: EstadoOperacion;
  cliente_id: number | null;
  /** Formato FLUJO (captura completa): quién paga la operación. */
  pagador: string;
  /** Tipo de operación del negocio (catálogo 'tipo_operacion', ej. FLUJOS). */
  tipo_operacion: string;
  /** ¿Se timbra (factura)? Sí = 1 / No = 0. */
  timbrar: number;
  /** Porcentaje de comisión que cobra la operación sobre el monto pagado. */
  comision_pct: number;
  /** Fase 14: porcentaje de comisión que va DIRECTO al resguardo de TRF
   *  (preestablecida por el cliente o indicada al capturar; NULL = no aplica). */
  comision_trf_pct: number | null;
  /** Observaciones o instrucciones especiales de la captura. */
  observaciones: string;
  creado_por: number;
  creado_en: string;
  actualizado_en: string;
  /** Liberación del Tesorero Fondeador: el analista de Tesorería no ve ni
   *  paga la operación hasta que el Fondeador la libera (visibilidad Fase 12). */
  liberada_por: number | null;
  liberada_en: string | null;
}

/** Catálogo de brokers: intermediarios que participan del cobro de comisión. */
export interface Broker {
  id: number;
  nombre: string;
  /** Porcentaje del total de la comisión que le corresponde. */
  porcentaje: number;
  activo: number;
  creado_en: string;
}

/** Broker participante en una operación (copia de seguridad de nombre/%/monto). */
export interface OperacionBroker {
  id: number;
  operacion_id: number;
  broker_id: number;
  nombre: string;
  porcentaje: number;
  monto: number;
}

/**
 * Línea de dispersión del formato FLUJO: a quién se le paga, con qué datos
 * bancarios y cuánto. El "Flujo Total" del formato es la suma de sus importes.
 */
export interface Dispersion {
  id: number;
  operacion_id: number;
  orden: number;
  beneficiario: string;
  razon_social: string;
  referencia: string;
  ine: string;
  numero: string;
  tarjeta: string;
  cuenta: string;
  clabe: string;
  banco: string;
  etiqueta: string;
  /** Fase 14: datos de la persona beneficiaria y del pago, TODOS OPCIONALES
   *  (el sistema no los hace obligatorios, ni en captura ni por layout). */
  nombre: string;
  apellido_paterno: string;
  apellido_materno: string;
  concepto: string;
  referencia_pago: string;
  importe: number;
  pagadora: string;
  pagadora_cuenta_id: number | null;
}

/**
 * Pago especial (Fase 14): operación de retiro respaldada por un resguardo
 * (TRF o broker). El ejecutivo adjunta el formato (p.ej. SAT), captura el
 * importe, la pagadora y una descripción breve; al pagarse descuenta del
 * resguardo de origen (append-only, como las comisiones de brokers).
 */
export interface PagoEspecial {
  operacion_id: number;
  descripcion: string;
  pagadora_cuenta_id: number | null;
  pagadora: string;
  resguardo_origen: "trf" | "broker";
  broker_origen_id: number | null;
  broker_origen: string;
  formato_nombre: string;
  formato_mime: string;
  formato_contenido: string;
  creado_por: number;
  creado_en: string;
}

/**
 * Pagadora/frente de la operación seleccionado del catálogo de Tesorería
 * (Tarea 12). cuenta_id NULL = "CUALQUIER <tipo>" (Tesorería determina la
 * cuenta concreta); nombre es la fotografía del catálogo al capturar.
 */
export interface DestinoOperacion {
  id: number;
  operacion_id: number;
  cuenta_id: number | null;
  tipo: string;
  nombre: string;
  manejo_manual: number;
}

/** Cálculos del formato FLUJO (iguales a los del Excel del negocio). */
export interface CalculosFlujo {
  /** IVA desglosado del monto pagado (16/116). */
  iva: number;
  /** Neto (subtotal) sin IVA (100/116). */
  neto: number;
  /** Comisión total de la operación (monto × comision_pct). */
  comision_total: number;
  /** Parte de la comisión asignada a brokers (el resto la retiene la casa). */
  comision_brokers: number;
  /** Fase 14: comisión que va DIRECTO al resguardo de TRF (monto × comision_trf_pct). */
  comision_trf: number;
  /** Flujo Total: suma de los importes de dispersión. */
  flujo_total: number;
  /** Devolución: flujo total menos comisión. */
  devolucion: number;
  /** Diferencia a favor (monto − flujo total); se ingresa al resguardo del cliente. */
  diferencia: number;
  /** VERDADERO si el flujo total no excede el monto pagado. */
  comprobacion: "VERDADERO" | "FALSO";
}

/** Redondeo a centavos estable para sumas de dinero. */
export function redondear2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Cálculos del formato FLUJO (replica el Excel del negocio):
 *   IVA desglosado = monto × 16/116 · Neto = monto × 100/116
 *   Comisión = monto × pct · Flujo Total = Σ dispersiones
 *   Devolución = Flujo Total − Comisión · Diferencia = Monto − Flujo Total
 */
export function calcularFlujo(
  monto: number,
  comisionPct: number,
  dispersiones: Array<{ importe: number }>,
  brokers: Array<{ porcentaje: number }> = [],
  comisionTrfPct = 0
): CalculosFlujo {
  const flujoTotal = redondear2(dispersiones.reduce((s, d) => s + d.importe, 0));
  const comisionTotal = redondear2((monto * comisionPct) / 100);
  const comisionBrokers = redondear2(
    brokers.reduce((s, b) => s + (comisionTotal * b.porcentaje) / 100, 0)
  );
  const comisionTrf = redondear2((monto * comisionTrfPct) / 100);
  const diferencia = redondear2(monto - flujoTotal);
  return {
    iva: redondear2((monto * 16) / 116),
    neto: redondear2((monto * 100) / 116),
    comision_total: comisionTotal,
    comision_brokers: comisionBrokers,
    comision_trf: comisionTrf,
    flujo_total: flujoTotal,
    devolucion: redondear2(flujoTotal - comisionTotal),
    diferencia,
    comprobacion: diferencia >= -0.005 ? "VERDADERO" : "FALSO",
  };
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

export interface Cliente {
  id: number;
  nombre: string;
  rfc: string;
  contacto: string;
  notas: string;
  activo: number;
  /** Fase 14: comisiones preestablecidas del cliente (las fija
   *  admin_operaciones). NULL = el cliente no tiene preestablecida. */
  comision_broker_pct: number | null;
  comision_trf_pct: number | null;
  creado_por: number;
  creado_en: string;
}

export interface AsignacionCliente {
  id: number;
  cliente_id: number;
  ejecutivo_id: number;
  motivo: string;
  asignado_por: number;
  activo: number;
  creado_en: string;
  cerrado_en: string | null;
}

export interface AsignacionValidacion {
  id: number;
  operacion_id: number;
  validador_id: number;
  motivo: string;
  asignado_por: number;
  activo: number;
  creado_en: string;
  cerrado_en: string | null;
}

export interface AsignacionCuenta {
  id: number;
  cuenta_id: number;
  tesorero_id: number;
  motivo: string;
  asignado_por: number;
  activo: number;
  creado_en: string;
  cerrado_en: string | null;
}

/**
 * Asignación de un EJECUTIVO DE OPERACIONES a un VALIDADOR (append-only,
 * la cierra/reasigna el Administrador de Validación): el validador visualiza
 * las operaciones capturadas por ese ejecutivo.
 */
export interface ValidacionEjecutivo {
  id: number;
  validador_id: number;
  ejecutivo_id: number;
  motivo: string;
  asignado_por: number;
  activo: number;
  creado_en: string;
  cerrado_en: string | null;
}

/**
 * Solicitud de alta bancaria: registro de una cuenta de beneficiario en el
 * banco (para dispersar directo desde el portal). El Ejecutivo la solicita y
 * el Tesorero de Altas la registra o la rechaza.
 */
export interface AltaBancaria {
  id: number;
  operacion_id: number | null;
  beneficiario: string;
  banco: string;
  moneda: string;
  cuenta: string;
  /** Fase 15 — CLABE completa (18) cuando se conoce (captura por lotes). */
  clabe?: string;
  estado: "solicitada" | "registrada" | "rechazada";
  notas: string;
  motivo_rechazo: string;
  solicitado_por: number;
  creado_en: string;
  resuelto_por: number | null;
  resuelto_en: string | null;
}

export interface Cobertura {
  id: number;
  cuenta_id: number;
  tesorero_habitual_id: number;
  tesorero_temporal_id: number;
  fecha_inicio: string;
  fecha_fin: string | null;
  motivo: string;
  asignado_por: number;
  activo: number;
  creado_en: string;
  cerrado_en: string | null;
}

export interface ClienteCobertura {
  id: number;
  cliente_id: number;
  ejecutivo_habitual_id: number;
  ejecutivo_temporal_id: number;
  fecha_inicio: string;
  fecha_fin: string | null;
  motivo: string;
  asignado_por: number;
  activo: number;
  creado_en: string;
  cerrado_en: string | null;
}

export interface ResguardoMovimiento {
  id: number;
  cliente_id: number;
  /** 'deposito' y 'financiamiento' suman; 'cargo' resta (§14). */
  tipo: "deposito" | "cargo" | "financiamiento";
  importe: number;
  operacion_id: number | null;
  cuenta_id: number | null;
  comprobante: string;
  observaciones: string;
  creado_por: number;
  creado_en: string;
}

/**
 * Financiamiento solicitado para respaldar una operación cuando el resguardo
 * del cliente no alcanza. Requiere aprobación de Dirección SALVO que el
 * cliente tenga exención previa (sin aprobación) o el monto entre en su
 * máximo ya aprobado (01-ROLES.md §6.1).
 */
export interface Financiamiento {
  id: number;
  operacion_id: number;
  cliente_id: number;
  monto: number;
  notas: string;
  estado: "solicitado" | "aprobado" | "rechazado" | "cancelado";
  /** 1 = Dirección debe aprobarlo; 0 = entró por una exención del cliente. */
  requiere_aprobacion: number;
  /** Por qué no requirió aprobación: 'sin_aprobacion_previa' | 'monto_maximo'. */
  exento_motivo: string;
  solicitado_por: number;
  creado_en: string;
  resuelto_por: number | null;
  resuelto_en: string | null;
  /** Movimiento de resguardo generado al aprobarse (evita doble alta). */
  movimiento_id: number | null;
}

export interface DepositoOperacion {
  id: number;
  operacion_id: number;
  cuenta_id: number;
  monto: number;
  comprobante: string;
  fecha_deposito: string;
  indicado_por: number;
  creado_en: string;
  validado_por: number | null;
  validado_en: string | null;
}

export interface AplicacionRecurso {
  id: number;
  movimiento_id: number;
  operacion_id: number;
  importe: number;
  moneda: string;
  observaciones: string;
  aplicado_por: number;
  aplicado_en: string;
  liberado_por: number | null;
  liberado_en: string | null;
  liberado_motivo: string | null;
}

export interface ComprobanteDeposito {
  id: number;
  deposito_id: number;
  nombre: string;
  mime: string;
  tamano: number;
  subido_por: number;
  creado_en: string;
}

export interface BrokerResguardo {
  id: number;
  broker_id: number;
  tipo: "comision" | "retiro";
  importe: number;
  operacion_id: number | null;
  notas: string;
  creado_por: number;
  creado_en: string;
}

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS usuarios (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  nombre        TEXT NOT NULL,
  rol           TEXT NOT NULL CHECK (rol IN ('admin','admin_operaciones','admin_validacion','admin_tesoreria','operacion','validacion','validador_tesoreria','confirmador','tesoreria','fondeador','altas','direccion','auditoria')),
  activo        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS operaciones (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  folio           TEXT NOT NULL UNIQUE,
  tipo            TEXT NOT NULL CHECK (tipo IN ('pago','cobro','financiamiento','flujo','pago_especial')),
  concepto        TEXT NOT NULL,
  proveedor       TEXT NOT NULL,
  monto           REAL NOT NULL CHECK (monto > 0),
  moneda          TEXT NOT NULL DEFAULT 'MXN',
  fecha_operacion TEXT NOT NULL,
  estado          TEXT NOT NULL DEFAULT 'borrador'
                  CHECK (estado IN ('borrador','en_validacion','observada','pendiente_direccion','aprobada','en_pago','pagada','cancelada')),
  cliente_id      INTEGER REFERENCES clientes(id),
  pagador         TEXT NOT NULL DEFAULT '',
  tipo_operacion  TEXT NOT NULL DEFAULT '',
  timbrar         INTEGER NOT NULL DEFAULT 0,
  comision_pct    REAL NOT NULL DEFAULT 0,
  comision_trf_pct REAL,
  observaciones   TEXT NOT NULL DEFAULT '',
  creado_por      INTEGER NOT NULL REFERENCES usuarios(id),
  creado_en       TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado_en  TEXT NOT NULL DEFAULT (datetime('now')),
  liberada_por    INTEGER REFERENCES usuarios(id),
  liberada_en     TEXT
);

-- Catálogo de brokers (intermediarios que participan del cobro de comisión):
-- su porcentaje es la parte del TOTAL de la comisión que le corresponde.
CREATE TABLE IF NOT EXISTS brokers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre      TEXT NOT NULL UNIQUE,
  porcentaje  REAL NOT NULL DEFAULT 0 CHECK (porcentaje >= 0 AND porcentaje <= 100),
  activo      INTEGER NOT NULL DEFAULT 1,
  creado_en   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Brokers participantes en una operación (fotografía de nombre/%/monto al
-- capturar; los cambios posteriores del catálogo no alteran la operación).
CREATE TABLE IF NOT EXISTS operaciones_brokers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  operacion_id INTEGER NOT NULL REFERENCES operaciones(id),
  broker_id    INTEGER NOT NULL REFERENCES brokers(id),
  nombre       TEXT NOT NULL,
  porcentaje   REAL NOT NULL,
  monto        REAL NOT NULL DEFAULT 0
);

-- Dispersiones del formato FLUJO: el plan de pagos a beneficiarios. Cada fila
-- es un "pago" del formato original (manual o importado por layout); su suma
-- es el Flujo Total. Editable sólo mientras la operación no ha sido pagada.
-- pagadora: la cuenta de Tesorería que pagará la línea, tomada del catálogo
-- (fotografía del nombre) o el literal "CUALQUIER <TIPO>" cuando el ejecutivo
-- deja que Tesorería determine la cuenta; pagadora_cuenta_id queda NULL en ese
-- caso. Son orientativas: la cuenta real de salida la elige Tesorería al pagar.
CREATE TABLE IF NOT EXISTS dispersiones (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  operacion_id INTEGER NOT NULL REFERENCES operaciones(id),
  orden        INTEGER NOT NULL DEFAULT 1,
  beneficiario TEXT NOT NULL,
  razon_social TEXT NOT NULL DEFAULT '',
  referencia   TEXT NOT NULL DEFAULT '',
  ine          TEXT NOT NULL DEFAULT '',
  numero       TEXT NOT NULL DEFAULT '',
  tarjeta      TEXT NOT NULL DEFAULT '',
  cuenta       TEXT NOT NULL DEFAULT '',
  clabe        TEXT NOT NULL DEFAULT '',
  banco        TEXT NOT NULL DEFAULT '',
  etiqueta     TEXT NOT NULL DEFAULT '',
  nombre             TEXT NOT NULL DEFAULT '',
  apellido_paterno   TEXT NOT NULL DEFAULT '',
  apellido_materno   TEXT NOT NULL DEFAULT '',
  concepto           TEXT NOT NULL DEFAULT '',
  referencia_pago    TEXT NOT NULL DEFAULT '',
  importe      REAL NOT NULL CHECK (importe > 0),
  pagadora     TEXT NOT NULL DEFAULT '',
  pagadora_cuenta_id INTEGER REFERENCES cuentas(id)
);

-- Pagadoras / frentes de la operación (Tarea 12): cuentas seleccionadas del
-- catálogo de Tesorería por el ejecutivo al capturar. Una operación puede
-- combinar asimilados, flujos, rendimientos, frentes, etc. cuenta_id NULL =
-- "CUALQUIER <tipo>": Tesorería determina la cuenta concreta. manejo_manual
-- marca los frentes que el negocio atenderá de manera manual.
CREATE TABLE IF NOT EXISTS operaciones_destinos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  operacion_id  INTEGER NOT NULL REFERENCES operaciones(id),
  cuenta_id     INTEGER REFERENCES cuentas(id),
  tipo          TEXT NOT NULL DEFAULT 'flujo',
  nombre        TEXT NOT NULL DEFAULT '',
  manejo_manual INTEGER NOT NULL DEFAULT 0,
  creado_en     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Fase roles (01-ROLES.md §3): clientes administrados por el Administrador de
-- Operaciones y asignados a Ejecutivos de Operaciones. La política de
-- financiamiento la determina Dirección (§6.1): exención de aprobación previa
-- y/o monto máximo ya aprobado.
CREATE TABLE IF NOT EXISTS clientes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre        TEXT NOT NULL,
  rfc           TEXT NOT NULL DEFAULT '',
  contacto      TEXT NOT NULL DEFAULT '',
  notas         TEXT NOT NULL DEFAULT '',
  activo        INTEGER NOT NULL DEFAULT 1,
  financiamiento_sin_aprobacion INTEGER NOT NULL DEFAULT 0,
  financiamiento_maximo         REAL,
  comision_broker_pct REAL,
  comision_trf_pct    REAL,
  creado_por    INTEGER NOT NULL REFERENCES usuarios(id),
  creado_en     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Financiamientos que respaldan operaciones (§6.1): Dirección aprueba o
-- rechaza; al aprobarse el monto ingresa al resguardo del cliente como un
-- movimiento tipo 'financiamiento' (§14: el saldo sigue siendo calculado).
CREATE TABLE IF NOT EXISTS financiamientos (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  operacion_id        INTEGER NOT NULL REFERENCES operaciones(id),
  cliente_id          INTEGER NOT NULL REFERENCES clientes(id),
  monto               REAL NOT NULL CHECK (monto > 0),
  notas               TEXT NOT NULL DEFAULT '',
  estado              TEXT NOT NULL DEFAULT 'solicitado'
                      CHECK (estado IN ('solicitado','aprobado','rechazado','cancelado')),
  requiere_aprobacion INTEGER NOT NULL DEFAULT 1,
  exento_motivo       TEXT NOT NULL DEFAULT '',
  solicitado_por      INTEGER NOT NULL REFERENCES usuarios(id),
  creado_en           TEXT NOT NULL DEFAULT (datetime('now')),
  resuelto_por        INTEGER REFERENCES usuarios(id),
  resuelto_en         TEXT,
  movimiento_id       INTEGER REFERENCES resguardos_movimientos(id)
);

-- Historial de asignaciones cliente -> ejecutivo (append-only: la asignación
-- original se conserva; una reasignación cierra la anterior y abre otra).
CREATE TABLE IF NOT EXISTS cliente_asignaciones (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id    INTEGER NOT NULL REFERENCES clientes(id),
  ejecutivo_id  INTEGER NOT NULL REFERENCES usuarios(id),
  motivo        TEXT NOT NULL DEFAULT '',
  asignado_por  INTEGER NOT NULL REFERENCES usuarios(id),
  activo        INTEGER NOT NULL DEFAULT 1,
  creado_en     TEXT NOT NULL DEFAULT (datetime('now')),
  cerrado_en    TEXT
);

CREATE INDEX IF NOT EXISTS idx_asignaciones_ejecutivo ON cliente_asignaciones(ejecutivo_id, activo);
CREATE INDEX IF NOT EXISTS idx_asignaciones_cliente ON cliente_asignaciones(cliente_id, activo);

-- Cobertura temporal de clientes (01-ROLES.md §3.1 + 00-VISION.md §6): una
-- segunda asignación por vacaciones/permisos especiales. El ejecutivo temporal
-- ve el cliente y su historial sin alterar la asignación principal.
CREATE TABLE IF NOT EXISTS cliente_coberturas (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id            INTEGER NOT NULL REFERENCES clientes(id),
  ejecutivo_habitual_id INTEGER NOT NULL REFERENCES usuarios(id),
  ejecutivo_temporal_id INTEGER NOT NULL REFERENCES usuarios(id),
  fecha_inicio          TEXT NOT NULL,
  fecha_fin             TEXT,
  motivo                TEXT NOT NULL DEFAULT '',
  asignado_por          INTEGER NOT NULL REFERENCES usuarios(id),
  activo                INTEGER NOT NULL DEFAULT 1,
  creado_en             TEXT NOT NULL DEFAULT (datetime('now')),
  cerrado_en            TEXT
);

-- Resguardo por cliente (modelo financiero del resguardo): el saldo NO se
-- guarda nunca (01-ROLES.md §14), es la suma de sus movimientos:
--   deposito (+) y financiamiento (+) validados/aprobados, cargo (−) al pagar.
CREATE TABLE IF NOT EXISTS resguardos_movimientos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id    INTEGER NOT NULL REFERENCES clientes(id),
  tipo          TEXT NOT NULL CHECK (tipo IN ('deposito','cargo','financiamiento')),
  importe       REAL NOT NULL CHECK (importe > 0),
  operacion_id  INTEGER REFERENCES operaciones(id),
  cuenta_id     INTEGER REFERENCES cuentas(id),
  comprobante   TEXT NOT NULL DEFAULT '',
  observaciones TEXT NOT NULL DEFAULT '',
  creado_por    INTEGER NOT NULL REFERENCES usuarios(id),
  creado_en     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Depósitos indicados por el Ejecutivo para respaldar la operación (uno o
-- varios): cuenta donde se depositó + comprobante, pendientes de validar por
-- Tesorería. Sin UNIQUE por operación: la captura admite varios depósitos.
CREATE TABLE IF NOT EXISTS operaciones_depositos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  operacion_id   INTEGER NOT NULL REFERENCES operaciones(id),
  cuenta_id      INTEGER NOT NULL REFERENCES cuentas(id),
  monto          REAL NOT NULL CHECK (monto > 0),
  comprobante    TEXT NOT NULL,
  fecha_deposito TEXT NOT NULL,
  indicado_por   INTEGER NOT NULL REFERENCES usuarios(id),
  creado_en      TEXT NOT NULL DEFAULT (datetime('now')),
  validado_por   INTEGER REFERENCES usuarios(id),
  validado_en    TEXT
);

-- Fase roles (01-ROLES.md §4): cola de validación administrada por el
-- Administrador de Validación; asignación operación -> validador (append-only).
CREATE TABLE IF NOT EXISTS asignaciones_validacion (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  operacion_id  INTEGER NOT NULL REFERENCES operaciones(id),
  validador_id  INTEGER NOT NULL REFERENCES usuarios(id),
  motivo        TEXT NOT NULL DEFAULT '',
  asignado_por  INTEGER NOT NULL REFERENCES usuarios(id),
  activo        INTEGER NOT NULL DEFAULT 1,
  creado_en     TEXT NOT NULL DEFAULT (datetime('now')),
  cerrado_en    TEXT
);

-- Visibilidad de Validación por ejecutivo: el Administrador de Validación
-- asigna EJECUTIVOS DE OPERACIONES a sus VALIDADORES (append-only); el
-- validador visualiza las operaciones capturadas por esos ejecutivos. Los
-- ejecutivos sin asignación siguen el flujo simple (cualquier validador).
CREATE TABLE IF NOT EXISTS validacion_ejecutivos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  validador_id  INTEGER NOT NULL REFERENCES usuarios(id),
  ejecutivo_id  INTEGER NOT NULL REFERENCES usuarios(id),
  motivo        TEXT NOT NULL DEFAULT '',
  asignado_por  INTEGER NOT NULL REFERENCES usuarios(id),
  activo        INTEGER NOT NULL DEFAULT 1,
  creado_en     TEXT NOT NULL DEFAULT (datetime('now')),
  cerrado_en    TEXT
);
CREATE INDEX IF NOT EXISTS idx_val_ejec_validador ON validacion_ejecutivos(validador_id, activo);
CREATE INDEX IF NOT EXISTS idx_val_ejec_ejecutivo ON validacion_ejecutivos(ejecutivo_id, activo);

-- Altas bancarias (rol 'altas' — Tesorería de Altas): el Ejecutivo solicita el
-- registro de una cuenta de beneficiario en el banco (para dispersar directo
-- desde el portal bancario) y el Tesorero de Altas la registra/rechaza. La
-- base conserva fecha, solicitante, moneda y banco. Tesorería NO puede pagar
-- (registrar tandas) a cuentas sin alta registrada.
CREATE TABLE IF NOT EXISTS altas_bancarias (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  operacion_id   INTEGER REFERENCES operaciones(id),
  beneficiario   TEXT NOT NULL,
  banco          TEXT NOT NULL,
  moneda         TEXT NOT NULL DEFAULT 'MXN',
  cuenta         TEXT NOT NULL,
  clabe          TEXT NOT NULL DEFAULT '',
  estado         TEXT NOT NULL DEFAULT 'solicitada'
                 CHECK (estado IN ('solicitada','registrada','rechazada')),
  notas          TEXT NOT NULL DEFAULT '',
  motivo_rechazo TEXT NOT NULL DEFAULT '',
  solicitado_por INTEGER NOT NULL REFERENCES usuarios(id),
  creado_en      TEXT NOT NULL DEFAULT (datetime('now')),
  resuelto_por   INTEGER REFERENCES usuarios(id),
  resuelto_en    TEXT
);
CREATE INDEX IF NOT EXISTS idx_altas_estado ON altas_bancarias(estado);
CREATE INDEX IF NOT EXISTS idx_altas_operacion ON altas_bancarias(operacion_id);
CREATE INDEX IF NOT EXISTS idx_altas_cuenta ON altas_bancarias(banco, cuenta);

-- Fase roles (01-ROLES.md §5): cuentas asignadas a tesoreros (append-only) y
-- coberturas temporales por ausencia (00-VISION.md §6 continuidad operativa).
CREATE TABLE IF NOT EXISTS cuentas_asignaciones (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  cuenta_id     INTEGER NOT NULL REFERENCES cuentas(id),
  tesorero_id   INTEGER NOT NULL REFERENCES usuarios(id),
  motivo        TEXT NOT NULL DEFAULT '',
  asignado_por  INTEGER NOT NULL REFERENCES usuarios(id),
  activo        INTEGER NOT NULL DEFAULT 1,
  creado_en     TEXT NOT NULL DEFAULT (datetime('now')),
  cerrado_en    TEXT
);

CREATE TABLE IF NOT EXISTS coberturas (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  cuenta_id             INTEGER NOT NULL REFERENCES cuentas(id),
  tesorero_habitual_id  INTEGER NOT NULL REFERENCES usuarios(id),
  tesorero_temporal_id  INTEGER NOT NULL REFERENCES usuarios(id),
  fecha_inicio          TEXT NOT NULL,
  fecha_fin             TEXT,
  motivo                TEXT NOT NULL DEFAULT '',
  asignado_por          INTEGER NOT NULL REFERENCES usuarios(id),
  activo                INTEGER NOT NULL DEFAULT 1,
  creado_en             TEXT NOT NULL DEFAULT (datetime('now')),
  cerrado_en            TEXT
);

-- Aplicaciones de recursos (01-ROLES.md §5.2): un movimiento bancario
-- (depósito) se ocupa parcialmente para una operación. Anti doble uso: la
-- suma de aplicaciones vigentes nunca excede el monto del movimiento ni el
-- monto de la operación. Liberación por otra persona (doble control, §10).
CREATE TABLE IF NOT EXISTS aplicaciones_recursos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  movimiento_id   INTEGER NOT NULL REFERENCES movimientos_cuentas(id),
  operacion_id    INTEGER NOT NULL REFERENCES operaciones(id),
  importe         REAL NOT NULL CHECK (importe > 0),
  moneda          TEXT NOT NULL DEFAULT 'MXN',
  observaciones   TEXT NOT NULL DEFAULT '',
  aplicado_por    INTEGER NOT NULL REFERENCES usuarios(id),
  aplicado_en     TEXT NOT NULL DEFAULT (datetime('now')),
  liberado_por    INTEGER REFERENCES usuarios(id),
  liberado_en     TEXT,
  liberado_motivo TEXT
);

-- Catálogos administrables por el Administrador del sistema (01-ROLES.md §8.1):
-- pagadoras, conceptos, documentos, etc.
CREATE TABLE IF NOT EXISTS catalogos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  dominio    TEXT NOT NULL,
  clave      TEXT NOT NULL,
  valor      TEXT NOT NULL,
  activo     INTEGER NOT NULL DEFAULT 1,
  actualizado_por INTEGER REFERENCES usuarios(id),
  UNIQUE (dominio, clave)
);

-- Parámetros generales del sistema (admin editable). Si un parámetro tiene
-- valor, prevalece sobre la variable de entorno equivalente.
CREATE TABLE IF NOT EXISTS parametros (
  clave          TEXT PRIMARY KEY,
  valor          TEXT NOT NULL,
  descripcion    TEXT NOT NULL DEFAULT '',
  actualizado_por INTEGER REFERENCES usuarios(id),
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
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
  tipo            TEXT NOT NULL DEFAULT 'flujo' CHECK (tipo IN ('flujo','frente','prestamo','anticipo_rendimiento','sofom','asimilado')),
  saldo_inicial   REAL NOT NULL DEFAULT 0,
  activa          INTEGER NOT NULL DEFAULT 1,
  -- Fase 13: visible en el listado de pagadoras de los operadores (Tesorería
  -- la controla; todas nacen visibles).
  visible_operador INTEGER NOT NULL DEFAULT 1,
  creado_en       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Resguardo de TRF (la empresa, Fase 13): ledger append-only de ingresos y
-- retiros. Los movimientos en moneda distinta de MXN registran el TIPO DE
-- CAMBIO que aplicó el banco (tipo_cambio), de modo que el resguardo cuadre:
-- equivalente en pesos = importe × tipo_cambio. El saldo nunca se guarda:
-- es la suma de los movimientos por moneda.
CREATE TABLE IF NOT EXISTS trf_resguardos_movimientos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo          TEXT NOT NULL CHECK (tipo IN ('ingreso','retiro')),
  importe       REAL NOT NULL CHECK (importe > 0),
  moneda        TEXT NOT NULL DEFAULT 'MXN',
  tipo_cambio   REAL CHECK (tipo_cambio IS NULL OR tipo_cambio > 0),
  operacion_id  INTEGER REFERENCES operaciones(id),
  notas         TEXT NOT NULL DEFAULT '',
  creado_por    INTEGER NOT NULL REFERENCES usuarios(id),
  creado_en     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_trf_resguardos_moneda ON trf_resguardos_movimientos(moneda);

-- Pagos especiales (Fase 14): operación de retiro respaldada por un resguardo
-- (TRF o broker). El ejecutivo adjunta el FORMATO (p.ej. SAT), captura el
-- importe, la pagadora (cuenta del catálogo) y una descripción breve; el
-- resguardo de origen debe tener depósito suficiente y al pagarse la operación
-- se descuenta del resguardo (ledger append-only) para que todo cuadre.
CREATE TABLE IF NOT EXISTS pagos_especiales (
  operacion_id        INTEGER PRIMARY KEY REFERENCES operaciones(id),
  descripcion         TEXT NOT NULL DEFAULT '',
  pagadora_cuenta_id  INTEGER REFERENCES cuentas(id),
  pagadora            TEXT NOT NULL DEFAULT '',
  resguardo_origen    TEXT NOT NULL CHECK (resguardo_origen IN ('trf','broker')),
  broker_origen_id    INTEGER REFERENCES brokers(id),
  broker_origen       TEXT NOT NULL DEFAULT '',
  formato_nombre      TEXT NOT NULL DEFAULT '',
  formato_mime        TEXT NOT NULL DEFAULT '',
  formato_contenido   TEXT NOT NULL DEFAULT '',
  creado_por          INTEGER NOT NULL REFERENCES usuarios(id),
  creado_en           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Fase 15 — Catálogo de bancos SPEI: la clave son los 3 primeros dígitos de la
-- CLABE. Sembrado con los 92 bancos del formato de alta de cuentas.
CREATE TABLE IF NOT EXISTS bancos_spei (
  clave           TEXT PRIMARY KEY,
  nombre_corto    TEXT NOT NULL,
  nombre_completo TEXT NOT NULL DEFAULT ''
);

-- Fase 15 — Bóveda de credenciales: 1 cuenta → N credenciales (multi-usuario
-- nativo, como en el catálogo real de cuentas). Los campos sensibles (secreto,
-- nip, clave_seguridad) se guardan CIFRADOS con AES-256-GCM (backend/src/boveda.ts)
-- y JAMÁS se registran en logs ni se devuelven en los listados.
CREATE TABLE IF NOT EXISTS cuentas_credenciales (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  cuenta_id       INTEGER NOT NULL REFERENCES cuentas(id),
  tipo            TEXT NOT NULL DEFAULT 'portal'
                  CHECK (tipo IN ('portal','correo','eplata','sofipo','token','otro')),
  etiqueta        TEXT NOT NULL DEFAULT '',
  usuario         TEXT NOT NULL DEFAULT '',
  secreto         TEXT NOT NULL DEFAULT '',
  nip             TEXT NOT NULL DEFAULT '',
  clave_seguridad TEXT NOT NULL DEFAULT '',
  token_numero    TEXT NOT NULL DEFAULT '',
  telefono        TEXT NOT NULL DEFAULT '',
  correo          TEXT NOT NULL DEFAULT '',
  vigencia        TEXT NOT NULL DEFAULT '',
  notas           TEXT NOT NULL DEFAULT '',
  activo          INTEGER NOT NULL DEFAULT 1,
  creado_por      INTEGER NOT NULL REFERENCES usuarios(id),
  creado_en       TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado_en  TEXT
);
CREATE INDEX IF NOT EXISTS idx_credenciales_cuenta ON cuentas_credenciales(cuenta_id);

-- Fase 15 — Auditoría de la bóveda: quién consultó/copió qué credencial y cuándo.
CREATE TABLE IF NOT EXISTS credenciales_accesos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  credencial_id INTEGER NOT NULL REFERENCES cuentas_credenciales(id),
  usuario_id    INTEGER NOT NULL REFERENCES usuarios(id),
  accion        TEXT NOT NULL CHECK (accion IN ('ver','crear','actualizar','desactivar')),
  campo         TEXT NOT NULL DEFAULT '',
  fecha         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cred_accesos_cred ON credenciales_accesos(credencial_id);

-- Fase 15 — Altas en portales (formato "ALTA CUENTA"): una alta bancaria se
-- registra en los portales de una o varias pagadoras; el estado se lleva POR
-- PORTAL (pendiente → dada_de_alta | rechazada). Cuando todos los portales
-- ligados quedan dados de alta, la alta bancaria se marca 'registrada' sola.
CREATE TABLE IF NOT EXISTS altas_portales (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  alta_bancaria_id INTEGER NOT NULL REFERENCES altas_bancarias(id),
  portal_cuenta_id INTEGER NOT NULL REFERENCES cuentas(id),
  estado           TEXT NOT NULL DEFAULT 'pendiente'
                   CHECK (estado IN ('pendiente','dada_de_alta','rechazada')),
  motivo_rechazo   TEXT NOT NULL DEFAULT '',
  registrado_por   INTEGER REFERENCES usuarios(id),
  registrado_en    TEXT,
  creado_por       INTEGER NOT NULL REFERENCES usuarios(id),
  creado_en        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (alta_bancaria_id, portal_cuenta_id)
);
CREATE INDEX IF NOT EXISTS idx_altas_portales_alta ON altas_portales(alta_bancaria_id);
CREATE INDEX IF NOT EXISTS idx_altas_portales_portal ON altas_portales(portal_cuenta_id, estado);

-- Concentrado de movimientos bancarios: el tesorero pega los estados de cuenta
-- de sus cuentas asignadas (panel tipo Excel); validador y confirmador también
-- alimentan el concentrado. La "marca" es la copia de trabajo de Tesorería:
-- liga el movimiento bancario con el depósito del cliente que cubre, con un
-- comentario. Auditoría consulta la versión limpia (sin marcas).
CREATE TABLE IF NOT EXISTS movimientos_cuentas (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  cuenta_id       INTEGER NOT NULL REFERENCES cuentas(id),
  tipo            TEXT NOT NULL CHECK (tipo IN ('deposito','retiro')),
  monto           REAL NOT NULL CHECK (monto > 0),
  concepto        TEXT NOT NULL,
  referencia      TEXT NOT NULL DEFAULT '',
  fecha           TEXT NOT NULL,
  origen          TEXT NOT NULL DEFAULT 'tesoreria',
  deposito_id     INTEGER REFERENCES operaciones_depositos(id),
  marca           TEXT NOT NULL DEFAULT '',
  marcado_por     INTEGER REFERENCES usuarios(id),
  marcado_en      TEXT,
  creado_por      INTEGER NOT NULL REFERENCES usuarios(id),
  creado_en       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Comprobantes (respaldos) de un depósito indicado por el Ejecutivo: 1 o
-- varios archivos por depósito (PDF/imágenes en base64) para que Tesorería
-- valide contra ellos (§5.3).
CREATE TABLE IF NOT EXISTS depositos_comprobantes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  deposito_id  INTEGER NOT NULL REFERENCES operaciones_depositos(id),
  nombre       TEXT NOT NULL,
  mime         TEXT NOT NULL DEFAULT 'application/octet-stream',
  tamano       INTEGER NOT NULL DEFAULT 0,
  contenido    BLOB NOT NULL,
  subido_por   INTEGER NOT NULL REFERENCES usuarios(id),
  creado_en    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_depositos_comprobantes_deposito ON depositos_comprobantes(deposito_id);

-- Resguardo de comisiones por broker: cuando una operación queda PAGADA, la
-- comisión cobrada de cada broker participante entra a su resguardo; los
-- retiros (pagos al broker) lo disminuyen. Ledger append-only.
CREATE TABLE IF NOT EXISTS brokers_resguardos (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  broker_id    INTEGER NOT NULL REFERENCES brokers(id),
  tipo         TEXT NOT NULL CHECK (tipo IN ('comision','retiro')),
  importe      REAL NOT NULL CHECK (importe > 0),
  operacion_id INTEGER REFERENCES operaciones(id),
  notas        TEXT NOT NULL DEFAULT '',
  creado_por   INTEGER NOT NULL REFERENCES usuarios(id),
  creado_en    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_brokers_resguardos_broker ON brokers_resguardos(broker_id);

-- Pagos (tandas) de una operación: sin UNIQUE por operación — el formato FLUJO
-- permite dispersar en varias tandas hasta cubrir el Flujo Total.
CREATE TABLE IF NOT EXISTS pagos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  operacion_id    INTEGER NOT NULL REFERENCES operaciones(id),
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
CREATE INDEX IF NOT EXISTS idx_asig_val_operacion ON asignaciones_validacion(operacion_id, activo);
CREATE INDEX IF NOT EXISTS idx_asig_val_validador ON asignaciones_validacion(validador_id, activo);
CREATE INDEX IF NOT EXISTS idx_asig_cuenta_tesorero ON cuentas_asignaciones(tesorero_id, activo);
CREATE INDEX IF NOT EXISTS idx_asig_cuenta_cuenta ON cuentas_asignaciones(cuenta_id, activo);
CREATE INDEX IF NOT EXISTS idx_coberturas_cuenta ON coberturas(cuenta_id, activo);
CREATE INDEX IF NOT EXISTS idx_aplicaciones_movimiento ON aplicaciones_recursos(movimiento_id);
CREATE INDEX IF NOT EXISTS idx_aplicaciones_operacion ON aplicaciones_recursos(operacion_id);
CREATE INDEX IF NOT EXISTS idx_cli_cobertura_cliente ON cliente_coberturas(cliente_id, activo);
CREATE INDEX IF NOT EXISTS idx_cli_cobertura_temporal ON cliente_coberturas(ejecutivo_temporal_id, activo);
CREATE INDEX IF NOT EXISTS idx_resguardos_cliente ON resguardos_movimientos(cliente_id);
CREATE INDEX IF NOT EXISTS idx_resguardos_operacion ON resguardos_movimientos(operacion_id);
CREATE INDEX IF NOT EXISTS idx_ops_depositos_pendientes ON operaciones_depositos(validado_por);
CREATE INDEX IF NOT EXISTS idx_dispersiones_operacion ON dispersiones(operacion_id);
CREATE INDEX IF NOT EXISTS idx_destinos_operacion ON operaciones_destinos(operacion_id);
CREATE INDEX IF NOT EXISTS idx_ops_brokers_operacion ON operaciones_brokers(operacion_id);
CREATE INDEX IF NOT EXISTS idx_pagos_operacion ON pagos(operacion_id);
CREATE INDEX IF NOT EXISTS idx_financiamientos_estado ON financiamientos(estado);
CREATE INDEX IF NOT EXISTS idx_financiamientos_cliente ON financiamientos(cliente_id);
CREATE INDEX IF NOT EXISTS idx_financiamientos_operacion ON financiamientos(operacion_id);
`;

export function abrirBase(ruta: string = RUTA_DB): Database.Database {
  if (!ruta.includes(":memory:")) mkdirSync(dirname(ruta), { recursive: true });
  const db = new Database(ruta);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(ESQUEMA);
  migrarEsquema(db);
  migrarPagos(db);
  migrarUsuarios(db);
  migrarOperacionesCliente(db);
  migrarCapturaFlujo(db);
  migrarRespaldosFinanciamientos(db);
  migrarTesoreriaDepositos(db);
  migrarFondeoAltas(db);
  migrarPagadorasDestinos(db);
  migrarFase13(db);
  migrarFase14(db);
  migrarFase15(db);
  sembrarUsuarios(db);
  asegurarUsuariosBase(db);
  sembrarCatalogosYParametros(db);
  sembrarBancosSpei(db);
  sembrarCuentasTesoreria(db);
  return db;
}

/**
 * Fase 15 — Catálogo maestro de cuentas: añade a `cuentas` las columnas del
 * catálogo real (CLABE, moneda, origen, estatus, cliente, fechas y el formato
 * de reporte bancario). Idempotente y conservando datos.
 */
function migrarFase15(db: Database.Database): void {
  const cols = (db.pragma("table_info(cuentas)") as Array<{ name: string }>).map((c) => c.name);
  if (!cols.length) return; // base nueva: el ESQUEMA ya nace con todo
  const nuevas: Array<[string, string]> = [
    ["clabe", "TEXT NOT NULL DEFAULT ''"],
    ["moneda", "TEXT NOT NULL DEFAULT 'MXN'"],
    ["origen", "TEXT NOT NULL DEFAULT ''"],
    ["estatus", "TEXT NOT NULL DEFAULT ''"],
    ["cliente", "TEXT NOT NULL DEFAULT ''"],
    ["fecha_alta", "TEXT"],
    ["fecha_baja", "TEXT"],
    ["formato_reporte", "TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [c, def] of nuevas) {
    if (!cols.includes(c)) {
      db.exec(`ALTER TABLE cuentas ADD COLUMN ${c} ${def}`);
      console.log(`[Migración] Fase 15: cuentas.${c} añadida`);
    }
  }
  // La alta bancaria guarda también la CLABE completa cuando se conoce.
  const colsAlta = (db.pragma("table_info(altas_bancarias)") as Array<{ name: string }>).map((c) => c.name);
  if (colsAlta.length && !colsAlta.includes("clabe")) {
    db.exec("ALTER TABLE altas_bancarias ADD COLUMN clabe TEXT NOT NULL DEFAULT ''");
    console.log("[Migración] Fase 15: altas_bancarias.clabe añadida");
  }
}

/** Fase 15 — siembra el catálogo SPEI (92 bancos) una sola vez. */
function sembrarBancosSpei(db: Database.Database): void {
  const contar = db.prepare("SELECT COUNT(*) AS n FROM bancos_spei").get() as { n: number };
  if (contar.n > 0) return;
  const insertar = db.prepare(
    "INSERT INTO bancos_spei (clave, nombre_corto, nombre_completo) VALUES (?, ?, ?)"
  );
  for (const [clave, corto, completo] of SEMILLA_BANCOS) insertar.run(clave, corto, completo);
  console.log(`[semilla] catálogo SPEI: ${SEMILLA_BANCOS.length} bancos`);
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
 * Fase roles: añade `operaciones.cliente_id` a bases creadas antes de la fase
 * de roles (operaciones ligadas a clientes asignados, 01-ROLES.md §3).
 * El índice sobre la columna se crea aquí (no en el ESQUEMA) porque en bases
 * preexistentes la columna no existe al momento de ejecutar el esquema.
 */
function migrarOperacionesCliente(db: Database.Database): void {
  const columnas = (db.pragma("table_info(operaciones)") as Array<{ name: string }>).map((c) => c.name);
  if (columnas.length === 0) return;
  if (!columnas.includes("cliente_id")) {
    db.exec("ALTER TABLE operaciones ADD COLUMN cliente_id INTEGER REFERENCES clientes(id)");
    console.log("[migración] operaciones.cliente_id añadida");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_operaciones_cliente ON operaciones(cliente_id)");
}

/**
 * Fase roles: reconstruye `usuarios` si su CHECK de rol no incluye los roles
 * nuevos (`admin`, `admin_operaciones`, `admin_validacion`, `admin_tesoreria`,
 * `validador_tesoreria`). Conserva id, contraseña y contenido.
 */
function migrarUsuarios(db: Database.Database): void {
  const tabla = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'usuarios'")
    .get() as { sql: string } | undefined;
  if (!tabla || tabla.sql.includes("'fondeador'")) return;

  db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");
  try {
    db.exec(`
      ALTER TABLE usuarios RENAME TO usuarios_old;
      CREATE TABLE usuarios (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        nombre        TEXT NOT NULL,
        rol           TEXT NOT NULL CHECK (rol IN ('admin','admin_operaciones','admin_validacion','admin_tesoreria','operacion','validacion','validador_tesoreria','confirmador','tesoreria','fondeador','altas','direccion','auditoria')),
        activo        INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO usuarios (id, username, password_hash, nombre, rol, activo)
        SELECT id, username, password_hash, nombre, rol, activo FROM usuarios_old;
      DROP TABLE usuarios_old;
    `);
    db.pragma("legacy_alter_table = OFF");
    db.pragma("foreign_keys = ON");
    console.log("[migración] usuarios reconstruida con los 10 roles del sistema");
  } catch (e) {
    db.pragma("legacy_alter_table = OFF");
    db.pragma("foreign_keys = ON");
    throw e;
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

/**
 * Formato FLUJO (captura completa): reconstruye `operaciones` para aceptar el
 * tipo 'flujo', el estado 'en_pago' y las columnas de captura completa
 * (pagador, tipo_operacion, timbrar, comision_pct, observaciones); reconstruye
 * `pagos` sin el UNIQUE por operación para permitir tandas. Conserva filas.
 */
function migrarCapturaFlujo(db: Database.Database): void {
  const tabla = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'operaciones'")
    .get() as { sql: string } | undefined;
  if (tabla && tabla.sql.includes("'en_pago'")) return;

  const pagos = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pagos'")
    .get() as { sql: string } | undefined;
  const reconstruirPagos = !!pagos && pagos.sql.includes("UNIQUE");

  db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");
  try {
    if (tabla) {
      db.exec(`
        ALTER TABLE operaciones RENAME TO operaciones_old;
        CREATE TABLE operaciones (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          folio           TEXT NOT NULL UNIQUE,
          tipo            TEXT NOT NULL CHECK (tipo IN ('pago','cobro','financiamiento','flujo')),
          concepto        TEXT NOT NULL,
          proveedor       TEXT NOT NULL,
          monto           REAL NOT NULL CHECK (monto > 0),
          moneda          TEXT NOT NULL DEFAULT 'MXN',
          fecha_operacion TEXT NOT NULL,
          estado          TEXT NOT NULL DEFAULT 'borrador'
                          CHECK (estado IN ('borrador','en_validacion','observada','pendiente_direccion','aprobada','en_pago','pagada','cancelada')),
          cliente_id      INTEGER REFERENCES clientes(id),
          pagador         TEXT NOT NULL DEFAULT '',
          tipo_operacion  TEXT NOT NULL DEFAULT '',
          timbrar         INTEGER NOT NULL DEFAULT 0,
          comision_pct    REAL NOT NULL DEFAULT 0,
          observaciones   TEXT NOT NULL DEFAULT '',
          creado_por      INTEGER NOT NULL REFERENCES usuarios(id),
          creado_en       TEXT NOT NULL DEFAULT (datetime('now')),
          actualizado_en  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO operaciones (id, folio, tipo, concepto, proveedor, monto, moneda, fecha_operacion, estado, cliente_id, creado_por, creado_en, actualizado_en)
          SELECT id, folio, tipo, concepto, proveedor, monto, moneda, fecha_operacion, estado, cliente_id, creado_por, creado_en, actualizado_en FROM operaciones_old;
        DROP TABLE operaciones_old;
      `);
    }
    if (reconstruirPagos) {
      db.exec(`
        ALTER TABLE pagos RENAME TO pagos_old;
        CREATE TABLE pagos (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          operacion_id    INTEGER NOT NULL REFERENCES operaciones(id),
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
        INSERT INTO pagos (id, operacion_id, medio, monto, moneda, fecha_pago, comprobante, notas, pagado_por, cuenta_id, fecha_registro)
          SELECT id, operacion_id, medio, monto, moneda, fecha_pago, comprobante, notas, pagado_por, cuenta_id, fecha_registro FROM pagos_old;
        DROP TABLE pagos_old;
      `);
    }
    db.pragma("legacy_alter_table = OFF");
    db.pragma("foreign_keys = ON");
    console.log("[migración] captura completa FLUJO: operaciones con pagador/comisión/estado en_pago y pagos múltiples (tandas)");
  } catch (e) {
    db.pragma("legacy_alter_table = OFF");
    db.pragma("foreign_keys = ON");
    throw e;
  }
}

/**
 * Respaldo de operaciones con depósitos múltiples y financiamientos (§6.1):
 *   1) columnas de política de financiamiento en `clientes`;
 *   2) tabla `financiamientos`;
 *   3) `resguardos_movimientos` acepta el tipo 'financiamiento' (rebuild si su
 *      CHECK es viejo);
 *   4) `operaciones_depositos` admite VARIOS depósitos por operación (rebuild
 *      si quedó con UNIQUE). Las filas y validaciones previas se conservan.
 * Todas las pasos son idempotentes (seguras en cada arranque).
 */
function migrarRespaldosFinanciamientos(db: Database.Database): void {
  // 1) Columnas de política en clientes (ALTER simple, sin rebuild).
  const columnasCliente = (db.pragma("table_info(clientes)") as Array<{ name: string }>).map((c) => c.name);
  if (columnasCliente.length > 0 && !columnasCliente.includes("financiamiento_sin_aprobacion")) {
    db.exec("ALTER TABLE clientes ADD COLUMN financiamiento_sin_aprobacion INTEGER NOT NULL DEFAULT 0");
    console.log("[migración] clientes.financiamiento_sin_aprobacion añadida");
  }
  if (columnasCliente.length > 0 && !columnasCliente.includes("financiamiento_maximo")) {
    db.exec("ALTER TABLE clientes ADD COLUMN financiamiento_maximo REAL");
    console.log("[migración] clientes.financiamiento_maximo añadida");
  }

  // 2) Tabla de financiamientos + índices.
  db.exec(`
    CREATE TABLE IF NOT EXISTS financiamientos (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      operacion_id        INTEGER NOT NULL REFERENCES operaciones(id),
      cliente_id          INTEGER NOT NULL REFERENCES clientes(id),
      monto               REAL NOT NULL CHECK (monto > 0),
      notas               TEXT NOT NULL DEFAULT '',
      estado              TEXT NOT NULL DEFAULT 'solicitado'
                          CHECK (estado IN ('solicitado','aprobado','rechazado','cancelado')),
      requiere_aprobacion INTEGER NOT NULL DEFAULT 1,
      exento_motivo       TEXT NOT NULL DEFAULT '',
      solicitado_por      INTEGER NOT NULL REFERENCES usuarios(id),
      creado_en           TEXT NOT NULL DEFAULT (datetime('now')),
      resuelto_por        INTEGER REFERENCES usuarios(id),
      resuelto_en         TEXT,
      movimiento_id       INTEGER REFERENCES resguardos_movimientos(id)
    );
    CREATE INDEX IF NOT EXISTS idx_financiamientos_estado ON financiamientos(estado);
    CREATE INDEX IF NOT EXISTS idx_financiamientos_cliente ON financiamientos(cliente_id);
    CREATE INDEX IF NOT EXISTS idx_financiamientos_operacion ON financiamientos(operacion_id);
  `);

  // 3) resguardos_movimientos: rebuild si el CHECK no conoce 'financiamiento'.
  const resguardo = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'resguardos_movimientos'")
    .get() as { sql: string } | undefined;
  if (resguardo && !resguardo.sql.includes("'financiamiento'")) {
    db.pragma("foreign_keys = OFF");
    db.pragma("legacy_alter_table = ON");
    try {
      db.exec(`
        ALTER TABLE resguardos_movimientos RENAME TO resguardos_movimientos_old;
        CREATE TABLE resguardos_movimientos (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          cliente_id    INTEGER NOT NULL REFERENCES clientes(id),
          tipo          TEXT NOT NULL CHECK (tipo IN ('deposito','cargo','financiamiento')),
          importe       REAL NOT NULL CHECK (importe > 0),
          operacion_id  INTEGER REFERENCES operaciones(id),
          cuenta_id     INTEGER REFERENCES cuentas(id),
          comprobante   TEXT NOT NULL DEFAULT '',
          observaciones TEXT NOT NULL DEFAULT '',
          creado_por    INTEGER NOT NULL REFERENCES usuarios(id),
          creado_en     TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO resguardos_movimientos (id, cliente_id, tipo, importe, operacion_id, cuenta_id, comprobante, observaciones, creado_por, creado_en)
          SELECT id, cliente_id, tipo, importe, operacion_id, cuenta_id, comprobante, observaciones, creado_por, creado_en FROM resguardos_movimientos_old;
        DROP TABLE resguardos_movimientos_old;
      `);
      db.pragma("legacy_alter_table = OFF");
      db.pragma("foreign_keys = ON");
      console.log("[migración] resguardos_movimientos reconstruida con tipo 'financiamiento'");
    } catch (e) {
      db.pragma("legacy_alter_table = OFF");
      db.pragma("foreign_keys = ON");
      throw e;
    }
  }

  // 4) operaciones_depositos: rebuild si quedó con UNIQUE (un solo depósito).
  const depositos = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'operaciones_depositos'")
    .get() as { sql: string } | undefined;
  if (depositos && depositos.sql.includes("UNIQUE")) {
    db.pragma("foreign_keys = OFF");
    db.pragma("legacy_alter_table = ON");
    try {
      db.exec(`
        ALTER TABLE operaciones_depositos RENAME TO operaciones_depositos_old;
        CREATE TABLE operaciones_depositos (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          operacion_id   INTEGER NOT NULL REFERENCES operaciones(id),
          cuenta_id      INTEGER NOT NULL REFERENCES cuentas(id),
          monto          REAL NOT NULL CHECK (monto > 0),
          comprobante    TEXT NOT NULL,
          fecha_deposito TEXT NOT NULL,
          indicado_por   INTEGER NOT NULL REFERENCES usuarios(id),
          creado_en      TEXT NOT NULL DEFAULT (datetime('now')),
          validado_por   INTEGER REFERENCES usuarios(id),
          validado_en    TEXT
        );
        INSERT INTO operaciones_depositos (id, operacion_id, cuenta_id, monto, comprobante, fecha_deposito, indicado_por, creado_en, validado_por, validado_en)
          SELECT id, operacion_id, cuenta_id, monto, comprobante, fecha_deposito, indicado_por, creado_en, validado_por, validado_en FROM operaciones_depositos_old;
        DROP TABLE operaciones_depositos_old;
      `);
      db.pragma("legacy_alter_table = OFF");
      db.pragma("foreign_keys = ON");
      console.log("[migración] operaciones_depositos admite varios depósitos por operación (UNIQUE retirada)");
    } catch (e) {
      db.pragma("legacy_alter_table = OFF");
      db.pragma("foreign_keys = ON");
      throw e;
    }
  }
}

/**
 * Task 11 (Tesorería de depósitos): añade el rol 'confirmador', el tipo de
 * cuenta (flujo/frente/préstamo/anticipo/sofom/asimilado) y las columnas del
 * concentrado de movimientos (referencia, origen, marca de depósito) a bases
 * creadas antes de esta fase. Las tablas nuevas (depositos_comprobantes,
 * brokers_resguardos) ya las cubre el ESQUEMA con IF NOT EXISTS.
 */
function migrarTesoreriaDepositos(db: Database.Database): void {
  // 1) usuarios: rebuild si el CHECK no conoce 'confirmador'.
  const tabla = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'usuarios'")
    .get() as { sql: string } | undefined;
  if (tabla && !tabla.sql.includes("'confirmador'")) {
    db.pragma("foreign_keys = OFF");
    db.pragma("legacy_alter_table = ON");
    try {
      db.exec(`
        ALTER TABLE usuarios RENAME TO usuarios_old;
        CREATE TABLE usuarios (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          username      TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          nombre        TEXT NOT NULL,
          rol           TEXT NOT NULL CHECK (rol IN ('admin','admin_operaciones','admin_validacion','admin_tesoreria','operacion','validacion','validador_tesoreria','confirmador','tesoreria','fondeador','altas','direccion','auditoria')),
          activo        INTEGER NOT NULL DEFAULT 1
        );
        INSERT INTO usuarios (id, username, password_hash, nombre, rol, activo)
          SELECT id, username, password_hash, nombre, rol, activo FROM usuarios_old;
        DROP TABLE usuarios_old;
      `);
      db.pragma("legacy_alter_table = OFF");
      db.pragma("foreign_keys = ON");
      console.log("[migración] usuarios reconstruida con el rol 'confirmador'");
    } catch (e) {
      db.pragma("legacy_alter_table = OFF");
      db.pragma("foreign_keys = ON");
      throw e;
    }
  }

  // 2) cuentas.tipo (ALTER con CHECK y DEFAULT 'flujo': las cuentas previas
  //    quedan como flujos, que es lo que eran).
  const columnasCuenta = (db.pragma("table_info(cuentas)") as Array<{ name: string }>).map((c) => c.name);
  if (columnasCuenta.length > 0 && !columnasCuenta.includes("tipo")) {
    db.exec(
      "ALTER TABLE cuentas ADD COLUMN tipo TEXT NOT NULL DEFAULT 'flujo' CHECK (tipo IN ('flujo','frente','prestamo','anticipo_rendimiento','sofom','asimilado'))"
    );
    console.log("[migración] cuentas.tipo añadida (existentes como 'flujo')");
  }

  // 3) movimientos_cuentas: columnas del concentrado (referencia, origen y
  //    marca de trabajo). ALTER simples, conservan filas.
  const columnasMov = (db.pragma("table_info(movimientos_cuentas)") as Array<{ name: string }>).map(
    (c) => c.name
  );
  if (columnasMov.length > 0 && !columnasMov.includes("referencia")) {
    db.exec('ALTER TABLE movimientos_cuentas ADD COLUMN referencia TEXT NOT NULL DEFAULT \'\'');
    console.log("[migración] movimientos_cuentas.referencia añadida");
  }
  if (columnasMov.length > 0 && !columnasMov.includes("origen")) {
    db.exec("ALTER TABLE movimientos_cuentas ADD COLUMN origen TEXT NOT NULL DEFAULT 'tesoreria'");
    console.log("[migración] movimientos_cuentas.origen añadida");
  }
  if (columnasMov.length > 0 && !columnasMov.includes("deposito_id")) {
    db.exec("ALTER TABLE movimientos_cuentas ADD COLUMN deposito_id INTEGER REFERENCES operaciones_depositos(id)");
    console.log("[migración] movimientos_cuentas.deposito_id añadida");
  }
  if (columnasMov.length > 0 && !columnasMov.includes("marca")) {
    db.exec('ALTER TABLE movimientos_cuentas ADD COLUMN marca TEXT NOT NULL DEFAULT \'\'');
    console.log("[migración] movimientos_cuentas.marca añadida");
  }
  if (columnasMov.length > 0 && !columnasMov.includes("marcado_por")) {
    db.exec("ALTER TABLE movimientos_cuentas ADD COLUMN marcado_por INTEGER REFERENCES usuarios(id)");
    console.log("[migración] movimientos_cuentas.marcado_por añadida");
  }
  if (columnasMov.length > 0 && !columnasMov.includes("marcado_en")) {
    db.exec("ALTER TABLE movimientos_cuentas ADD COLUMN marcado_en TEXT");
    console.log("[migración] movimientos_cuentas.marcado_en añadida");
  }
}

/**
 * Fase Fondeo + Altas: añade `operaciones.liberada_por` / `liberada_en` (la
 * liberación del Tesorero Fondeador ante Tesorería). Las tablas nuevas
 * (validacion_ejecutivos, altas_bancarias) ya las cubre el ESQUEMA con IF NOT
 * EXISTS; el rol nuevo ('fondeador') lo cubre la reconstrucción de usuarios de
 * migrarUsuarios (su condición ahora es el CHECK de 13 roles).
 */
function migrarFondeoAltas(db: Database.Database): void {
  const columnas = (db.pragma("table_info(operaciones)") as Array<{ name: string }>).map((c) => c.name);
  if (columnas.length === 0) return;
  if (!columnas.includes("liberada_por")) {
    db.exec("ALTER TABLE operaciones ADD COLUMN liberada_por INTEGER REFERENCES usuarios(id)");
    console.log("[migración] operaciones.liberada_por añadida");
  }
  if (!columnas.includes("liberada_en")) {
    db.exec("ALTER TABLE operaciones ADD COLUMN liberada_en TEXT");
    console.log("[migración] operaciones.liberada_en añadida");
  }
}

/**
 * Tarea 12 (pagadoras del catálogo): añade a bases preexistentes las columnas
 * `dispersiones.pagadora` y `dispersiones.pagadora_cuenta_id`. La tabla
 * `operaciones_destinos` ya la crea el ESQUEMA (CREATE IF NOT EXISTS).
 */
function migrarPagadorasDestinos(db: Database.Database): void {
  const columnas = (db.pragma("table_info(dispersiones)") as Array<{ name: string }>).map((c) => c.name);
  if (columnas.length === 0) return;
  if (!columnas.includes("pagadora")) {
    db.exec("ALTER TABLE dispersiones ADD COLUMN pagadora TEXT NOT NULL DEFAULT ''");
    console.log("[migración] dispersiones.pagadora añadida");
  }
  if (!columnas.includes("pagadora_cuenta_id")) {
    db.exec("ALTER TABLE dispersiones ADD COLUMN pagadora_cuenta_id INTEGER REFERENCES cuentas(id)");
    console.log("[migración] dispersiones.pagadora_cuenta_id añadida");
  }
}

/**
 * Fase 13: añade `cuentas.visible_operador` a bases preexistentes (todas las
 * cuentas quedan visibles para los operadores, igual que antes). La tabla
 * `trf_resguardos_movimientos` (resguardo de TRF, la empresa) ya la crea el
 * ESQUEMA con CREATE IF NOT EXISTS en cada arranque.
 */
function migrarFase13(db: Database.Database): void {
  const columnas = (db.pragma("table_info(cuentas)") as Array<{ name: string }>).map((c) => c.name);
  if (columnas.length === 0) return;
  if (!columnas.includes("visible_operador")) {
    db.exec("ALTER TABLE cuentas ADD COLUMN visible_operador INTEGER NOT NULL DEFAULT 1");
    console.log("[migración] cuentas.visible_operador añadida (todas visibles para operadores)");
  }
}
/**
 * Fase 14:
 *   1) `operaciones` reconstruida: tipo 'pago_especial' + comision_trf_pct;
 *   2) `dispersiones` con nombre, apellido_paterno, apellido_materno,
 *      concepto y referencia_pago (TODOS OPCIONALES, DEFAULT '');
 *   3) `clientes` con comision_broker_pct / comision_trf_pct (NULL = sin
 *      preestablecer; las fija admin_operaciones);
 *   4) tabla `pagos_especiales` (formato adjunto + resguardo de origen).
 * Idempotente y conservando filas.
 */
function migrarFase14(db: Database.Database): void {
  const tablaOp = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'operaciones'")
    .get() as { sql: string } | undefined;
  if (!tablaOp) return; // base nueva: el ESQUEMA ya nace con todo
  const reconstruirOp = !tablaOp.sql.includes("'pago_especial'");

  const colsDisp = (db.pragma("table_info(dispersiones)") as Array<{ name: string }>).map((c) => c.name);
  if (colsDisp.length) {
    for (const c of ["nombre", "apellido_paterno", "apellido_materno", "concepto", "referencia_pago"]) {
      if (!colsDisp.includes(c)) {
        db.exec(`ALTER TABLE dispersiones ADD COLUMN ${c} TEXT NOT NULL DEFAULT ''`);
        console.log(`[migración] dispersiones.${c} añadida (opcional)`);
      }
    }
  }
  const colsCli = (db.pragma("table_info(clientes)") as Array<{ name: string }>).map((c) => c.name);
  if (colsCli.length) {
    if (!colsCli.includes("comision_broker_pct")) {
      db.exec("ALTER TABLE clientes ADD COLUMN comision_broker_pct REAL");
      console.log("[migración] clientes.comision_broker_pct añadida");
    }
    if (!colsCli.includes("comision_trf_pct")) {
      db.exec("ALTER TABLE clientes ADD COLUMN comision_trf_pct REAL");
      console.log("[migración] clientes.comision_trf_pct añadida");
    }
  }
  if (reconstruirOp) {
    db.pragma("foreign_keys = OFF");
    db.pragma("legacy_alter_table = ON");
    try {
      db.exec(`
        ALTER TABLE operaciones RENAME TO operaciones_old;
        CREATE TABLE operaciones (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          folio           TEXT NOT NULL UNIQUE,
          tipo            TEXT NOT NULL CHECK (tipo IN ('pago','cobro','financiamiento','flujo','pago_especial')),
          concepto        TEXT NOT NULL,
          proveedor       TEXT NOT NULL,
          monto           REAL NOT NULL CHECK (monto > 0),
          moneda          TEXT NOT NULL DEFAULT 'MXN',
          fecha_operacion TEXT NOT NULL,
          estado          TEXT NOT NULL DEFAULT 'borrador'
                          CHECK (estado IN ('borrador','en_validacion','observada','pendiente_direccion','aprobada','en_pago','pagada','cancelada')),
          cliente_id      INTEGER REFERENCES clientes(id),
          pagador         TEXT NOT NULL DEFAULT '',
          tipo_operacion  TEXT NOT NULL DEFAULT '',
          timbrar         INTEGER NOT NULL DEFAULT 0,
          comision_pct    REAL NOT NULL DEFAULT 0,
          comision_trf_pct REAL,
          observaciones   TEXT NOT NULL DEFAULT '',
          creado_por      INTEGER NOT NULL REFERENCES usuarios(id),
          creado_en       TEXT NOT NULL DEFAULT (datetime('now')),
          actualizado_en  TEXT NOT NULL DEFAULT (datetime('now')),
          liberada_por    INTEGER REFERENCES usuarios(id),
          liberada_en     TEXT
        );
        INSERT INTO operaciones (id, folio, tipo, concepto, proveedor, monto, moneda, fecha_operacion, estado, cliente_id, pagador, tipo_operacion, timbrar, comision_pct, comision_trf_pct, observaciones, creado_por, creado_en, actualizado_en, liberada_por, liberada_en)
          -- La tabla vieja nunca trae comision_trf_pct (si la tuviera, el CHECK
          -- ya sería el nuevo y no habría reconstrucción): se copia NULL.
          SELECT id, folio, tipo, concepto, proveedor, monto, moneda, fecha_operacion, estado, cliente_id, pagador, tipo_operacion, timbrar, comision_pct, NULL, observaciones, creado_por, creado_en, actualizado_en, liberada_por, liberada_en FROM operaciones_old;
        DROP TABLE operaciones_old;
      `);
      db.pragma("legacy_alter_table = OFF");
      db.pragma("foreign_keys = ON");
      console.log("[migración] operaciones reconstruida: tipo 'pago_especial' + comision_trf_pct (Fase 14)");
    } catch (e) {
      db.pragma("legacy_alter_table = OFF");
      db.pragma("foreign_keys = ON");
      throw e;
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS pagos_especiales (
      operacion_id        INTEGER PRIMARY KEY REFERENCES operaciones(id),
      descripcion         TEXT NOT NULL DEFAULT '',
      pagadora_cuenta_id  INTEGER REFERENCES cuentas(id),
      pagadora            TEXT NOT NULL DEFAULT '',
      resguardo_origen    TEXT NOT NULL CHECK (resguardo_origen IN ('trf','broker')),
      broker_origen_id    INTEGER REFERENCES brokers(id),
      broker_origen       TEXT NOT NULL DEFAULT '',
      formato_nombre      TEXT NOT NULL DEFAULT '',
      formato_mime        TEXT NOT NULL DEFAULT '',
      formato_contenido   TEXT NOT NULL DEFAULT '',
      creado_por          INTEGER NOT NULL REFERENCES usuarios(id),
      creado_en           TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

/**
 * Semilla del catálogo de cuentas del negocio (10 flujos y 2 de cada uno de
 * los demás tipos) para empezar a revisar los flujos del sistema. Idempotente:
 * sólo inserta las que no existen por nombre.
 */
function sembrarCuentasTesoreria(db: Database.Database): void {
  const semilla: Array<[nombre: string, tipo: string, banco: string, numero: string]> = [
    ...Array.from({ length: 10 }, (_, i) => {
      const n = String(i + 1).padStart(2, "0");
      const bancos = ["BBVA", "BANORTE", "SANTANDER", "BANAMEX", "HSBC"];
      return [`FLUJOS ${n}`, "flujo", bancos[i % bancos.length], `000${n}`] as [string, string, string, string];
    }),
    ["FRENTES 01", "frente", "BBVA", "0101"],
    ["FRENTES 02", "frente", "BANORTE", "0102"],
    ["PRESTAMOS 01", "prestamo", "SANTANDER", "0201"],
    ["PRESTAMOS 02", "prestamo", "BBVA", "0202"],
    ["ANTICIPO RENDIMIENTOS 01", "anticipo_rendimiento", "BANAMEX", "0301"],
    ["ANTICIPO RENDIMIENTOS 02", "anticipo_rendimiento", "HSBC", "0302"],
    ["SOFOM 01", "sofom", "BBVA", "0401"],
    ["SOFOM 02", "sofom", "BANORTE", "0402"],
    ["ASIMILADOS 01", "asimilado", "SANTANDER", "0501"],
    ["ASIMILADOS 02", "asimilado", "BBVA", "0502"],
  ];
  const insertar = db.prepare(
    `INSERT INTO cuentas (nombre, banco, numero_cuenta, tipo)
     SELECT ?, ?, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM cuentas WHERE nombre = ?)`
  );
  let altas = 0;
  for (const [nombre, tipo, banco, numero] of semilla) {
    const r = insertar.run(nombre, banco, numero, tipo, nombre);
    altas += Number(r.changes);
  }
  if (altas > 0) console.log(`[semilla] catálogo de cuentas de Tesorería: ${altas} alta(s)`);
}

function sembrarUsuarios(db: Database.Database): void {
  const cuenta = db.prepare("SELECT COUNT(*) AS n FROM usuarios").get() as { n: number };
  if (cuenta.n > 0) return;
  const insertar = db.prepare(
    "INSERT INTO usuarios (username, password_hash, nombre, rol) VALUES (?, ?, ?, ?)"
  );
  const semilla: Array<[string, string, Rol]> = [
    ["admin", "Administrador del Sistema", "admin"],
    ["admin_ops", "Administrador de Operaciones", "admin_operaciones"],
    ["admin_validacion", "Administrador de Validación", "admin_validacion"],
    ["admin_tesoreria", "Administrador de Tesorería", "admin_tesoreria"],
    ["operador", "Ejecutivo de Operaciones", "operacion"],
    ["validador", "Validador de Operaciones", "validacion"],
    ["val_tesoreria", "Validador de Tesorería", "validador_tesoreria"],
    ["confirmador", "Confirmador de Depósitos", "confirmador"],
    ["tesoreria", "Analista de Tesorería", "tesoreria"],
    ["fondeador", "Tesorero Fondeador", "fondeador"],
    ["altas", "Tesorería de Altas", "altas"],
    ["direccion", "Dirección", "direccion"],
    ["auditor", "Auditoría", "auditoria"],
  ];
  for (const [username, nombre, rol] of semilla) {
    // Password por defecto igual al username (cambiar en producción).
    insertar.run(username, bcrypt.hashSync(username, 10), nombre, rol);
  }
}

/**
 * Asegura que los usuarios base existan también en bases creadas antes de la
 * fase de roles (donde `sembrarUsuarios` ya no corre porque hay usuarios).
 */
function asegurarUsuariosBase(db: Database.Database): void {
  const insertar = db.prepare(
    "INSERT OR IGNORE INTO usuarios (username, password_hash, nombre, rol) VALUES (?, ?, ?, ?)"
  );
  const base: Array<[string, string, Rol]> = [
    ["admin", "Administrador del Sistema", "admin"],
    ["admin_ops", "Administrador de Operaciones", "admin_operaciones"],
    ["admin_validacion", "Administrador de Validación", "admin_validacion"],
    ["admin_tesoreria", "Administrador de Tesorería", "admin_tesoreria"],
    ["val_tesoreria", "Validador de Tesorería", "validador_tesoreria"],
    ["confirmador", "Confirmador de Depósitos", "confirmador"],
    ["fondeador", "Tesorero Fondeador", "fondeador"],
    ["altas", "Tesorería de Altas", "altas"],
  ];
  for (const [username, nombre, rol] of base) {
    insertar.run(username, bcrypt.hashSync(username, 10), nombre, rol);
  }
}

/** Catálogos y parámetros iniciales (sólo si no existen). */
function sembrarCatalogosYParametros(db: Database.Database): void {
  db.prepare(
    "INSERT OR IGNORE INTO catalogos (dominio, clave, valor) VALUES ('pagadora', 'BBVA', 'BBVA México'), ('pagadora', 'SANTANDER', 'Santander México'), ('pagadora', 'BANORTE', 'Banorte')"
  ).run();
  // Formato FLUJO: catálogos del negocio para el nuevo formulario de captura.
  db.prepare(
    "INSERT OR IGNORE INTO catalogos (dominio, clave, valor) VALUES ('pagador', 'FLUJOS', 'FLUJOS'), ('tipo_operacion', 'FLUJOS', 'FLUJOS')"
  ).run();
  db.prepare(
    "INSERT OR IGNORE INTO parametros (clave, valor, descripcion) VALUES ('umbral_direccion', '500000', 'Monto igual o mayor al cual la operación requiere aprobación de Dirección')"
  ).run();
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
  tipo: TipoCuenta;
  saldo_inicial: number;
  activa: number;
  /**
   * Fase 13: visibilidad de la cuenta en el listado de PAGADORAS que ven los
   * usuarios operadores al capturar (1 = visible, 0 = oculta para operadores).
   * Tesorería la enciende/apaga; por defecto todas son visibles. Es un control
   * de catálogo (lo que el operador ve): la validación de fondo del backend
   * sigue exigiendo sólo que la cuenta esté activa.
   */
  visible_operador: number;
  creado_en: string;
  /** Fase 15 — catálogo maestro (columnas añadidas por la migración). */
  clabe?: string;
  moneda?: string;
  origen?: string;
  estatus?: string;
  cliente?: string;
  fecha_alta?: string | null;
  fecha_baja?: string | null;
  formato_reporte?: string;
}

/** Fase 15 — banco del catálogo SPEI (los 3 primeros dígitos de la CLABE). */
export interface BancoSpei {
  clave: string;
  nombre_corto: string;
  nombre_completo: string;
}

/**
 * Fase 15 — credencial de la bóveda (1 cuenta → N credenciales). Los campos
 * sensibles NUNCA se exponen: los listados sólo traen banderas `tiene_*`; el
 * contenido se entrega por un endpoint aparte que audita el acceso.
 */
export interface CredencialBoveda {
  id: number;
  cuenta_id: number;
  tipo: "portal" | "correo" | "eplata" | "sofipo" | "token" | "otro";
  etiqueta: string;
  usuario: string;
  tiene_secreto: boolean;
  tiene_nip: boolean;
  tiene_clave_seguridad: boolean;
  token_numero: string;
  telefono: string;
  correo: string;
  vigencia: string;
  notas: string;
  activo: number;
  creado_por: number;
  creado_en: string;
  actualizado_en: string | null;
}

/** Fase 15 — registro de acceso a la bóveda (auditoría). */
export interface AccesoCredencial {
  id: number;
  credencial_id: number;
  usuario_id: number;
  usuario?: string;
  accion: "ver" | "crear" | "actualizar" | "desactivar";
  campo: string;
  fecha: string;
}

/** Fase 15 — registro de una alta bancaria en el portal de una pagadora. */
export interface AltaPortal {
  id: number;
  alta_bancaria_id: number;
  portal_cuenta_id: number;
  portal?: string;
  estado: "pendiente" | "dada_de_alta" | "rechazada";
  motivo_rechazo: string;
  registrado_por: number | null;
  registrado_en: string | null;
  creado_en: string;
}

/**
 * Fase 13: resguardo de TRF (la empresa). Ledger append-only de ingresos y
 * retiros en la moneda en que ocurren; los movimientos en moneda distinta de
 * MXN guardan el TIPO DE CAMBIO que aplicó el banco en la operación, para que
 * los resguardos cuadren contra pesos (el equivalente es importe × tipo_cambio).
 */
export interface TrfResguardoMovimiento {
  id: number;
  /** 'ingreso' suma al resguardo; 'retiro' resta. */
  tipo: "ingreso" | "retiro";
  importe: number;
  /** Moneda del movimiento (código de 3 letras; MXN no requiere tipo de cambio). */
  moneda: string;
  /** Tipo de cambio aplicado por el banco (obligatorio cuando moneda ≠ MXN). */
  tipo_cambio: number | null;
  operacion_id: number | null;
  notas: string;
  creado_por: number;
  creado_en: string;
}

export interface MovimientoCuenta {
  id: number;
  cuenta_id: number;
  tipo: "deposito" | "retiro";
  monto: number;
  concepto: string;
  referencia: string;
  fecha: string;
  origen: string;
  deposito_id: number | null;
  marca: string;
  marcado_por: number | null;
  marcado_en: string | null;
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
  // Tesorería puede cancelar una operación en proceso (sólo si no hay tandas).
  en_validacion: ["aprobada", "observada", "pendiente_direccion", "cancelada"],
  observada: ["en_validacion", "cancelada"],
  pendiente_direccion: ["aprobada", "observada", "cancelada"],
  // Formato FLUJO: una tanda parcial deja la operación 'en_pago' hasta cubrir
  // el flujo total; una tanda completa pasa directo a 'pagada'.
  aprobada: ["pagada", "en_pago", "cancelada"],
  en_pago: ["pagada", "cancelada"],
  pagada: [],
  cancelada: [],
};