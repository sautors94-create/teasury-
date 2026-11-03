/**
 * Smoke E2E Fase 14:
 * 1) BD previa (fase 13) sin las novedades de Fase 14 (sin las 5 columnas de
 *    dispersiones, sin comisiones de cliente, sin tipo pago_especial, sin
 *    pagos_especiales) → al arrancar, la migración debe reponerlas.
 * 2) Flujo por API: captura con campos nuevos (y sin ellos) → comisiones
 *    preestablecidas por cliente → resguardo TRF manejado por el ejecutivo →
 *    pago especial completo hasta PAGADA con descuento del resguardo.
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const REPO = "/home/z/my-project/treasury-repo";
const require = createRequire(join(REPO, "package.json"));
const Database = require("better-sqlite3");

const BASE = join(tmpdir(), `tesoreria-smoke14-${Date.now()}`);
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
      appendFileSync("/tmp/smoke14-server.log", d.toString());
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

// --- Paso 1: BD con datos y "reversa" de las novedades de Fase 14.
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
    ALTER TABLE dispersiones DROP COLUMN nombre;
    ALTER TABLE dispersiones DROP COLUMN apellido_paterno;
    ALTER TABLE dispersiones DROP COLUMN apellido_materno;
    ALTER TABLE dispersiones DROP COLUMN concepto;
    ALTER TABLE dispersiones DROP COLUMN referencia_pago;
    ALTER TABLE clientes DROP COLUMN comision_broker_pct;
    ALTER TABLE clientes DROP COLUMN comision_trf_pct;
    DROP TABLE IF EXISTS pagos_especiales;
  `);
  // Revertir el CHECK de operaciones quitando pago_especial (reconstrucción).
  dba.exec(`
    ALTER TABLE operaciones RENAME TO op_vieja;
    CREATE TABLE operaciones (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      folio           TEXT NOT NULL UNIQUE,
      tipo            TEXT NOT NULL CHECK (tipo IN ('pago','cobro','financiamiento','flujo')),
      concepto        TEXT NOT NULL,
      proveedor       TEXT NOT NULL,
      monto           REAL NOT NULL CHECK (monto > 0),
      moneda          TEXT NOT NULL DEFAULT 'MXN',
      fecha_operacion TEXT NOT NULL,
      estado          TEXT NOT NULL DEFAULT 'borrador'
                      CHECK (estado IN ('borrador','en_validacion','observada','pendiente_direccion','aprobada','en_pago','pagada','cancelada')),
      cliente_id      INTEGER REFERENCES clientes(id),
      pagador         TEXT NOT NULL DEFAULT '',
      tipo_operacion  TEXT NOT NULL DEFAULT '',
      timbrar         INTEGER NOT NULL DEFAULT 0,
      comision_pct    REAL NOT NULL DEFAULT 0,
      observaciones   TEXT NOT NULL DEFAULT '',
      creado_por      INTEGER NOT NULL REFERENCES usuarios(id),
      creado_en       TEXT NOT NULL DEFAULT (datetime('now')),
      actualizado_en  TEXT NOT NULL DEFAULT (datetime('now')),
      liberada_por    INTEGER REFERENCES usuarios(id),
      liberada_en     TEXT
    );
    INSERT INTO operaciones (id, folio, tipo, concepto, proveedor, monto, moneda, fecha_operacion, estado, cliente_id, pagador, tipo_operacion, timbrar, comision_pct, observaciones, creado_por, creado_en, actualizado_en, liberada_por, liberada_en)
      SELECT id, folio, tipo, concepto, proveedor, monto, moneda, fecha_operacion, estado, cliente_id, pagador, tipo_operacion, timbrar, comision_pct, observaciones, creado_por, creado_en, actualizado_en, liberada_por, liberada_en FROM op_vieja;
    DROP TABLE op_vieja;
  `);
  dba.pragma("legacy_alter_table = OFF");
  dba.close();
  console.log("[smoke] BD con novedades de Fase 14 RETIRADAS (simula BD previa)");
}

// --- Paso 2: arrancar de nuevo → la migración debe reponer todo.
const backend = arrancar();
{
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
}

try {
  const dba = new Database(RUTA_DB);
  const colsDisp = dba.pragma("table_info(dispersiones)").map((c) => c.name);
  verificar(
    ["nombre", "apellido_paterno", "apellido_materno", "concepto", "referencia_pago"].every((c) => colsDisp.includes(c)),
    "migración repuso las 5 columnas nuevas de dispersiones"
  );
  const colsCli = dba.pragma("table_info(clientes)").map((c) => c.name);
  verificar(
    colsCli.includes("comision_broker_pct") && colsCli.includes("comision_trf_pct"),
    "migración repuso las comisiones de cliente"
  );
  const sqlOp = dba.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='operaciones'").get();
  verificar(sqlOp.sql.includes("'pago_especial'"), "migración reconstruyó operaciones con tipo pago_especial");
  const tablaPE = dba.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pagos_especiales'").get();
  verificar(!!tablaPE, "migración creó pagos_especiales");
  dba.close();

  const login = async (u, p) => {
    const r = await api("/auth/login", { method: "POST", body: { username: u, password: p } });
    verificar(r.status === 200, `login ${u}`);
    return r.cuerpo.token;
  };
  const tOp = await login("operador", "operador");
  const tAdminOps = await login("admin_ops", "admin_ops");
  const tAdminT = await login("admin_tesoreria", "admin_tesoreria");

  // --- Captura con los campos nuevos de la dispersión (y sin ellos).
  const hoy = new Date().toISOString().slice(0, 10);
  const capt1 = await api("/operaciones", {
    method: "POST",
    token: tOp,
    body: {
      tipo: "flujo",
      concepto: "Fase 14: flujo con beneficiario persona",
      monto: 20000,
      fecha_operacion: hoy,
      timbrar: false,
      comision_pct: 2.5,
      destinos: [{ tipo: "flujo" }],
      dispersiones: [
        {
          beneficiario: "JUAN PEREZ GARCIA",
          nombre: "JUAN",
          apellido_paterno: "PEREZ",
          apellido_materno: "GARCIA",
          concepto: "PAGO DE HONORARIOS",
          referencia_pago: "REF-SM14",
          importe: 20000,
        },
      ],
    },
  });
  verificar(capt1.status === 201, `captura con nombre/apellidos/concepto/referencia de pago (status ${capt1.status}) ${capt1.status !== 201 ? JSON.stringify(capt1.cuerpo).slice(0, 300) : ""}`);
  const det1 = await api(`/operaciones/${capt1.cuerpo.operacion.id}`, { token: tOp });
  verificar(det1.cuerpo.dispersiones[0].nombre === "JUAN", "el detalle devuelve los campos nuevos");

  const capt2 = await api("/operaciones", {
    method: "POST",
    token: tOp,
    body: {
      tipo: "flujo",
      concepto: "Fase 14: flujo sin campos nuevos",
      monto: 15000,
      fecha_operacion: hoy,
      timbrar: false,
      comision_pct: 2.5,
      destinos: [{ tipo: "flujo" }],
      dispersiones: [{ beneficiario: "PROVEEDOR SIN DATOS", importe: 15000 }],
    },
  });
  verificar(capt2.status === 201, "captura SIN los campos nuevos (ninguno es obligatorio)");

  // --- Comisiones preestablecidas por cliente.
  const cli = await api("/clientes", { method: "POST", token: tAdminOps, body: { nombre: "CLIENTE SM14" } });
  verificar(cli.status === 201, "cliente de prueba creado");
  const ejs = await api("/usuarios/ejecutivos", { token: tAdminOps });
  const operador = (ejs.cuerpo.ejecutivos ?? []).find((u) => u.username === "operador");
  const asig = await api(`/clientes/${cli.cuerpo.cliente.id}/asignaciones`, {
    method: "POST",
    token: tAdminOps,
    body: { ejecutivo_id: operador.id, motivo: "smoke 14" },
  });
  verificar(asig.status === 201, "cliente asignado al ejecutivo");
  const comis = await api(`/clientes/${cli.cuerpo.cliente.id}/comisiones`, {
    method: "PATCH",
    token: tAdminOps,
    body: { comision_broker_pct: 2.5, comision_trf_pct: 0.5 },
  });
  verificar(comis.status === 200 && comis.cuerpo.cliente.comision_trf_pct === 0.5, "admin_ops fija comisiones broker 2.5% / TRF 0.5%");
  const comisOp = await api(`/clientes/${cli.cuerpo.cliente.id}/comisiones`, {
    method: "PATCH",
    token: tOp,
    body: { comision_broker_pct: 9 },
  });
  verificar(comisOp.status === 403, "el ejecutivo NO puede fijar comisiones (403)");

  const cat = await api("/cuentas/catalogo", { token: tOp });
  const flujo02 = cat.cuerpo.cuentas.find((c) => c.nombre === "FLUJOS 02");
  const flujo01 = cat.cuerpo.cuentas.find((c) => c.nombre === "FLUJOS 01");
  const captCli = await api("/operaciones", {
    method: "POST",
    token: tOp,
    body: {
      tipo: "flujo",
      concepto: "Fase 14: con comisiones preestablecidas",
      monto: 40000,
      fecha_operacion: hoy,
      timbrar: false,
      cliente_id: cli.cuerpo.cliente.id,
      respaldo: { depositos: [{ cuenta_id: flujo02.id, monto: 40000, comprobante: "DEP-SM14" }] },
      destinos: [{ tipo: "flujo" }],
      dispersiones: [{ beneficiario: "CON PREESTABLECIDAS", importe: 40000 }],
    },
  });
  verificar(captCli.status === 201, "captura para el cliente SIN enviar comisiones");
  verificar(captCli.cuerpo.operacion.comision_pct === 2.5, "comision_pct tomada del cliente (2.5%)");
  verificar(captCli.cuerpo.operacion.comision_trf_pct === 0.5, "comision_trf_pct tomada del cliente (0.5%)");
  verificar(captCli.cuerpo.calculos.comision_trf === 200, "calculos.comision_trf = 200 (0.5% de 40000)");

  // --- Resguardo TRF: lo maneja el ejecutivo; tesorería ya no registra.
  const trfTes = await api("/trf/resguardo", { method: "POST", token: tAdminT, body: { tipo: "ingreso", importe: 10 } });
  verificar(trfTes.status === 403, "Tesorería ya NO registra en el resguardo TRF (403)");
  const retiroOp = await api("/trf/resguardo", { method: "POST", token: tOp, body: { tipo: "retiro", importe: 5 } });
  verificar(retiroOp.status === 403, "el ejecutivo NO retira manualmente: va por pago especial (403)");
  const ingreso = await api("/trf/resguardo", { method: "POST", token: tOp, body: { tipo: "ingreso", importe: 3000, notas: "comisiones de la casa" } });
  verificar(ingreso.status === 201, "el ejecutivo registra ingreso en el resguardo TRF");
  const lecturaOp = await api("/trf/resguardo", { token: tOp });
  verificar(lecturaOp.status === 200 && lecturaOp.cuerpo.saldos.some((s) => s.moneda === "MXN" && s.saldo === 3000), "el ejecutivo consulta el resguardo TRF (saldo 3000 MXN)");

  // --- Pago especial: sin depósito → 409; con depósito → flujo completo.
  const peSin = await api("/operaciones", {
    method: "POST",
    token: tOp,
    body: {
      tipo: "pago_especial",
      concepto: "Pago SAT sin fondo",
      monto: 9000,
      fecha_operacion: hoy,
      pagadora_cuenta_id: flujo01.id,
      origen: { tipo: "trf" },
      formato: { nombre: "sat.pdf", mime: "application/pdf", contenido: "data:application/pdf;base64,JVBERi0xLjQK" },
    },
  });
  verificar(peSin.status === 409, "pago especial sin depósito suficiente → 409");

  const pe = await api("/operaciones", {
    method: "POST",
    token: tOp,
    body: {
      tipo: "pago_especial",
      concepto: "Pago de impuestos SAT",
      monto: 2500,
      fecha_operacion: hoy,
      pagadora_cuenta_id: flujo01.id,
      origen: { tipo: "trf" },
      formato: { nombre: "formato-sat.pdf", mime: "application/pdf", contenido: "data:application/pdf;base64,JVBERi0xLjQK" },
    },
  });
  verificar(pe.status === 201 && pe.cuerpo.operacion.tipo === "pago_especial", "pago especial capturado (2500 MXN, origen TRF, formato adjunto)");
  const peId = pe.cuerpo.operacion.id;

  const tAdmin = await login("admin", "admin");
  const filtroPE = await api("/operaciones?tipo=pago_especial", { token: tAdmin });
  verificar(filtroPE.status === 200 && filtroPE.cuerpo.operaciones.some((o) => o.id === peId), "el listado filtra por tipo pago_especial");

  const formato = await api(`/operaciones/${peId}/pago-especial/formato`, { token: tOp });
  verificar(formato.status === 200 && formato.cuerpo.nombre === "formato-sat.pdf", "el formato adjunto se descarga por su endpoint");

  const tv = await login("validador", "validador");
  const tf = await login("fondeador", "fondeador");
  const tt = await login("tesoreria", "tesoreria");
  const ev = await api(`/operaciones/${peId}/enviar-validacion`, { method: "POST", token: tOp });
  verificar(ev.status === 200, "pago especial enviado a validación");
  const rev = await api(`/operaciones/${peId}/revision`, { method: "POST", token: tv, body: { resultado: "aprobada", comentario: "OK SM14" } });
  verificar(rev.status === 200, "validador aprueba el pago especial");
  const lib = await api(`/operaciones/${peId}/liberar`, { method: "POST", token: tf });
  verificar(lib.status === 200, "fondeador libera el pago especial");
  const pago = await api(`/operaciones/${peId}/pago`, {
    method: "POST",
    token: tt,
    body: { medio: "transferencia", monto: 2500, comprobante: "TRF14-SM", fecha_pago: hoy },
  });
  verificar(pago.status === 200 || pago.status === 201, "tesorería paga el pago especial");
  verificar(pago.cuerpo?.operacion?.estado === "pagada", "pago especial PAGADA");

  const resg = await api("/trf/resguardo", { token: tAdminT });
  const mxn = resg.cuerpo.saldos.find((s) => s.moneda === "MXN");
  verificar(mxn?.saldo === 500, "resguardo TRF descontado al pagarse (3000 − 2500 = 500)");
  const detPE = await api(`/operaciones/${peId}`, { token: tOp });
  verificar(detPE.cuerpo.pago_especial?.resguardo_origen === "trf", "el detalle muestra el pago especial con su origen");

  // --- Comisión TRF directa al pagarse una operación flujo (MXN).
  const opTrf = await api("/operaciones", {
    method: "POST",
    token: tOp,
    body: {
      tipo: "flujo",
      concepto: "Fase 14: comisión TRF directa",
      monto: 100000,
      fecha_operacion: hoy,
      timbrar: false,
      comision_pct: 2,
      comision_trf_pct: 0.5,
      destinos: [{ tipo: "flujo" }],
      dispersiones: [{ beneficiario: "COMISION TRF", importe: 100000 }],
    },
  });
  verificar(opTrf.status === 201, "flujo con comision_trf_pct 0.5% capturado");
  await api(`/operaciones/${opTrf.cuerpo.operacion.id}/enviar-validacion`, { method: "POST", token: tOp });
  await api(`/operaciones/${opTrf.cuerpo.operacion.id}/revision`, { method: "POST", token: tv, body: { resultado: "aprobada", comentario: "OK SM14 comisión TRF" } });
  await api(`/operaciones/${opTrf.cuerpo.operacion.id}/liberar`, { method: "POST", token: tf });
  const pagoTrf = await api(`/operaciones/${opTrf.cuerpo.operacion.id}/pago`, {
    method: "POST",
    token: tt,
    body: { medio: "transferencia", monto: 100000, comprobante: "TRF14-COM", fecha_pago: hoy },
  });
  verificar(pagoTrf.cuerpo?.operacion?.estado === "pagada", "flujo con comisión TRF pagado");
  const resg2 = await api("/trf/resguardo", { token: tOp });
  const mxn2 = resg2.cuerpo.saldos.find((s) => s.moneda === "MXN");
  verificar(mxn2?.saldo === 1000, "comisión TRF ingresada directa al resguardo (500 + 500 = 1000)");

  // --- Bitácora.
  const aud = await api("/auditoria", { token: tAdmin });
  const acciones = aud.cuerpo.eventos.map((e) => e.accion);
  verificar(acciones.includes("comisiones_cliente"), "bitácora: comisiones_cliente registrada");
  verificar(acciones.includes("pago_especial_resguardo"), "bitácora: pago_especial_resguardo registrada");
  verificar(acciones.includes("trf_resguardo"), "bitácora: trf_resguardo registrada");
} catch (err) {
  fallos++;
  console.log(`FALLO excepción: ${err.message}`);
}

backend.matar();
await esperar(400);
rmSync(BASE, { recursive: true, force: true });
console.log(fallos === 0 ? "\nSMOKE FASE 14: TODO OK" : `\nSMOKE FASE 14: ${fallos} FALLO(S)`);
process.exit(fallos === 0 ? 0 : 1);
