# Sistema Integral de Tesorería

Sistema de gestión y control para el área de Tesorería.

## Objetivo

Centralizar y controlar el flujo de operaciones financieras desde su
captura hasta el pago, comprobante, control de recursos, resguardos,
financiamientos y auditoría.

## Arquitectura

- Desktop: Electron
- Frontend: React + Vite (renderer de Electron, usable también en navegador)
- Backend: Node.js + Express + TypeScript
- Base de datos central: PostgreSQL (fase de sincronización)
- Base de datos local: SQLite
- Comunicación: API REST (JWT + roles)
- Auditoría: bitácora append-only por operación y usuario
- Sincronización: local ↔ servidor (diseñada en `docs/05-sincronizacion.md`)

## Áreas

- Operaciones
- Validación
- Tesorería
- Dirección
- Auditoría

## Estructura

```
backend/   API Express: auth, operaciones, validación, auditoría
desktop/   Electron + React (captura, validación, bitácora)
docs/      Especificación funcional completa
```

## Arranque

```bash
npm install
npm run dev        # backend (:4000) + renderer (:5173)
npm run typecheck  # TypeScript en ambos workspaces
npm test           # tests de la API
```

 desktop solo (con Electron): `npm run dev -w @teasury/desktop` y luego
`npm run dev:app -w @teasury/desktop`.

Usuarios sembrados en desarrollo: `operador`, `validador`, `tesoreria`,
`direccion`, `auditor` (contraseña = usuario).

## Estado

Fase 1 (Operaciones + Validación) implementada:

- ✅ Captura con validación de datos y folio automático (`OP-<año>-<corr>`)
- ✅ Máquina de estados: borrador → en_validación → aprobada / observada
- ✅ Roles y permisos por endpoint (401 / 403 / 409)
- ✅ Bitácora de auditoría visible a Auditoría y Dirección
- ✅ Tesorería: pago con comprobante (medio, folio, fecha) y vista de pagos con totales
- ⬜ Tesorería: control de recursos y conciliación bancaria
- ⬜ Dirección: reportes y aprobaciones por montos
- ⬜ Sincronización local ↔ PostgreSQL

## Documentación

Toda la especificación funcional se encuentra dentro de:

docs/