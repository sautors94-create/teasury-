# Fase 12 — Visibilidad de operaciones por rol, Tesorero Fondeador y Altas bancarias

Esta fase regula **quién ve qué** en el módulo de Operaciones, introduce la
**liberación del Tesorero Fondeador** como paso obligatorio antes de que
Tesorería pueda dispersar, agrega la **asignación de ejecutivos a validadores**
por parte del Administrador de Validación, limita la **cancelación** al dueño de
la captura y a Tesorería, deja **Auditoría en sólo lectura** y crea el módulo de
**Altas bancarias** con el rol **Tesorería de Altas**.

Al arrancar, la base se migra sola (idempotente): la tabla `usuarios` se
reconstruye con los 13 roles, `operaciones` recibe las columnas
`liberada_por` / `liberada_en` y se crean las tablas `validacion_ejecutivos`
y `altas_bancarias`. En el arranque también se aseguran los dos usuarios base
nuevos: `fondeador` (Tesorero Fondeador) y `altas` (Tesorería de Altas), con
contraseña inicial igual al nombre de usuario.

---

## 1. Visibilidad del listado y del detalle de operaciones

Mismo alcance en `GET /api/operaciones` y `GET /api/operaciones/:id`
(en el detalle responde 403 si la operación está fuera del alcance del rol).

| Rol | Alcance |
|---|---|
| `admin` | **Todas** las operaciones. |
| `admin_operaciones` | Todas (supervisa el área de Operaciones). |
| `admin_validacion` | Todas, con su panel de asignaciones. |
| `admin_tesoreria` | Todas. |
| `validador_tesoreria` | Todas, con su contexto (quién validó, historial completo). |
| `direccion` | Todas. Sólo lectura **salvo** lo que le corresponde: aprobar/rechazar operaciones en `pendiente_direccion` y financiamientos. |
| `auditoria` | Todas, con su estatus. **Sólo lectura**: el endpoint de "observaciones de auditoría" se retiró; no modifica nada. |
| `operacion` (Ejecutivo) | Sólo **su historial**: operaciones propias o de sus clientes asignados/cubiertos, **por día**, y puede mirar hacia atrás **hasta 1 mes** (ver §2). |
| `validacion` (Validador) | Sólo lo que le toca: asignaciones vigentes por operación ∪ operaciones de los **ejecutivos que le asignaron** ∪ operaciones de ejecutivos **sin distribución** (flujo simple §4.2). |
| `fondeador` (Tesorero Fondeador) | Las **por validar** (`en_validacion`, `observada`, `pendiente_direccion`) y las **ya validadas** (`aprobada`, `en_pago`, `pagada`) para calcular los montos de flujos de efectivo por frente (FLUJOS, SOFOM, anticipos a rendimientos, etc.). No ve borradores ni canceladas. |
| `tesoreria` (Analista) | **Sólo las liberadas** por el Tesorero Fondeador (`liberada_en` con valor). |
| `confirmador` | **Sólo las que tienen depósitos por confirmar** (depósitos pendientes de validar). Al confirmarse el último depósito, la operación sale de su vista. |
| `altas` (Tesorería de Altas) | En el listado de operaciones no participa; sólo abre operaciones con solicitudes de alta ligadas (contexto del detalle), y trabaja desde la vista **Altas bancarias**. |

## 2. Historial por día del Ejecutivo (ventana de 1 mes)

* Sin parámetros, el Ejecutivo consulta su historial del **último mes**
  (tolerancia de 31 días para husos horarios).
* Con `?desde=YYYY-MM-DD` consulta ese día en adelante; con `?hasta=` acota el
  rango. Si pide `desde` **mayor a 1 mes atrás** responde 400:
  *"Como Ejecutivo sólo puedes consultar tu historial hasta 1 mes atrás"*.
* En la UI, la vista de Operaciones del ejecutivo trae el selector **"Historial
  del día"** con botones ‹ › para navegar día por día (límite: 1 mes atrás).

## 3. Asignación de ejecutivos a validadores (Administrador de Validación)

* Nueva tabla **`validacion_ejecutivos`** (append-only): el
  `admin_validacion` asigna **ejecutivos de operaciones** a **validadores**;
  el validador visualiza (y revisa) las operaciones capturadas por esos
  ejecutivos. La reasignación cierra la vigente y abre la nueva.
* Endpoints:
  * `POST /api/validacion/asignar-ejecutivo` (admin_validacion) —
    `{ validador_id, ejecutivo_id, motivo? }`; 409 si ya existe la pareja
    vigente.
  * `GET /api/validacion/asignaciones-ejecutivos` (admin_validacion, admin,
    auditoria) — base histórica con nombres.
  * `POST /api/validacion/asignaciones-ejecutivos/:id/cerrar`
    (admin_validacion) — cierra la asignación.
* Regla de revisión (`POST /api/operaciones/:id/revision`):
  1. Si la operación tiene asignación por operación vigente, sólo ese
     validador puede revisarla (§4.1, igual que antes).
  2. Sin asignación por operación: si el ejecutivo que la capturó está
     asignado a validadores, **sólo esos validadores** la revisan (403 para
     los demás).
  3. Si el ejecutivo no está distribuido, cualquier validador del área la
     revisa (flujo simple §4.2 — compatibilidad con el flujo actual).
* La cola `GET /api/validacion/cola` aplica el mismo filtro para el validador;
  el Administrador de Validación siempre ve toda la cola.
* En la UI (pestaña **Validación**, bloque del admin) se agregó el panel
  **"Ejecutivos de Operaciones asignados a validadores"** con el formulario de
  asignación y la tabla con cierre.

## 4. Tesorero Fondeador: visibilidad, resumen y LIBERACIÓN

* Nuevo rol **`fondeador`** y usuario base `fondeador`.
* **Resumen de fondeo** `GET /api/fondeador/resumen` (fondeador,
  admin_tesoreria, admin): montos por estado (con flujo total a dispersar) y
  **por tipo de operación del negocio** (FLUJOS, SOFOM, anticipos a
  rendimientos, etc.) con desglose por validar / por dispersar / pagado, más
  los contadores por liberar / liberadas.
* **Liberación** `POST /api/operaciones/:id/liberar` (**sólo `fondeador`**):
  * Requiere estado `aprobada` (o `en_pago` heredado sin liberar); 409 si ya
    estaba liberada.
  * Marca `liberada_por` / `liberada_en`, queda en bitácora como
    `operacion_liberada` y se emite a sincronización.
* **Bloqueo en pagos**: `POST /api/operaciones/:id/pago` y `POST
  /api/operaciones/:id/pagos` rechazan con 409 si `liberada_en IS NULL`:
  *"La operación requiere la liberación del Tesorero Fondeador antes de
  dispersar"*.
* UI: pestaña **Fondeo** (rol fondeador) con tarjetas por estado, tabla por
  tipo de operación y la lista **"Aprobadas por liberar"** con el botón
  **Liberar a Tesorería**; en el detalle de operación el fondeador también
  tiene el botón, y todos los roles ven el aviso **"Liberada por el Tesorero
  Fondeador"** con fecha y responsable.

## 5. Cancelación: dueño o Tesorería (Dirección ya no cancela)

* `POST /api/operaciones/:id/cancelar` acepta ahora los roles
  `operacion`, `tesoreria`, `admin_tesoreria` y `fondeador`.
* **Ejecutivo (dueño)**: sólo puede cancelar **su** captura y sólo en
  `borrador` u `observada` (403 si no es suya, 409 en otro estado).
* **Tesorería**: puede cancelar en `borrador`, `en_validacion`,
  `observada`, `pendiente_direccion` y `aprobada`; en `en_pago` sólo si no
  hay tandas registradas (409 con el dispersado en el mensaje). Nunca una
  `pagada` o ya `cancelada`.
* **Dirección** quedó fuera: su única escritura es lo propio de su rol
  (aprobación de operaciones pendientes y financiamientos).
* Las transiciones de estado se ampliaron para permitir
  `en_validacion → cancelada`, `pendiente_direccion → cancelada`,
  `aprobada → cancelada` y `en_pago → cancelada` (esta última sólo se alcanza
  sin pagos por la regla anterior).

## 6. Auditoría sólo lectura

* Se retiró `POST /api/operaciones/:id/observacion-auditoria`. Auditoría
  consulta todas las operaciones (proceso y estatus), la bitácora y el
  concentrado (versión limpia), pero **no registra observaciones ni modifica
  nada**.

## 7. Altas bancarias (rol `altas` — Tesorería de Altas)

Flujo del negocio: el Ejecutivo **solicita el registro** de la cuenta de un
beneficiario en el banco; el Tesorero de Altas la registra **directo desde el
portal bancario** y lo marca en el sistema. Tesorería **no puede realizar
pagos** a cuentas que no estén registradas.

### Solicitud (Ejecutivo de Operaciones)

* `POST /api/altas-bancarias` (rol `operacion`):
  * **Desde una línea de dispersión** (recomendado): `{ dispersion_id }` —
    toma beneficiario, banco y cuenta/CLABE de la línea (la operación debe ser
    del alcance del ejecutivo); la moneda sale de la operación. También acepta
    `{ operacion_id, ... }` para ligar la solicitud a una operación.
  * **Manual**: `{ beneficiario, banco, moneda, cuenta, notas? }`.
  * Validaciones: beneficiario, banco y cuenta requeridos; moneda de 3 letras
    (MXN por omisión). Sin duplicados: 409 si la cuenta ya está **registrada**
    o si hay una **solicitud pendiente** igual (banco + cuenta normalizados:
    mayúsculas, sin espacios ni guiones). Una solicitud **rechazada** sí
    permite volver a solicitar.
* Base de altas `GET /api/altas-bancarias` (`?estado=`, `?operacion_id=`):
  el Ejecutivo ve **las suyas**; `altas`, `admin_tesoreria`, `admin`,
  `admin_operaciones`, `fondeador`, `validador_tesoreria`, `direccion` y
  `auditoria` ven la base completa. Cada fila conserva **fecha, quién la
  solicitó, moneda y banco** (más folio de la operación ligada).

### Registro / rechazo (Tesorería de Altas)

* `POST /api/altas-bancarias/:id/registrada` (roles `altas`, `admin_tesoreria`,
  `admin`): marca la solicitud como **registrada** con fecha y responsable
  (bitácora `alta_registrada`).
* `POST /api/altas-bancarias/:id/rechazar` (mismos roles): exige `motivo`
  (bitácora `alta_rechazada`).
* Los estados son `solicitada → registrada | rechazada` (append-only: no se
  borra ni se edita).

### Bloqueo de pagos a cuentas no registradas

* Antes de registrar una tanda (individual o por lote) de una operación
  `flujo` con dispersiones, el backend verifica **cada línea con banco y
  cuenta/CLABE**: debe existir un alta **registrada** de ese banco+cuenta.
* Si falta alguna, responde 409 con la lista de pendientes:
  *"Tesorería no puede pagar: hay N cuenta(s) sin alta bancaria registrada —
  BENEFICIARIO (BANCO, cuenta). Solicita el alta en 'Altas bancarias'."*
* Las líneas **sin datos bancarios** (sólo beneficiario e importe) no son
  verificables y no bloquean (medios de pago no bancarios).
* El detalle de la operación expone `altas_dispersiones[]` con el estado por
  línea (`verificable`, `registrada`, `estado_alta`) y, para el ejecutivo, el
  botón **"Solicitar alta"** por línea; la pestaña **Altas bancarias** da el
  formulario manual y la base con acciones para Altas/Tesorería.

## 8. Pruebas

* `backend/test/visibilidad-roles.test.ts` (7 pruebas): historial por día y
  límite de 1 mes del ejecutivo, alcance admin/operador, liberación del
  fondeador con bloqueo previo de Tesorería, resumen de fondeo, asignación de
  ejecutivos con revisión restringida y cierre, cancelaciones por rol y
  alcance del confirmador.
* `backend/test/altas-bancarias.test.ts` (4 pruebas): solicitud desde
  dispersión con base completa, duplicados, alta manual, alcance, rechazo con
  motivo, permisos y bloqueo/desbloqueo de pagos (individual y por lote).
* Suite completa: **143 passed + 5 todo, cero fallos**; build de producción y
  smoke E2E con servidor real (migración de base de 11 roles incluida) OK.
