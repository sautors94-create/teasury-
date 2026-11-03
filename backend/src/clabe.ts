/**
 * Fase 15 — Utilidades de CLABE y de nombres para portales bancarios.
 *
 * Basadas en el formato operativo "ALTA CUENTA" (alta de cuentas en portales
 * bancarios):
 *   · La CLABE es de 18 dígitos; sus 3 primeros dígitos son la clave SPEI del
 *     banco (catálogo `bancos_spei`).
 *   · El número de cuenta interno se deriva de la CLABE con una regla por
 *     banco: la mayoría usa los dígitos 8-17 (10 caracteres); SANTANDER (014)
 *     usa los dígitos 7-17 (11 caracteres).
 *   · Los portales bancarios no aceptan acentos ni Ñ: el nombre que se teclea
 *     en el portal se normaliza (mayúsculas, sin acentos, Ñ→N, un espacio).
 */

/** Regla de derivación de número de cuenta desde la CLABE, por banco (1-indexado inclusivo). */
const REGLAS_CUENTA: Record<string, [number, number]> = {
  "072": [8, 17], // Banorte
  "002": [8, 17], // Banamex
  "021": [8, 17], // HSBC
  "012": [8, 17], // BBVA Bancomer
  "044": [8, 17], // Scotiabank
  "127": [8, 17], // Azteca
  "014": [7, 17], // Santander (regla especial: 11 dígitos, posición 7-17)
};

/** Deja sólo dígitos (equivale a Tullbox(cadena,1) del formato operativo). */
export function normalizarClabe(entrada: string): string {
  return (entrada ?? "").replace(/\D+/g, "");
}

export interface ValidacionClabe {
  ok: boolean;
  clabe: string;
  errores: string[];
  banco_clave: string;
}

/** Valida longitud y composición de la CLABE (sólo dígitos, 18). */
export function validarClabe(entrada: string): ValidacionClabe {
  const clabe = normalizarClabe(entrada);
  const errores: string[] = [];
  if (!clabe) errores.push("CLABE vacía");
  if (clabe.length > 0 && clabe.length !== 18)
    errores.push(`la CLABE debe tener 18 dígitos (tiene ${clabe.length})`);
  return { ok: errores.length === 0, clabe, errores, banco_clave: clabe.slice(0, 3) };
}

/** Clave SPEI (3 primeros dígitos) de la CLABE. */
export function claveBancoDeClabe(clabe: string): string {
  return normalizarClabe(clabe).slice(0, 3);
}

/**
 * Número de cuenta interno derivado de la CLABE según el banco.
 * Devuelve "" si el banco no tiene regla (se maneja manual, como el formato).
 */
export function cuentaDesdeClabe(clabe: string): string {
  const c = normalizarClabe(clabe);
  if (c.length !== 18) return "";
  const regla = REGLAS_CUENTA[c.slice(0, 3)];
  if (!regla) return "";
  const [inicio, fin] = regla;
  return c.slice(inicio - 1, fin);
}

/**
 * Normaliza un nombre para los portales bancarios (equivalente a la macro
 * `Tullbox(nombre,3)` + la cadena de SUBSTITUTE del formato operativo):
 * mayúsculas, sin acentos, Ñ→N, sólo letras y espacios, espacios compactos.
 */
export function normalizarNombrePortal(entrada: string): string {
  const upper = (entrada ?? "").toUpperCase();
  // NFD separa acentos y la Ñ en N + tilde; quitamos las marcas de combinación.
  const sinAcentos = upper.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  // Todo lo que no sea A-Z se vuelve espacio (como Tullbox con patrón letras).
  const soloLetras = sinAcentos.replace(/[^A-Z]+/g, " ");
  return soloLetras.replace(/\s+/g, " ").trim();
}

/** Nombre completo concatenado (PATERNO MATERNO NOMBRE), como el formato. */
export function nombreCompleto(paterno: string, materno: string, nombre: string): string {
  return [paterno, materno, nombre]
    .map((p) => (p ?? "").trim())
    .filter(Boolean)
    .join(" ");
}
