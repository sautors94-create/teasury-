# 05 — Sincronización Local ↔ Servidor (diseño, pendiente)

> **Estado:** diseño. Esta fase corre 100% local sobre SQLite. Este documento
> fija las decisiones para implementar la sincronización sin romper el flujo.

## Objetivo

Múltiples escritorios con copia local de PostgreSQL central:

- Operan **offline** contra su SQLite local.
- Sincronizan al recuperar red, sin perder cambios ni romper la bitácora.

## Decisiones propuestas

### 1. Esquema

- Cada tabla operativa lleva `uuid` (generado en el cliente), `version`
  (entero), `modificado_en` (timestamp ISO) y `modificado_por` (uuid de usuario).
- `uuid + version` resuelven identidad y orden; los folios de operaciones se
  asignan **en el servidor** al sincronizar para evitar colisiones (el local usa
  prefijo temporal `OP-LOCAL-…`).

### 2. Transporte

- Cola local `sincronizacion_log`: `{tabla, uuid, version, operacion}`
  (`upsert`/`delete`), con estados `pendiente | enviado | confirmado | conflicto`.
- Endpoint sync: `POST /api/sync/push` (cambios del cliente) y
  `GET /api/sync/pull?desde=<cursor>` (cambios del servidor).
- Paginado por cursor (`modificado_en`, `uuid`) y confirmación (`ack`) en dos
  fases: primero aplicar en staging, luego confirmar.

### 3. Conflictos

- Regla general: **gana la versión más alta**; si el servidor ya avanzó, el
  cliente recibe `conflicto` y el registro queda para resolución humana.
- Restricciones de dominio se evalúan **después** de fusionar (p. ej. el estado
  final de una operación debe ser una transición válida del fusión de bits).
- `auditoria` es **append-only y mergeable por concatenación**; nunca genera
  conflicto, es la fuente para reconstruir historiales.

### 4. Seguridad

- JWT del servidor; cada evento lleva `usuario` real (auditoría inmutable).
- TLS obligatorio; el cliente sólo empuja los registros de su copia.

### 5. Modo degradado

- La UI distingue `sincronizado | pendiente | conflicto` por registro (badge),
  sin bloquear la captura offline.

## Criterios de aceptación (cuando se implemente)

1. Dos clientes capturan sin conexión y sincronizan sin pérdida.
2. Conflicto de estado resuelve con revisión, no con sobrescritura silenciosa.
3. La bitácora final es idéntica en todos los clientes y en el servidor.
4. Fallo de red a mitad de `push` no duplica registros (idempotencia por uuid+version).