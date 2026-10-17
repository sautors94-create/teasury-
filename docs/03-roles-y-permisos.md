# 03 — Roles y Permisos

## Áreas y roles

| Rol (`rol`) | Área | Función principal |
|---|---|---|
| `operacion` | Operaciones | Captura y corrige operaciones; las envía a validación |
| `validacion` | Validación | Aprueba u observa operaciones en validación |
| `tesoreria` | Tesorería | Ejecuta pagos/cobros, comprobantes y control de recursos |
| `direccion` | Dirección | Reportes, auditoría y aprobaciones fuera de rutina |
| `auditoria` | Auditoría | Solo lectura: bitácora y expedientes |

El rol viaja dentro del JWT (`req.usuario.rol`) y se verifica con
`requiereRol(...)` en `backend/src/rutas.ts`.

## Matriz de permisos (fase actual)

| Permiso / Endpoint | operacion | validacion | tesoreria | direccion | auditoria |
|---|:-:|:-:|:-:|:-:|:-:|
| `POST /api/auth/login` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `GET /api/catálogos`, `GET /api/operaciones` (lista/detalle) | ✅ | ✅ | ✅ | ✅ | ✅ |
| `POST /api/operaciones` (captura) | ✅ | ❌ | ❌ | ❌ | ❌ |
| `POST /api/operaciones/:id/enviar-validacion` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `POST /api/operaciones/:id/cancelar` | ✅ (siempre) | ❌ | ❌ | ✅ (futuro: cualquier estado) | ❌ |
| `POST /api/operaciones/:id/revision` (aprobar/observar) | ❌ | ✅ | ❌ | ❌ | ❌ |
| `GET /api/auditoria` (bitácora global) | ❌ | ❌ | ❌ | ✅ | ✅ |
| Registrar pago (`POST .../pago`, con comprobante) | ❌ | ❌ | ✅ | ❌ | ❌ |
| `GET /api/pagos` (historial de pagos) | ❌ | ❌ | ✅ | ✅ | ✅ |

Respuestas:

- Sin token o token inválido → `401`.
- Token válido pero rol insuficiente → `403` con mensaje indicando el rol requerido.
- Estado que no permite la transición → `409`.
- Datos inválidos → `400` con arreglo `detalles[]`.

## Usuarios sembrados (desarrollo)

Creados automáticamente en la primera arranada (`backend/src/db.ts`), con la
contraseña igual al nombre de usuario. **Producción: obligar cambio y usar
secretos gestionados.**

## Reglas pendientes

- Cambio forzoso de contraseña en primer inicio.
- Bloqueo por intentos fallidos y expiración de sesión configurable.
- Permiso de cancelación de Dirección sobre estados posteriores (política de
  montos).
- Separación de duties: quien captura no valida (ya implementado); quien valida
  no paga (ya implementado: sólo `tesoreria` ejecuta el pago).