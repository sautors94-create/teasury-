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

## Estado de implementación

- ✅ Backend API con operaciones y validación (`backend/`)
- ✅ Desktop con captura, validación y auditoría (`desktop/`)
- ✅ Tesorería: ejecución de pago con comprobante y vista de pagos
- ✅ Dirección: aprobación por monto (umbral configurable) y reportes de control
- ✅ Tesorería: cuentas con saldos, depósitos/retiros y conciliación de pagos
- ✅ Sincronización: protocolo push/pull (uuid+version, conflictos, idempotencia) + schema central (`backend/central/`)
- ⬜ Resguardos de bienes y adjuntos documentales
- ⬜ Cliente offline con cola de sincronización
- ⬜ Dirección: reportes y aprobaciones especiales
- ⬜ Multiempresa y multimonedas avanzadas

## Usuarios sembrados (desarrollo)

| Usuario | Contraseña | Rol |
|---|---|---|
| operador | operador | operacion |
| validador | validador | validacion |
| tesoreria | tesoreria | tesoreria |
| direccion | direccion | direccion |
| auditor | auditor | auditoria |

> En producción estas contraseñas deben cambiarse en el primer inicio de sesión.