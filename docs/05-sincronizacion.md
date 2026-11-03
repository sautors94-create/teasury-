# 05 — Sincronización Local ↔ Servidor (diseño, pendiente)

> **Estado:** protocolo **implementado y probado** (push/pull con uuid+version,
> regla de conflictos, idempotencia y cursor; 6 tests en
> `backend/test/sync.test.ts`). El cliente offline con cola y el staging con
> `ack` en dos fases quedan pendientes. El schema del servidor central está en
> `backend/central/schema.sql` (PostgreSQL).

## Objetivo

Múltiples escritorios con copia local de PostgreSQL central:

- Operan **offline** contra su SQLite local.
- Sincronizan al recuperar red, sin perder cambios ni romper la bitácora.

## Decisiones propuestas

### 1. Esquema (implementado con tablas sidecar)

- En vez de agregar columnas a cada tabla, la identidad vive en
  `sync_registros (tabla, uuid, registro_id, version)` — una fila por registro
  sincronizable — lo que evita reconstruir tablas y mantiene el esquema de
  negocio limpio.
- Folios: el cliente usa prefijo temporal `OP-LOCAL-*`; **el servidor reasigna
  el folio definitivo** al aplicar (`OP-<año>-<correlativo>`).
- `creado_por`: el servidor registra **el usuario que empuja** (los ids de
  usuarios no son comparables entre clientes).

### 2. Transporte (implementado)

- Emisión local: cada captura o cambio de estado llama a `emitir()`; el cambio
  queda en `sync_aplicados` (append-only, `(tabla, uuid, version)` UNIQUE =
  idempotencia).
- `POST /api/sync/push` con `{ cambios: [{ tabla, uuid, version, payload }] }`;
  devuelve por cambio `aplicado | conflicto | error`. Tablas permitidas hoy:
  `operaciones` (`TABLAS_SYNC`).
- `GET /api/sync/pull?desde=<cursor>` devuelve cambios posteriores al cursor (id
  de `sync_aplicados`) y el cursor nuevo (página de 200).
- **Pendiente:** cola offline en el desktop (`pendiente | confirmado |
  conflicto`) y staging con `ack` en dos fases.

### 3. Conflictos

- Regla general: **gana la versión más alta** — implementada: si el servidor ya
  alcanzó esa versión o mayor, responde `conflicto` con `version_servidor` y
  `registro_local` para resolución humana.
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

## Criterios de aceptación

1. ✅ (protocolo) Push/pull aplican cambios sin pérdida; pull por cursor.
2. ✅ Conflicto resuelve con revisión (`conflicto` + `registro_local`), no con
   sobrescritura silenciosa.
3. ✅ Bitácora append-only: `auditoria` + `sync_aplicados` registran cada
   aplicación con su usuario.
4. ✅ Idempotencia: repetir el mismo `(tabla, uuid, version)` no duplica
   registros (UNIQUE + verificación de versión).
5. ⬜ Dos clientes offline reales (cola en el desktop) — fase siguiente.