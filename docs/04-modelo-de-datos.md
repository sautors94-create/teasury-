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

## Entidades futuras (esta fase no las implementa)

- `pagos` (monto ejecutado, fecha, medio, comprobante) → estado `pagada`.
- `adjuntos` (archivos por operación: contratos, facturas, comprobantes).
- `tipos_cambio` y `cuentas` / `resguardos` (control de recursos).
- `financiamientos` (líneas, cortes, saldos).
- `sincronizacion_log` (cambios pendientes de subir/bajar, ver doc 05).