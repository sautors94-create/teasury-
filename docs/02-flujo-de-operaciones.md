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
                 aprobada│
                       ▼ ┌──────────┐  (pago — Tesorería,
               ┌──────────┐         │   fuera de esta fase)
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
| `observada` | Rechazada con comentario, rework en Operaciones | Validación |
| `aprobada` | Validada; lista para pago | Validación |
| `pagada` | Ejecutada por Tesorería con comprobante | Tesorería (pago) |
| `cancelada` | Fuera de flujo | Operaciones / Dirección |

## Transiciones permitidas (regla de dominio)

Implementado en `TRANSICIONES` (`backend/src/db.ts`):

| Desde | Hacia |
|---|---|
| borrador | en_validacion, cancelada |
| en_validacion | aprobada, observada |
| observada | en_validacion, cancelada |
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
   observar (expediente auditables).
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

## Fases pendientes de este flujo

- Adjuntos documentales por operación (expediente digital).
- Aprobaciones extraordinarias de Dirección (montos fuera de umbral).
- Conciliación bancaria y control de resguardos.