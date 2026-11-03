# Tesorería de depósitos: confirmador, comprobantes, concentrado bancario y resguardos de brokers

Ampliación de la balanza y respaldos (ver `balanza-financiamientos.md`) que cubre los
requisitos del negocio de tesorería de depósitos. Todo el contenido de este documento
describe código ya implementado y probado (backend + desktop).

## 1. Nuevo rol: Confirmador de Depósitos

- Usuario de la semilla: `confirmador` / `confirmador` (renombrar y cambiar contraseña en producción).
- **Función principal**: ver todos los depósitos que los ejecutivos indicaron en las
  operaciones, revisar sus comprobantes y **validarlos** ("Confirmar" en su vista).
- También puede: **alimentar el concentrado** de movimientos bancarios (altas individuales
  y lote pegado desde Excel) y **marcar con comentario** en el listado de movimientos los
  depósitos ya revisados.
- El **Validador de Tesorería** (`validador_tesoreria`) conserva la facultad de validar
  depósitos; la confirmación es la función exclusiva de prioridad del confirmador.
- Vista propia en la app: **"Confirmación de depósitos"** (cola + concentrado + cuadre).

## 2. Comprobantes documentales por depósito

- Cada depósito indicado por el cliente admite **1 o varios comprobantes** (archivos
  PDF o imagen, base64, hasta 10 por depósito y ~6 MB por archivo):
  - `POST /api/depositos/:id/comprobantes` (ejecutivo de la operación, admin_tesorería o admin).
  - `GET /api/depositos/:id/comprobantes` (metadatos; roles de tesorería o el ejecutivo).
  - `GET /api/comprobantes/:id` (descarga del contenido).
  - `DELETE /api/comprobantes/:id` (mientras el depósito no esté validado).
- **Regla dura**: sin al menos un comprobante, **el depósito no puede validarse**
  (409 en `POST /depositos/:id/validar` y en el endpoint legacy por operación).
- En la **captura**, el ejecutivo adjunta los archivos junto con cada depósito del
  respaldo; en el detalle de la operación puede agregarlos o quitarlos mientras esté pendiente.

## 3. Catálogo de cuentas por tipo (sólo el administrador crea)

- Tipos: `flujo`, `frente`, `prestamo`, `anticipo_rendimiento`, `sofom`, `asimilado`.
- **Sólo `admin_tesoreria` y `admin` crean cuentas** (`POST /api/cuentas`); el analista
  de tesorería consulta y moviliza las que le fueron asignadas.
- **Semilla automática** (idempotente, al arrancar el backend): **10 cuentas de flujos**
  (FLUJOS 01…10 en BBVA/BANORTE/SANTANDER/BANAMEX/HSBC) y **2 de cada otro tipo**
  (FRENTES, PRESTAMOS, ANTICIPO RENDIMIENTOS, SOFOM, ASIMILADOS) — 20 cuentas en total.
- La vista de cuentas muestra el **tipo** con filtro y la columna del tesorero asignado.

## 4. Asignación de cuentas a tesoreros (Administrador de Tesorería)

- `POST /api/cuentas/:id/asignar` (sólo `admin_tesoreria`): asigna/reasigna una cuenta a
  un tesorero; la reasignación cierra la vigente y conserva el **historial append-only**.
- **Alcance §5.3**: un tesorero con asignaciones (o coberturas vigentes) consulta y
  moviliza **sólo sus cuentas**; sin asignaciones mantiene el alcance histórico (todas).
- De sus cuentas asignadas, cada tesorero obtiene el **saldo actual** y los **movimientos
  de su banca** (`GET /api/cuentas`, `GET /api/cuentas/:id`, `GET /api/movimientos`).

## 5. Concentrado bancario tipo Excel (copia de trabajo vs versión limpia)

- **Pegar movimientos**: el tesorero pega los últimos movimientos o todos los del mes
  desde el estado de cuenta (Excel/CSV) en el panel "Concentrado de movimientos
  bancarios". El parser acepta columnas variables (fecha, referencia, concepto, monto;
  monto negativo = retiro), analiza el lote y lo inserta todo-o-nada
  (`POST /api/cuentas/:id/movimientos/lote`, máximo 500 filas).
- **Quién alimenta el concentrado**: tesorero (sus cuentas), validador de tesorería y
  **confirmador**; el campo `origen` deja constancia del rol que lo cargó.
- **Marca de trabajo**: los movimientos de tipo depósito se **marcan** con un comentario
  y opcionalmente se **ligan al depósito del cliente** que cubren
  (`POST /api/movimientos/:id/marca`). Es la función del confirmador y de tesorería;
  la marca se puede quitar (queda en bitácora).
- **Versión limpia**: Dirección y Auditoría consultan el mismo concentrado **sin marcas**
  (`version_limpia: true`; el backend oculta marca/depósito/marcador). Auditoría y
  Dirección no pueden marcar ni desmarcar.

## 6. Listado de operaciones con respaldos y cuadre (Validador)

- `GET /api/operaciones/respaldos` (validador_tesoreria, confirmador, admin_tesoreria,
  admin, dirección, auditoría): por cada operación con cliente devuelve
  `resguardo_saldo`, `depositos_pendientes/validados`, `depositos_sin_comprobante`,
  `financiamiento_solicitado/aprobado`, `respaldo_solido` y **`cuadre`**
  (VERDADERO cuando lo sólido cubre el monto de la operación).
- Panel "Operaciones y respaldos (cuadre)" en Tesorería, Confirmación y Auditoría.

## 7. Resguardos de brokers (comisiones cobradas)

- Cuando una operación queda **PAGADA**, la parte de la comisión de cada broker
  participante (fotografiada en la captura) **entra automáticamente a su resguardo**
  (anti doble alta por operación+broker; evento `broker_comision_resguardo` en bitácora).
- `GET /api/brokers/resguardos`: saldo por broker = comisiones − retiros (roles de
  tesorería, dirección, auditoría y admin_operaciones).
- `POST /api/brokers/:id/retiros` (admin_tesoreria, admin, admin_operaciones): paga
  comisiones al broker; **409 si excede el saldo**.
- Panel "Resguardos de brokers" en Tesorería (con formulario de retiro para quien
  corresponde).

## 8. Sincronización con el esquema central

`backend/central/schema.sql` quedó alineado: CHECK de roles con `confirmador`,
`cuentas.tipo`, columnas del concentrado (`referencia`, `origen`, `deposito_id`,
`marca`, `marcado_por`, `marcado_en`) y tablas `depositos_comprobantes`
(`BYTEA`) y `brokers_resguardos`.

## 9. Migración automática

Al arrancar el backend, `migrarTesoreriaDepositos` reconstruye `usuarios` si su CHECK no
conoce el rol `confirmador`, añade `cuentas.tipo` (las cuentas previas quedan como
`flujo`), añade las columnas del concentrado y siembra el catálogo. Todo idempotente;
las filas existentes se conservan.

## 10. Pruebas

`backend/test/tesoreria-confirmaciones.test.ts` — 22 pruebas: rol confirmador (cola con
`comprobantes_count`, validación con/sin comprobantes, descarga del comprobante,
permisos), catálogo por tipo y semilla, creación reservada al administrador, asignación
con historial y alcance, concentrado (individual, lote todo-o-nada, orígenes, saldo),
marcas con comentario y **versión limpia** para Auditoría/Dirección, reglas
documentales de comprobantes, resguardos de brokers (comisión al pagar, retiros,
permisos) y cuadre de respaldos. Suite completa: **132 pruebas verdes + 5 todo**.
