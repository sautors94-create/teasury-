import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Database } from "better-sqlite3";
import { crearApp } from "../src/app.js";
import { abrirBase } from "../src/db.js";

let db: Database;
let app: ReturnType<typeof crearApp>;

async function login(username: string, password: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ username, password });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** PNG 1x1 válido para comprobantes de prueba. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Adjunta un comprobante a cada depósito pendiente (sin ellos no se valida, §5.3). */
async function adjuntarComprobantes(operacionId: number, token: string): Promise<void> {
  const det = await request(app).get(`/api/operaciones/${operacionId}`).set(auth(token));
  for (const dep of (det.body.depositos ?? []) as Array<{ id: number; validado_por: number | null }>) {
    if (dep.validado_por !== null) continue;
    const r = await request(app)
      .post(`/api/depositos/${dep.id}/comprobantes`)
      .set(auth(token))
      .send({ comprobantes: [{ nombre: "ficha.png", mime: "image/png", contenido: PNG }] });
    expect(r.status).toBe(201);
  }
}

/** Captura con los números exactos del formato del negocio (Excel FLUJOS). */
async function capturarFlujo(
  token: string,
  extras: Record<string, unknown> = {}
): Promise<{ id: number; calculos: Record<string, unknown> }> {
  const res = await request(app)
    .post("/api/operaciones")
    .set(auth(token))
    .send({
      tipo: "flujo",
      concepto: "Flujo de dispersión semana 43",
      monto: 60000,
      fecha_operacion: "2026-10-26",
      pagador: "FLUJOS",
      tipo_operacion: "FLUJOS",
      timbrar: false,
      comision_pct: 2.5,
      observaciones: "Instrucciones especiales de la semana",
      dispersiones: [
        { beneficiario: "COMERCIAL BRAIN FENIX", razon_social: "COMERCIAL BRAIN FENIX S DE RL DE CV", cuenta: "6461803528523520323", banco: "STP", importe: 57000, etiqueta: "PROVEEDOR" },
        { beneficiario: "TRF CARD SAPI SA DE CV", referencia: "1010", cuenta: "646180352590100116", banco: "STP", importe: 303, etiqueta: "GASTOS" },
        { beneficiario: "MGN INTRUST", importe: 1500, etiqueta: "COMISION" },
      ],
      ...extras,
    });
  expect(res.status).toBe(201);
  return { id: res.body.operacion.id, calculos: res.body.calculos };
}

/** Cliente con asignación vigente al operador (para el resguardo). */
async function clienteConAsignacion(): Promise<number> {
  const tAdmin = await login("admin_ops", "admin_ops");
  const creacion = await request(app)
    .post("/api/clientes")
    .set(auth(tAdmin))
    .send({ nombre: "Cliente Flujo SA" });
  expect(creacion.status).toBe(201);
  const clienteId = creacion.body.cliente.id as number;
  const tOperador = await login("operador", "operador");
  const idOp = (
    await request(app).get("/api/auth/me").set(auth(tOperador))
  ).body.usuario.id as number;
  const asignacion = await request(app)
    .post(`/api/clientes/${clienteId}/asignaciones`)
    .set(auth(tAdmin))
    .send({ ejecutivo_id: idOp, motivo: "cuenta principal" });
  expect(asignacion.status).toBe(201);
  return clienteId;
}

/** Lleva la operación a 'aprobada' (monto < umbral de Dirección). */
async function aprobar(id: number): Promise<void> {
  const tOperador = await login("operador", "operador");
  await request(app).post(`/api/operaciones/${id}/enviar-validacion`).set(auth(tOperador));
  const tValidador = await login("validador", "validador");
  const rev = await request(app)
    .post(`/api/operaciones/${id}/revision`)
    .set(auth(tValidador))
    .send({ resultado: "aprobada", comentario: "en orden" });
  expect(rev.status).toBe(200);
  // Fase 12: el Fondeador libera la operación y se registran las altas
  // bancarias de las líneas de dispersión (sin ellas Tesorería no dispersa).
  const liberar = await request(app).post(`/api/operaciones/${id}/liberar`).set(auth(await login("fondeador", "fondeador")));
  expect(liberar.status).toBe(200);
  const det = await request(app).get(`/api/operaciones/${id}`).set(auth(tOperador));
  const tAltas = await login("altas", "altas");
  for (const a of (det.body.altas_dispersiones ?? []) as Array<{
    verificable: boolean;
    registrada: boolean;
    dispersion_id: number;
  }>) {
    if (!a.verificable || a.registrada) continue;
    const sol = await request(app)
      .post("/api/altas-bancarias")
      .set(auth(tOperador))
      .send({ dispersion_id: a.dispersion_id });
    if (sol.status === 201) {
      const reg = await request(app).post(`/api/altas-bancarias/${sol.body.alta.id}/registrada`).set(auth(tAltas));
      expect(reg.status).toBe(200);
    }
  }
}

beforeEach(() => {
  db = abrirBase(":memory:");
  app = crearApp(db);
});

describe("catálogo de brokers (formato FLUJO)", () => {
  it("admin_operaciones administra brokers; captura y detalle los reflejan con su monto", async () => {
    const tAdmin = await login("admin_ops", "admin_ops");
    const alta = await request(app)
      .post("/api/brokers")
      .set(auth(tAdmin))
      .send({ nombre: "MGN INTRUST", porcentaje: 60 });
    expect(alta.status).toBe(201);
    const alta2 = await request(app)
      .post("/api/brokers")
      .set(auth(tAdmin))
      .send({ nombre: "BROKER NORTE", porcentaje: 40 });
    expect(alta2.status).toBe(201);

    // Operador puede consultar; no puede administrar
    const tOperador = await login("operador", "operador");
    const lista = await request(app).get("/api/brokers").set(auth(tOperador));
    expect(lista.status).toBe(200);
    expect(lista.body.brokers).toHaveLength(2);
    const negado = await request(app).post("/api/brokers").set(auth(tOperador)).send({ nombre: "X" });
    expect(negado.status).toBe(403);

    // Captura con broker al 60%: la comisión 1,500 → 900 al broker
    const { id, calculos } = await capturarFlujo(tOperador, {
      brokers: [{ broker_id: alta.body.broker.id, porcentaje: 60 }],
    });
    expect(calculos.comision_brokers).toBe(900);
    const detalle = await request(app).get(`/api/operaciones/${id}`).set(auth(tOperador));
    expect(detalle.body.brokers).toHaveLength(1);
    expect(detalle.body.brokers[0].nombre).toBe("MGN INTRUST");
    expect(detalle.body.brokers[0].monto).toBe(900);

    // Suma de porcentajes > 100 se rechaza
    const rechazo = await request(app)
      .post("/api/operaciones")
      .set(auth(tOperador))
      .send({
        tipo: "flujo",
        concepto: "x",
        monto: 1000,
        fecha_operacion: "2026-10-26",
        pagador: "FLUJOS",
        tipo_operacion: "FLUJOS",
        comision_pct: 2.5,
        dispersiones: [{ beneficiario: "A", importe: 900 }],
        brokers: [
          { broker_id: alta.body.broker.id, porcentaje: 70 },
          { broker_id: alta2.body.broker.id, porcentaje: 70 },
        ],
      });
    expect(rechazo.status).toBe(400);
    expect(rechazo.body.detalles.join(" ")).toContain("excede 100%");
  });
});

describe("captura completa (formato FLUJO)", () => {
  it("captura con los números del formato y calcula IVA, neto, comisión, devolución, flujo y diferencia", async () => {
    const tOperador = await login("operador", "operador");
    const { id, calculos } = await capturarFlujo(tOperador);
    // Números del Excel del negocio: 60,000 pagado, 2.50% comisión,
    // dispersiones 57,000 + 303 + 1,500 = 58,803 → diferencia 1,197.
    expect(calculos.iva).toBeCloseTo(8275.86, 2);
    expect(calculos.neto).toBeCloseTo(51724.14, 2);
    expect(calculos.comision_total).toBe(1500);
    expect(calculos.flujo_total).toBe(58803);
    expect(calculos.devolucion).toBe(57303);
    expect(calculos.diferencia).toBe(1197);
    expect(calculos.comprobacion).toBe("VERDADERO");

    const detalle = await request(app).get(`/api/operaciones/${id}`).set(auth(tOperador));
    expect(detalle.body.operacion.tipo).toBe("flujo");
    expect(detalle.body.operacion.pagador).toBe("FLUJOS");
    expect(detalle.body.operacion.timbrar).toBe(0);
    expect(detalle.body.dispersiones).toHaveLength(3);
    expect(detalle.body.dispersiones[0].orden).toBe(1);
    expect(detalle.body.totales_pago.total_por_dispersar).toBe(58803);
    expect(detalle.body.totales_pago.restante).toBe(58803);
    // proveedor se toma del pagador cuando no se envía
    expect(detalle.body.operacion.proveedor).toBe("FLUJOS");
  });

  it("rechaza flujo sin dispersiones y comprobación EN CONTRA (flujo total > monto)", async () => {
    const tOperador = await login("operador", "operador");
    const sinLineas = await request(app)
      .post("/api/operaciones")
      .set(auth(tOperador))
      .send({
        tipo: "flujo",
        concepto: "x",
        monto: 1000,
        fecha_operacion: "2026-10-26",
        pagador: "FLUJOS",
        tipo_operacion: "FLUJOS",
        comision_pct: 2.5,
        dispersiones: [],
      });
    expect(sinLineas.status).toBe(400);

    const enContra = await request(app)
      .post("/api/operaciones")
      .set(auth(tOperador))
      .send({
        tipo: "flujo",
        concepto: "x",
        monto: 1000,
        fecha_operacion: "2026-10-26",
        pagador: "FLUJOS",
        tipo_operacion: "FLUJOS",
        comision_pct: 2.5,
        dispersiones: [
          { beneficiario: "A", importe: 700 },
          { beneficiario: "B", importe: 500 },
        ],
      });
    expect(enContra.status).toBe(400);
    expect(enContra.body.detalles.join(" ")).toContain("EN CONTRA");
    expect(enContra.body.detalles.join(" ")).toContain("1200.00");
  });

  it("el ejecutivo edita dispersiones y datos del flujo mientras no hay tandas; bloqueado tras aprobada", async () => {
    const tOperador = await login("operador", "operador");
    const { id } = await capturarFlujo(tOperador);

    // Edición de dispersiones en borrador
    const edicion = await request(app)
      .put(`/api/operaciones/${id}/dispersiones`)
      .set(auth(tOperador))
      .send({
        dispersiones: [
          { beneficiario: "BENEF A", importe: 40000 },
          { beneficiario: "BENEF B", importe: 18000 },
          { beneficiario: "MGN INTRUST", importe: 1000 },
        ],
      });
    expect(edicion.status).toBe(200);
    expect(edicion.body.calculos.flujo_total).toBe(59000);
    expect(edicion.body.calculos.diferencia).toBe(1000);

    // Edición de datos del flujo (comisión 3%: 60,000 × 3% = 1,800)
    const datos = await request(app)
      .put(`/api/operaciones/${id}/datos-flujo`)
      .set(auth(tOperador))
      .send({ comision_pct: 3, timbrar: true, observaciones: "ajuste de comisión" });
    expect(datos.status).toBe(200);
    expect(datos.body.operacion.comision_pct).toBe(3);
    expect(datos.body.operacion.timbrar).toBe(1);
    expect(datos.body.calculos.comision_total).toBe(1800);

    await aprobar(id);

    // Ya aprobada: nada editable
    const negado = await request(app)
      .put(`/api/operaciones/${id}/dispersiones`)
      .set(auth(tOperador))
      .send({ dispersiones: [{ beneficiario: "X", importe: 100 }] });
    expect(negado.status).toBe(409);
    const negadoDatos = await request(app)
      .put(`/api/operaciones/${id}/datos-flujo`)
      .set(auth(tOperador))
      .send({ comision_pct: 5 });
    expect(negadoDatos.status).toBe(409);
  });
});

describe("pagos por tandas hasta el flujo total", () => {
  it("tanda parcial → en_pago; tanda final → pagada y la diferencia queda en el resguardo", async () => {
    const clienteId = await clienteConAsignacion();
    const tTesoreria = await login("tesoreria", "tesoreria");
    // Sólo el Administrador de Tesorería crea cuentas; el analista moviliza.
    const cuenta = await request(app)
      .post("/api/cuentas")
      .set(auth(await login("admin_tesoreria", "admin_tesoreria")))
      .send({ nombre: "STP Operaciones", banco: "STP" });
    expect(cuenta.status).toBe(201);
    const cuentaId = cuenta.body.cuenta.id as number;
    const tOperador = await login("operador", "operador");
    // Captura CON respaldo: la operación nace con el depósito indicado
    // (60,000) que respalda el flujo total (58,803).
    const { id } = await capturarFlujo(tOperador, {
      cliente_id: clienteId,
      respaldo: { depositos: [{ cuenta_id: cuentaId, monto: 60000, comprobante: "SPEI-9001" }] },
    });

    // Tesorería valida el depósito indicado en la captura: resguardo 60,000
    // (antes de validar, el ejecutivo adjunta su comprobante documental, §5.3).
    await adjuntarComprobantes(id, tOperador);
    const tValTes = await login("val_tesoreria", "val_tesoreria");
    const validar = await request(app)
      .post(`/api/operaciones/${id}/deposito/validar`)
      .set(auth(tValTes));
    expect(validar.status).toBe(200);
    expect(validar.body.saldo).toBe(60000);
    expect(validar.body.depositos).toBe(1);

    await aprobar(id);

    // Tanda 1 parcial (30,000 de 58,803) → en_pago
    const tanda1 = await request(app)
      .post(`/api/operaciones/${id}/pago`)
      .set(auth(tTesoreria))
      .send({ medio: "transferencia", monto: 30000, comprobante: "TRF-1", cuenta_id: cuentaId });
    expect(tanda1.status).toBe(201);
    expect(tanda1.body.operacion.estado).toBe("en_pago");
    expect(tanda1.body.completado).toBe(false);
    expect(tanda1.body.pagado.restante).toBe(28803);

    // Aparece en el filtro de en_pago
    const enPago = await request(app)
      .get("/api/operaciones?estado=en_pago")
      .set(auth(tTesoreria));
    expect(enPago.body.operaciones.map((o: { id: number }) => o.id)).toContain(id);

    // Una tanda que excede el restante se rechaza
    const exceso = await request(app)
      .post(`/api/operaciones/${id}/pago`)
      .set(auth(tTesoreria))
      .send({ medio: "transferencia", monto: 30000, comprobante: "TRF-2" });
    expect(exceso.status).toBe(400);
    expect(exceso.body.restante).toBe(28803);

    // Tanda 2 completa el flujo total → pagada; diferencia 1,197 al resguardo
    const tanda2 = await request(app)
      .post(`/api/operaciones/${id}/pago`)
      .set(auth(tTesoreria))
      .send({ medio: "transferencia", monto: 28803, comprobante: "TRF-2" });
    expect(tanda2.status).toBe(201);
    expect(tanda2.body.operacion.estado).toBe("pagada");
    expect(tanda2.body.completado).toBe(true);
    expect(tanda2.body.pagado.total_dispersado).toBe(58803);

    // Resguardo: 60,000 − 30,000 − 28,803 = 1,197 (diferencia a favor)
    const resguardo = await request(app).get(`/api/clientes/${clienteId}/resguardo`).set(auth(tOperador));
    expect(resguardo.body.saldo).toBeCloseTo(1197, 2);

    // Bitácora con el evento de diferencia a resguardo y no se puede pagar más
    const detalle = await request(app).get(`/api/operaciones/${id}`).set(auth(tTesoreria));
    const acciones = detalle.body.historial.map((h: { accion: string }) => h.accion);
    expect(acciones).toContain("diferencia_resguardo");
    const extra = await request(app)
      .post(`/api/operaciones/${id}/pago`)
      .set(auth(tTesoreria))
      .send({ medio: "transferencia", monto: 100, comprobante: "TRF-3" });
    expect(extra.status).toBe(409);
  });

  it("lote de tandas por layout (POST /pagos): todo o nada", async () => {
    const clienteId = await clienteConAsignacion();
    const tTesoreria = await login("tesoreria", "tesoreria");
    // Sólo el Administrador de Tesorería crea cuentas; el analista moviliza.
    const cuenta = await request(app)
      .post("/api/cuentas")
      .set(auth(await login("admin_tesoreria", "admin_tesoreria")))
      .send({ nombre: "STP Operaciones" });
    const cuentaId = cuenta.body.cuenta.id as number;
    const tOperador = await login("operador", "operador");
    const { id } = await capturarFlujo(tOperador, {
      cliente_id: clienteId,
      respaldo: { depositos: [{ cuenta_id: cuentaId, monto: 60000, comprobante: "SPEI-7788" }] },
    });
    await adjuntarComprobantes(id, tOperador);
    await request(app)
      .post(`/api/operaciones/${id}/deposito/validar`)
      .set(auth(await login("val_tesoreria", "val_tesoreria")));
    await aprobar(id);

    // Lote válido: dos tandas que suman el flujo total
    const lote = await request(app)
      .post(`/api/operaciones/${id}/pagos`)
      .set(auth(tTesoreria))
      .send({
        pagos: [
          { monto: 40000, comprobante: "LOTE-A", fecha_pago: "2026-10-27" },
          { monto: 18803, comprobante: "LOTE-B", fecha_pago: "2026-10-28" },
        ],
      });
    expect(lote.status).toBe(201);
    expect(lote.body.pagos).toHaveLength(2);
    expect(lote.body.completado).toBe(true);
    expect(lote.body.operacion.estado).toBe("pagada");
    expect(lote.body.pagado.total_dispersado).toBe(58803);

    // Lote con una tanda inválida → se revierte todo (todo o nada)
    const { id: id2 } = await capturarFlujo(tOperador, {
      cliente_id: clienteId,
      concepto: "Flujo 2",
      respaldo: { depositos: [{ cuenta_id: cuentaId, monto: 60000, comprobante: "SPEI-7789" }] },
    });
    await adjuntarComprobantes(id2, tOperador);
    await request(app)
      .post(`/api/operaciones/${id2}/deposito/validar`)
      .set(auth(await login("val_tesoreria", "val_tesoreria")));
    await aprobar(id2);
    const loteMalo = await request(app)
      .post(`/api/operaciones/${id2}/pagos`)
      .set(auth(tTesoreria))
      .send({
        pagos: [
          { monto: 40000, comprobante: "MALO-A" },
          { monto: 99999, comprobante: "MALO-B" },
        ],
      });
    expect(loteMalo.status).toBe(400);
    const detalle2 = await request(app).get(`/api/operaciones/${id2}`).set(auth(tTesoreria));
    expect(detalle2.body.pagos).toHaveLength(0);
    expect(detalle2.body.operacion.estado).toBe("aprobada");

    // El lote no aplica a operaciones del formato anterior
    const legacy = await request(app)
      .post("/api/operaciones")
      .set(auth(tOperador))
      .send({ tipo: "pago", concepto: "viejo", proveedor: "X", monto: 100, fecha_operacion: "2026-10-26" });
    const loteLegacy = await request(app)
      .post(`/api/operaciones/${legacy.body.operacion.id}/pagos`)
      .set(auth(tTesoreria))
      .send({ pagos: [{ monto: 100, comprobante: "L" }] });
    expect(loteLegacy.status).toBe(409);
  });

  it("operaciones del formato anterior conservan el pago único exacto (sin regresión)", async () => {
    const tOperador = await login("operador", "operador");
    const creacion = await request(app)
      .post("/api/operaciones")
      .set(auth(tOperador))
      .send({ tipo: "pago", concepto: "Renta", proveedor: "Inmobiliaria", monto: 10000, fecha_operacion: "2026-10-26" });
    const id = creacion.body.operacion.id as number;
    await aprobar(id);
    const tTesoreria = await login("tesoreria", "tesoreria");

    const montoDistinto = await request(app)
      .post(`/api/operaciones/${id}/pago`)
      .set(auth(tTesoreria))
      .send({ medio: "cheque", monto: 9000, comprobante: "CHQ-1" });
    expect(montoDistinto.status).toBe(400);
    expect(montoDistinto.body.monto_operacion).toBe(10000);

    const pago = await request(app)
      .post(`/api/operaciones/${id}/pago`)
      .set(auth(tTesoreria))
      .send({ medio: "transferencia", monto: 10000, comprobante: "TRF-88" });
    expect(pago.status).toBe(201);
    expect(pago.body.operacion.estado).toBe("pagada");

    const doble = await request(app)
      .post(`/api/operaciones/${id}/pago`)
      .set(auth(tTesoreria))
      .send({ medio: "transferencia", monto: 10000, comprobante: "TRF-89" });
    expect(doble.status).toBe(409);

    // Detalle: 'pago' sigue presente para compatibilidad y 'pagos' como arreglo
    const detalle = await request(app).get(`/api/operaciones/${id}`).set(auth(tTesoreria));
    expect(detalle.body.pago.comprobante).toBe("TRF-88");
    expect(detalle.body.pagos).toHaveLength(1);
  });
});
