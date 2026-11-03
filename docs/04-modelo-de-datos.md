# 04 — Modelo de Datos

Esquema actual (SQLite, creado en `backend/src/db.ts`). El paso a PostgreSQL
mantendrá los mismos nombres; los `INTEGER` de dominio pasan a `SERIAL`,
`datetime('now')` a `TIMESTAMP`, y se añaden `uuid` y columnas de sincronización
(ver [05-sincronizacion.md](05-sincronizacion.md)).

## usuarios

| Columna | Tipo | Notas |
|---|---|---|
| id | INTEGER PK | |
| username | TEXT UNIQUE | login |
| password_hash | TEXT | bcrypt |
| nombre | TEXT | nombre visible |
| rol | TEXT | CHECK: operacion, validacion, tesoreria, direccion, auditoria |
| activo | INTEGER | 1/0, borrado lógico |

## operaciones

| Columna | Tipo | Notas |
|---|---|---|
| id | INTEGER PK | |
| folio | TEXT UNIQUE | `OP-AAAA-NNNNN`, correlativo por año |
| tipo | TEXT | CHECK: pago, cobro, financiamiento |
| concepto | TEXT | requerido |
| proveedor | TEXT | beneficiario o pagador |
| monto | REAL | CHECK: > 0 |
| moneda | TEXT | default MXN |
| fecha_operacion | TEXT | `YYYY-MM-DD` |
| estado | TEXT | CHECK sobre los 6 estados (ver 02) |
| creado_por | INTEGER FK → usuarios | |
| creado_en / actualizado_en | TEXT | `datetime('now')` |

Índice: `idx_operaciones_estado`.

## revisiones

| Columna | Tipo | Notas |
|---|---|---|
| id | INTEGER PK | |
| operacion_id | FK → operaciones | |
| revisor_id | FK → usuarios | rol validacion |
| resultado | TEXT | CHECK: aprobada, observada |
| comentario | TEXT | obligatorio |
| fecha | TEXT | |

Una operación observada y reenviada acumula varias revisiones: el historial es
la pista de auditoría de la decisión.

## auditoria (append-only)

| Columna | Tipo | Notas |
|---|---|---|
| id | INTEGER PK | |
| operacion_id | FK → operaciones, anulable | `NULL` para eventos sin operación |
| usuario_id | FK → usuarios | quién actuó |
| accion | TEXT | captura, cambio_estado, consulta, login… |
| detalle | TEXT | humano-readable |
| fecha | TEXT | |

**Nunca se actualizan ni borran filas de `auditoria`.** Índice por operación.

## pagos (uno a uno con operación pagada)

| Columna | Tipo | Notas |
|---|---|---|
| id | INTEGER PK | |
| operacion_id | INTEGER UNIQUE FK → operaciones | garantiza el no-doble-pago |
| medio | TEXT | CHECK: transferencia, domiciliacion, cheque, efectivo, otro |
| monto | REAL | CHECK: > 0; debe coincidir con el monto de la operación |
| moneda | TEXT | heredada de la operación |
| fecha_pago | TEXT | `YYYY-MM-DD` |
| comprobante | TEXT | folio o referencia del comprobante |
| notas | TEXT | default `''` |
| pagado_por | FK → usuarios | rol tesoreria |
| cuenta_id | FK → cuentas, anulable | descuenta del saldo de la cuenta |
| fecha_registro | TEXT | `datetime('now')` |

INDEX: `idx_pagos_fecha`.

## cuentas (control de recursos)

| Columna | Tipo | Notas |
|---|---|---|
| id | INTEGER PK | |
| nombre | TEXT | requerido |
| banco / numero_cuenta | TEXT | informativos |
| saldo_inicial | REAL | punto de partida |
| activa | INTEGER | 1/0 |
| creado_en | TEXT | `datetime('now')` |

**Saldo actual** = `saldo_inicial − SUM(pagos.cuenta_id) + depósitos − retiros`
(vista calculada en `GET /api/cuentas`).

## movimientos_cuentas (depósitos y retiros)

| Columna | Tipo | Notas |
|---|---|---|
| id | INTEGER PK | |
| cuenta_id | FK → cuentas | |
| tipo | TEXT | CHECK: deposito, retiro |
| monto | REAL | CHECK: > 0 (el signo lo da el tipo) |
| concepto / fecha | TEXT | requerido / `YYYY-MM-DD` |
| creado_por / creado_en | FK / TEXT | quién y cuándo |

INDEX: `idx_movimientos_cuenta`.

## Entidades futuras (esta fase no las implementa)

- `resguardos` (custodia de bienes y responsables).
- `adjuntos` (archivos por operación: contratos, facturas, comprobantes).
- `tipos_cambio` (multimoneda) y catálogo de bancos.
- `financiamientos` (líneas, cortes, saldos).
- `sincronizacion_log` (cambios pendientes de subir/bajar, ver doc 05).