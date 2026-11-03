# Fase 14 — Layout ampliado (datos opcionales), Pagos especiales, Comisiones preestablecidas por cliente y Resguardo TRF manejado por los ejecutivos

## 1. Datos nuevos de la dispersión (captura y layout) — TODOS OPCIONALES

Cada línea de dispersión (manual, por layout o por API) acepta 5 datos nuevos:

| Campo | Columna del layout | Alias aceptados al importar |
|---|---|---|
| `nombre` | `NOMBRE` | NOMBRE |
| `apellido_paterno` | `APELLIDO PATERNO` | APELLIDO PATERNO, APELLIDO_PATERNO, PATERNO |
| `apellido_materno` | `APELLIDO MATERNO` | APELLIDO MATERNO, APELLIDO_MATERNO, MATERNO |
| `concepto` | `CONCEPTO` | CONCEPTO, CONCEPTO DE PAGO |
| `referencia_pago` | `REFERENCIA PAGO` | REFERENCIA PAGO, REFERENCIA PARA PAGO |

- **Ninguno es obligatorio** (literal del requisito): la captura pasa igual
  incluyéndolos o no, tanto en el formulario manual como en el layout.
- La plantilla descargable (`layout-dispersiones.xlsx`) incluye las 5 columnas
  nuevas en orden: BENEFICIARIO, NOMBRE, APELLIDO PATERNO, APELLIDO MATERNO,
  RAZON SOCIAL, CONCEPTO, REFERENCIA, REFERENCIA PAGO, INE, NUMERO, TARJETA,
  CUENTA, CLABE, BANCO, PAGADORA, IMPORTE, ETIQUETA.
- Nota de compatibilidad: la columna `NOMBRE` del layout ahora mapea al nombre
  de pila (antes era alias de BENEFICIARIO). Los archivos que traen sólo
  `NOMBRE CORTO` siguen funcionando como antes.

## 2. Pagos especiales

Nuevo tipo de operación `pago_especial` (mismo flujo que cualquier operación:
validación → aprobación → liberación del Fondeador → pago de Tesorería).

- El **ejecutivo** captura: **formato adjunto** (PDF/imagen, p. ej. el del
  SAT, obligatorio), **importe** (MXN), **pagadora** (cuenta del catálogo de
  Tesorería, desplegable con las visibles) y una **descripción breve**;
  notas opcional.
- **El efectivo sale de un RESGUARDO** (origen): el de **TRF (la empresa)** o
  el de **un broker**. El resguardo debe tener **depósito suficiente**:
  si el saldo no cubre el importe, la captura se rechaza (409) y el pago
  se re-valida al dispersar (si el saldo bajó, Tesorería recibe 409).
- Al quedar **PAGADA**, el importe sale del resguardo de origen con un
  movimiento append-only (`retiro`) — igual que las comisiones de brokers —
  y queda en bitácora (`pago_especial_resguardo`).
- El formato adjunto se descarga desde el detalle
  (`GET /api/operaciones/:id/pago-especial/formato`).
- La captura está en **Nueva operación → Pago especial (formato adjunto)**,
  con vista previa antes de confirmar.
- API: `POST /api/operaciones` con `tipo: "pago_especial"`, `pagadora_cuenta_id`,
  `origen: { tipo: "trf" } | { tipo: "broker", broker_id }` y
  `formato: { nombre, mime, contenido }` (contenido en data-URL/base64,
  máximo ~9 MB). El listado filtra con `?tipo=pago_especial`.

## 3. Comisiones preestablecidas por cliente

- `admin_operaciones` fija por cliente (Clientes → cliente → panel
  "Comisiones preestablecidas"): **comisión de broker** (%) y **comisión TRF**
  (%) — la que va DIRECTO al resguardo de la empresa. `PATCH
  /api/clientes/:id/comisiones` (número 0–100 o `null` para quitarla).
- Al capturar una operación del cliente **sin enviar comisiones**, se usan
  automáticamente las preestablecidas (la de broker rellena el campo y la UI
  lo muestra; la de TRF viaja con la operación como `comision_trf_pct`).
  Si el ejecutivo envía comisiones explícitas, mandan sobre las del cliente.
- **Comisión TRF al pagarse**: si la operación es MXN y tiene
  `comision_trf_pct > 0`, al quedar PAGADA ingresa sola al resguardo de TRF
  (`ingreso` automático, sin duplicarse si ya se registró un ingreso ligado a
  esa operación). En monedas distintas de MXN el ejecutivo lo registra a mano
  con el tipo de cambio del banco (el resguardo exige el TC).
- El resguardo de TRF **puede quedar en 0**: no hay mínimo exigido.

## 4. Resguardo TRF: lo manejan los EJECUTIVOS

- **Registrar movimientos**: `operacion` (ejecutivo), `admin_operaciones` y
  `admin`. **Tesorería ya no registra** (conserva la lectura para conciliar).
- **Retiros manuales**: sólo `admin` (correcciones). Los retiros normales se
  hacen **solicitando la operación (Pago especial) a un ejecutivo**: la
  operación pide formato, importe y pagadora, y al pagarse descuenta el
  resguardo automáticamente.
- La vista "Resguardo TRF" está en el menú de los ejecutivos, con la nota del
  nuevo flujo de retiros.

## 5. Esquema (migración automática al arrancar)

- `operaciones` reconstruida: tipo `pago_especial` + `comision_trf_pct REAL`.
- `dispersiones` + `nombre`, `apellido_paterno`, `apellido_materno`,
  `concepto`, `referencia_pago` (TEXT DEFAULT '', opcionales).
- `clientes` + `comision_broker_pct REAL`, `comision_trf_pct REAL`.
- Tabla nueva `pagos_especiales` (operación, descripción, pagadora, origen,
  formato adjunto). Espejo PostgreSQL sincronizado en `central/schema.sql`.

## 6. Verificación

- typecheck backend + desktop: sin errores; build de producción OK.
- Suite: **173 pruebas + 5 todo, cero fallos** (8 nuevas en
  `backend/test/fase14.test.ts`; ajustadas las de TRF de Fase 13 por el
  cambio de roles).
- Smoke E2E `scripts/smoke-fase14.mjs` (40 verificaciones): migración sobre BD
  previa sin las novedades, capturas con/sin campos nuevos, comisiones
  preestablecidas, TRF por ejecutivos, pago especial completo hasta PAGADA con
  descuento del resguardo, comisión TRF directa y bitácora. **TODO OK.**
