import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Database } from "better-sqlite3";
import { crearApp } from "../src/app.js";
import { abrirBase } from "../src/db.js";

/**
 * Fase 14 (con el ajuste del negocio sobre el resguardo de TRF):
 *   · Captura/layout: NOMBRE, APELLIDO PATERNO, APELLIDO MATERNO, CONCEPTO y
 *     REFERENCIA PAGO — TODOS OPCIONALES (con o sin ellos la captura pasa, en
 *     manual o por layout/API).
 *   · Comisiones preestablecidas por cliente (las fija admin_operaciones): la
 *     de broker rellena la comisión al capturar sin enviarla; la de TRF viaja
 *     con la operación e ingresa DIRECTO al resguardo de TRF AL AUTORIZARSE (MXN).
 *   · PAGOS ESPECIALES: el ejecutivo adjunta el formato (p.ej. SAT), captura
 *     importe/pagadora/descripción; el resguardo de origen (TRF o broker) debe
 *     tener depósito suficiente. El de TRF se descuenta AL AUTORIZARSE (con
 *     reversa si se cancela); el del broker se descuenta al PAGARSE.
 *   · Resguardo de TRF: NO visible ni para operadores — se modifica sólo con
 *     operaciones; movimientos manuales sólo del admin; Tesorería sólo lee.
 */
let db: Database;
let app: ReturnType<typeof crearApp>;

async function login(username: string, password: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ username, password });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const hoy = (): string => new Date().toISOString().slice(0, 10);

interface CuentaCat {
  id: number;
  nombre: string;
  tipo: string;
}

async function cuentaPorNombre(token: string, nombre: string): Promise<CuentaCat> {
  const res = await request(app).get("/api/cuentas/catalogo").set(auth(token));
  expect(res.status).toBe(200);
  const c = (res.body.cuentas as CuentaCat[]).find((x) => x.nombre === nombre);
  expect(c, `la cuenta '${nombre}' debe existir en el catálogo sembrado`).toBeTruthy();
  return c as CuentaCat;
}

/** Cliente de prueba asignado al operador (se crea vía API de admin_ops). */
async function crearClienteConEjecutivo(tAdminOps: string): Promise<number> {
  const res = await request(app)
    .post("/api/clientes")
    .set(auth(tAdminOps))
    .send({ nombre: "CLIENTE FASE 14", rfc: "XAXX010101000" });
  expect(res.status).toBe(201);
  const clienteId = res.body.cliente.id as number;
  const ejecutivos = await request(app).get("/api/usuarios/ejecutivos").set(auth(tAdminOps));
  expect(ejecutivos.status).toBe(200);
  const operador = (ejecutivos.body.ejecutivos as Array<{ id: number; username: string }>).find(
    (u) => u.username === "operador"
  );
  expect(operador).toBeTruthy();
  const asig = await request(app)
    .post(`/api/clientes/${clienteId}/asignaciones`)
    .set(auth(tAdminOps))
    .send({ ejecutivo_id: operador!.id, motivo: "pruebas fase 14" });
  expect(asig.status).toBe(201);
  return clienteId;
}

/** Captura formato FLUJO con una sola dispersión (sin datos bancarios → no exige altas). */
async function capturarFlujo(
  token: string,
  opciones: {
    monto?: number;
    concepto?: string;
    comision_pct?: number;
    comision_trf_pct?: number;
    cliente_id?: number;
    conCamposNuevos?: boolean;
    deposito?: { cuenta_id: number; monto: number; comprobante: string };
  } = {}
) {
  const monto = opciones.monto ?? 60000;
  return request(app)
    .post("/api/operaciones")
    .set(auth(token))
    .send({
      tipo: "flujo",
      concepto: opciones.concepto ?? "Operación Fase 14",
      monto,
      fecha_operacion: hoy(),
      timbrar: false,
      ...(opciones.comision_pct !== undefined ? { comision_pct: opciones.comision_pct } : {}),
      ...(opciones.comision_trf_pct !== undefined ? { comision_trf_pct: opciones.comision_trf_pct } : {}),
      ...(opciones.cliente_id ? { cliente_id: opciones.cliente_id } : {}),
      ...(opciones.deposito
        ? { respaldo: { depositos: [opciones.deposito] } }
        : {}),
      destinos: [{ tipo: "flujo" }],
      dispersiones: [
        {
          beneficiario: opciones.concepto ?? "BENEFICIARIO FASE 14",
          ...(opciones.conCamposNuevos
            ? {
                nombre: "JUAN",
                apellido_paterno: "PEREZ",
                apellido_materno: "GARCIA",
                concepto: "PAGO DE HONORARIOS",
                referencia_pago: "REF-88",
              }
            : {}),
          importe: monto,
        },
      ],
    });
}

/** Lleva una operación (cualquier tipo) hasta PAGADA por API. */
async function hastaPagada(
  opId: number,
  tokens: { op: string; validador: string; fondeador: string; tesoreria: string },
  montoPago: number
) {
  const env = await request(app).post(`/api/operaciones/${opId}/enviar-validacion`).set(auth(tokens.op));
  expect(env.status).toBe(200);
  const rev = await request(app)
    .post(`/api/operaciones/${opId}/revision`)
    .set(auth(tokens.validador))
    .send({ resultado: "aprobada", comentario: "OK Fase 14" });
  expect(rev.status).toBe(200);
  const lib = await request(app).post(`/api/operaciones/${opId}/liberar`).set(auth(tokens.fondeador));
  expect(lib.status).toBe(200);
  const pago = await request(app)
    .post(`/api/operaciones/${opId}/pago`)
    .set(auth(tokens.tesoreria))
    .send({ medio: "transferencia", monto: montoPago, comprobante: `TRF14-${opId}`, fecha_pago: hoy() });
  expect(pago.status === 200 || pago.status === 201).toBe(true);
  return pago;
}

beforeEach(() => {
  db = abrirBase(":memory:");
  app = crearApp(db);
});

describe("Campos nuevos de la dispersión: NOMBRE, APELLIDOS, CONCEPTO, REFERENCIA PAGO (opcionales)", () => {
  it("se guardan y se devuelven en el detalle cuando vienen", async () => {
    const tOp = await login("operador", "operador");
    const res = await capturarFlujo(tOp, { conCamposNuevos: true, concepto: "CON BENEFICIARIO PERSONA", comision_pct: 2.5 });
    expect(res.status).toBe(201);
    const det = await request(app).get(`/api/operaciones/${res.body.operacion.id}`).set(auth(tOp));
    expect(det.status).toBe(200);
    const linea = det.body.dispersiones[0];
    expect(linea.nombre).toBe("JUAN");
    expect(linea.apellido_paterno).toBe("PEREZ");
    expect(linea.apellido_materno).toBe("GARCIA");
    expect(linea.concepto).toBe("PAGO DE HONORARIOS");
    expect(linea.referencia_pago).toBe("REF-88");
  });

  it("NINGUNO es obligatorio: la captura sin ellos pasa igual (manual y por API)", async () => {
    const tOp = await login("operador", "operador");
    const res = await capturarFlujo(tOp, { concepto: "SIN CAMPOS NUEVOS", comision_pct: 2.5 });
    expect(res.status).toBe(201);
    const det = await request(app).get(`/api/operaciones/${res.body.operacion.id}`).set(auth(tOp));
    expect(det.body.dispersiones[0].nombre).toBe("");
    expect(det.body.dispersiones[0].referencia_pago).toBe("");

    // Y la edición de dispersiones los conserva (con y sin ellos).
    const put = await request(app)
      .put(`/api/operaciones/${res.body.operacion.id}/dispersiones`)
      .set(auth(tOp))
      .send({
        dispersiones: [
          {
            beneficiario: "EDITADO",
            nombre: "MARIA",
            apellido_paterno: "LOPEZ",
            apellido_materno: "DIAZ",
            concepto: "PAGO DE RENTA",
            referencia_pago: "REF-99",
            importe: 60000,
          },
        ],
      });
    expect(put.status).toBe(200);
    expect(put.body.dispersiones[0].nombre).toBe("MARIA");
    expect(put.body.dispersiones[0].apellido_materno).toBe("DIAZ");
    expect(put.body.dispersiones[0].concepto).toBe("PAGO DE RENTA");
    expect(put.body.dispersiones[0].referencia_pago).toBe("REF-99");
  });
});

describe("Comisiones preestablecidas por cliente (admin_operaciones)", () => {
  it("admin_ops las fija, el ejecutivo captura sin comision_pct y se usan las del cliente", async () => {
    const tAdminOps = await login("admin_ops", "admin_ops");
    const tOp = await login("operador", "operador");
    const clienteId = await crearClienteConEjecutivo(tAdminOps);

    // El ejecutivo no puede fijar comisiones.
    const prohibido = await request(app)
      .patch(`/api/clientes/${clienteId}/comisiones`)
      .set(auth(tOp))
      .send({ comision_broker_pct: 5 });
    expect(prohibido.status).toBe(403);

    const fijar = await request(app)
      .patch(`/api/clientes/${clienteId}/comisiones`)
      .set(auth(tAdminOps))
      .send({ comision_broker_pct: 2.5, comision_trf_pct: 0.5 });
    expect(fijar.status).toBe(200);
    expect(fijar.body.cliente.comision_broker_pct).toBe(2.5);
    expect(fijar.body.cliente.comision_trf_pct).toBe(0.5);

    // Captura SIN comision_pct ni comision_trf_pct: salen del cliente.
    // (El respaldo del flujo se cubre con un depósito indicado.)
    const dep = await cuentaPorNombre(tOp, "FLUJOS 02");
    const res = await capturarFlujo(tOp, {
      cliente_id: clienteId,
      monto: 40000,
      concepto: "CON PREESTABLECIDAS",
      deposito: { cuenta_id: dep.id, monto: 40000, comprobante: "DEP-14" },
    });
    expect(res.status).toBe(201);
    expect(res.body.operacion.comision_pct).toBe(2.5);
    expect(res.body.operacion.comision_trf_pct).toBe(0.5);
    expect(res.body.calculos.comision_total).toBe(1000);
    expect(res.body.calculos.comision_trf).toBe(200);

    // Si el ejecutivo SÍ envía comisiones, mandan sobre las preestablecidas.
    const manual = await capturarFlujo(tOp, {
      cliente_id: clienteId,
      monto: 40000,
      comision_pct: 1,
      comision_trf_pct: 0,
      concepto: "MANUALES",
      deposito: { cuenta_id: dep.id, monto: 80000, comprobante: "DEP-14B" },
    });
    expect(manual.status).toBe(201);
    expect(manual.body.operacion.comision_pct).toBe(1);
    expect(manual.body.operacion.comision_trf_pct).toBe(0);

    // Validación: porcentajes fuera de rango → 400.
    const mala = await request(app)
      .patch(`/api/clientes/${clienteId}/comisiones`)
      .set(auth(tAdminOps))
      .send({ comision_broker_pct: 150 });
    expect(mala.status).toBe(400);
  });

  it("la comisión TRF preestablecida ingresa al resguardo de TRF AL AUTORIZARSE (MXN)", async () => {
    const tAdmin = await login("admin", "admin");
    const tOp = await login("operador", "operador");
    const tValidador = await login("validador", "validador");
    const tFondeador = await login("fondeador", "fondeador");
    const tTes = await login("tesoreria", "tesoreria");

    // Ingreso previo para que el resguardo quede distinguible (sólo admin).
    await request(app)
      .post("/api/trf/resguardo")
      .set(auth(tAdmin))
      .send({ tipo: "ingreso", importe: 1000, notas: "base" });

    const res = await capturarFlujo(tOp, {
      monto: 100000,
      comision_pct: 2,
      comision_trf_pct: 0.5,
      concepto: "CON COMISION TRF",
    });
    expect(res.status).toBe(201);

    // La CAPTURA no toca el resguardo.
    let resg = await request(app).get("/api/trf/resguardo").set(auth(tAdmin));
    let mxn = (resg.body.saldos as Array<{ moneda: string; saldo: number }>).find((s) => s.moneda === "MXN");
    expect(mxn?.saldo).toBe(1000);

    // Autorización (la validación aprueba): AQUÍ ingresa la comisión TRF.
    const env = await request(app).post(`/api/operaciones/${res.body.operacion.id}/enviar-validacion`).set(auth(tOp));
    expect(env.status).toBe(200);
    const rev = await request(app)
      .post(`/api/operaciones/${res.body.operacion.id}/revision`)
      .set(auth(tValidador))
      .send({ resultado: "aprobada", comentario: "OK Fase 14" });
    expect(rev.status).toBe(200);

    resg = await request(app).get("/api/trf/resguardo").set(auth(tAdmin));
    mxn = (resg.body.saldos as Array<{ moneda: string; saldo: number }>).find((s) => s.moneda === "MXN");
    // 1000 (base) + 500 (comisión TRF 0.5% de 100000, aplicada AL AUTORIZARSE)
    expect(mxn?.saldo).toBe(1500);

    // Liberar y pagar: al PAGARSE no se duplica el ingreso.
    const lib = await request(app).post(`/api/operaciones/${res.body.operacion.id}/liberar`).set(auth(tFondeador));
    expect(lib.status).toBe(200);
    const pago = await request(app)
      .post(`/api/operaciones/${res.body.operacion.id}/pago`)
      .set(auth(tTes))
      .send({ medio: "transferencia", monto: 100000, comprobante: "TRF-AUT", fecha_pago: hoy() });
    expect(pago.status === 200 || pago.status === 201).toBe(true);

    resg = await request(app).get("/api/trf/resguardo").set(auth(tAdmin));
    mxn = (resg.body.saldos as Array<{ moneda: string; saldo: number }>).find((s) => s.moneda === "MXN");
    expect(mxn?.saldo).toBe(1500);
  });
});

describe("Pagos especiales (formato adjunto + resguardo de origen)", () => {
  it("exige formato, pagadora y origen; moneda distinta de MXN se rechaza", async () => {
    const tOp = await login("operador", "operador");
    const flujo01 = await cuentaPorNombre(tOp, "FLUJOS 01");

    const sinFormato = await request(app)
      .post("/api/operaciones")
      .set(auth(tOp))
      .send({
        tipo: "pago_especial",
        concepto: "Pago SAT",
        monto: 500,
        fecha_operacion: hoy(),
        pagadora_cuenta_id: flujo01.id,
        origen: { tipo: "trf" },
      });
    expect(sinFormato.status).toBe(400);
    expect(JSON.stringify(sinFormato.body)).toContain("formato");

    const sinOrigen = await request(app)
      .post("/api/operaciones")
      .set(auth(tOp))
      .send({
        tipo: "pago_especial",
        concepto: "Pago SAT",
        monto: 500,
        fecha_operacion: hoy(),
        pagadora_cuenta_id: flujo01.id,
        formato: { nombre: "sat.pdf", mime: "application/pdf", contenido: "data:application/pdf;base64,JVBERi0=" },
      });
    expect(sinOrigen.status).toBe(400);
    expect(JSON.stringify(sinOrigen.body)).toContain("origen");

    const enUsd = await request(app)
      .post("/api/operaciones")
      .set(auth(tOp))
      .send({
        tipo: "pago_especial",
        concepto: "Pago SAT",
        monto: 500,
        moneda: "USD",
        fecha_operacion: hoy(),
        pagadora_cuenta_id: flujo01.id,
        origen: { tipo: "trf" },
        formato: { nombre: "sat.pdf", mime: "application/pdf", contenido: "data:application/pdf;base64,JVBERi0=" },
      });
    expect(enUsd.status).toBe(400);
    expect(JSON.stringify(enUsd.body)).toContain("MXN");

    // Tesorería no captura pagos especiales (sólo el ejecutivo).
    const tTes = await login("tesoreria", "tesoreria");
    const rol = await request(app)
      .post("/api/operaciones")
      .set(auth(tTes))
      .send({ tipo: "pago_especial", concepto: "x", monto: 500, fecha_operacion: hoy() });
    expect(rol.status).toBe(403);
  });

  it("el resguardo de origen debe tener DEPÓSITO suficiente; el resguardo TRF se descuenta AL AUTORIZARSE", async () => {
    const tOp = await login("operador", "operador");
    const tAdmin = await login("admin", "admin");
    const tValidador = await login("validador", "validador");
    const tFondeador = await login("fondeador", "fondeador");
    const tTes = await login("tesoreria", "tesoreria");
    const flujo01 = await cuentaPorNombre(tOp, "FLUJOS 01");

    // Sin saldo en TRF → 409 ("debe de tener un depósito").
    const sinSaldo = await request(app)
      .post("/api/operaciones")
      .set(auth(tOp))
      .send({
        tipo: "pago_especial",
        concepto: "Pago SAT sin fondo",
        monto: 5000,
        fecha_operacion: hoy(),
        pagadora_cuenta_id: flujo01.id,
        origen: { tipo: "trf" },
        formato: { nombre: "sat.pdf", mime: "application/pdf", contenido: "data:application/pdf;base64,JVBERi0=" },
      });
    expect(sinSaldo.status).toBe(409);
    expect(JSON.stringify(sinSaldo.body)).toContain("depósito");

    // El admin alimenta el resguardo (los ejecutivos ya no registran movimientos).
    const ingreso = await request(app)
      .post("/api/trf/resguardo")
      .set(auth(tAdmin))
      .send({ tipo: "ingreso", importe: 3000, notas: "comisiones de la casa" });
    expect(ingreso.status).toBe(201);

    const res = await request(app)
      .post("/api/operaciones")
      .set(auth(tOp))
      .send({
        tipo: "pago_especial",
        concepto: "Pago de impuestos SAT",
        monto: 2500,
        fecha_operacion: hoy(),
        pagadora_cuenta_id: flujo01.id,
        origen: { tipo: "trf" },
        formato: { nombre: "formato-sat.pdf", mime: "application/pdf", contenido: "data:application/pdf;base64,JVBERi0=" },
      });
    expect(res.status).toBe(201);
    expect(res.body.operacion.tipo).toBe("pago_especial");
    expect(res.body.pago_especial.pagadora).toBe("FLUJOS 01");
    expect(res.body.pago_especial.resguardo_origen).toBe("trf");
    expect(res.body.pago_especial.formato_nombre).toBe("formato-sat.pdf");
    const opId = res.body.operacion.id as number;

    // La CAPTURA no descuenta el resguardo.
    let resg = await request(app).get("/api/trf/resguardo").set(auth(tAdmin));
    let mxn = (resg.body.saldos as Array<{ moneda: string; saldo: number }>).find((s) => s.moneda === "MXN");
    expect(mxn?.saldo).toBe(3000);

    // El formato se descarga por su endpoint (quien ve la operación).
    const formato = await request(app).get(`/api/operaciones/${opId}/pago-especial/formato`).set(auth(tOp));
    expect(formato.status).toBe(200);
    expect(formato.body.nombre).toBe("formato-sat.pdf");
    expect(formato.body.contenido).toContain("JVBERi0");

    // Autorización (validación aprueba): AQUÍ se descuenta el resguardo TRF
    // (el efectivo queda apartado para la operación).
    const env = await request(app).post(`/api/operaciones/${opId}/enviar-validacion`).set(auth(tOp));
    expect(env.status).toBe(200);
    const rev = await request(app)
      .post(`/api/operaciones/${opId}/revision`)
      .set(auth(tValidador))
      .send({ resultado: "aprobada", comentario: "OK Fase 14" });
    expect(rev.status).toBe(200);

    resg = await request(app).get("/api/trf/resguardo").set(auth(tAdmin));
    mxn = (resg.body.saldos as Array<{ moneda: string; saldo: number }>).find((s) => s.moneda === "MXN");
    expect(mxn?.saldo).toBe(500);

    // Liberar y pagar: el pago procede (el efectivo ya estaba apartado) y no
    // se duplica el retiro al PAGARSE.
    const lib = await request(app).post(`/api/operaciones/${opId}/liberar`).set(auth(tFondeador));
    expect(lib.status).toBe(200);
    const pago = await request(app)
      .post(`/api/operaciones/${opId}/pago`)
      .set(auth(tTes))
      .send({ medio: "transferencia", monto: 2500, comprobante: `TRF14-${opId}`, fecha_pago: hoy() });
    expect(pago.status === 200 || pago.status === 201).toBe(true);

    resg = await request(app).get("/api/trf/resguardo").set(auth(tAdmin));
    mxn = (resg.body.saldos as Array<{ moneda: string; saldo: number }>).find((s) => s.moneda === "MXN");
    expect(mxn?.saldo).toBe(500);

    // El detalle muestra el pago especial con su origen.
    const det = await request(app).get(`/api/operaciones/${opId}`).set(auth(tOp));
    expect(det.body.pago_especial.resguardo_origen).toBe("trf");
    expect(det.body.pago_especial.pagadora).toBe("FLUJOS 01");
  });

  it("pago especial desde el resguardo de un broker: comisión acumulada y retiro al pagarse", async () => {
    const tOp = await login("operador", "operador");
    const tAdminOps = await login("admin_ops", "admin_ops");
    const tValidador = await login("validador", "validador");
    const tFondeador = await login("fondeador", "fondeador");
    const tTes = await login("tesoreria", "tesoreria");
    const flujo01 = await cuentaPorNombre(tOp, "FLUJOS 01");

    // Un broker se gana comisión: operación pagada con comision_pct 100 y el
    // broker al 50% → resguardo del broker con saldo 500 (50% de 1000).
    const b = await request(app)
      .post("/api/brokers")
      .set(auth(tAdminOps))
      .send({ nombre: "BROKER F14", porcentaje: 50 });
    expect(b.status).toBe(201);
    const opComision = await capturarFlujo(tOp, { monto: 1000, comision_pct: 100, concepto: "GENERA COMISION" });
    expect(opComision.status).toBe(201);
    // La comisión del broker se fija en los datos del flujo (reemplazo completo).
    const conBroker = await request(app)
      .put(`/api/operaciones/${opComision.body.operacion.id}/datos-flujo`)
      .set(auth(tOp))
      .send({ brokers: [{ broker_id: b.body.broker.id, porcentaje: 50 }] });
    expect(conBroker.status).toBe(200);
    await hastaPagada(opComision.body.operacion.id, { op: tOp, validador: tValidador, fondeador: tFondeador, tesoreria: tTes }, 1000);
    const resguardos = await request(app).get("/api/brokers/resguardos").set(auth(tOp));
    expect(resguardos.status).toBe(200);
    const rBroker = (resguardos.body.resguardos as Array<{ broker_id: number; saldo: number }>).find(
      (r) => r.broker_id === b.body.broker.id
    );
    expect(rBroker?.saldo).toBe(500);

    // Pago especial desde el resguardo del broker: captura sin fondo (600 > 500) → 409.
    const excede = await request(app)
      .post("/api/operaciones")
      .set(auth(tOp))
      .send({
        tipo: "pago_especial",
        concepto: "Pago de comisión al broker",
        monto: 600,
        fecha_operacion: hoy(),
        pagadora_cuenta_id: flujo01.id,
        origen: { tipo: "broker", broker_id: b.body.broker.id },
        formato: { nombre: "recibo.pdf", mime: "application/pdf", contenido: "data:application/pdf;base64,JVBERi0=" },
      });
    expect(excede.status).toBe(409);
    expect(JSON.stringify(excede.body)).toContain("broker");

    // Con 400 (≤ saldo) pasa el flujo completo y el resguardo del broker queda en 100.
    const res = await request(app)
      .post("/api/operaciones")
      .set(auth(tOp))
      .send({
        tipo: "pago_especial",
        concepto: "Pago de comisión al broker",
        monto: 400,
        fecha_operacion: hoy(),
        pagadora_cuenta_id: flujo01.id,
        origen: { tipo: "broker", broker_id: b.body.broker.id },
        formato: { nombre: "recibo.pdf", mime: "application/pdf", contenido: "data:application/pdf;base64,JVBERi0=" },
      });
    expect(res.status).toBe(201);
    await hastaPagada(res.body.operacion.id, { op: tOp, validador: tValidador, fondeador: tFondeador, tesoreria: tTes }, 400);
    const resguardos2 = await request(app).get("/api/brokers/resguardos").set(auth(tAdminOps));
    const rBroker2 = (resguardos2.body.resguardos as Array<{ broker_id: number; saldo: number }>).find(
      (r) => r.broker_id === b.body.broker.id
    );
    expect(rBroker2?.saldo).toBe(100);
  });

  it("no se puede AUTORIZAR un pago especial si el resguardo de TRF ya no tiene fondo", async () => {
    const tOp = await login("operador", "operador");
    const tAdmin = await login("admin", "admin");
    const tValidador = await login("validador", "validador");
    const flujo01 = await cuentaPorNombre(tOp, "FLUJOS 01");

    await request(app).post("/api/trf/resguardo").set(auth(tAdmin)).send({ tipo: "ingreso", importe: 1000 });

    const res = await request(app)
      .post("/api/operaciones")
      .set(auth(tOp))
      .send({
        tipo: "pago_especial",
        concepto: "Pago SAT a autorizar sin fondo",
        monto: 800,
        fecha_operacion: hoy(),
        pagadora_cuenta_id: flujo01.id,
        origen: { tipo: "trf" },
        formato: { nombre: "sat.pdf", mime: "application/pdf", contenido: "data:application/pdf;base64,JVBERi0=" },
      });
    expect(res.status).toBe(201);
    const opId = res.body.operacion.id as number;

    // El fondo desaparece DESPUÉS de la captura (retiro manual de corrección).
    const retiro = await request(app)
      .post("/api/trf/resguardo")
      .set(auth(tAdmin))
      .send({ tipo: "retiro", importe: 1000, notas: "corrección" });
    expect(retiro.status).toBe(201);

    // La AUTORIZACIÓN no procede: 409 y la operación sigue en validación.
    await request(app).post(`/api/operaciones/${opId}/enviar-validacion`).set(auth(tOp));
    const rev = await request(app)
      .post(`/api/operaciones/${opId}/revision`)
      .set(auth(tValidador))
      .send({ resultado: "aprobada", comentario: "OK" });
    expect(rev.status).toBe(409);
    expect(JSON.stringify(rev.body)).toContain("No se puede autorizar");

    const det = await request(app).get(`/api/operaciones/${opId}`).set(auth(tValidador));
    expect(det.body.operacion.estado).toBe("en_validacion");
  });

  it("cancelar una operación ya autorizada revierte el retiro del resguardo de TRF", async () => {
    const tOp = await login("operador", "operador");
    const tAdmin = await login("admin", "admin");
    const tValidador = await login("validador", "validador");
    const tTes = await login("tesoreria", "tesoreria");
    const flujo01 = await cuentaPorNombre(tOp, "FLUJOS 01");

    await request(app).post("/api/trf/resguardo").set(auth(tAdmin)).send({ tipo: "ingreso", importe: 2000 });

    const res = await request(app)
      .post("/api/operaciones")
      .set(auth(tOp))
      .send({
        tipo: "pago_especial",
        concepto: "Pago SAT a cancelar",
        monto: 700,
        fecha_operacion: hoy(),
        pagadora_cuenta_id: flujo01.id,
        origen: { tipo: "trf" },
        formato: { nombre: "sat.pdf", mime: "application/pdf", contenido: "data:application/pdf;base64,JVBERi0=" },
      });
    expect(res.status).toBe(201);
    const opId = res.body.operacion.id as number;

    // Autorizar → retiro aplicado: 2000 - 700 = 1300.
    await request(app).post(`/api/operaciones/${opId}/enviar-validacion`).set(auth(tOp));
    const rev = await request(app)
      .post(`/api/operaciones/${opId}/revision`)
      .set(auth(tValidador))
      .send({ resultado: "aprobada", comentario: "OK" });
    expect(rev.status).toBe(200);
    let resg = await request(app).get("/api/trf/resguardo").set(auth(tAdmin));
    let mxn = (resg.body.saldos as Array<{ moneda: string; saldo: number }>).find((s) => s.moneda === "MXN");
    expect(mxn?.saldo).toBe(1300);

    // Tesorería cancela la aprobada (sin tandas) → reversa: vuelve a 2000.
    const can = await request(app).post(`/api/operaciones/${opId}/cancelar`).set(auth(tTes));
    expect(can.status).toBe(200);
    resg = await request(app).get("/api/trf/resguardo").set(auth(tAdmin));
    mxn = (resg.body.saldos as Array<{ moneda: string; saldo: number }>).find((s) => s.moneda === "MXN");
    expect(mxn?.saldo).toBe(2000);
  });

  it("el listado filtra por tipo pago_especial y la captura paga a la pagadora indicada", async () => {
    const tOp = await login("operador", "operador");
    const tAdmin = await login("admin", "admin");
    const flujo01 = await cuentaPorNombre(tOp, "FLUJOS 01");
    await request(app)
      .post("/api/trf/resguardo")
      .set(auth(tAdmin))
      .send({ tipo: "ingreso", importe: 5000 });

    const res = await request(app)
      .post("/api/operaciones")
      .set(auth(tOp))
      .send({
        tipo: "pago_especial",
        concepto: "Derechos SAT",
        monto: 1200,
        fecha_operacion: hoy(),
        pagadora_cuenta_id: flujo01.id,
        origen: { tipo: "trf" },
        formato: { nombre: "sat.png", mime: "image/png", contenido: "data:image/png;base64,iVBORw0=" },
      });
    expect(res.status).toBe(201);

    const lista = await request(app).get("/api/operaciones?tipo=pago_especial").set(auth(tAdmin));
    expect(lista.status).toBe(200);
    const ops = lista.body.operaciones as Array<{ tipo: string; concepto: string }>;
    expect(ops.length).toBeGreaterThanOrEqual(1);
    expect(ops.every((o) => o.tipo === "pago_especial")).toBe(true);
    expect(ops.some((o) => o.concepto === "Derechos SAT")).toBe(true);
  });
});
