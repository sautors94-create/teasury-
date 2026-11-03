# Especificación Funcional — Sistema Integral de Tesorería

Esta carpeta concentra la especificación del sistema. El código de `backend/` y
`desktop/` debe obedecer lo documentado aquí; cualquier cambio de regla empieza
en estos documentos.

## Contenido

| Documento | Contenido |
|---|---|
| [01-visión-y-arquitectura.md](01-visión-y-arquitectura.md) | Objetivo, componentes, decisiones técnicas |
| [02-flujo-de-operaciones.md](02-flujo-de-operaciones.md) | Estados, transiciones y reglas del flujo principal |
| [03-roles-y-permisos.md](03-roles-y-permisos.md) | Áreas, roles y matriz de permisos |
| [04-modelo-de-datos.md](04-modelo-de-datos.md) | Entidades, tablas y relaciones (SQLite / PostgreSQL) |
| [05-sincronizacion.md](05-sincronizacion.md) | Diseño de sincronización local ↔ servidor (pendiente) |
| [06-tesoreria-direccion-auditoria.md](06-tesoreria-direccion-auditoria.md) | Tesorería, Dirección y Auditoría: reglas, permisos, flujos y endpoints |
| [07-empaquetado-electron.md](07-empaquetado-electron.md) | Empaquetado Electron: instalador multiplataforma, IPC seguro, configuración, distribución |

## Checklist resumen (detalle completo en README.md raíz)

### Completado ✅
- Backend API: operaciones, validación, tesorería, direccion, auditoría, cuentas, resguardos, adjuntos, sincronización.
- Desktop: login, operaciones, captura, validación, pago con comprobante, direccion, reportes, cuentas, pagos, auditoría, sincronización, expediente (adjuntos + resguardos).
- Documentación: 7 fases documentadas (docs/01..07).
- Empaquetado Electron: electron-builder.yml, main.js, preload.js, scripts de package (win/mac/linux), iconos placeholders, documentación de distribución.
- Tests: 32 pruebas automatizadas (flujo, pagos, recursos, cola, sincronización).

### En curso / Pendiente ⬜
- X1. Reemplazar íconos placeholder con assets reales del producto.
- X2. Configurar firma de código y notarización para macOS.
- X3. Probar instalación en cada plataforma objetivo.
- X4. Configurar actualizaciones automáticas con electron-updater.
- X5. Generar instaladores para arquitecturas adicionales.

### Próximas fases de funcionalidad ⬜
- Multiempresa/multimonedas avanzadas, conciliación bancaria, reportes Tesorería, servidor central en producción.

## Usuarios sembrados (desarrollo)

| Usuario | Contraseña | Rol |
|---|---|---|
| operador | operador | operacion |
| validador | validador | validacion |
| tesoreria | tesoreria | tesoreria |
| direccion | direccion | direccion |
| auditor | auditor | auditoria |

> En producción estas contraseñas deben cambiarse en el primer inicio de sesión.