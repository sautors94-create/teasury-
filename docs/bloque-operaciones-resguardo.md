# Bloque Operaciones: coberturas, resguardo, depósitos y catálogo de cuentas

Diseño e implementación del primer bloque funcional del área de Operaciones
(sobre la base de los 10 roles ya implementados y verificados).

## 1. Qué resuelve este bloque

| # | Requisito | Solución |
|---|-----------|----------|
| 1 | Segunda asignación de un cliente (vacaciones / permisos especiales): otro ejecutivo puede ver al cliente y su historial | Tabla `cliente_coberturas` + rutas de alta/lista/cierre; el alcance (§12) del ejecutivo temporal incluye al cliente |
| 2 | Resguardo por cliente que sube y baja con cada operación | Tabla `resguardos_movimientos`; el saldo **nunca se guarda**: es la suma de sus movimientos (§14) |
| 3 | El depósito del cliente suma al resguardo **sólo cuando lo valida Tesorería** | `POST /api/resguardos/depositos` y `POST /api/operaciones/:id/deposito/validar` crean el movimiento bancario y el depósito de resguardo en una sola transacción |
| 4 | Con saldo 0, el ejecutivo adjunta el comprobante del pago/deposito que se usará | Tabla `operaciones_depositos`: cuenta del catálogo + comprobante + monto + fecha, editable mientras Tesorería no lo valide |
| 5 | El ejecutivo elige la cuenta donde el cliente depositó, para que Tesorería verifique el recurso | `GET /api/cuentas/catalogo` (ligero, sin saldos) alimentando el selector del ejecutivo; la validación crea el movimiento en esa cuenta |

## 2. Flujo completo (feliz path)

1. `admin_operaciones` crea al cliente y lo asigna a un Ejecutivo (ya existía).
2. El cliente deposita a una cuenta de Tesorería. Dos caminos:
   - **A. Tesorería registra directo**: Validador de Tesorería / Admin de Tesorería
     usa `POST /api/resguardos/depositos` (cliente, cuenta, monto, comprobante).
   - **B. El ejecutivo lo indica**: al capturar la operación (o después, mientras
     esté en `borrador` u `observada`), indica cuenta del catálogo + comprobante
     (`POST /api/operaciones/:id/deposito`). Queda en la cola
     `GET /api/resguardos/depositos-pendientes` y Tesorería lo valida
     (`POST /api/operaciones/:id/deposito/validar`).
3. La validación crea el **movimiento bancario** (depósito) en la cuenta elegida y
   el **movimiento de resguardo** (`tipo='deposito'`) en la misma transacción → el
   saldo del cliente sube.
4. La operación sigue su flujo normal (borrador → en_validacion → aprobada → pagada).
5. Al **pagar**, Tesorería (rol `tesoreria`) dispara el cargo: si
   `saldo - monto < 0` el pago se rechaza con 409 y `saldo_resguardo`; si hay
   fondo, se inserta el movimiento `tipo='cargo'` y el saldo baja.
6. Si el ejecutivo habitual está ausente, `admin_operaciones` crea una
   **cobertura** (`POST /api/clientes/:id/coberturas`): el ejecutivo temporal ve al
   cliente, sus operaciones, sus pagos y su resguardo; la asignación principal no
   se toca. El cierre anticipado (`.../cerrar`) revoca el acceso de inmediato.

## 3. Tablas nuevas (SQLite local, espejo en `backend/central/schema.sql`)

- `cliente_coberturas` — segunda asignación temporal (habitual, temporal, fechas,
  motivo, asignado_por, activo, cerrado_en). Append-only en la práctica: el cierre
  marca `activo=0` + `cerrado_en`, nunca borra.
- `resguardos_movimientos` — libro del resguardo: `deposito` (+) / `cargo` (−),
  importe, operación y cuenta opcionales, comprobante, observaciones, creado_por.
- `operaciones_depositos` — depósito indicado por el ejecutivo (1:1 con la
  operación, `UNIQUE operacion_id`): cuenta, monto, comprobante, fecha, quién lo
  indicó y quién lo validó (`validado_por/validado_en`).

Ninguna tabla guarda el saldo del resguardo: se calcula siempre con
`SUM(CASE WHEN tipo='deposito' THEN importe ELSE -importe END)` (§14 "saldos
calculados, no editables").

## 4. Rutas nuevas y permisos (§13)

| Ruta | Roles | Notas |
|------|-------|-------|
| `GET /api/cuentas/catalogo` | cualquiera autenticado | ligero: id, nombre, banco, número; sin saldos |
| `POST /api/clientes/:id/coberturas` | `admin_operaciones` | habitual ≠ temporal; ambos rol `operacion` activos; `fecha_fin` opcional |
| `GET /api/clientes/:id/coberturas` | `admin_operaciones`, `admin`, `auditoria` | historial |
| `POST /api/clientes/:id/coberturas/:id/cerrar` | `admin_operaciones` | cierre anticipado |
| `GET /api/clientes/:id/resguardo` | ops de operaciones + tesorería + dirección + auditoría | el ejecutivo sólo sus clientes (§12) |
| `POST /api/resguardos/depositos` | `validador_tesoreria`, `admin_tesoreria` | transacción: movimiento bancario + resguardo |
| `GET /api/resguardos/depositos-pendientes` | `validador_tesoreria`, `admin_tesoreria` | cola de indicaciones |
| `POST /api/operaciones/:id/deposito` | `operacion` (con alcance) | alta o corrección mientras no esté validado; exige cliente y estado `borrador|observada` |
| `POST /api/operaciones/:id/deposito/validar` | `validador_tesoreria`, `admin_tesoreria` | idempotente: doble validación → 409 |

Cambios en rutas existentes: el alcance del ejecutivo (listas de operaciones,
detalle, pagos, clientes, resguardo) ahora es *asignación vigente ∪ cobertura
vigente*; `POST /operaciones/:id/pago` valida el resguardo y genera el cargo;
`GET /operaciones/:id` devuelve también `deposito`.

## 5. Decisiones de diseño

1. **El chequeo de fondos ocurre al pagar, no al capturar.** La operación puede
   capturarse con saldo 0 (adjuntando la indicación de depósito); el dinero se
   compromete cuando Tesorería paga. Así el flujo no se bloquea y el control real
   queda en Tesorería, que es quien verifica el recurso en la cuenta.
2. **El depósito indicado es editable hasta su validación** (corrección de folios
   o montos capturados mal); tras validar, es inmutable (409).
3. **La validación del depósito es una sola transacción** (movimiento bancario +
   resguardo): nunca puede quedar el resguardo acreditado sin respaldo bancario.
4. **La cobertura no reemplaza la asignación**: es una segunda llave temporal; el
   historial append-only queda intacto y el cierre es inmediato.
5. **El catálogo para el ejecutivo no expone saldos** (mínimo privilegio §9).

## 6. UI (desktop)

- **Clientes** (`admin_operaciones`): botón "Asignar / cobertura / resguardo" por
  cliente → asignación + historial, formulario de cobertura temporal con cierre
  anticipado, y panel de resguardo con saldo y movimientos.
- **Mis clientes** (`operacion`): botón "Ver resguardo" por cliente.
- **Operaciones** (`operacion`): en el detalle, saldo del resguardo del cliente y
  sección "Depósito del cliente (comprobante de recursos)" con selector del
  catálogo, monto, fecha y comprobante; editable mientras no se valide.
- **Tesorería** (`validador_tesoreria` / `admin_tesoreria`): cola "Depósitos de
  clientes por validar" con botón Validar (muestra el saldo resultante) y
  formulario "Registrar depósito al resguardo del cliente" (entrada directa).

## 7. Pruebas

`backend/test/operaciones-resguardo.test.ts` — 15 pruebas que cubren: catálogo sin
saldos; alcance del temporal y su revocación; 400 por habitual=temporal; saldo 0
inicial; depósito validado suma y crea movimiento bancario; comprobante
obligatorio; pago resta y deja saldo exacto; pago sin fondo → 409 sin cambiar
estado; indicación + validación suma al resguardo; edición previa a validación;
doble validación → 409; validaciones de datos; alcance en la indicación; 409 por
operación de otro cliente. Suite completa del repo: **80 pruebas pasando + 5 todo,
cero fallos**.
