import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Database } from "better-sqlite3";
import { crearApp } from "../src/app.js";
import { abrirBase } from "../src/db.js";

/**
 * Fase 13:
 *   · Filtros del listado de operaciones (tipo, moneda, monto_min/monto_max).
 *   · Otras monedas: normalización de la moneda capturada (código de 3 letras).
 *   · Visibilidad de cuentas para el listado de pagadoras de los operadores
 *     (Tesorería oculta/muestra; todas nacen visibles).
 *   · Resguardo de TRF (la empresa): ingresos/retiros en MXN/USD/otras con el
 *     tipo de cambio del banco obligatorio fuera de MXN y saldos que cuadran.
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
  visible_operador?: number;
}

async function cuentaPorNombre(token: string, nombre: string): Promise<CuentaCat> {
  const res = await request(app).get("/api/cuentas/catalogo").set(auth(token));
  expect(res.status).toBe(200);
  const c = (res.body.cuentas as CuentaCat[]).find((x) => x.nombre === nombre);
  expect(c, `la cuenta '${nombre}' debe existir en el catálogo sembrado`).toBeTruthy();
  return c as CuentaCat;
}

/** Captura base (formato completo) con moneda y pagadoras configurables. */
async function capturar(
  token: string,
  extra: {
    moneda?: string;
    monto?: number;
    concepto?: string;
    destinos?: Array<{ cuenta_id?: number; tipo?: string }>;
    brokers?: Array<{ broker_id: number; porcentaje: number }>;
  } = {}
) {
  const monto = extra.monto ?? 60000;
  return request(app)
    .post("/api/operaciones")
    .set(auth(token))
    .send({
      tipo: "flujo",
      concepto: extra.concepto ?? "Operación Fase 13",
      monto,
      ...(extra.moneda !== undefined ? { moneda: extra.moneda } : {}),
      fecha_operacion: hoy(),
      timbrar: false,
      comision_pct: 2.5,
      ...(extra.destinos ? { destinos: extra.destinos } : { destinos: [{ tipo: "flujo" }] }),
      ...(extra.brokers ? { brokers: extra.brokers } : {}),
      dispersiones: [
        {
          beneficiario: "COMERCIAL BRAIN FENIX",
          cuenta: "6461803528523520323",
          banco: "STP",
          importe: monto - 303,
          etiqueta: "PROVEEDOR",
        },
        {
          beneficiario: "TRF CARD SAPI SA DE CV",
          cuenta: "646180352590100116",
          banco: "STP",
          importe: 303,
          etiqueta: "GASTOS",
        },
      ],
    });
}

beforeEach(() => {
  db = abrirBase(":memory:");
  app = crearApp(db);
});

describe("Filtros del listado de operaciones (Fase 13)", () => {
  it("filtra por tipo, moneda y rango de monto combinados con el rol", async () => {
    const tOp = await login("operador", "operador");
    const flujo = await capturar(tOp, { concepto: "MXN chico", monto: 10000, moneda: "MXN" });
    expect(flujo.status).toBe(201);
    const usd = await capturar(tOp, { concepto: "USD grande", monto: 90000, moneda: "USD" });
    expect(usd.status).toBe(201);

    const tAdmin = await login("admin", "admin");
    const porTipo = await request(app).get("/api/operaciones?tipo=flujo").set(auth(tAdmin));
    expect(porTipo.status).toBe(200);
    expect((porTipo.body.operaciones as Array<{ concepto: string }>).every((o) => o.concepto)).toBeTruthy();

    const porMoneda = await request(app).get("/api/operaciones?moneda=usd").set(auth(tAdmin));
    expect(porMoneda.status).toBe(200);
    const ops = porMoneda.body.operaciones as Array<{ concepto: string; moneda: string }>;
    expect(ops.length).toBe(1);
    expect(ops[0].concepto).toBe("USD grande");
    expect(ops[0].moneda).toBe("USD");

    const porMonto = await request(app).get("/api/operaciones?monto_min=50000").set(auth(tAdmin));
    expect(porMonto.status).toBe(200);
    expect(
      (porMonto.body.operaciones as Array<{ concepto: string }>).map((o) => o.concepto)
    ).toContain("USD grande");

    const porRango = await request(app)
      .get("/api/operaciones?monto_min=5000&monto_max=20000")
      .set(auth(tAdmin));
    expect(porRango.status).toBe(200);
    expect(
      (porRango.body.operaciones as Array<{ concepto: string }>).map((o) => o.concepto)
    ).toContain("MXN chico");

    // El ejecutivo (alcance de su historial) también puede usar los filtros.
    const propio = await request(app).get("/api/operaciones?moneda=MXN").set(auth(tOp));
    expect(propio.status).toBe(200);
    expect((propio.body.operaciones as unknown[]).length).toBe(1);
  });

  it("rechaza filtros inválidos con 400", async () => {
    const tAdmin = await login("admin", "admin");
    const tipo = await request(app).get("/api/operaciones?tipo=otro").set(auth(tAdmin));
    expect(tipo.status).toBe(400);
    const moneda = await request(app).get("/api/operaciones?moneda=PESOS").set(auth(tAdmin));
    expect(moneda.status).toBe(400);
    const min = await request(app).get("/api/operaciones?monto_min=-5").set(auth(tAdmin));
    expect(min.status).toBe(400);
    const max = await request(app).get("/api/operaciones?monto_max=0").set(auth(tAdmin));
    expect(max.status).toBe(400);
  });
});

describe("Otras monedas en la captura (Fase 13)", () => {
  it("normaliza la moneda a mayúsculas y acepta códigos como GBP/JPY", async () => {
    const tOp = await login("operador", "operador");
    const res = await capturar(tOp, { moneda: "gbp", concepto: "Operación en libras" });
    expect(res.status).toBe(201);
    expect(res.body.operacion.moneda).toBe("GBP");
    const res2 = await capturar(tOp, { moneda: "jpy", concepto: "Operación en yenes" });
    expect(res2.status).toBe(201);
    expect(res2.body.operacion.moneda).toBe("JPY");
  });

  it("sin moneda queda MXN y un código inválido responde 400", async () => {
    const tOp = await login("operador", "operador");
    const ok = await capturar(tOp, { concepto: "Sin moneda explícita" });
    expect(ok.status).toBe(201);
    expect(ok.body.operacion.moneda).toBe("MXN");
    const mal = await capturar(tOp, { moneda: "DOLARES" });
    expect(mal.status).toBe(400);
    expect(JSON.stringify(mal.body)).toContain("moneda");
  });
});

describe("Visibilidad de cuentas para el listado de pagadoras de operadores", () => {
  it("todas nacen visibles y Tesorería puede ocultar/mostrar con bitácora", async () => {
    const tAdminT = await login("admin_tesoreria", "admin_tesoreria");
    const cuenta = await cuentaPorNombre(tAdminT, "FLUJOS 01");
    expect(cuenta.visible_operador).toBe(1);

    const ocultar = await request(app)
      .patch(`/api/cuentas/${cuenta.id}/visible`)
      .set(auth(tAdminT))
      .send({ visible_operador: false, motivo: "cuenta en revisión" });
    expect(ocultar.status).toBe(200);
    expect(ocultar.body.cuenta.visible_operador).toBe(0);

    // Repetido → 409; inválido → 400; inexistente → 404.
    const repetido = await request(app)
      .patch(`/api/cuentas/${cuenta.id}/visible`)
      .set(auth(tAdminT))
      .send({ visible_operador: false });
    expect(repetido.status).toBe(409);
    const invalido = await request(app)
      .patch(`/api/cuentas/${cuenta.id}/visible`)
      .set(auth(tAdminT))
      .send({ visible_operador: "sí" });
    expect(invalido.status).toBe(400);
    const inexistente = await request(app)
      .patch("/api/cuentas/999999/visible")
      .set(auth(tAdminT))
      .send({ visible_operador: true });
    expect(inexistente.status).toBe(404);

    // El operador no puede cambiar la visibilidad.
    const tOp = await login("operador", "operador");
    const prohibido = await request(app)
      .patch(`/api/cuentas/${cuenta.id}/visible`)
      .set(auth(tOp))
      .send({ visible_operador: true });
    expect(prohibido.status).toBe(403);

    const mostrar = await request(app)
      .patch(`/api/cuentas/${cuenta.id}/visible`)
      .set(auth(tAdminT))
      .send({ visible_operador: true });
    expect(mostrar.status).toBe(200);
    expect(mostrar.body.cuenta.visible_operador).toBe(1);

    // Bitácora de la acción.
    const tAud = await login("auditor", "auditor");
    const bit = await request(app).get("/api/auditoria").set(auth(tAud));
    const acciones = (bit.body.eventos as Array<{ accion: string }>).map((e) => e.accion);
    expect(acciones).toContain("cuenta_visibilidad");
  });

  it("el catálogo ligero trae visible_operador y la cuenta oculta sigue activa para capturar por API", async () => {
    const tAdminT = await login("admin_tesoreria", "admin_tesoreria");
    const cuenta = await cuentaPorNombre(tAdminT, "SOFOM 01");
    await request(app)
      .patch(`/api/cuentas/${cuenta.id}/visible`)
      .set(auth(tAdminT))
      .send({ visible_operador: false });

    // El catálogo sigue devolviendo las cuentas activas (la UI filtra las
    // ocultas del desplegable), ahora con la marca.
    const tOp = await login("operador", "operador");
    const cat = await request(app).get("/api/cuentas/catalogo").set(auth(tOp));
    expect(cat.status).toBe(200);
    const fila = (cat.body.cuentas as CuentaCat[]).find((x) => x.id === cuenta.id);
    expect(fila).toBeTruthy();
    expect(fila?.visible_operador).toBe(0);

    // La validación de fondo no cambia: la cuenta activa sigue siendo válida
    // como pagadora de línea (el control de visibilidad es de catálogo/UI).
    const res = await capturar(tOp, {
      destinos: [{ cuenta_id: cuenta.id }],
    });
    expect(res.status).toBe(201);
    const detalle = await request(app).get(`/api/operaciones/${res.body.operacion.id}`).set(auth(tOp));
    expect(detalle.status).toBe(200);
    expect(detalle.body.operacion.pagador).toBe("SOFOM 01");
  });
});

describe("Resguardo de TRF (la empresa) con tipo de cambio (Fase 13, ajuste al autorizarse)", () => {
  it("ingreso en MXN sin tipo de cambio y consulta de saldos (lo registra el admin)", async () => {
    // Ajuste del negocio: los ejecutivos ya no registran movimientos del
    // resguardo; los manuales son correcciones exclusivas del admin.
    const tAdmin = await login("admin", "admin");
    const res = await request(app)
      .post("/api/trf/resguardo")
      .set(auth(tAdmin))
      .send({ tipo: "ingreso", importe: 15000.5, notas: "comisión de la casa" });
    expect(res.status).toBe(201);
    expect(res.body.movimiento.moneda).toBe("MXN");
    expect(res.body.movimiento.tipo_cambio).toBeNull();

    const tTes = await login("tesoreria", "tesoreria");
    const resg = await request(app).get("/api/trf/resguardo").set(auth(tTes));
    expect(resg.status).toBe(200);
    expect(resg.body.saldos).toHaveLength(1);
    expect(resg.body.saldos[0].moneda).toBe("MXN");
    expect(resg.body.saldos[0].saldo).toBe(15000.5);
    expect(resg.body.equivalente_total_mxn).toBe(15000.5);
  });

  it("USD exige tipo de cambio y el equivalente en pesos se calcula con él", async () => {
    const tAdmin = await login("admin", "admin");
    const sinTC = await request(app)
      .post("/api/trf/resguardo")
      .set(auth(tAdmin))
      .send({ tipo: "ingreso", importe: 100, moneda: "USD" });
    expect(sinTC.status).toBe(400);
    expect(JSON.stringify(sinTC.body)).toContain("tipo_cambio");

    const conTC = await request(app)
      .post("/api/trf/resguardo")
      .set(auth(tAdmin))
      .send({ tipo: "ingreso", importe: 100, moneda: "usd", tipo_cambio: 18.5, notas: "banco BBVA" });
    expect(conTC.status).toBe(201);
    expect(conTC.body.movimiento.moneda).toBe("USD");
    expect(conTC.body.movimiento.tipo_cambio).toBe(18.5);
    expect(conTC.body.movimiento.equivalente_mxn).toBe(1850);

    const resg = await request(app).get("/api/trf/resguardo").set(auth(tAdmin));
    const usd = (resg.body.saldos as Array<{ moneda: string; saldo: number; equivalente_mxn: number }>).find(
      (s) => s.moneda === "USD"
    );
    expect(usd?.saldo).toBe(100);
    expect(usd?.equivalente_mxn).toBe(1850);
    expect(resg.body.equivalente_total_mxn).toBe(1850);
  });

  it("sólo el admin registra movimientos manuales; el ejecutivo ya ni ve el resguardo", async () => {
    const tOp = await login("operador", "operador");

    // El ejecutivo YA NO registra movimientos (ni siquiera ingresos): el
    // resguardo se modifica sólo con operaciones (pago especial / comisión TRF).
    const prohibido = await request(app)
      .post("/api/trf/resguardo")
      .set(auth(tOp))
      .send({ tipo: "ingreso", importe: 500, moneda: "USD", tipo_cambio: 18 });
    expect(prohibido.status).toBe(403);

    const retiroOp = await request(app)
      .post("/api/trf/resguardo")
      .set(auth(tOp))
      .send({ tipo: "retiro", importe: 100, moneda: "USD", tipo_cambio: 18 });
    expect(retiroOp.status).toBe(403);

    // Tesorería tampoco gestiona el resguardo (sólo lectura).
    const tTes = await login("tesoreria", "tesoreria");
    const tesorera = await request(app)
      .post("/api/trf/resguardo")
      .set(auth(tTes))
      .send({ tipo: "ingreso", importe: 10 });
    expect(tesorera.status).toBe(403);

    // El admin sí registra (correcciones) y el retiro no deja saldo negativo.
    const tAdmin = await login("admin", "admin");
    const ingreso = await request(app)
      .post("/api/trf/resguardo")
      .set(auth(tAdmin))
      .send({ tipo: "ingreso", importe: 500, moneda: "USD", tipo_cambio: 18 });
    expect(ingreso.status).toBe(201);

    const excede = await request(app)
      .post("/api/trf/resguardo")
      .set(auth(tAdmin))
      .send({ tipo: "retiro", importe: 500.01, moneda: "USD", tipo_cambio: 18 });
    expect(excede.status).toBe(409);
    expect(JSON.stringify(excede.body)).toContain("excede");

    const ok = await request(app)
      .post("/api/trf/resguardo")
      .set(auth(tAdmin))
      .send({ tipo: "retiro", importe: 200, moneda: "USD", tipo_cambio: 18, notas: "pago al proveedor" });
    expect(ok.status).toBe(201);

    const resg = await request(app).get("/api/trf/resguardo").set(auth(tAdmin));
    const usd = (resg.body.saldos as Array<{ moneda: string; saldo: number; equivalente_mxn: number }>).find(
      (s) => s.moneda === "USD"
    );
    expect(usd?.saldo).toBe(300);
    expect(usd?.equivalente_mxn).toBe(5400);
  });

  it("moneda inválida y operación inexistente se rechazan; el ejecutivo ya NO ve el ledger (sólo el saldo)", async () => {
    const tAdmin = await login("admin", "admin");
    const moneda = await request(app)
      .post("/api/trf/resguardo")
      .set(auth(tAdmin))
      .send({ tipo: "ingreso", importe: 10, moneda: "PESOS" });
    expect(moneda.status).toBe(400);

    const opFantasma = await request(app)
      .post("/api/trf/resguardo")
      .set(auth(tAdmin))
      .send({ tipo: "ingreso", importe: 10, operacion_id: 999999 });
    expect(opFantasma.status).toBe(400);

    // El ejecutivo NO ve el ledger del resguardo (ajuste del negocio).
    const tOp = await login("operador", "operador");
    const lectura = await request(app).get("/api/trf/resguardo").set(auth(tOp));
    expect(lectura.status).toBe(403);

    // Pero sí consulta el SALDO (sin movimientos) para capturar el pago especial.
    const saldoOp = await request(app).get("/api/trf/resguardo/saldo").set(auth(tOp));
    expect(saldoOp.status).toBe(200);
    expect(Array.isArray(saldoOp.body.saldos)).toBe(true);
    expect(saldoOp.body.movimientos).toBeUndefined();

    // Tesorería conserva la lectura del ledger para conciliar.
    const tTes = await login("tesoreria", "tesoreria");
    const deTesoreria = await request(app).get("/api/trf/resguardo").set(auth(tTes));
    expect(deTesoreria.status).toBe(200);
    // Un rol ajeno (validador simple) sigue fuera, del ledger y del saldo.
    const tVal = await login("validador", "validador");
    const prohibido = await request(app).get("/api/trf/resguardo").set(auth(tVal));
    expect(prohibido.status).toBe(403);
    const saldoVal = await request(app).get("/api/trf/resguardo/saldo").set(auth(tVal));
    expect(saldoVal.status).toBe(403);
  });

  it("un movimiento puede ligarse a una operación real y muestra su folio", async () => {
    const tOp = await login("operador", "operador");
    const tAdmin = await login("admin", "admin");
    const op = await capturar(tOp, { concepto: "Operación para TRF" });
    expect(op.status).toBe(201);
    const res = await request(app)
      .post("/api/trf/resguardo")
      .set(auth(tAdmin))
      .send({
        tipo: "ingreso",
        importe: 1000,
        moneda: "USD",
        tipo_cambio: 17.2,
        operacion_id: op.body.operacion.id,
        notas: "TC del banco en la operación",
      });
    expect(res.status).toBe(201);
    expect(res.body.movimiento.folio).toBe(op.body.operacion.folio);
    expect(res.body.movimiento.equivalente_mxn).toBe(17200);
  });
});

describe("Brokers múltiples por operación (verificación Fase 13)", () => {
  it("una operación se liga a dos brokers con sus porcentajes y la fotografía queda en el detalle", async () => {
    const tAdminOps = await login("admin_ops", "admin_ops");
    const b1 = await request(app)
      .post("/api/brokers")
      .set(auth(tAdminOps))
      .send({ nombre: "BROKER ALFA", porcentaje: 30 });
    const b2 = await request(app)
      .post("/api/brokers")
      .set(auth(tAdminOps))
      .send({ nombre: "BROKER BETA", porcentaje: 20 });
    expect(b1.status).toBe(201);
    expect(b2.status).toBe(201);

    const tOp = await login("operador", "operador");
    const res = await capturar(tOp, {
      concepto: "Operación con dos brokers",
      brokers: [
        { broker_id: b1.body.broker.id, porcentaje: 30 },
        { broker_id: b2.body.broker.id, porcentaje: 20 },
      ],
    });
    expect(res.status).toBe(201);
    // Comisión total 2.5% de 60000 = 1500; brokers 50% → 750.
    expect(res.body.calculos.comision_brokers).toBe(750);

    const detalle = await request(app).get(`/api/operaciones/${res.body.operacion.id}`).set(auth(tOp));
    expect(detalle.status).toBe(200);
    const brokers = detalle.body.brokers as Array<{ nombre: string; porcentaje: number; monto: number }>;
    expect(brokers).toHaveLength(2);
    expect(brokers.map((b) => b.nombre).sort()).toEqual(["BROKER ALFA", "BROKER BETA"]);
    expect(brokers.every((b) => b.monto > 0)).toBe(true);
  });
});
