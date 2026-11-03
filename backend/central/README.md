# Servidor central (PostgreSQL)

`schema.sql` crea la base central con la misma estructura que el backend usa en
SQLite local, más las tablas de sincronización (`sync_registros`,
`sync_aplicados`).

## Despliegue sugerido

```bash
createdb teasury
psql teasury < backend/central/schema.sql
PORT=4000 DB_URL=postgres://user:pass@central/teasury npm run dev -w @teasury/backend
```

El backend de esta fase habla SQLite (`better-sqlite3`); para apuntarlo a
Postgres se cambia el driver por `pg` manteniendo las mismas consultas (las
únicas diferencias: `NUMERIC` vs `REAL`, `TIMESTAMPTZ` vs `datetime('now')` y
`SERIAL` vs `AUTOINCREMENT`, ya contempladas en `schema.sql`).

## Protocolo de sincronización (resumen)

- **Identidad:** `uuid` (cliente) + `version` (entero). Tabla `sync_registros`.
- **Emisión local:** cada captura o cambio de estado llama a `emitir()` y agrega
  una fila en `sync_aplicados` (append-only, es la fuente del pull).
- **Cliente → servidor:** `POST /api/sync/push` con
  `{ cambios: [{ tabla, uuid, version, payload }] }`. Reglas por cambio:
  `aplicado` (versión mayor → se aplica), `conflicto` (versión menor o igual →
  gana la del servidor; resolución humana), `duplicado`/no-op (misma versión ya
  aplicada), `error` (tabla/campos inválidos).
  El servidor reasigna folios `OP-LOCAL-*` y registra `creado_por` como el
  usuario que empuja.
- **Servidor → cliente:** `GET /api/sync/pull?desde=<cursor>` devuelve los
  cambios aplicados posteriores al cursor (id de `sync_aplicados`) y el cursor
  nuevo. Idempotencia por `(tabla, uuid, version)` UNIQUE.

Pendiente de fases siguientes: cola offline en el cliente (badge
sincronizado/pendiente/conflicto), staging con `ack` en dos fases y paginación
por fecha en lugar de id.