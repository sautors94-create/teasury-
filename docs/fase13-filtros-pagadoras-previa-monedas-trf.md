# Fase 13: filtros de listados, pagadoras desplegables con visibilidad, vista previa, otras monedas y resguardo de TRF

Implementación de los 5 puntos solicitados por el negocio sobre la Fase 12
(pagadoras del catálogo, fondeo, altas).

## 1. Filtros en los listados de cada área

Todo listado que ve un operador del sistema ahora tiene filtros para identificar
operaciones rápido:

| Vista | Filtros nuevos |
|-------|----------------|
| Operaciones (todos los roles) | Tipo (flujo/pago/cobro/financiamiento), Moneda (detectada de tus operaciones), Monto mínimo, Monto máximo — en vivo, junto con el estado y el buscador que ya existían |
| Cola de Validación | Búsqueda por folio, cliente, concepto o capturista |
| Pagos | Búsqueda por folio, comprobante, pagador, notas o moneda (el total se recalcula) |
| Cuentas de Tesorería | Búsqueda por nombre, banco o número (junto al filtro por tipo) |

La API también aprendió los mismos filtros por si se consultan listados fuera de
la UI: `GET /api/operaciones?tipo=&moneda=&monto_min=&monto_max=` (se combinan
con el alcance por rol; `monto_min/monto_max` o `tipo/moneda` inválidos
responden 400).

## 2. Menú de pagadoras del operador: desplegable y sin banco ni manejo manual

- El selector de pagadoras de la captura ya no es una tabla con checkboxes: es
  **desplegable** (el catálogo puede superar las 300 cuentas) + botón
  "Agregar pagadora"; las elegidas se muestran como **etiquetas (chips) con ×**
  para quitarlas. Se siguen pudiendo seleccionar varias.
- Se quitó la columna **Banco** y la opción de **Manejo manual** del selector
  del operador (la marca se envía siempre en 0; el campo sigue existiendo en la
  API por compatibilidad). **CUALQUIER FLUJO** sigue disponible: Tesorería
  determina la cuenta concreta.
- El select de PAGADORA por línea (captura manual, layout y edición) ahora
  muestra sólo cuentas **visibles para operadores**.
- **Visibilidad controlada por Tesorería**: nueva columna
  `cuentas.visible_operador` (1 = visible, 0 = oculta; **todas nacen visibles**,
  tal como pidió el negocio). En Cuentas de Tesorería, el Administrador de
  Tesorería/Admin tiene el botón "Ocultar a operadores" / "Mostrar a
  operadores" (pide motivo opcional, deja bitácora `cuenta_visibilidad`) y la
  tabla muestra la columna "Operadores" con Visible/OCULTA.
- La visibilidad es un control de catálogo: la cuenta oculta no aparece en el
  desplegable ni en la hoja CATALOGO PAGADORAS del layout, y al importar un
  layout que la referencie se rechaza la fila (igual que una cuenta sacada de
  operación). Sigue siendo válida para depósitos del respaldo y para pagos; la
  validación de fondo del backend no cambia (exige `activa`).
  - API: `GET /api/cuentas/catalogo` devuelve `visible_operador` por cuenta;
    `PATCH /api/cuentas/:id/visible` `{ visible_operador: boolean, motivo? }`
    (roles `admin_tesoreria`/`admin`; 404/400/409 igual que el bloqueo).

## 3. Vista previa antes de enviar la operación

El botón del formulario de captura ahora es **"Revisar y enviar (vista
previa)"**: no envía nada, valida la captura y abre la **Vista previa**, donde
el ejecutivo ve:

1. **Listado de todos los pagos** (#, beneficiario, cuenta/banco, importe) con
   el Flujo Total y la comprobación — **arriba de la balanza** de su operación.
2. **La balanza** (sumas/restas con IVA, neto, comisión, brokers y devolución)
   debajo del listado de pagos, más el resumen del respaldo cuando hay cliente.
3. **Las pagadoras como etiquetas modificables**: cada pago muestra su pagadora
   como etiqueta; al picarla se abre el desplegable del catálogo para corregirla
   (p. ej. una que quedó mal en el layout) antes del envío. Las pagadoras de la
   operación también se muestran/editan como etiquetas (agregar/quitar).
4. Botones **"‹ Volver a editar"** y **"Confirmar y enviar"** (único punto que
   hace el POST; si algo cambió y ya no cuadra, revalida y regresa).

La tabla de dispersiones de la captura también usa etiquetas editables de
pagadora, para corregir sobre la marcha.

## 4. Otras monedas ("Otras" y especificar)

- El selector de moneda de la captura ofrece **MXN, USD y "Otra moneda…
  (especificar)"**. Al elegir "Otra…" se despliega el **listado de las monedas
  más usadas**: EUR (Euro), GBP (Libra Esterlina), JPY (Yen Japonés), CHF
  (Franco Suizo), CAD (Dólar Canadiense), AUD (Dólar Australiano), CNY (Yuan
  Chino) — o un **código libre de 3 letras** para cualquier otra (SEK, NZD, …).
- El backend acepta cualquier código ISO de 3 letras y lo normaliza a
  mayúsculas (`gbp` → `GBP`); un código inválido responde 400. Sin moneda queda
  `MXN` (compatibilidad con capturas previas).
- El listado de Operaciones muestra y filtra por la moneda capturada.

## 5. Brokers por operación + resguardo de TRF (la empresa) en dólares con tipo de cambio

### Brokers (ya operado, verificado en esta fase)

Una operación **ya puede estar ligada a uno o más brokers** que cobran comisión:
en la captura se marcan varios brokers del catálogo con su **% de la comisión**
(la suma no puede exceder 100%; el resto lo retiene la casa). La operación
guarda la fotografía (nombre/%/monto) y al quedar PAGADA la comisión entra al
resguardo de cada broker (`brokers_resguardos`), con retiros controlados. La
vista previa muestra el reparto por broker y el detalle sigue mostrando la
sección "Brokers participantes".

### Resguardo de TRF — nuevo

- Nueva tabla `trf_resguardos_movimientos` (ledger **append-only**, el saldo
  nunca se guarda): `ingreso` (+) / `retiro` (−), importe, **moneda**
  (código de 3 letras), **tipo_cambio**, operación opcional ligada, notas y
  quién lo registró.
- Se maneja **en dólares y otras monedas**: un movimiento en moneda distinta de
  MXN **obliga a registrar el tipo de cambio que aplicó el banco** (400 si
  falta). Ese registro es el que hace **cuadrar los resguardos**: cada
  movimiento muestra su **equivalente en pesos = importe × tipo de cambio**, y
  el resguardo muestra saldo por moneda + equivalente total en MXN.
- Un retiro no puede dejar el saldo de su moneda en negativo (409).
- API:
  - `GET /api/trf/resguardo` → `{ movimientos[], saldos[{moneda, saldo,
    ingresos, retiros, equivalente_mxn}], equivalente_total_mxn }` — lectura
    para tesorería/fondeo/dirección/auditoría/admin.
  - `POST /api/trf/resguardo` `{ tipo, importe, moneda?, tipo_cambio?,
    operacion_id?, notas? }` — sólo `admin_tesoreria`, `validador_tesoreria` y
    `admin`; bitácora `trf_resguardo`.
- UI: nueva vista **"Resguardo TRF"** en el menú (tesorería, fondeo, dirección,
  auditoría, admin): tarjetas de saldo por moneda con equivalente, formulario
  de ingreso/retiro con selector de moneda (MXN/USD/más usadas/otra) y campo de
  **tipo de cambio del banco** (obligatorio fuera de MXN, con equivalente
  estimado en vivo), y la tabla de movimientos con su TC y filtrable.

## 6. Migración

Automática al arrancar el backend, idempotente:

- `cuentas.visible_operador INTEGER NOT NULL DEFAULT 1` (ALTER; todas quedan
  visibles, como están hoy).
- `trf_resguardos_movimientos` (CREATE IF NOT EXISTS en cada arranque).
- `backend/central/schema.sql` sincronizado (PostgreSQL).

## 7. Pruebas

`backend/test/fase13.test.ts` cubre: filtros de GET /operaciones (tipo, moneda,
monto_min/max y 400 por inválidos); moneda normalizada e inválida en
POST /operaciones; visibilidad de cuentas (ocultar/mostrar con permisos, 404,
409, flag en el catálogo ligero, rechazo en el importe de layout);
resguardo TRF (ingreso MXN, USD sin TC 400, USD con TC registra equivalente,
retiro con saldo insuficiente 409, retiro válido, permisos de lectura/escritura,
moneda inválida, operación inexistente). Además el smoke E2E verifica captura
con moneda GBP + 2 brokers + visibilidad de cuentas de extremo a extremo.
