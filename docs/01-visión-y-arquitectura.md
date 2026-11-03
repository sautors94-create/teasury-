# 01 — Visión y Arquitectura

## Objetivo

Centralizar y controlar el flujo de operaciones financieras desde su **captura**
hasta el **pago**, incluyendo comprobantes, control de recursos, resguardos,
financiamientos y auditoría, con trazabilidad completa y cumplimiento interno.

## Áreas funcionales

1. **Operaciones** — captura de operaciones (pagos, cobros, financiamientos) y
   envío a validación.
2. **Validación** — revisión documental y de reglas; aprueba u observa.
3. **Tesorería** — ejecución del pago/cobro, comprobantes y control de recursos.
4. **Dirección** — aprobaciones fuera de rutina y reportes de control.
5. **Auditoría** — lectura del rastro de auditoría y de expedientes.

## Arquitectura actual

```
┌─────────────────────────────┐        ┌──────────────────────────┐
│  desktop/ (Electron)        │  REST  │  backend/ (Node+Express) │
│  ─ React + Vite (renderer)  │◄──────►│  ─ Auth JWT + roles      │
│  ─ main.js (process shell)  │ /api   │  ─ Reglas de dominio     │
└─────────────────────────────┘        │  ─ Auditoría             │
                                       └────────────┬─────────────┘
                                                    │ better-sqlite3
                                       ┌────────────▼─────────────┐
                                       │  SQLite local            │
                                       │  (copia de trabajo)      │
                                       └──────────────────────────┘
                                       PostgreSQL central (futuro,
                                       ver docs/05-sincronizacion.md)
```

- **Desktop:** Electron. El renderer corre React/Vite y habla solo por HTTP con
  la API; sin acceso a Node en el renderer (contextIsolation activo).
- **Backend:** Node.js + Express + TypeScript, JWT con roles.
- **Base de datos local:** SQLite (WAL). Es el sistema de registro en esta fase.
- **Base de datos central:** PostgreSQL, reservada para la fase de sincronización.
- **Comunicación:** API REST bajo `/api` (ver `backend/src/rutas.ts`).

## Decisiones técnicas registradas

| Decisión | Elección | Motivo |
|---|---|---|
| Lenguaje | TypeScript en backend y renderer | Tipos compartidos con el modelo de datos |
| Auth | JWT (12 h) + roles en token | Sin sesión server-side en fase local |
| Hash de contraseñas | bcrypt | Estándar, sin binarios nativos |
| SQLite WAL | `better-sqlite3` | API síncrona simple, apta para escritura por procesos |
| Auditoría | Tabla `auditoria` append-only | Trazabilidad por operación y por usuario |
| Dev UI | Vite dev server | Hot reload y preview web; Electron lo carga en dev |

## Convenciones

- Estados de operación en minúscula con guion bajo (`en_validacion`).
- Folios correlativos `OP-AAAAA-NNNNN`.
- Fechas ISO `YYYY-MM-DD`; marcas de tiempo SQLite `datetime('now')` (UTC).
- Todo cambio de estado genera un registro de auditoría.