-- Esquema central para PostgreSQL (fase de sincronización).
-- El backend habla primero con SQLite local; al desplegar el servidor central,
-- este archivo crea la base equivalente en Postgres. Mismos nombres de
-- tablas/columnas que backend/src/db.ts, con tipos nativos de Postgres.

CREATE TABLE IF NOT EXISTS usuarios (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  nombre        TEXT NOT NULL,
  rol           TEXT NOT NULL CHECK (rol IN ('admin','admin_operaciones','admin_validacion','admin_tesoreria','operacion','validacion','validador_tesoreria','confirmador','tesoreria','direccion','auditoria')),
  activo        BOOLEAN NOT NULL DEFAULT TRUE
);

-- Fase roles (01-ROLES.md §3): clientes y asignaciones a ejecutivos. La
-- política de financiamiento la determina Dirección (§6.1).
CREATE TABLE IF NOT EXISTS clientes (
  id         SERIAL PRIMARY KEY,
  nombre     TEXT NOT NULL,
  rfc        TEXT NOT NULL DEFAULT '',
  contacto   TEXT NOT NULL DEFAULT '',
  notas      TEXT NOT NULL DEFAULT '',
  activo     BOOLEAN NOT NULL DEFAULT TRUE,
  financiamiento_sin_aprobacion BOOLEAN NOT NULL DEFAULT FALSE,
  financiamiento_maximo         NUMERIC(14,2),
  comision_broker_pct NUMERIC(5,2),
  comision_trf_pct    NUMERIC(5,2),
  creado_por INTEGER NOT NULL REFERENCES usuarios(id),
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Financiamientos que respaldan operaciones (§6.1): Dirección aprueba o
-- rechaza; al aprobarse el monto ingresa al resguardo del cliente.
-- (La tabla se define después de resguardos_movimientos por la FK movimiento_id.)

CREATE TABLE IF NOT EXISTS cliente_asignaciones (
  id           SERIAL PRIMARY KEY,
  cliente_id   INTEGER NOT NULL REFERENCES clientes(id),
  ejecutivo_id INTEGER NOT NULL REFERENCES usuarios(id),
  motivo       TEXT NOT NULL DEFAULT '',
  asignado_por INTEGER NOT NULL REFERENCES usuarios(id),
  activo       BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
  cerrado_en   TIMESTAMPTZ
);

-- Cobertura temporal de clientes (01-ROLES.md §3.1 + 00-VISION.md §6): una
-- segunda asignación por vacaciones/permisos especiales. El ejecutivo temporal
-- ve el cliente y su historial sin alterar la asignación principal.
CREATE TABLE IF NOT EXISTS cliente_coberturas (
  id                    SERIAL PRIMARY KEY,
  cliente_id            INTEGER NOT NULL REFERENCES clientes(id),
  ejecutivo_habitual_id INTEGER NOT NULL REFERENCES usuarios(id),
  ejecutivo_temporal_id INTEGER NOT NULL REFERENCES usuarios(id),
  fecha_inicio          TEXT NOT NULL,
  fecha_fin             TEXT,
  motivo                TEXT NOT NULL DEFAULT '',
  asignado_por          INTEGER NOT NULL REFERENCES usuarios(id),
  activo                BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en             TIMESTAMPTZ NOT NULL DEFAULT now(),
  cerrado_en            TIMESTAMPTZ
);

-- Resguardo por cliente (modelo financiero del resguardo): el saldo NO se
-- guarda nunca (01-ROLES.md §14), es la suma de sus movimientos:
--   deposito (+) y financiamiento (+) validados/aprobados, cargo (−) al pagar.
CREATE TABLE IF NOT EXISTS resguardos_movimientos (
  id            SERIAL PRIMARY KEY,
  cliente_id    INTEGER NOT NULL REFERENCES clientes(id),
  tipo          TEXT NOT NULL CHECK (tipo IN ('deposito','cargo','financiamiento')),
  importe       NUMERIC(14,2) NOT NULL CHECK (importe > 0),
  operacion_id  INTEGER REFERENCES operaciones(id),
  cuenta_id     INTEGER REFERENCES cuentas(id),
  comprobante   TEXT NOT NULL DEFAULT '',
  observaciones TEXT NOT NULL DEFAULT '',
  creado_por    INTEGER NOT NULL REFERENCES usuarios(id),
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Financiamientos que respaldan operaciones (§6.1): Dirección aprueba o
-- rechaza; al aprobarse el monto ingresa al resguardo del cliente como un
-- movimiento tipo 'financiamiento' (§14: el saldo sigue siendo calculado).
CREATE TABLE IF NOT EXISTS financiamientos (
  id                  SERIAL PRIMARY KEY,
  operacion_id        INTEGER NOT NULL REFERENCES operaciones(id),
  cliente_id          INTEGER NOT NULL REFERENCES clientes(id),
  monto               NUMERIC(14,2) NOT NULL CHECK (monto > 0),
  notas               TEXT NOT NULL DEFAULT '',
  estado              TEXT NOT NULL DEFAULT 'solicitado'
                      CHECK (estado IN ('solicitado','aprobado','rechazado','cancelado')),
  requiere_aprobacion BOOLEAN NOT NULL DEFAULT TRUE,
  exento_motivo       TEXT NOT NULL DEFAULT '',
  solicitado_por      INTEGER NOT NULL REFERENCES usuarios(id),
  creado_en           TIMESTAMPTZ NOT NULL DEFAULT now(),
  resuelto_por        INTEGER REFERENCES usuarios(id),
  resuelto_en         TIMESTAMPTZ,
  movimiento_id       INTEGER REFERENCES resguardos_movimientos(id)
);

CREATE INDEX IF NOT EXISTS idx_financiamientos_estado ON financiamientos (estado);
CREATE INDEX IF NOT EXISTS idx_financiamientos_cliente ON financiamientos (cliente_id);
CREATE INDEX IF NOT EXISTS idx_financiamientos_operacion ON financiamientos (operacion_id);

-- Depósitos indicados por el Ejecutivo para respaldar la operación (uno o
-- varios): cuenta donde se depositó + comprobante, pendientes de validar por
-- Tesorería. Sin UNIQUE por operación: la captura admite varios depósitos.
CREATE TABLE IF NOT EXISTS operaciones_depositos (
  id             SERIAL PRIMARY KEY,
  operacion_id   INTEGER NOT NULL REFERENCES operaciones(id),
  cuenta_id      INTEGER NOT NULL REFERENCES cuentas(id),
  monto          NUMERIC(14,2) NOT NULL CHECK (monto > 0),
  comprobante    TEXT NOT NULL,
  fecha_deposito TEXT NOT NULL,
  indicado_por   INTEGER NOT NULL REFERENCES usuarios(id),
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  validado_por   INTEGER REFERENCES usuarios(id),
  validado_en    TIMESTAMPTZ
);

-- Comprobantes (respaldos) de un depósito indicado: 1 o varios archivos
-- (PDF/imágenes) por depósito para que Tesorería valide contra ellos (§5.3).
-- Sin al menos un comprobante el depósito no puede validarse.
CREATE TABLE IF NOT EXISTS depositos_comprobantes (
  id           SERIAL PRIMARY KEY,
  deposito_id  INTEGER NOT NULL REFERENCES operaciones_depositos(id),
  nombre       TEXT NOT NULL,
  mime         TEXT NOT NULL DEFAULT 'application/octet-stream',
  tamano       INTEGER NOT NULL DEFAULT 0,
  contenido    BYTEA NOT NULL,
  subido_por   INTEGER NOT NULL REFERENCES usuarios(id),
  creado_en    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_depositos_comprobantes_deposito ON depositos_comprobantes (deposito_id);

-- Fase roles (01-ROLES.md §4): cola de validación administrada por el
-- Administrador de Validación; asignación operación -> validador (append-only).
CREATE TABLE IF NOT EXISTS asignaciones_validacion (
  id           SERIAL PRIMARY KEY,
  operacion_id INTEGER NOT NULL REFERENCES operaciones(id),
  validador_id INTEGER NOT NULL REFERENCES usuarios(id),
  motivo       TEXT NOT NULL DEFAULT '',
  asignado_por INTEGER NOT NULL REFERENCES usuarios(id),
  activo       BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
  cerrado_en   TIMESTAMPTZ
);

-- Fase roles (01-ROLES.md §5): asignaciones de cuentas a tesoreros
-- (append-only) y coberturas temporales (00-VISION.md §6).
CREATE TABLE IF NOT EXISTS cuentas_asignaciones (
  id           SERIAL PRIMARY KEY,
  cuenta_id    INTEGER NOT NULL REFERENCES cuentas(id),
  tesorero_id  INTEGER NOT NULL REFERENCES usuarios(id),
  motivo       TEXT NOT NULL DEFAULT '',
  asignado_por INTEGER NOT NULL REFERENCES usuarios(id),
  activo       BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
  cerrado_en   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS coberturas (
  id                   SERIAL PRIMARY KEY,
  cuenta_id            INTEGER NOT NULL REFERENCES cuentas(id),
  tesorero_habitual_id INTEGER NOT NULL REFERENCES usuarios(id),
  tesorero_temporal_id INTEGER NOT NULL REFERENCES usuarios(id),
  fecha_inicio         TEXT NOT NULL,
  fecha_fin            TEXT,
  motivo               TEXT NOT NULL DEFAULT '',
  asignado_por         INTEGER NOT NULL REFERENCES usuarios(id),
  activo               BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en            TIMESTAMPTZ NOT NULL DEFAULT now(),
  cerrado_en           TIMESTAMPTZ
);

-- Aplicaciones de recursos (01-ROLES.md §5.2) con doble control (§10) y
-- anti doble uso: la suma vigente nunca excede el movimiento ni la operación.
CREATE TABLE IF NOT EXISTS aplicaciones_recursos (
  id              SERIAL PRIMARY KEY,
  movimiento_id   INTEGER NOT NULL REFERENCES movimientos_cuentas(id),
  operacion_id    INTEGER NOT NULL REFERENCES operaciones(id),
  importe         NUMERIC(14,2) NOT NULL CHECK (importe > 0),
  moneda          TEXT NOT NULL DEFAULT 'MXN',
  observaciones   TEXT NOT NULL DEFAULT '',
  aplicado_por    INTEGER NOT NULL REFERENCES usuarios(id),
  aplicado_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
  liberado_por    INTEGER REFERENCES usuarios(id),
  liberado_en     TIMESTAMPTZ,
  liberado_motivo TEXT
);

-- Catálogos y parámetros administrables por el Administrador del sistema (§8.1).
CREATE TABLE IF NOT EXISTS catalogos (
  id              SERIAL PRIMARY KEY,
  dominio         TEXT NOT NULL,
  clave           TEXT NOT NULL,
  valor           TEXT NOT NULL,
  activo          BOOLEAN NOT NULL DEFAULT TRUE,
  actualizado_por INTEGER REFERENCES usuarios(id),
  UNIQUE (dominio, clave)
);

CREATE TABLE IF NOT EXISTS parametros (
  clave           TEXT PRIMARY KEY,
  valor           TEXT NOT NULL,
  descripcion     TEXT NOT NULL DEFAULT '',
  actualizado_por INTEGER REFERENCES usuarios(id),
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS operaciones (
  id              SERIAL PRIMARY KEY,
  folio           TEXT NOT NULL UNIQUE,
  tipo            TEXT NOT NULL CHECK (tipo IN ('pago','cobro','financiamiento','flujo','pago_especial')),
  concepto        TEXT NOT NULL,
  proveedor       TEXT NOT NULL,
  monto           NUMERIC(14,2) NOT NULL CHECK (monto > 0),
  moneda          TEXT NOT NULL DEFAULT 'MXN',
  fecha_operacion TEXT NOT NULL,
  estado          TEXT NOT NULL DEFAULT 'borrador'
                  CHECK (estado IN ('borrador','en_validacion','observada','pendiente_direccion','aprobada','en_pago','pagada','cancelada')),
  cliente_id      INTEGER REFERENCES clientes(id),
  pagador         TEXT NOT NULL DEFAULT '',
  tipo_operacion  TEXT NOT NULL DEFAULT '',
  timbrar         BOOLEAN NOT NULL DEFAULT FALSE,
  comision_pct    NUMERIC(7,4) NOT NULL DEFAULT 0,
  comision_trf_pct NUMERIC(5,2),
  observaciones   TEXT NOT NULL DEFAULT '',
  creado_por      INTEGER NOT NULL REFERENCES usuarios(id),
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Formato FLUJO: catálogo de brokers (reparto de la comisión).
CREATE TABLE IF NOT EXISTS brokers (
  id         SERIAL PRIMARY KEY,
  nombre     TEXT NOT NULL UNIQUE,
  porcentaje NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (porcentaje >= 0 AND porcentaje <= 100),
  activo     BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Brokers participantes en una operación (fotografía de nombre/%/monto).
CREATE TABLE IF NOT EXISTS operaciones_brokers (
  id           SERIAL PRIMARY KEY,
  operacion_id INTEGER NOT NULL REFERENCES operaciones(id),
  broker_id    INTEGER NOT NULL REFERENCES brokers(id),
  nombre       TEXT NOT NULL,
  porcentaje   NUMERIC(5,2) NOT NULL,
  monto        NUMERIC(14,2) NOT NULL DEFAULT 0
);

-- Dispersiones del formato FLUJO: plan de pagos a beneficiarios; su suma es
-- el Flujo Total del formato.
CREATE TABLE IF NOT EXISTS dispersiones (
  id           SERIAL PRIMARY KEY,
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
  importe      NUMERIC(14,2) NOT NULL CHECK (importe > 0),
  pagadora     TEXT NOT NULL DEFAULT '',
  pagadora_cuenta_id INTEGER REFERENCES cuentas(id)
);

-- Tarea 12: pagadoras/frentes de la operación seleccionados del catálogo de
-- Tesorería (multi-selección con marca de manejo manual). cuenta_id NULL =
-- "CUALQUIER <tipo>": Tesorería determina la cuenta concreta.
CREATE TABLE IF NOT EXISTS operaciones_destinos (
  id            SERIAL PRIMARY KEY,
  operacion_id  INTEGER NOT NULL REFERENCES operaciones(id),
  cuenta_id     INTEGER REFERENCES cuentas(id),
  tipo          TEXT NOT NULL DEFAULT 'flujo',
  nombre        TEXT NOT NULL DEFAULT '',
  manejo_manual INTEGER NOT NULL DEFAULT 0,
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_destinos_operacion ON operaciones_destinos(operacion_id);

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
  tipo          TEXT NOT NULL DEFAULT 'flujo' CHECK (tipo IN ('flujo','frente','prestamo','anticipo_rendimiento','sofom','asimilado')),
  saldo_inicial NUMERIC(14,2) NOT NULL DEFAULT 0,
  activa        BOOLEAN NOT NULL DEFAULT TRUE,
  -- Fase 13: visible en el listado de pagadoras de los operadores (Tesorería la controla).
  visible_operador BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pagos (
  id            SERIAL PRIMARY KEY,
  operacion_id  INTEGER NOT NULL REFERENCES operaciones(id),
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
  referencia  TEXT NOT NULL DEFAULT '',
  fecha       TEXT NOT NULL,
  origen      TEXT NOT NULL DEFAULT 'tesoreria',
  deposito_id INTEGER REFERENCES operaciones_depositos(id),
  marca       TEXT NOT NULL DEFAULT '',
  marcado_por INTEGER REFERENCES usuarios(id),
  marcado_en  TIMESTAMPTZ,
  creado_por  INTEGER NOT NULL REFERENCES usuarios(id),
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Resguardo de comisiones por broker: al quedar PAGADA una operación, la
-- comisión cobrada de cada broker participante entra a su resguardo; los
-- retiros (pagos al broker) lo disminuyen. Ledger append-only.
CREATE TABLE IF NOT EXISTS brokers_resguardos (
  id           SERIAL PRIMARY KEY,
  broker_id    INTEGER NOT NULL REFERENCES brokers(id),
  tipo         TEXT NOT NULL CHECK (tipo IN ('comision','retiro')),
  importe      NUMERIC(14,2) NOT NULL CHECK (importe > 0),
  operacion_id INTEGER REFERENCES operaciones(id),
  notas        TEXT NOT NULL DEFAULT '',
  creado_por   INTEGER NOT NULL REFERENCES usuarios(id),
  creado_en    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_brokers_resguardos_broker ON brokers_resguardos (broker_id);

-- Resguardo de TRF (la empresa, Fase 13): ledger append-only de ingresos y
-- retiros en la moneda en que ocurren. Los movimientos en moneda distinta de
-- MXN registran el TIPO DE CAMBIO que aplicó el banco (tipo_cambio), de modo
-- que el resguardo cuadre: equivalente en pesos = importe × tipo_cambio.
CREATE TABLE IF NOT EXISTS trf_resguardos_movimientos (
  id           SERIAL PRIMARY KEY,
  tipo         TEXT NOT NULL CHECK (tipo IN ('ingreso','retiro')),
  importe      NUMERIC(14,2) NOT NULL CHECK (importe > 0),
  moneda       TEXT NOT NULL DEFAULT 'MXN',
  tipo_cambio  NUMERIC(14,6) CHECK (tipo_cambio IS NULL OR tipo_cambio > 0),
  operacion_id INTEGER REFERENCES operaciones(id),
  notas        TEXT NOT NULL DEFAULT '',
  creado_por   INTEGER NOT NULL REFERENCES usuarios(id),
  creado_en    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trf_resguardos_moneda ON trf_resguardos_movimientos (moneda);

-- Pagos especiales (Fase 14): retiro respaldado por un resguardo (TRF o
-- broker); el ejecutivo adjunta el formato (p.ej. SAT), captura importe,
-- pagadora y descripción breve. Al pagarse descuenta del resguardo de origen.
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
  creado_en           TIMESTAMPTZ NOT NULL DEFAULT now()
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

-- Cola de envíos del cliente offline (fase siguiente, docs/05-sincronizacion.md)
CREATE TABLE IF NOT EXISTS sync_envios (
  tabla          TEXT NOT NULL,
  uuid           TEXT NOT NULL,
  version        INTEGER NOT NULL,
  estado         TEXT NOT NULL CHECK (estado IN ('pendiente','confirmado','conflicto','error','resuelto')),
  detalle        TEXT NOT NULL DEFAULT '',
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tabla, uuid, version)
);

CREATE INDEX IF NOT EXISTS idx_sync_envios_estado ON sync_envios (estado);
CREATE INDEX IF NOT EXISTS idx_operaciones_estado ON operaciones (estado);
CREATE INDEX IF NOT EXISTS idx_operaciones_cliente ON operaciones (cliente_id);
CREATE INDEX IF NOT EXISTS idx_asignaciones_ejecutivo ON cliente_asignaciones (ejecutivo_id, activo);
CREATE INDEX IF NOT EXISTS idx_asignaciones_cliente ON cliente_asignaciones (cliente_id, activo);
CREATE INDEX IF NOT EXISTS idx_asig_val_operacion ON asignaciones_validacion (operacion_id, activo);
CREATE INDEX IF NOT EXISTS idx_asig_val_validador ON asignaciones_validacion (validador_id, activo);
CREATE INDEX IF NOT EXISTS idx_asig_cuenta_tesorero ON cuentas_asignaciones (tesorero_id, activo);
CREATE INDEX IF NOT EXISTS idx_asig_cuenta_cuenta ON cuentas_asignaciones (cuenta_id, activo);
CREATE INDEX IF NOT EXISTS idx_coberturas_cuenta ON coberturas (cuenta_id, activo);
CREATE INDEX IF NOT EXISTS idx_aplicaciones_movimiento ON aplicaciones_recursos (movimiento_id);
CREATE INDEX IF NOT EXISTS idx_aplicaciones_operacion ON aplicaciones_recursos (operacion_id);
CREATE INDEX IF NOT EXISTS idx_auditoria_operacion ON auditoria (operacion_id);
CREATE INDEX IF NOT EXISTS idx_pagos_fecha ON pagos (fecha_pago);
CREATE INDEX IF NOT EXISTS idx_movimientos_cuenta ON movimientos_cuentas (cuenta_id);
CREATE INDEX IF NOT EXISTS idx_cli_cobertura_cliente ON cliente_coberturas (cliente_id, activo);
CREATE INDEX IF NOT EXISTS idx_cli_cobertura_temporal ON cliente_coberturas (ejecutivo_temporal_id, activo);
CREATE INDEX IF NOT EXISTS idx_resguardos_cliente ON resguardos_movimientos (cliente_id);
CREATE INDEX IF NOT EXISTS idx_resguardos_operacion ON resguardos_movimientos (operacion_id);
CREATE INDEX IF NOT EXISTS idx_ops_depositos_pendientes ON operaciones_depositos (validado_por);
CREATE INDEX IF NOT EXISTS idx_dispersiones_operacion ON dispersiones (operacion_id);
CREATE INDEX IF NOT EXISTS idx_ops_brokers_operacion ON operaciones_brokers (operacion_id);
CREATE INDEX IF NOT EXISTS idx_pagos_operacion ON pagos (operacion_id);
-- ============================================================= Fase 15 ======
-- Catálogo maestro de cuentas bancarias, bóveda de credenciales y altas en
-- portales (formato "ALTA CUENTA"). Sintaxis PostgreSQL (espejo central).

-- Columnas del catálogo real en `cuentas` (idempotente en PostgreSQL 9.6+).
ALTER TABLE cuentas ADD COLUMN IF NOT EXISTS clabe            TEXT NOT NULL DEFAULT '';
ALTER TABLE cuentas ADD COLUMN IF NOT EXISTS moneda          TEXT NOT NULL DEFAULT 'MXN';
ALTER TABLE cuentas ADD COLUMN IF NOT EXISTS origen          TEXT NOT NULL DEFAULT '';
ALTER TABLE cuentas ADD COLUMN IF NOT EXISTS estatus         TEXT NOT NULL DEFAULT '';
ALTER TABLE cuentas ADD COLUMN IF NOT EXISTS cliente         TEXT NOT NULL DEFAULT '';
ALTER TABLE cuentas ADD COLUMN IF NOT EXISTS fecha_alta      TEXT;
ALTER TABLE cuentas ADD COLUMN IF NOT EXISTS fecha_baja      TEXT;
ALTER TABLE cuentas ADD COLUMN IF NOT EXISTS formato_reporte TEXT NOT NULL DEFAULT '';

-- Altas bancarias (Fase 12) con la CLABE completa (Fase 15).
CREATE TABLE IF NOT EXISTS altas_bancarias (
  id             SERIAL PRIMARY KEY,
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
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resuelto_por   INTEGER REFERENCES usuarios(id),
  resuelto_en    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_altas_estado ON altas_bancarias(estado);
CREATE INDEX IF NOT EXISTS idx_altas_operacion ON altas_bancarias(operacion_id);
CREATE INDEX IF NOT EXISTS idx_altas_cuenta ON altas_bancarias(banco, cuenta);

-- Catálogo de bancos SPEI (92 bancos; la clave son los 3 primeros dígitos
-- de la CLABE). Sembrado por el backend al arrancar.
CREATE TABLE IF NOT EXISTS bancos_spei (
  clave           TEXT PRIMARY KEY,
  nombre_corto    TEXT NOT NULL,
  nombre_completo TEXT NOT NULL DEFAULT ''
);

-- Bóveda de credenciales: 1 cuenta → N credenciales (multi-usuario nativo).
-- secreto/nip/clave_seguridad se guardan CIFRADOS (AES-256-GCM en el backend);
-- jamás en logs ni en respuestas de listado.
CREATE TABLE IF NOT EXISTS cuentas_credenciales (
  id              SERIAL PRIMARY KEY,
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
  activo          BOOLEAN NOT NULL DEFAULT TRUE,
  creado_por      INTEGER NOT NULL REFERENCES usuarios(id),
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_credenciales_cuenta ON cuentas_credenciales(cuenta_id);

-- Auditoría de la bóveda: quién consultó/copió qué credencial y cuándo.
CREATE TABLE IF NOT EXISTS credenciales_accesos (
  id            SERIAL PRIMARY KEY,
  credencial_id INTEGER NOT NULL REFERENCES cuentas_credenciales(id),
  usuario_id    INTEGER NOT NULL REFERENCES usuarios(id),
  accion        TEXT NOT NULL CHECK (accion IN ('ver','crear','actualizar','desactivar')),
  campo         TEXT NOT NULL DEFAULT '',
  fecha         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cred_accesos_cred ON credenciales_accesos(credencial_id);

-- Altas en portales: matriz alta × portal (pagadora) con estado por portal.
-- Todos los portales dados de alta → la alta bancaria queda 'registrada'.
CREATE TABLE IF NOT EXISTS altas_portales (
  id               SERIAL PRIMARY KEY,
  alta_bancaria_id INTEGER NOT NULL REFERENCES altas_bancarias(id),
  portal_cuenta_id INTEGER NOT NULL REFERENCES cuentas(id),
  estado           TEXT NOT NULL DEFAULT 'pendiente'
                   CHECK (estado IN ('pendiente','dada_de_alta','rechazada')),
  motivo_rechazo   TEXT NOT NULL DEFAULT '',
  registrado_por   INTEGER REFERENCES usuarios(id),
  registrado_en    TIMESTAMPTZ,
  creado_por       INTEGER NOT NULL REFERENCES usuarios(id),
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (alta_bancaria_id, portal_cuenta_id)
);
CREATE INDEX IF NOT EXISTS idx_altas_portales_alta ON altas_portales(alta_bancaria_id);
CREATE INDEX IF NOT EXISTS idx_altas_portales_portal ON altas_portales(portal_cuenta_id, estado);
