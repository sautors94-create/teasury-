# Captura completa de operaciones — Formato FLUJO (v1)

Reemplaza la captura simple por el formato del negocio (Excel "FLUJOS"): pagador,
tipo de operación, timbrar, comisión %, IVA desglosado, neto, comisión con reparto
a brokers, dispersiones a beneficiarios, flujo total con comprobación, diferencia
a resguardo y pagos por **tandas** (manual o por **layout** en Excel/CSV).

## 1. Qué cambia

| Antes | Ahora |
|---|---|
| Captura: tipo, concepto, proveedor, monto, moneda, fecha | + pagador, tipo_operación (catálogo), timbrar SÍ/NO, comisión %, observaciones, dispersiones, brokers |
| 1 solo pago por operación (`pagos.operacion_id UNIQUE`) | N **tandas** por operación; `en_pago` cuando la suma no cubre el total |
| Sin layout | Importación de dispersiones y de tandas por **Excel (.xlsx/.xls) o CSV** |
| Comisión no existía | Comisión = monto × %; reparto automático entre **brokers** del catálogo |
| Diferencia no existía | Diferencia = monto − flujo total; se **ingresa al resguardo del cliente** |

## 2. Cálculos (idénticos al Excel del negocio)

Con "Monto pagado" $60,000, comisión 2.50% y dispersiones 57,000 + 303 + 1,500:

```
IVA desglosado  = monto × 16/116  =  8,275.86
Neto (subtotal) = monto × 100/116 = 51,724.14
Comisión total  = monto × %       =  1,500.00
Broker i        = comisión × %i   =  (p. ej. 60% → 900.00); el resto la retiene la casa
Flujo Total     = Σ importes de dispersiones = 58,803.00
Devolución      = Flujo Total − Comisión     = 57,303.00
Diferencia      = Monto − Flujo Total        =  1,197.00  → SE INGRESA A RESGUARDO
Comprobación    = VERDADERO si Flujo Total ≤ Monto (se bloquea "EN CONTRA")
```

Los cálculos **no se guardan** (§14): se recalculan en cada lectura a partir de
monto, comisión %, dispersiones y brokers (copia de seguridad de nombre/%/monto
al capturar, inmune a cambios posteriores del catálogo).

## 3. Flujo de la operación

```
captura (formato completo, ≥ 1 dispersión, comprobación VERDADERO)
  → borrador → en_validacion → (aprobada | observada)
  → Tesorería dispersa en 1..N tandas:
       · tanda parcial  → estado 'en_pago' (restante visible)
       · tanda final    → 'pagada' + diferencia ingresada al resguardo (evento
                          'diferencia_resguardo' en bitácora)
```

- Cada tanda: medio, monto (≤ restante por dispersar), comprobante, fecha,
  cuenta opcional; valida fondos del **resguardo** del cliente (§14).
- El resguardo se carga por tanda (Σ tandas = flujo total), así la diferencia
  queda como **saldo remanente** del resguardo — exactamente "se ingresa a
  resguardo" del formato, sin duplicar movimientos.
- Editable (dispersiones y datos del flujo) por el Ejecutivo en
  borrador / en_validacion / **observada** (corrección) y sólo mientras no haya
  tandas registradas — esto resuelve en la práctica la corrección de operadas
  observadas sin recapturar.

## 4. Layouts (Excel o CSV)

### Dispersiones (captura) — encabezados aceptados (con o sin acentos)

| Columna | Alias |
|---|---|
| Beneficiario | NOMBRE, NOMBRE CORTO |
| Razon social | RAZON, NOMBRE COMPLETO |
| Referencia | REF |
| Cuenta | CUENTA |
| Clabe | CUENTA CLABE, CLABE INTERBANCARIA |
| Banco | BANCO |
| Importe | MONTO, CANTIDAD |
| Ine / Numero / Tarjeta / Etiqueta | TAG para etiqueta |

Filas sin beneficiario ni importe (totales, notas) se ignoran; la UI muestra
vista previa con errores por fila y botón de **plantilla descargable** (CSV).

### Tandas (Tesorería)

`MEDIO, MONTO, FECHA_PAGO, COMPROBANTE, NOTAS` — vista previa y registro por
lote (`POST /api/operaciones/:id/pagos`): **todo o nada** (si una tanda excede
el restante o falla, se revierte el lote completo).

## 5. Endpoints nuevos / modificados

| Método y ruta | Rol | Uso |
|---|---|---|
| `POST /operaciones` | operacion | modo completo (`tipo:'flujo'` + dispersiones) o legado |
| `GET /operaciones/:id` | todos | + dispersiones, brokers, calculos, pagos[], totales_pago |
| `PUT /operaciones/:id/dispersiones` | operacion | reemplaza líneas (editable según §3) |
| `PUT /operaciones/:id/datos-flujo` | operacion | pagador/tipo/timbrar/%/observaciones/brokers |
| `POST /operaciones/:id/pago` | tesoreria | tanda (parcial → `en_pago`; final → `pagada`) |
| `POST /operaciones/:id/pagos` | tesoreria | lote de tandas (todo o nada) |
| `GET/POST/PATCH /brokers` | todos / admin_ops, admin | catálogo de brokers |

Compatibilidad: las operaciones del formato anterior siguen funcionando igual
(pago único exacto, doble pago 409, monto distinto 400 — pruebas originales
intactas); las capturadas antes quedaron como estaban.

## 6. Base de datos (migración automática al arrancar)

- `operaciones` reconstruida: `tipo` acepta **'flujo'**, `estado` acepta
  **'en_pago'**, columnas nuevas `pagador, tipo_operacion, timbrar,
  comision_pct, observaciones` (conserva filas).
- `pagos` reconstruida **sin UNIQUE por operación** (conserva filas).
- Tablas nuevas: `brokers`, `operaciones_brokers`, `dispersiones` + índices.
- Catálogos sembrados: dominios `pagador` y `tipo_operacion` con el valor
  **FLUJOS** (ampliables en Configuración → Catálogos).
- `central/schema.sql` sincronizado (PostgreSQL).

## 7. Roles (01-ROLES.md)

- **Ejecutivo (operacion)**: captura el formato completo, importa layouts,
  edita dispersiones/datos hasta que hay tandas; ve cálculos y resguardo.
- **Validador**: ve el formato completo en el detalle (mismo panel).
- **Tesorería**: registra tandas (manual o por layout) hasta cubrir el flujo.
- **Admin de Operaciones / admin**: administran el catálogo de brokers
  (Configuración → Brokers) y los dominios pagador/tipo_operacion.

## 8. Verificación

- Suite completa: **97 pruebas pasando + 5 todo**, cero fallos
  (90 previas sin regresiones + 7 nuevas en `captura-flujo.test.ts`).
- Pruebas nuevas: cálculos exactos del Excel, comprobación EN CONTRA,
  brokers con reparto, edición/bloqueo, tanda parcial → en_pago → pagada,
  diferencia al resguardo (saldo 1,197 verificado), lote todo-o-nada,
  pago único del formato anterior sin regresión.
- Smoke E2E en servidor real: captura → depósito → aprobación → 2 tandas →
  pagada con resguardo final 1,197 y bitácora completa.
- Typecheck y build de producción OK en backend y desktop.
