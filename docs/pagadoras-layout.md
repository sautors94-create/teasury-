# Tarea 12 — Pagadoras del catálogo de Tesorería, layout actualizado y frentes

Fecha: 2026-10-28

## Qué cambia

Hasta ahora la captura pedía "Pagador" y "Tipo de operación" como textos sueltos
(catálogos administrables). Con esta entrega ambos se toman **del catálogo de
cuentas de Tesorería**, con selección múltiple, marca de manejo manual y un
layout de Excel que lleva el catálogo vigente.

## 1) Pagadoras / tipo de operación desde el catálogo (multi-selección)

- En **Nueva operación** la sección "Pagadoras / tipo de operación (catálogo de
  Tesorería)" lista las **cuentas activas** del catálogo agrupadas por tipo
  (Flujo, Frente, Préstamo, Anticipo a rendimientos, SOFOM, Asimilado) y además
  la opción **CUALQUIER FLUJO** (Tesorería determina la cuenta concreta).
- **Selección múltiple**: una operación puede combinar asimilados, flujos,
  rendimientos, frentes, etc. Cada renglón seleccionado admite la marca
  **Manejo manual** (para los frentes que el negocio atenderá manualmente).
- El ejecutivo debe seleccionar **al menos una** pagadora (o CUALQUIER FLUJO);
  sin selección la captura no se envía.
- El "pagador" y el "tipo de operación" de la operación se rellenan
  automáticamente con los nombres/tipos de las cuentas seleccionadas
  (`pagador = "FLUJOS 01, ASIMILADOS 01, CUALQUIER FLUJO"`,
  `tipo_operacion = "flujo, asimilado"`), de modo que listados, bitácora y
  reportes siguen mostrando la información.
- Los datos se guardan en la tabla nueva `operaciones_destinos` (fotografía del
  catálogo al capturar: cuenta, tipo, nombre y marca de manejo manual).

## 2) PAGADORA por línea de dispersión

- Cada línea de dispersión (manual o por layout) puede indicar su **PAGADORA**:
  - una **cuenta concreta del catálogo** (select agrupado por tipo), o
  - **CUALQUIER FLUJO** (u otro "CUALQUIER <TIPO>" al importar layout): queda
    sin cuenta concreta y **Tesorería la determina** al dispersar.
- La pagadora es **orientativa**: Tesorería sigue eligiendo la cuenta de salida
  real al registrar la tanda; el detalle muestra un recordatorio con las
  pagadoras solicitadas (y cuáles son de manejo manual).

## 3) Layout de dispersiones con catálogo siempre actualizado

- **Descargar layout**: genera `layout-dispersiones.xlsx` con dos hojas:
  - `DISPERSIONES` — renglones a llenar (BENEFICIARIO, …, BANCO, **PAGADORA**,
    IMPORTE, ETIQUETA) con 2 ejemplos.
  - `CATALOGO PAGADORAS` — las cuentas **activas** al momento de la descarga
    (nombre, tipo, banco, número).
- **Siempre actualizado**: el catálogo ligero (`GET /cuentas/catalogo`) sólo
  devuelve cuentas con `activa = 1`. Si el Administrador de Tesorería **saca
  una cuenta de operación** (bloqueo o no uso momentáneo), esa cuenta
  desaparece del catálogo y por consiguiente del layout descargado.
- **Subir layout**: la columna **PAGADORA es obligatoria**. El sistema resuelve
  cada renglón contra el catálogo vigente:
  - nombre del catálogo (comparación sin mayúsculas/acentos) → cuenta concreta;
  - `CUALQUIER FLUJO` (o `CUALQUIER SOFOM`, `CUALQUIER FRENTE`, …) → cuenta por
    determinar;
  - una pagadora que ya no está en el catálogo (cuenta sacada de operación o
    escrita mal) **se rechaza con error por renglón**, pidiendo descargar el
    layout actualizado.
- Se sigue aceptando CSV (con columna PAGADORA) y la hoja de datos se detecta
  por nombre (`DISPERSIONES`), por lo que la hoja de catálogo no molesta.

## 4) Sacar de operación / reactivar cuentas (Administrador de Tesorería)

- Nueva acción en **Cuentas de Tesorería**: "Sacar de operación" (pide motivo)
  y "Reactivar". Sólo `admin_tesoreria` y `admin` (`PATCH /cuentas/:id/estado`).
- Con la casilla "Mostrar cuentas fuera de operación" el administrador ve
  también las inactivas (`GET /cuentas?todas=1`) para reactivarlas.
- Una cuenta fuera de operación: desaparece del catálogo ligero y del layout;
  no admite pagos ni respaldos (reglas existentes); capturarla como destino o
  pagadora responde **400** con el motivo.
- Queda en bitácora: `cuenta_estado` (quién, cuándo y motivo).

## 5) Frentes

El tipo **Frente** ya forma parte del catálogo de Tesorería (semilla
`FRENTES 01`/`FRENTES 02`, tipo `frente`). Con la selección múltiple puede
usarse como pagadora/frente de la operación igual que los demás tipos; el
Administrador puede dar de alta más cuentas tipo Frente desde
Cuentas de Tesorería → Nueva cuenta.

## API (resumen)

| Endpoint | Cambio |
|---|---|
| `POST /operaciones` | acepta `destinos: [{ cuenta_id? , tipo?, manejo_manual? }]` (mín. 1) y `dispersiones[]` con `pagadora` / `pagadora_cuenta_id`. Con `destinos`, `pagador`/`tipo_operacion` se deducen del catálogo (sin destinos se conserva la captura legada por textos). |
| `GET /operaciones/:id` | devuelve `destinos[]` (con nombre vigente, banco y `cuenta_activa`) y cada dispersión con `pagadora`. |
| `PUT /operaciones/:id/datos-flujo` | acepta `destinos` (reemplazo completo; recalcula pagador/tipo_operacion). |
| `PUT /operaciones/:id/dispersiones` | las líneas admiten `pagadora` / `pagadora_cuenta_id`. |
| `PATCH /cuentas/:id/estado` | NUEVO: `{ activa: boolean, motivo? }` (admin_tesoreria/admin). 409 si ya está en ese estado. |
| `GET /cuentas?todas=1` | el administrador ve también las cuentas fuera de operación. |

## Migración

Automática al arrancar el backend (idempotente):

- `dispersiones.pagadora` y `dispersiones.pagadora_cuenta_id` (ALTER, bases
  previas).
- Tabla `operaciones_destinos` + índice (CREATE IF NOT EXISTS).
- Sin dependencias nuevas.

## Pruebas

`backend/test/pagadoras-destinos.test.ts` (10 pruebas): selección múltiple con
manejo manual y CUALQUIER FLUJO, pagadora por línea, rechazo de destinos/
pagadoras fuera de operación, compatibilidad legada, edición de destinos y
dispersiones, permisos del cambio de estado, catálogo `?todas=1` y flujo de
pago completo con liberación del Fondeador.

Suite completa esperada: **153 passed + 5 todo, 0 fallos**.
