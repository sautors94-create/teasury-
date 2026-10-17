-- Esquema central para PostgreSQL (fase de sincronización).
-- El backend habla primero con SQLite local; al desplegar el servidor central,
-- este archivo crea la base equivalente en Postgres. Mismos nombres de
-- tablas/columnas que backend/src/db.ts, con tipos nativos de Postgres.

CREATE TABLE IF NOT EXISTS usuarios (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  nombre        TEXT NOT NULL,
  rol           TEXT NOT NULL CHECK (rol IN ('operacion','validacion','tesoreria','direccion','auditoria')),
  activo        BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS operaciones (
  id              SERIAL PRIMARY KEY,
  folio           TEXT NOT NULL UNIQUE,
  tipo            TEXT NOT NULL CHECK (tipo IN ('pago','cobro','financiamiento')),
  concepto        TEXT NOT NULL,
  proveedor       TEXT NOT NULL,
  monto           NUMERIC(14,2) NOT NULL CHECK (monto > 0),
  moneda          TEXT NOT NULL DEFAULT 'MXN',
  fecha_operacion TEXT NOT NULL,
  estado          TEXT NOT NULL DEFAULT 'borrador'
                  CHECK (estado IN ('borrador','en_validacion','observada','pendiente_direccion','aprobada','pagada','cancelada')),
  creado_por      INTEGER NOT NULL REFERENCES usuarios(id),
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS revisiones (
  id            SERIAL PRIMARY KEY,
  operacion_id  INTEGER NOT NULL REFERENCES operaciones(id),
  revisor_id    INTEGER NOT NULL REFERENCES usuarios(id),
  resultado     TEXT NOT NULL CHECK (resultado IN ('aprobada','observada')),
  comentario    TEXT NOT NULL,
  fecha         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auditoria (
  id            SERIAL PRIMARY KEY,
  operacion_id  INTEGER REFERENCES operaciones(id),
  usuario_id    INTEGER NOT NULL REFERENCES usuarios(id),
  accion        TEXT NOT NULL,
  detalle       TEXT NOT NULL,
  fecha         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cuentas (
  id            SERIAL PRIMARY KEY,
  nombre        TEXT NOT NULL,
  banco         TEXT NOT NULL DEFAULT '',
  numero_cuenta TEXT NOT NULL DEFAULT '',
  saldo_inicial NUMERIC(14,2) NOT NULL DEFAULT 0,
  activa        BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pagos (
  id            SERIAL PRIMARY KEY,
  operacion_id  INTEGER NOT NULL UNIQUE REFERENCES operaciones(id),
  medio         TEXT NOT NULL CHECK (medio IN ('transferencia','domiciliacion','cheque','efectivo','otro')),
  monto         NUMERIC(14,2) NOT NULL CHECK (monto > 0),
  moneda        TEXT NOT NULL DEFAULT 'MXN',
  fecha_pago    TEXT NOT NULL,
  comprobante   TEXT NOT NULL,
  notas         TEXT NOT NULL DEFAULT '',
  pagado_por    INTEGER NOT NULL REFERENCES usuarios(id),
  cuenta_id     INTEGER REFERENCES cuentas(id),
  fecha_registro TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS movimientos_cuentas (
  id          SERIAL PRIMARY KEY,
  cuenta_id   INTEGER NOT NULL REFERENCES cuentas(id),
  tipo        TEXT NOT NULL CHECK (tipo IN ('deposito','retiro')),
  monto       NUMERIC(14,2) NOT NULL CHECK (monto > 0),
  concepto    TEXT NOT NULL,
  fecha       TEXT NOT NULL,
  creado_por  INTEGER NOT NULL REFERENCES usuarios(id),
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Identidad de sincronización (uuid + versión), igual que en el local.
CREATE TABLE IF NOT EXISTS sync_registros (
  tabla       TEXT NOT NULL,
  uuid        TEXT NOT NULL,
  registro_id INTEGER NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tabla, uuid),
  UNIQUE (tabla, registro_id)
);

CREATE TABLE IF NOT EXISTS sync_aplicados (
  id          SERIAL PRIMARY KEY,
  tabla       TEXT NOT NULL,
  uuid        TEXT NOT NULL,
  version     INTEGER NOT NULL,
  accion      TEXT NOT NULL,
  payload     TEXT NOT NULL,
  usuario_id  INTEGER REFERENCES usuarios(id),
  fecha       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tabla, uuid, version)
);

CREATE INDEX IF NOT EXISTS idx_operaciones_estado ON operaciones (estado);
CREATE INDEX IF NOT EXISTS idx_auditoria_operacion ON auditoria (operacion_id);
CREATE INDEX IF NOT EXISTS idx_pagos_fecha ON pagos (fecha_pago);
CREATE INDEX IF NOT EXISTS idx_movimientos_cuenta ON movimientos_cuentas (cuenta_id);