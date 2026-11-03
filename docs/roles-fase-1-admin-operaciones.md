# Fase 1 — Diseño de roles: Administrador del sistema y área de Operaciones

> Fuente: `docs/01-ROLES.md` (§3 Operaciones, §8 Administración del sistema,
> §9 mínimo privilegio, §10 doble control, §12 regla general de alcance).
> Este documento describe el diseño implementado en esta fase y los endpoints
> que lo materializan. Las siguientes fases cubrirán Validación, Tesorería
> (administrador + validador + tesorero con coberturas), Dirección y Auditoría.

## 1. Resumen de la fase

El sistema original manejaba 5 roles genéricos. Con `01-ROLES.md` el equipo
define **7 roles** en esta fase (de los 10 finales del documento): se agregan
`admin` (Administrador del sistema) y `admin_operaciones` (Administrador de
Operaciones), y el Ejecutivo de Operaciones (`operacion`) pasa a trabajar con
**alcance por clientes asignados**. La separación de funciones queda aplicada
en el código: quien administra el sistema no opera financieramente, quien
captura sólo lo hace para sus clientes, y quien supervisa no ejecuta pagos.

| Rol (01-ROLES.md) | Clave en el sistema | Estado en esta fase |
|---|---|---|
| Administrador del sistema (§8.1) | `admin` | **Nuevo** |
| Administrador de Operaciones (§3.1) | `admin_operaciones` | **Nuevo** |
| Ejecutivo de Operaciones (§3.2) | `operacion` | Existente, ahora con alcance |
| Validador (§4.2) | `validacion` | Existente (fase siguiente) |
| Administrador de Validación (§4.1) | *(fase siguiente)* | Pendiente |
| Administrador de Tesorería (§5.1) | *(fase siguiente)* | Pendiente |
| Validador de Tesorería (§5.2) | *(fase siguiente)* | Pendiente |
| Tesorero (§5.3) | `tesoreria` | Existente (fase siguiente) |
| Usuario de Dirección (§6.1) | `direccion` | Existente |
| Auditor (§7.1) | `auditoria` | Existente |

## 2. Administrador del sistema (`admin`)

Responsabilidades implementadas (§8.1): administración técnica de usuarios,
roles, catálogos, parámetros y supervisión de la bitácora técnica.

**Puede:**

* Crear usuarios: `POST /api/usuarios` (valida username único, rol del
  catálogo de roles, contraseña inicial mínima de 4 caracteres; se registra
  `usuario_creado` en bitácora).
* Desactivar/activar usuarios: `PATCH /api/usuarios/:id/estado`. La
  desactivación impide el login de inmediato y, además, bloquea las escrituras
  de una sesión ya iniciada (middleware `usuarioVivo`).
* Asignar roles: `PATCH /api/usuarios/:id/rol` (queda registrado el valor
  anterior y el nuevo en la bitácora).
* Administrar catálogos: `GET/POST/PATCH /api/catalogos/registros`
  (dominios como `pagadora`; vienen sembrados BBVA, Santander y Banorte).
* Configurar parámetros: `GET/PATCH /api/parametros`. El parámetro
  `umbral_direccion` prevalece sobre la variable de entorno `UMBRAL_DIRECCION`
  en cuanto el admin lo cambia; aplica de inmediato en la validación.
* Consultar la bitácora: `GET /api/auditoria` (supervisión técnica; el análisis
  y conciliación siguen siendo de Auditoría).

**No puede (separación de funciones, §8.1):** capturar operaciones, revisar,
pagar, tocar cuentas o consultar `GET /api/pagos`. El admin opera el sistema,
no el dinero.

**Doble control implementado (§10):** el admin no puede desactivar su propio
usuario ni cambiarse su propio rol, y no puede desactivar/bajar el rol del
último administrador activo (siempre debe quedar otro admin operativo).

## 3. Administrador de Operaciones (`admin_operaciones`)

Responsabilidades implementadas (§3.1): administrar clientes, asignarlos y
reasignarlos a ejecutivos, y supervisar las operaciones del área.

**Puede:**

* Crear clientes: `POST /api/clientes` (nombre, RFC, contacto, notas).
* Modificar información administrativa de clientes: `PATCH /api/clientes/:id`
  (incluye activar/desactivar; nunca se borra físicamente).
* Asignar y reasignar clientes: `POST /api/clientes/:id/asignaciones`
  (sólo acepta usuarios con rol `operacion` activos; motivo opcional).
* Consultar historial de asignaciones: `GET /api/clientes/:id/asignaciones`.
* Supervisar operaciones de todo el área: `GET /api/operaciones` sin filtro de
  alcance (incluye capturista, cliente, estado y tiempos en el historial del
  detalle).
* Listar ejecutivos: `GET /api/usuarios/ejecutivos`.

**No puede:** ejecutar pagos, modificar movimientos bancarios, liberar
recursos ni alterar registros financieros históricos.

**Modelo de asignaciones (append-only, principio de trazabilidad de
`00-VISION.md`):** la tabla `cliente_asignaciones` conserva TODAS las
asignaciones. Una reasignación cierra la vigente (`activo=0`, `cerrado_en`)
y abre una nueva; la original nunca se pierde, lo que permite reconstruir la
cartera de cualquier ejecutivo en cualquier fecha.

## 4. Ejecutivo de Operaciones (`operacion`) — alcance por cliente

**Puede:**

* Crear operaciones para **sus clientes asignados**: el campo `cliente_id` de
  `POST /api/operaciones` se valida contra `cliente_asignaciones` (asignación
  activa). Si el cliente no está asignado al ejecutivo, el backend responde
  **403** "Cliente no asignado a tu usuario". El campo sigue siendo opcional
  para no romper operaciones generales sin cliente (compatibilidad con el
  flujo ya probado por el equipo).
* Consultar sólo lo suyo: `GET /api/operaciones` devuelve sus capturas y las
  de sus clientes asignados; `GET /api/operaciones/:id` responde 403 fuera de
  alcance; `GET /api/clientes` devuelve únicamente sus clientes asignados.
* Descargar comprobantes (§3.2): `GET /api/pagos` ahora también responde al
  rol `operacion`, filtrado a los pagos de sus operaciones (propias o de
  clientes asignados). Validez no pierde la regla: validación no ve pagos.
* Corregir y reenviar operaciones observadas, y cancelar (flujo existente).

**No puede:** aprobar sus propias operaciones, ejecutar pagos, ocupar o
liberar recursos, crear o autorizar financiamientos, modificar saldos.

## 5. Cambios técnicos

**Backend (`backend/src/`):**

* `db.ts`: `Rol` ampliado (`admin`, `admin_operaciones`); CHECK de
  `usuarios.rol` reconstruido por migración automática (conserva datos);
  `operaciones.cliente_id` añadida por migración; tablas nuevas
  `clientes`, `cliente_asignaciones`, `catalogos`, `parametros`; semillas
  `admin`/`admin_ops` (contraseña inicial = username, cambiar en producción)
  con `INSERT OR IGNORE` para bases existentes.
* `rutas.ts`: endpoints de administración y clientes descritos arriba;
  alcance del ejecutivo en listado/detalle/pagos; helper
  `leerUmbralDireccion` (parámetro > variable de entorno); middleware
  `usuarioVivo` en escrituras críticas; eventos de bitácora nuevos:
  `usuario_creado`, `usuario_estado`, `usuario_rol`, `cliente_creado`,
  `cliente_actualizado`, `cliente_asignado`, `catalogo_cambio`,
  `parametro_cambio`.
* `central/schema.sql`: esquema PostgreSQL sincronizado (mismas tablas).
* Tests: `backend/test/roles.test.ts` (18 pruebas nuevas: separación de
  funciones, doble control, alcance, reasignación con historial, umbral
  editable) y ajuste en `pagos.test.ts` al nuevo acceso de comprobantes del
  ejecutivo. Total: 44 pruebas en verde + 5 pendientes programadas (cola).

**Desktop (`desktop/src/`):**

* Menús por rol: `admin` ve *Usuarios* y *Configuración*;
  `admin_operaciones` ve *Clientes*; `operacion` ve *Mis clientes* y en
  *Nueva operación* un selector de sus clientes asignados.
* Vista *Usuarios*: alta, cambiar rol (selector con etiquetas legibles) y
  activar/desactivar.
* Vista *Clientes*: tabla con ejecutivo asignado, alta de clientes, asignar /
  reasignar con motivo e historial append-only.
* Vista *Configuración*: parámetros (editar umbral de Dirección) y catálogos
  (alta y modificación de registros).
* Tabla de operaciones con columna *Cliente*.
* `api.ts` y `tipos.ts` ampliados con los tipos y llamadas correspondientes.

## 6. Usuarios sembrados de desarrollo

| Usuario | Contraseña | Rol |
|---|---|---|
| admin | admin | Administrador del sistema |
| admin_ops | admin_ops | Administrador de Operaciones |
| operador | operador | Ejecutivo de Operaciones |
| validador | validador | Validador |
| tesoreria | tesoreria | Tesorería |
| direccion | direccion | Dirección |
| auditor | auditor | Auditoría |

> En bases existentes los dos primeros se agregan automáticamente al arrancar
> el backend (migración + semilla idempotente). Cambiar contraseñas en
> producción.

## 7. Qué sigue (fases siguientes de roles)

1. Validación: `admin_validacion` (distribución de cola, supervisión de
   tiempos) y trazabilidad de reasignaciones de validación.
2. Tesorería: `admin_tesoreria` (asignación de cuentas a tesoreros,
   coberturas temporales con responsable habitual/temporal, inicio y
   término, motivo) y `validador_tesoreria` (aplicación de recursos y doble
   control en ocupaciones).
3. Doble control en acciones críticas financieras: regla de "dos personas
   distintas" para aplicar recursos y liberaciones.
4. Cambio de contraseña en el primer inicio y política de contraseñas.
