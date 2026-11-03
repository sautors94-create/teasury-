import { join } from "node:path";

export const PUERTO = Number(process.env.PORT ?? 4000);
// Ruta por omisión: <cwd>/data/tesoreria.db. Con `npm run dev` el cwd es
// backend/, así que el resultado es backend/data/tesoreria.db (igual que antes
// con import.meta.url). Se evita import.meta porque el bundle de producción
// (CJS, empaquetado en Electron) lo deja vacío; en ese contexto DB_PATH siempre
// lo inyecta el proceso main.
export const RUTA_DB = process.env.DB_PATH ?? join(process.cwd(), "data", "tesoreria.db");
export const SECRETO_JWT = process.env.JWT_SECRET ?? "teasury-dev-secret-cambiar-en-produccion";
/** Monto a partir del cual una operación requiere aprobación de Dirección. */
export const UMBRAL_DIRECCION = Number(process.env.UMBRAL_DIRECCION ?? 500000);

/**
 * URL base del servidor central (p. ej. `http://central:4000/api`). Se lee en
 * cada llamada para poder cambiarla en pruebas. Vacío = sólo cola local
 * (sin sincronización configurada).
 */
export function centralUrl(): string {
  return (process.env.CENTRAL_URL ?? "").replace(/\/+$/, "");
}