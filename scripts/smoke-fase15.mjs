/**
 * Smoke E2E Fase 15 (catálogo SPEI + CLABE + altas en portales + bóveda):
 * 1) BD previa sin las novedades de Fase 15 (sin bancos_spei, sin altas_portales,
 *    sin bóveda, sin columnas del catálogo maestro) → al arrancar, la migración
 *    debe reponerlas y sembrar los 92 bancos del formato "ALTA CUENTA".
 * 2) Flujo por API: catálogo → validador/derivador de CLABE (regla por banco,
 *    Santander especial) → cuenta nace con CLABE → captura por lotes con
 *    normalización de nombres → matriz alta × portal hasta REGISTRADA (con
 *    rechazo y re-agregado) → bóveda multi-usuario con secretos cifrados y
 *    auditados → importador del catálogo con dedupe.
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const REPO = "/home/z/my-project/treasury-repo";
const require = createRequire(join(REPO, "package.json"));
const Database = require("better-sqlite3");

const BASE = join(tmpdir(), `tesoreria-smoke15-${Date.now()}`);
mkdirSync(BASE, { recursive: true });
const RUTA_DB = join(BASE, "tesoreria.db");
const PUERTO = 4600 + Math.floor(Math.random() * 400);

function arrancar() {
  const p = spawn("npx", ["tsx", "src/server.ts"], {
    cwd: join(REPO, "backend"),
    env: { ...process.env, DB_PATH: RUTA_DB, PORT: String(PUERTO) },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  p.stdout.on("data", () => {});
  p.stderr.on("data", (d) => {
    try {
      appendFileSync("/tmp/smoke15-server.log", d.toString());
    } catch {}
  });
  p.matar = () => {
    try {
      process.kill(-p.pid, "SIGKILL");
    } catch {
      try {
        p.kill("SIGKILL");
      } catch {}
    }
  };
  return p;
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(ruta, opciones = {}) {
  const res = await fetch(`http://127.0.0.1:${PUERTO}/api${ruta}`, {
    headers: { "Content-Type": "application/json", ...(opciones.token ? { Authorization: `Bearer ${opciones.token}` } : {}) },
    ...opciones,
    body: opciones.body ? JSON.stringify(opciones.body) : undefined,
  });
  const cuerpo = await res.json().catch(() => ({}));
  return { status: res.status, cuerpo };
}

let fallos = 0;
function verificar(cond, texto) {
  console.log(`${cond ? "OK " : "FALLO"} ${texto}`);
  if (!cond) fallos++;
}

// --- CLABE sintéticas de prueba (18 dígitos; el sistema no valida dígito verificador).
const CLABE_BNO = "072180004912345678"; // Banorte → cuenta = dígitos 8-17 = 0491234567
const CLABE_SAN = "014180004912345678"; // Santander → cuenta = dígitos 7-17 = 00491234567
const CLABE_BBVA = "012180004912345678"; // BBVA → 0491234567
const CLABE_999 = "999180004912345678"; // prefijo inexistente
const CLABE_IMP = "072180004923456789"; // para el importador (cuenta nueva: 0492345678)

// --- Paso 1: BD con datos y "reversa" de las novedades de Fase 15.
{
  const preliminar = arrancar();
  let arriba = false;
  for (let i = 0; i < 30 && !arriba; i++) {
    await esperar(500);
    const s = await api("/salud").catch(() => ({ status: 0 }));
    arriba = s.status === 200;
  }
  if (!arriba) {
    console.log("FALLO el backend preliminar no levantó");
    process.exit(1);
  }
  preliminar.matar();
  let libre = false;
  for (let i = 0; i < 30; i++) {
    await esperar(300);
    const s = await api("/salud").catch(() => ({ status: 0 }));
    if (s.status !== 200) {
      libre = true;
      break;
    }
  }
  if (!libre) {
    console.log("FALLO el puerto no se liberó tras matar el preliminar");
    process.exit(1);
  }
  const dba = new Database(RUTA_DB);
  dba.pragma("foreign_keys = OFF");
  dba.pragma("legacy_alter_table = ON");
  dba.exec(`
    DROP TABLE IF EXISTS credenciales_accesos;
    DROP TABLE IF EXISTS cuentas_credenciales;
    DROP TABLE IF EXISTS altas_portales;
    DROP TABLE IF EXISTS bancos_spei;
    ALTER TABLE cuentas DROP COLUMN clabe;
    ALTER TABLE cuentas DROP COLUMN moneda;
    ALTER TABLE cuentas DROP COLUMN origen;
    ALTER TABLE cuentas DROP COLUMN estatus;
    ALTER TABLE cuentas DROP COLUMN cliente;
    ALTER TABLE cuentas DROP COLUMN fecha_alta;
    ALTER TABLE cuentas DROP COLUMN fecha_baja;
    ALTER TABLE cuentas DROP COLUMN formato_reporte;
    ALTER TABLE altas_bancarias DROP COLUMN clabe;
  `);
  dba.close();
}

// --- Paso 2: reiniciar; la migración debe reponer todo.
{
  try {
    rmSync("/tmp/smoke15-server.log", { force: true });
  } catch {}
  const principal = arrancar();
  let arriba = false;
  for (let i = 0; i < 30 && !arriba; i++) {
    await esperar(500);
    const s = await api("/salud").catch(() => ({ status: 0 }));
    arriba = s.status === 200;
  }
  if (!arriba) {
    console.log("FALLO el backend no levantó");
    process.exit(1);
  }
  globalThis.__servidor = principal;
}

try {
  const dba = new Database(RUTA_DB);
  const colsCta = dba.pragma("table_info(cuentas)").map((c) => c.name);
  verificar(
    ["clabe", "moneda", "origen", "estatus", "cliente", "fecha_alta", "fecha_baja", "formato_reporte"].every((c) =>
      colsCta.includes(c)
    ),
    "migración repuso las 8 columnas del catálogo maestro en cuentas"
  );
  verificar(dba.pragma("table_info(altas_bancarias)").some((c) => c.name === "clabe"), "migración repuso altas_bancarias.clabe");
  for (const t of ["bancos_spei", "cuentas_credenciales", "credenciales_accesos", "altas_portales"]) {
    const tabla = dba.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
    verificar(!!tabla, `migración creó ${t}`);
  }
  const nBancos = dba.prepare("SELECT COUNT(*) AS n FROM bancos_spei").get().n;
  verificar(nBancos === 92, `semilla SPEI siembra 92 bancos (${nBancos})`);
  const b655 = dba.prepare("SELECT nombre_corto FROM bancos_spei WHERE clave='655'").get();
  verificar(b655 && b655.nombre_corto === "SOFIEXPRESS", "catálogo corregido: 655 = SOFIEXPRESS");
  dba.close();

  const login = async (u, p) => {
    const r = await api("/auth/login", { method: "POST", body: { username: u, password: p } });
    verificar(r.status === 200, `login ${u}`);
    return r.cuerpo.token;
  };
  const tAdmin = await login("admin", "admin");
  const tAdminT = await login("admin_tesoreria", "admin_tesoreria");
  const tAltas = await login("altas", "altas");
  const tTes = await login("tesoreria", "tesoreria");
  const tOp = await login("operador", "operador");

  // --- Catálogo SPEI.
  const bancos = await api("/bancos", { token: tAltas });
  verificar(bancos.status === 200 && bancos.cuerpo.bancos.length === 92, "GET /bancos devuelve el catálogo completo");
  const stp = bancos.cuerpo.bancos.find((b) => b.clave === "646");
  verificar(stp && stp.nombre_corto === "STP", "catálogo incluye 646 STP");
  const jpm = bancos.cuerpo.bancos.find((b) => b.clave === "640");
  verificar(jpm && jpm.nombre_corto === "CB JPMORGAN" && jpm.nombre_completo.startsWith("J.P. Morgan"), "catálogo corregido: 640 CB JPMORGAN con nombre completo íntegro");

  // --- Validador/derivador de CLABE (regla por banco, Santander especial).
  const vBno = await api("/clabe/validar", { method: "POST", token: tAltas, body: { clabe: `ab ${CLABE_BNO} cd` } });
  verificar(vBno.status === 200 && vBno.cuerpo.ok, "CLABE con basura se normaliza a sólo dígitos");
  verificar(vBno.cuerpo.banco && vBno.cuerpo.banco.nombre === "BANORTE", "prefijo 072 → BANORTE");
  verificar(vBno.cuerpo.cuenta === "0491234567", "Banorte deriva cuenta = dígitos 8-17 (0491234567)");
  const vSan = await api("/clabe/validar", { method: "POST", token: tAltas, body: { clabe: CLABE_SAN } });
  verificar(vSan.cuerpo.banco && vSan.cuerpo.banco.nombre === "SANTANDER" && vSan.cuerpo.cuenta === "00491234567", "Santander deriva cuenta = dígitos 7-17, 11 dígitos");
  const vBbva = await api("/clabe/validar", { method: "POST", token: tAltas, body: { clabe: CLABE_BBVA } });
  verificar(vBbva.cuerpo.banco && vBbva.cuerpo.banco.nombre === "BBVA BANCOMER" && vBbva.cuerpo.cuenta === "0491234567", "BBVA resuelve del catálogo local (sin vínculo externo)");
  const v999 = await api("/clabe/validar", { method: "POST", token: tAltas, body: { clabe: CLABE_999 } });
  verificar(v999.cuerpo.banco === null && !v999.cuerpo.ok && v999.cuerpo.errores.some((e) => e.includes("999")), "prefijo 999 → banco nulo y error");
  const vCorto = await api("/clabe/validar", { method: "POST", token: tAltas, body: { clabe: "072123" } });
  verificar(!vCorto.cuerpo.ok && vCorto.cuerpo.errores.some((e) => e.includes("18")), "CLABE corta → error de 18 dígitos");
  const vAlta = await api("/clabe/validar", { method: "POST", token: tOp, body: { clabe: CLABE_BNO } });
  verificar(vAlta.status === 200, "el ejecutivo también puede validar CLABEs (sólo lectura)");

  // --- La cuenta nace con CLABE: banco y número auto.
  const ctaAlta = await api("/cuentas", {
    method: "POST",
    token: tAdminT,
    body: { nombre: "CTA CON CLABE", clabe: CLABE_BNO, saldo_inicial: 0 },
  });
  verificar(ctaAlta.status === 201, "POST /cuentas con CLABE (status " + ctaAlta.status + ")");
  verificar(ctaAlta.cuerpo.cuenta?.banco === "BANORTE", "banco auto-llenado desde el catálogo");
  verificar(ctaAlta.cuerpo.cuenta?.numero_cuenta === "0491234567", "número de cuenta derivado");
  verificar(ctaAlta.cuerpo.cuenta?.clabe === CLABE_BNO, "CLABE guardada completa");
  const ctaMala = await api("/cuentas", {
    method: "POST",
    token: tAdminT,
    body: { nombre: "CTA MALA", banco: "BBVA BANCOMER", clabe: CLABE_BNO },
  });
  verificar(ctaMala.status === 400, "banco declarado ≠ banco de la CLABE → 400");

  // --- Portales (pagadoras) donde se registrarán las altas.
  const portalA = await api("/cuentas", { method: "POST", token: tAdminT, body: { nombre: "PAGADORA ALPHA", banco: "STP" } });
  const portalB = await api("/cuentas", { method: "POST", token: tAdminT, body: { nombre: "PAGADORA BETA", banco: "STP" } });
  verificar(portalA.status === 201 && portalB.status === 201, "2 portales (pagadoras) creados");
  const idA = portalA.cuerpo.cuenta.id;
  const idB = portalB.cuerpo.cuenta.id;
  const portales = await api("/cuentas/portales", { token: tAltas });
  verificar(portales.cuerpo.portales.some((p) => p.id === idA) && portales.cuerpo.portales.some((p) => p.id === idB), "el rol altas lista portales activos");

  // --- Captura por lotes (formato ALTA CUENTA).
  const loteOp = await api("/altas-bancarias/lote", {
    method: "POST",
    token: tOp,
    body: { lineas: [{ paterno: "GARCIA", nombre: "MARIA", clabe: CLABE_BNO }], portales: [idA] },
  });
  verificar(loteOp.status === 403, "el ejecutivo NO captura por lotes (403; la solicita por operación)");
  const lote = await api("/altas-bancarias/lote", {
    method: "POST",
    token: tAltas,
    body: {
      lineas: [
        { paterno: "GARCÍA", materno: "ÑÁÑEZ", nombre: "María José", clabe: `clabe-${CLABE_BNO}` },
        { paterno: "Santana", materno: "", nombre: "Pedro", clabe: CLABE_SAN },
        { paterno: "SIN", materno: "CLABE", nombre: "VALIDA", clabe: "072-123" },
        { paterno: "BANCO", materno: "RARO", nombre: "SIN PORTAL", clabe: CLABE_999 },
      ],
      portales: [idA, idB],
    },
  });
  verificar(lote.status === 201, `lote aceptado (status ${lote.status})`);
  verificar(lote.cuerpo.creadas.length === 2, "2 líneas creadas");
  verificar(
    lote.cuerpo.creadas[0].beneficiario === "GARCIA NANEZ MARIA JOSE",
    `nombre normalizado sin acentos/Ñ (${lote.cuerpo.creadas[0]?.beneficiario})`
  );
  verificar(lote.cuerpo.creadas[1].beneficiario === "SANTANA PEDRO", "materno vacío se omite en el concatenado");
  verificar(lote.cuerpo.creadas[0].cuenta === "0491234567" && lote.cuerpo.creadas[1].cuenta === "00491234567", "cuenta derivada por línea con la regla de su banco");
  verificar(lote.cuerpo.errores.length === 2, "2 líneas con error reportadas sin bloquear al resto");
  verificar(
    lote.cuerpo.errores.some((e) => e.errores.some((m) => m.includes("18"))) &&
      lote.cuerpo.errores.some((e) => e.errores.some((m) => m.includes("999"))),
    "errores: CLABE corta y banco no reconocido"
  );
  const idAlta1 = lote.cuerpo.creadas[0].alta_id;
  const idAlta2 = lote.cuerpo.creadas[1].alta_id;

  // Reenvío del mismo lote → duplicadas (no se duplican altas).
  const loteDup = await api("/altas-bancarias/lote", {
    method: "POST",
    token: tAltas,
    body: {
      lineas: [
        { paterno: "GARCIA", materno: "NANEZ", nombre: "MARIA JOSE", clabe: CLABE_BNO },
        { paterno: "SANTANA", nombre: "PEDRO", clabe: CLABE_SAN },
      ],
      portales: [idA],
    },
  });
  verificar(loteDup.cuerpo.duplicadas.length === 2, "reenvío detecta 2 duplicadas (dedupe por banco+cuenta)");

  // --- Matriz alta × portal.
  const portalesAlta1 = await api(`/altas-bancarias/${idAlta1}/portales`, { token: tAltas });
  verificar(portalesAlta1.cuerpo.portales.length === 2 && portalesAlta1.cuerpo.portales.every((p) => p.estado === "pendiente"), "alta 1 ligada a 2 portales pendientes");
  const filaA = portalesAlta1.cuerpo.portales.find((p) => p.portal_cuenta_id === idA);
  const filaB = portalesAlta1.cuerpo.portales.find((p) => p.portal_cuenta_id === idB);
  const alta1 = await api("/altas-bancarias", { token: tAltas, });
  const enCola = alta1.cuerpo.altas.find((a) => a.id === idAlta1);
  verificar(enCola && enCola.estado === "solicitada", "las altas del lote entran a la cola como solicitada");

  const Estado = (p) => api(`/altas-portales/${p}/estado`, { method: "POST", token: tAltas, body: { estado: "dada_de_alta" } });
  const paso1 = await Estado(filaA.id);
  verificar(paso1.status === 200 && paso1.cuerpo.alta.estado === "solicitada", "1er portal dado de alta → la alta AÚN no está registrada");
  const paso2 = await Estado(filaB.id);
  verificar(paso2.cuerpo.alta.estado === "registrada", "2º portal dado de alta → la alta queda REGISTRADA");
  const rechazo = await api(`/altas-portales/${filaA.id}/estado`, {
    method: "POST",
    token: tAltas,
    body: { estado: "rechazada", motivo: "Nombre no coincide con el portal" },
  });
  verificar(rechazo.cuerpo.alta.estado === "solicitada", "un rechazo regresa la alta a la cola (Tesorería no dispersa)");
  const rechazoSinMotivo = await api(`/altas-portales/${filaB.id}/estado`, { method: "POST", token: tAltas, body: { estado: "rechazada" } });
  verificar(rechazoSinMotivo.status === 400, "rechazar sin motivo → 400");
  const fuera = await api(`/altas-portales/${filaA.id}/estado`, { method: "POST", token: tOp, body: { estado: "dada_de_alta" } });
  verificar(fuera.status === 403, "sólo Altas/Tesorería marca estados de portal (403)");
  const corregir = await Estado(filaA.id);
  verificar(corregir.cuerpo.alta.estado === "registrada", "corregido el rechazo → registrada de nuevo");

  // Quitar y re-agregar un portal (corrección de captura).
  const quita = await api(`/altas-portales/${filaB.id}`, { method: "DELETE", token: tAltas });
  verificar(quita.status === 200 && quita.cuerpo.alta.estado === "registrada", "quitar un portal ya dado de alta mantiene la alta registrada");
  const reAgrega = await api(`/altas-bancarias/${idAlta1}/portales`, { method: "POST", token: tAltas, body: { portal_cuenta_id: idB } });
  verificar(reAgrega.status === 201 && reAgrega.cuerpo.alta.estado === "solicitada", "re-agregar un portal pendiente regresa la alta a solicitada");
  const regresa = await Estado(reAgrega.cuerpo.portal.id);
  verificar(regresa.cuerpo.alta.estado === "registrada", "y al completarlo vuelve a registrada");
  await Estado(reAgrega.cuerpo.portal.id);
  const filasPortalB = await api(`/altas-portales?portal_cuenta_id=${idB}`, { token: tAltas });
  verificar(
    filasPortalB.cuerpo.filas.some((f) => f.alta_id === idAlta1 && f.estado_portal === "dada_de_alta"),
    "GET /altas-portales lista las filas del portal con su estado (teclee en el portal)"
  );
  const filasPortalOp = await api(`/altas-portales?portal_cuenta_id=${idB}`, { token: tOp });
  verificar(filasPortalOp.status === 403, "el ejecutivo no consulta filas de portal (403)");

  // --- Bóveda de credenciales (multi-usuario, cifrada, auditada).
  const cred = await api(`/cuentas/${idA}/credenciales`, {
    method: "POST",
    token: tAdminT,
    body: {
      tipo: "portal",
      etiqueta: "ADMIN1",
      usuario: "USUARIO_PORTAL_1",
      secreto: "S3cret0-Portal",
      nip: "4321",
      clave_seguridad: "CS-987",
      token_numero: "TOK-7",
      telefono: "55-0000-0000",
      correo: "acceso@pagadora.test",
      vigencia: "2026-12-31",
    },
  });
  verificar(cred.status === 201, "credencial creada en la bóveda");
  verificar(cred.cuerpo.credencial.usuario === "USUARIO_PORTAL_1" && !("secreto" in cred.cuerpo.credencial), "el usuario sale; el secreto NUNCA");
  const credId = cred.cuerpo.credencial.id;
  const lista = await api(`/cuentas/${idA}/credenciales`, { token: tTes });
  verificar(lista.status === 403, "tesorería NO asignada a la cuenta no ve la bóveda (403)");
  const listaAdmin = await api(`/cuentas/${idA}/credenciales`, { token: tAdminT });
  verificar(listaAdmin.cuerpo.credenciales.length === 1 && listaAdmin.cuerpo.credenciales[0].tiene_secreto === true, "admin_tesorería ve la credencial con banderas (sin valor)");
  const crudo = secretoEnBD(RUTA_DB, credId);
  verificar(!crudo.includes("S3cret0-Portal"), "en BD el secreto está CIFRADO (no aparece el plano)");
  const revela = await api(`/credenciales/${credId}/secreto?campo=secreto`, { token: tAdminT });
  verificar(revela.cuerpo.valor === "S3cret0-Portal", "revelar secreto devuelve el valor descifrado");
  const revelaAltas = await api(`/credenciales/${credId}/secreto?campo=secreto`, { token: tAltas });
  verificar(revelaAltas.status === 403, "el rol altas NO revela secretos (403)");
  const nip = await api(`/credenciales/${credId}`, { method: "PATCH", token: tAdminT, body: { nip: "5678", notas: "rotación trimestral" } });
  verificar(nip.status === 200, "PATCH de credencial (rotación de nip)");
  const nipPlano = await api(`/credenciales/${credId}/secreto?campo=nip`, { token: tAdminT });
  verificar(nipPlano.cuerpo.valor === "5678", "el nip rotado se descifra bien");
  const accesos = await api(`/cuentas/${idA}/credenciales/accesos`, { token: tAdminT });
  const acciones = (accesos.cuerpo.accesos ?? []).map((a) => a.accion);
  verificar(acciones.includes("crear") && acciones.includes("ver"), `auditoría de la bóveda registra crear y ver (${[...new Set(acciones)].join(",")})`);

  // --- Importador del catálogo de cuentas con dedupe.
  const imp = await api("/cuentas/importar-lote", {
    method: "POST",
    token: tAdminT,
    body: {
      lineas: [
        `ORION JS 0902\tBANORTE\t\t${CLABE_IMP}\t\tJS\tACTIVA\tCLIENTE IMPORT`,
        `ORION JS 0902\t\t\t${CLABE_IMP}\t\tJS MTY\tACTIVA\tCLIENTE IMPORT`,
        `CUENTA MALA\tBANORTE\t\t07212345\t\tJS\tACTIVA`,
        `\t\t\t\t\t\t\t`,
      ],
    },
  });
  verificar(imp.status === 201, "importador responde");
  verificar(imp.cuerpo.creadas.length === 1 && imp.cuerpo.creadas[0] === "ORION JS 0902", "1 cuenta creada");
  verificar(imp.cuerpo.actualizadas.length === 1, "reenvío con misma CLABE actualiza (no duplica)");
  verificar(imp.cuerpo.errores.length === 2, "líneas con CLABE corta o vacía reportadas");
  const importada = await api("/cuentas", { token: tAdminT });
  const orion = importada.cuerpo.cuentas.find((c) => c.nombre === "ORION JS 0902");
  if (process.env.DEBUG15) console.log("ORION:", JSON.stringify(orion));
  verificar(orion && orion.origen === "JS MTY" && orion.clabe === CLABE_IMP && orion.numero_cuenta === "0492345678", "la importada quedó con origen JS MTY, CLABE y cuenta derivada");
  const impOp = await api("/cuentas/importar-lote", { method: "POST", token: tOp, body: { lineas: ["X\t\t\t\t\t\t"] } });
  verificar(impOp.status === 403, "sólo admin_tesorería/admin importa el catálogo (403)");
} finally {
  try {
    globalThis.__servidor.matar();
  } catch {}
  await esperar(500);
  try {
    rmSync(BASE, { recursive: true, force: true });
  } catch {}
}

console.log(fallos === 0 ? "\nSMOKE FASE 15: TODO OK" : `\nSMOKE FASE 15: ${fallos} FALLO(S)`);
process.exit(fallos === 0 ? 0 : 1);

// --- utilidad: lee el secreto crudo (cifrado) directamente de la BD
function secretoEnBD(ruta, credId) {
  const D = require("better-sqlite3");
  const d = new D(ruta, { readonly: true });
  const fila = d.prepare("SELECT secreto, nip FROM cuentas_credenciales WHERE id = ?").get(credId);
  d.close();
  return `${fila?.secreto ?? ""}|${fila?.nip ?? ""}`;
}
