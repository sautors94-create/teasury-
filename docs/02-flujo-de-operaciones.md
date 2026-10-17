# 02 — Flujo de Operaciones

## Diagrama de estados

```
                 ┌──────────┐  captura
                 │ borrador │◄──────────────────────────────┐
                 └────┬─────┘                              │
                      │ enviar-validación                  │
                      ▼                                    │
              ┌───────────────┐   observada   ┌──────────┐ │
              │ en_validacion │──────────────►│observada │─┘
              └───────┬───────┘               └──────────┘
           monto >= umbral│
              (aprobada │ aprueba)         (monto < umbral:
                       ▼                   aprueba → aprobada)
              ┌──────────────────┐
              │pendiente_direccion│
              └───────┬──────────┘
          Dirección aprueba│    Dirección rechaza → observada
                       ▼ ┌──────────┐  (pago — Tesorería,
               ┌──────────┐         │   sólo desde aprobada)
               │ aprobada ├─────────┼──► pagada
               └────┬─────┘         │
                    └──► cancelada ◄┘ (desde borrador/observada, u
                                       por Dirección, según política)
```

## Estados

| Estado | Significado | Quién lo produce |
|---|---|---|
| `borrador` | Capturada, aún no enviada | Operaciones (al crear) |
| `en_validacion` | En revisión de Validación | Operaciones (enviar) |
| `observada` | Rechazada con comentario, rework en Operaciones | Validación / Dirección |
| `pendiente_direccion` | Aprobada por Validación pero sobre el umbral; espera a Dirección | Validación (montos ≥ umbral) |
| `aprobada` | Validada (y por Dirección si aplica); lista para pago | Validación / Dirección |
| `pagada` | Ejecutada por Tesorería con comprobante | Tesorería (pago) |
| `cancelada` | Fuera de flujo | Operaciones / Dirección |

## Transiciones permitidas (regla de dominio)

Implementado en `TRANSICIONES` (`backend/src/db.ts`):

| Desde | Hacia |
|---|---|
| borrador | en_validacion, cancelada |
| en_validacion | aprobada, observada, pendiente_direccion |
| observada | en_validacion, cancelada |
| pendiente_direccion | aprobada, observada |
| aprobada | pagada |
| pagada | (terminal) |
| cancelada | (terminal) |

Cualquier otra transición responde **409 Conflict** con el detalle de las
transiciones permitidas.

## Reglas de negocio

1. **Captura (Operaciones):** sólo el rol `operacion` crea operaciones. Campos
   obligatorios: tipo, concepto, proveedor, monto > 0, fecha ISO. El folio se
   asigna automáticamente (`OP-<año>-<correlativo>`).
2. **Envío a validación:** el rol `operacion` envía operaciones en `borrador` u
   `observada`. Una operación `aprobada` **no** puede regresar a validación.
3. **Revisión (Validación):** sólo el rol `validacion` y sólo en estado
   `en_validacion`. El **comentario es obligatorio** tanto al aprobar como al
   observar (expediente auditables). Al aprobar, si `monto >= UMBRAL_DIRECCION`
   (default 500 000, variable de entorno) la operación pasa a
   `pendiente_direccion`; si no, a `aprobada`.
4. **Rework:** una operación `observada` vuelve a Operaciones; tras corregirse
   se reenvía y genera una nueva entrada de revisión (el historial conserva
   todas las revisiones).
5. **Cancelación:** desde `borrador` u `observada` por Operaciones, o por
   Dirección conforme a política. Es estado terminal.
6. **Trazabilidad:** cada captura, consulta de detalle registra eventos en
   `auditoria`, y cada transición escribe `cambio_estado`. La bitácora es
   visible sólo para `auditoria` y `direccion`.
7. **Pago (Tesorería):** sólo el rol `tesoreria` registra el pago de una
   operación `aprobada` (`POST /api/operaciones/:id/pago`) indicando medio de
   pago, monto (**debe coincidir con el monto de la operación**), comprobante
   (folio/referencia), fecha y notas. El registro crea la fila en `pagos` y
   transiciona a `pagada`; si la operación no está `aprobada` responde 409 y el
   doble pago también, además de dejar rastro en la bitácora (`pago`).
8. **Consulta de pagos:** `GET /api/pagos` es visible para `tesoreria`,
   `direccion` y `auditoria`.
9. **Aprobación por monto (Dirección):** `POST /api/operaciones/:id/aprobacion-direccion`
   sólo para `direccion`, sólo en `pendiente_direccion`, con `comentario`
   obligatorio y `aprobado: true|false`. `true` → `aprobada`; `false` →
   `observada` (vuelve a Operaciones). Se registra `aprobacion_direccion` en la
   bitácora.
10. **Reportes de Dirección:** `GET /api/reportes/direccion` (sólo `direccion`)
   devuelve umbral, totales por estado, pendientes de Dirección y de
   Tesorería, y pagos de los últimos 30 días.11. **Bloqueo de pago:** Tesorería sólo puede pagar desde `aprobada` (los
    montos sobre umbral que no pasan por Dirección quedan bloqueados con 409).
12. **Cuentas y conciliación (Recursos):** el rol `tesoreria` da de alta cuentas
    (`POST /api/cuentas`) y registra depósitos/retiros
    (`POST /api/cuentas/:id/movimientos`). Cada pago puede ligarse a una cuenta
    (`cuenta_id`); el saldo se calcula como `saldo_inicial − pagos + depósitos −
    retiros`. La lectura de cuentas es de `tesoreria`, `direccion` y `auditoria`.

## Fases pendientes de este flujo

- Adjuntos documentales por operación (expediente digital).
- Conciliación bancaria y control de resguardos.