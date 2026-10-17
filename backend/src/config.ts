export const PUERTO = Number(process.env.PORT ?? 4000);
export const RUTA_DB = process.env.DB_PATH ?? new URL("../data/tesoreria.db", import.meta.url).pathname;
export const SECRETO_JWT = process.env.JWT_SECRET ?? "teasury-dev-secret-cambiar-en-produccion";