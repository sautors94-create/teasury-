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
| `pagada` | Ejecutada por Tesorería | Tesorería (fase futura) |
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
7. **Pago (pendiente, Tesorería):** desde `aprobada` executa el pago y adjunta
   comprobante; solo entonces pasa a `pagada`.

## Fases pendientes de este flujo

- Ejecución de pago y comprobantes (Tesorería).
- Adjuntos documentales por operación (expediente digital).
- Aprobaciones extraordinarias de Dirección (montos fuera de umbral).
- Conciliación bancaria y control de resguardos.