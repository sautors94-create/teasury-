# Balanza de comprobación y respaldo de operaciones (depósitos + financiamientos)

Diseño implementado en el bloque `balanza-financiamientos-v1`. Cubre dos peticiones del negocio sobre el formato FLUJO:

1. Que los cálculos dejan de ser una línea de texto y se presenten como una **balanza de comprobación** (un lado lo que suma, otro lo que resta, con desglose de a qué corresponde cada importe, sobrante/faltante al pie y el resguardo del cliente visible).
2. Que **ninguna operación quede sin respaldo**: si el cliente no tiene recurso en resguardo, la captura debe incluir uno o varios **depósitos**, o en su caso un **financiamiento** — y cualquier financiamiento requiere **aprobación de Dirección**, salvo que Dirección determine lo contrario por cliente.

---

## 1. Balanza de comprobación (formato FLUJO)

`BalanzaFlujo` (desktop/src/App.tsx) reemplaza la línea "Monto pagado · IVA · … · Comprobación" en dos lugares: la **captura** (cálculos en vivo mientras se escribe) y el **PanelFlujo** del detalle de la operación.

Estructura de la tabla:

| Suman (recursos)                | Importe     | Restan (aplicación)                  | Importe     |
| ------------------------------- | ----------- | ------------------------------------ | ----------- |
| Monto pagado por el cliente     | $770,000.00 | DEVOLUCION — DEVF NÓMINA (STP ·cta)  | $750,750.00 |
|                                 |             | COMISION — MGN INTRUST               | $19,250.00  |
| **Total que suma**              | **$770,000.00** | **Total que resta**              | **$770,000.00** |
| **Sobrante: $0.00 — queda en el resguardo del cliente** (o en rojo: *Faltante: $X — el flujo excede lo que suma*) | | | |

Bajo la tabla va el desglose fiscal del formato: IVA (desglosado) $106,206.90 · Neto $663,793.10 · Comisión total (2.50%) $19,250.00 · Devolución $750,750.00. Las fórmulas siguen siendo las del Excel (`calcularFlujo` en backend/src/db.ts):

- IVA = monto × 16/116 · Neto = monto × 100/116
- Comisión = monto × comision_pct
- Flujo Total = Σ dispersiones · Devolución = Flujo Total − Comisión
- Diferencia = Monto − Flujo Total → **sobrante** que queda en el resguardo (se refleja al pagarse: §14)
- Comprobación: VERDADERO si el flujo total no excede el monto.

En el detalle, debajo de la balanza aparece el panel **Respaldo del cliente**: disponible (saldo de resguardo + depósitos pendientes + financiamiento por aprobar), requerido (flujo total), faltante, y las tablas de depósitos indicados (con estado de validación) y financiamientos (con estado).

## 2. Respaldo obligatorio al capturar (§6.1)

### Regla

Si la operación tipo `flujo` tiene cliente, el **Flujo Total** debe quedar respaldado por:

```
disponible = saldo de resguardo del cliente
           + Σ depósitos indicados EN LA CAPTURA (pendientes de validar)
           + Σ financiamientos solicitados EN LA CAPTURA
```

Si `disponible < flujo total`, `POST /api/operaciones` responde **400** con el detalle del faltante y una sugerencia ("Agrega depósitos o un financiamiento por al menos $X"). La verificación es **por operación**: dos capturas en curso no pueden reclamar el mismo depósito pendiente.

Sin cliente no hay resguardo, así que la regla no aplica (operaciones sin cliente siguen admitiéndose, como antes). Las operaciones del formato anterior (tipo `pago`/`cobro`) no se ven afectadas.

Los depósitos indicados en la captura nacen **pendientes de validación**; Tesorería los valida desde su cola (fila por fila con `POST /api/depositos/:id/validar`, o todos juntos con el endpoint histórico `POST /api/operaciones/:id/deposito/validar`). Cada depósito validado crea su **movimiento bancario** y su **movimiento de resguardo** en una sola transacción. Sólo entonces el dinero es "real" para el pago: `validarTanda` sigue bloqueando tandas con saldo insuficiente (§14, sin cambios).

Ediciones: `PUT /api/operaciones/:id/dispersiones` re-verifica el respaldo con el nuevo flujo total (409 si la edición deja la operación sin respaldo).

### Depósitos múltiples

`operaciones_depositos` ya **no** tiene `UNIQUE(operacion_id)` (migración idempotente que reconstruye la tabla conservando filas y validaciones previas). Endpoints:

| Endpoint | Quién | Uso |
| --- | --- | --- |
| `POST /api/operaciones` con `respaldo.depositos[]` | operacion | Depósitos indicados al capturar (hasta 20; cuenta activa + comprobante obligatorios) |
| `POST /api/operaciones/:id/depositos` | operacion | Agregar OTRO depósito mientras esté en borrador / en validación / observada |
| `DELETE /api/operaciones/:id/depositos/:depositoId` | operacion | Quitar un depósito aún no validado |
| `POST /api/depositos/:id/validar` | validador_tesoreria / admin_tesoreria | Validar UN depósito concreto |
| `POST /api/operaciones/:id/deposito` (histórico) | operacion | Actualiza el primer depósito pendiente (se conserva por compatibilidad) |
| `POST /api/operaciones/:id/deposito/validar` (histórico) | Tesorería | Valida TODOS los pendientes de la operación |
| `GET /api/resguardos/depositos-pendientes` | Tesorería | Cola; ahora una fila por depósito |

`GET /api/operaciones/:id` devuelve `depositos[]` (con `cuenta`), `financiamientos[]` y `respaldo{}`; `deposito` (singular) se conserva apuntando al primero por compatibilidad con pantallas ya instaladas.

### Financiamientos (§6.1)

Tabla nueva `financiamientos` (estado `solicitado | aprobado | rechazado | cancelado`, `requiere_aprobacion`, `exento_motivo`, `movimiento_id`). Se solicitan desde la captura (`respaldo.financiamiento = { monto, notas }`) y su aprobación depende de la **política del cliente**, que fija Dirección:

- `PATCH /api/clientes/:id/financiamiento` (direccion | admin): `{ sin_aprobacion: boolean, monto_maximo: number | null }`.
- Cliente con `sin_aprobacion = 1` → el financiamiento entra **aprobado automáticamente** (exento `sin_aprobacion_previa`).
- Cliente con `monto_maximo = N` → si `monto ≤ N` entra **aprobado automáticamente** (exento `monto_maximo`); si lo excede, queda `solicitado`.
- Sin política → `solicitado`, espera a Dirección.

Cola de Dirección: `GET /api/financiamientos?estado=solicitado` (direccion | admin | auditoria | admin_operaciones) con cliente, folio, montos y solicitador. Resolución:

- `POST /api/financiamientos/:id/aprobar` (direccion | admin): marca `aprobado` e **inserta el movimiento de resguardo tipo `financiamiento`** en la misma transacción (`movimiento_id` evita el doble alta). El saldo del cliente sube de inmediato y Tesorería puede pagar.
- `POST /api/financiamientos/:id/rechazar` (direccion | admin, motivo opcional): queda `rechazado`, sin movimiento.
- Cancelar la operación (`POST /api/operaciones/:id/cancelar`) cancela sus financiamientos aún `solicitado`.

El tipo `financiamiento` **suma** al saldo del resguardo igual que un depósito (`saldoResguardo` y la subconsulta de `GET /api/clientes` fueron actualizadas; CHECK de `resguardos_movimientos` reconstruido por migración). Nota de alcance: el **pago del financiamiento** (devolver el dinero al financiador) pertenece al módulo de financiamientos a futuro; hoy el monto entra al resguardo y queda trazado en bitácora.

## 3. Interfaz (desktop)

- **VistaCaptura**: sección "Respaldo de la operación" — saldo actual del cliente (se consulta al elegirlo), alta de varios depósitos (cuenta / monto / comprobante / fecha), casilla de financiamiento con aviso de si requerirá aprobación, y línea en vivo "Respaldo disponible … frente a un flujo de … — OK / FALTANTE". Guardar bloquea el envío si hay faltante.
- **PanelFlujo (detalle)**: balanza + panel de respaldo con depósitos y financiamientos por estado.
- **VistaDireccion**: "Financiamientos por aprobar" (Aprobar / Rechazar con motivo) y "Política de financiamiento por cliente" (formulario + tabla con la política vigente).
- **VistaTesoreria**: la cola de depósitos pendientes valida **fila por fila** (hay varias por operación).

## 4. Migración (automática al arrancar el backend)

`migrarRespaldosFinanciamientos` en backend/src/db.ts, idempotente, conserva toda la información:

1. `clientes.financiamiento_sin_aprobacion` (0 por defecto) y `clientes.financiamiento_maximo` (NULL).
2. Tabla `financiamientos` + índices.
3. `resguardos_movimientos` reconstruida si su CHECK no conoce `'financiamiento'`.
4. `operaciones_depositos` reconstruida si quedó con `UNIQUE` (se conservan filas, validaciones y movimientos ya generados).

`backend/central/schema.sql` sincronizado para instalaciones nuevas (PostgreSQL; `financiamientos` se crea después de `resguardos_movimientos` por su FK).

## 5. Pruebas

- `backend/test/financiamientos-respaldo.test.ts` (13 nuevas): captura sin respaldo → 400 con faltante; varios depósitos con balanza y cola por fila; validación por fila y en lote; alta/baja de depósitos indicados; edición que rompe el respaldo → 409; financiamiento solicitado/aprobado/rechazado; exención por cliente y por monto máximo; permisos de la política (sólo Dirección/admin); pagos bloqueados sin respaldo real y desbloqueados al aprobar el financiamiento (cuadrando el resguardo a 0); cancelación de financiamientos al cancelar la operación; permisos del listado.
- `backend/test/captura-flujo.test.ts`: las dos capturas con cliente ahora incluyen el respaldo por la regla nueva (los números y resultados esperados no cambian).
- Suite completa: **110 passed + 5 todo, cero fallos** (97 previas sin regresiones). Smoke E2E con el ejemplo del negocio ($770,000 / 2.50% / dispersiones 750,750 + 19,250): IVA $106,206.90, neto $663,793.10, comprobación VERDADERO, 2 depósitos (150,000) + financiamiento 620,000 aprobado por Dirección → tandas 500,000 + 270,000 → pagada con resguardo final 0 y bitácora completa.
