import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Database } from "better-sqlite3";
import { crearApp } from "../src/app.js";
import { abrirBase } from "../src/db.js";

/**
 * Fase 12 — Altas bancarias (rol 'altas' — Tesorería de Altas):
 *   · El Ejecutivo solicita el registro de la cuenta del beneficiario en el
 *     banco (desde la línea de dispersión de su operación o manual).
 *   · La base conserva fecha, solicitante, moneda y banco.
 *   · Tesorería de Altas registra (portal bancario) o rechaza (con motivo).
 *   · Tesorería NO dispersa a cuentas sin alta registrada (409 con detalle).
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

/** Captura FLUJO con 2 líneas con datos bancarios y 1 sin ellos. */
async function capturarFlujo(token: string): Promise<{ id: number; dispersiones: Array<{ id: number; beneficiario: string; banco: string; cuenta: string; importe: number }> }> {
  const res = await request(app)
    .post("/api/operaciones")
    .set(auth(token))
    .send({
      tipo: "flujo",
      concepto: "Flujo con altas",
      monto: 60000,
      fecha_operacion: hoy(),
      pagador: "FLUJOS",
      tipo_operacion: "FLUJOS",
      timbrar: false,
      comision_pct: 2.5,
      dispersiones: [
        { beneficiario: "COMERCIAL BRAIN FENIX", cuenta: "6461803528523520323", banco: "STP", importe: 57000, etiqueta: "PROVEEDOR" },
        { beneficiario: "TRF CARD SAPI SA DE CV", cuenta: "646180352590100116", banco: "STP", importe: 303, etiqueta: "GASTOS" },
        { beneficiario: "MGN INTRUST", importe: 1500, etiqueta: "COMISION" },
      ],
    });
  expect(res.status).toBe(201);
  const id = res.body.operacion.id as number;
  const det = await request(app).get(`/api/operaciones/${id}`).set(auth(token));
  return { id, dispersiones: det.body.altas_dispersiones };
}

/** Lleva la operación a 'aprobada' y la libera el Fondeador. */
async function aprobarYLiberar(id: number): Promise<void> {
  await request(app).post(`/api/operaciones/${id}/enviar-validacion`).set(auth(await login("operador", "operador")));
  const rev = await request(app)
    .post(`/api/operaciones/${id}/revision`)
    .set(auth(await login("validador", "validador")))
    .send({ resultado: "aprobada", comentario: "ok" });
  expect(rev.status).toBe(200);
  const liberar = await request(app).post(`/api/operaciones/${id}/liberar`).set(auth(await login("fondeador", "fondeador")));
  expect(liberar.status).toBe(200);
}

beforeEach(() => {
  db = abrirBase(":memory:");
  app = crearApp(db);
});

describe("Solicitud de altas (Ejecutivo de Operaciones)", () => {
  it("solicita el alta desde una línea de dispersión y la base guarda fecha, quién, moneda y banco", async () => {
    const tOp = await login("operador", "operador");
    const { id, dispersiones } = await capturarFlujo(tOp);
    // 2 líneas verificables (STP + cuenta), 1 sin datos bancarios.
    const verificables = dispersiones.filter((d) => d.verificable);
    expect(verificables).toHaveLength(2);
    expect(verificables.every((d) => !d.registrada)).toBe(true);

    const solicitud = await request(app)
      .post("/api/altas-bancarias")
      .set(auth(tOp))
      .send({ operacion_id: id, dispersion_id: verificables[0].dispersion_id });
    expect(solicitud.status).toBe(201);
    expect(solicitud.body.alta.estado).toBe("solicitada");
    expect(solicitud.body.alta.beneficiario).toBe("COMERCIAL BRAIN FENIX");
    expect(solicitud.body.alta.banco).toBe("STP");
    expect(solicitud.body.alta.moneda).toBe("MXN");

    // Duplicada → 409; y la base del operador muestra su solicitud con folio.
    const duplicada = await request(app)
      .post("/api/altas-bancarias")
      .set(auth(tOp))
      .send({ dispersion_id: verificables[0].dispersion_id });
    expect(duplicada.status).toBe(409);

    const base = await request(app).get("/api/altas-bancarias").set(auth(tOp));
    expect(base.status).toBe(200);
    expect(base.body.altas).toHaveLength(1);
    expect(base.body.altas[0].folio).toBeTruthy();
    expect(base.body.altas[0].solicitador).toBe("Ejecutivo de Operaciones");
    expect(base.body.altas[0].creado_en).toBeTruthy();

    // El detalle de la operación ya marca la línea como 'solicitada'.
    const det = await request(app).get(`/api/operaciones/${id}`).set(auth(tOp));
    const linea = det.body.altas_dispersiones.find((d: { dispersion_id: number }) => d.dispersion_id === verificables[0].dispersion_id);
    expect(linea.estado_alta).toBe("solicitada");
  });

  it("alta manual con datos incompletos → 400 y sin alcance en operaciones ajenas", async () => {
    const tOp = await login("operador", "operador");
    const incompleta = await request(app)
      .post("/api/altas-bancarias")
      .set(auth(tOp))
      .send({ beneficiario: "X", banco: "BBVA" });
    expect(incompleta.status).toBe(400);
    expect(incompleta.body.detalles).toContain("cuenta (número de cuenta o CLABE) requerida");

    const tSis = await login("admin", "admin");
    await request(app)
      .post("/api/usuarios")
      .set(auth(tSis))
      .send({ username: "ops2", nombre: "Segundo Ejecutivo", rol: "operacion", password: "clave4" });
    const tOp2 = await login("ops2", "clave4");
    const res = await request(app)
      .post("/api/operaciones")
      .set(auth(tOp2))
      .send({
        tipo: "flujo",
        concepto: "Ajena",
        monto: 1000,
        fecha_operacion: hoy(),
        pagador: "FLUJOS",
        tipo_operacion: "FLUJOS",
        comision_pct: 0,
        dispersiones: [{ beneficiario: "B", cuenta: "123", banco: "BBVA", importe: 1000 }],
      });
    expect(res.status).toBe(201);
    const ajena = await request(app)
      .post("/api/altas-bancarias")
      .set(auth(tOp))
      .send({ operacion_id: res.body.operacion.id, beneficiario: "B", banco: "BBVA", cuenta: "123" });
    expect(ajena.status).toBe(403);
  });
});

describe("Registro por Tesorería de Altas y bloqueo de pagos", () => {
  it("sin altas registradas Tesorería no dispersa (409 con detalle); al registrarlas, el pago pasa", async () => {
    const tOp = await login("operador", "operador");
    const { id, dispersiones } = await capturarFlujo(tOp);
    await aprobarYLiberar(id);
    const tTes = await login("tesoreria", "tesoreria");
    const tAltas = await login("altas", "altas");

    // Pago bloqueado: 2 cuentas sin alta (la línea sin banco no bloquea).
    const pagoBloqueado = await request(app)
      .post(`/api/operaciones/${id}/pago`)
      .set(auth(tTes))
      .send({ medio: "transferencia", monto: 58500, comprobante: "TRF-1" });
    expect(pagoBloqueado.status).toBe(409);
    expect(pagoBloqueado.body.error).toMatch(/2 cuenta\(s\) sin alta bancaria registrada/);
    expect(pagoBloqueado.body.altas_pendientes).toHaveLength(2);

    // El lote también bloquea.
    const loteBloqueado = await request(app)
      .post(`/api/operaciones/${id}/pagos`)
      .set(auth(tTes))
      .send({ pagos: [{ monto: 57000, comprobante: "L-1" }] });
    expect(loteBloqueado.status).toBe(409);

    // El operador solicita las 2 altas; Altas registra UNA.
    for (const d of dispersiones.filter((x) => x.verificable)) {
      const sol = await request(app)
        .post("/api/altas-bancarias")
        .set(auth(tOp))
        .send({ dispersion_id: d.dispersion_id });
      expect(sol.status).toBe(201);
    }
    const cola = await request(app).get("/api/altas-bancarias?estado=solicitada").set(auth(tAltas));
    expect(cola.body.altas).toHaveLength(2);
    const primera = cola.body.altas[0];
    const registrar = await request(app).post(`/api/altas-bancarias/${primera.id}/registrada`).set(auth(tAltas));
    expect(registrar.status).toBe(200);
    expect(registrar.body.alta.estado).toBe("registrada");
    expect(registrar.body.alta.resuelto_en).toBeTruthy();

    // Con una sola registrada sigue bloqueado (1 pendiente).
    const pagoParcial = await request(app)
      .post(`/api/operaciones/${id}/pago`)
      .set(auth(tTes))
      .send({ medio: "transferencia", monto: 58500, comprobante: "TRF-2" });
    expect(pagoParcial.status).toBe(409);
    expect(pagoParcial.body.altas_pendientes).toHaveLength(1);

    // Registro la segunda → el pago pasa (tanda parcial → en_pago).
    const pendientes = await request(app).get("/api/altas-bancarias?estado=solicitada").set(auth(tAltas));
    const segunda = pendientes.body.altas[0];
    await request(app).post(`/api/altas-bancarias/${segunda.id}/registrada`).set(auth(tAltas));
    const pago = await request(app)
      .post(`/api/operaciones/${id}/pago`)
      .set(auth(tTes))
      .send({ medio: "transferencia", monto: 30000, comprobante: "TRF-3" });
    expect(pago.status).toBe(201);
    expect(pago.body.operacion.estado).toBe("en_pago");
  });

  it("rechazo con motivo, permisos y doble registro impedido", async () => {
    const tOp = await login("operador", "operador");
    const sol = await request(app)
      .post("/api/altas-bancarias")
      .set(auth(tOp))
      .send({ beneficiario: "BENEFICIARIO MANUAL", banco: "BBVA", moneda: "USD", cuenta: "0012345678", notas: "proveedor nuevo" });
    expect(sol.status).toBe(201);
    const altaId = sol.body.alta.id as number;
    const tAltas = await login("altas", "altas");

    // Rechazar sin motivo → 400; con motivo → rechazada.
    const sinMotivo = await request(app).post(`/api/altas-bancarias/${altaId}/rechazar`).set(auth(tAltas));
    expect(sinMotivo.status).toBe(400);
    const rechazo = await request(app)
      .post(`/api/altas-bancarias/${altaId}/rechazar`)
      .set(auth(tAltas))
      .send({ motivo: "Datos bancarios incorrectos" });
    expect(rechazo.status).toBe(200);
    expect(rechazo.body.alta.estado).toBe("rechazada");
    expect(rechazo.body.alta.motivo_rechazo).toBe("Datos bancarios incorrectos");

    // Rechazada permite volver a solicitar (no hay vigente).
    const otra = await request(app)
      .post("/api/altas-bancarias")
      .set(auth(tOp))
      .send({ beneficiario: "BENEFICIARIO MANUAL", banco: "BBVA", cuenta: "0012345678" });
    expect(otra.status).toBe(201);

    // Permisos: sólo altas/admin_tesoreria/admin registran; el operador no.
    const idNueva = otra.body.alta.id as number;
    const operadorNo = await request(app).post(`/api/altas-bancarias/${idNueva}/registrada`).set(auth(tOp));
    expect(operadorNo.status).toBe(403);
    const adminT = await login("admin_tesoreria", "admin_tesoreria");
    const porAdminT = await request(app).post(`/api/altas-bancarias/${idNueva}/registrada`).set(auth(adminT));
    expect(porAdminT.status).toBe(200);
    // Ya registrada → duplicada 409 y el operador no puede volver a solicitarla.
    const duplicada = await request(app).post(`/api/altas-bancarias/${idNueva}/registrada`).set(auth(tAltas));
    expect(duplicada.status).toBe(409);
    const solicitudRepetida = await request(app)
      .post("/api/altas-bancarias")
      .set(auth(tOp))
      .send({ beneficiario: "BENEFICIARIO MANUAL", banco: "bbva", cuenta: "00 1234-5678" });
    expect(solicitudRepetida.status).toBe(409);
    expect(solicitudRepetida.body.error).toMatch(/ya está registrada/i);

    // El validador no consulta la base de altas.
    const validador = await request(app).get("/api/altas-bancarias").set(auth(await login("validador", "validador")));
    expect(validador.status).toBe(403);
  });
});
