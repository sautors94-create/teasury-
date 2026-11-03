/**
 * Fase 15 — Bóveda de credenciales: cifrado AES-256-GCM.
 *
 * Las contraseñas/NIP/claves de seguridad de los portales bancarios se guardan
 * CIFRADOS en la base (nunca en texto plano, nunca en logs). La clave maestra
 * viene de la variable de entorno BOVEDA_CLAVE; si no existe, se usa una clave
 * de desarrollo (documentado en el LEEME de la fase: en producción definir
 * BOVEDA_CLAVE).
 *
 * Formato almacenado: "v1:" + base64(iv[12] | tag[16] | ciphertext).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const PREFIJO = "v1:";

function claveMaestra(): Buffer {
  const frase = process.env.BOVEDA_CLAVE ?? "tesoreria-boveda-local-fase15";
  // Derivamos 32 bytes (AES-256) de la frase maestra.
  return createHash("sha256").update(frase, "utf8").digest();
}

/** Cifra un secreto; cadena vacía/null → cadena vacía (sin secreto). */
export function cifrarSecreto(texto: string | null | undefined): string {
  const plano = (texto ?? "").trim();
  if (!plano) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", claveMaestra(), iv);
  const ct = Buffer.concat([cipher.update(plano, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIJO + Buffer.concat([iv, tag, ct]).toString("base64");
}

/** Descifra un secreto guardado; devuelve "" si no hay o si el dato no es nuestro. */
export function descifrarSecreto(guardado: string | null | undefined): string {
  const dato = (guardado ?? "").trim();
  if (!dato.startsWith(PREFIJO)) return "";
  try {
    const crudo = Buffer.from(dato.slice(PREFIJO.length), "base64");
    const iv = crudo.subarray(0, 12);
    const tag = crudo.subarray(12, 28);
    const ct = crudo.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", claveMaestra(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    // Clave maestra distinta o dato corrupto: nunca lanzar, nunca filtrar.
    return "";
  }
}

/** Indica si un valor guardado está cifrado por la bóveda. */
export function estaCifrado(guardado: string | null | undefined): boolean {
  return (guardado ?? "").startsWith(PREFIJO);
}
