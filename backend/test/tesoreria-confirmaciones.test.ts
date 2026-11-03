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

/** Cliente con asignación vigente al operador. */
async function clienteConAsignacion(nombre = "Cliente Confirmaciones SA"): Promise<number> {
  const tAdmin = await login("admin_ops", "admin_ops");
  const creacion = await request(app).post("/api/clientes").set(auth(tAdmin)).send({ nombre });
  expect(creacion.status).toBe(201);
  const clienteId = creacion.body.cliente.id as number;
  const tOperador = await login("operador", "operador");
  const idOp = (await request(app).get("/api/auth/me").set(auth(tOperador))).body.usuario.id as number;
  const asignacion = await request(app)
    .post(`/api/clientes/${clienteId}/asignaciones`)
    .set(auth(tAdmin))
    .send({ ejecutivo_id: idOp, motivo: "cuenta principal" });
  expect(asignacion.status).toBe(201);
  return clienteId;
}

/** Captura flujo con respaldo de depósitos (flujo 58,803; comisión 1,500). */
async function capturarFlujo(
  token: string,
  extras: Record<string, unknown> = {}
): Promise<{ id: number | null; res: request.Response }> {
  const res = await request(app)
    .post("/api/operaciones")
    .set(auth(token))
    .send({
      tipo: "flujo",
      concepto: "Flujo con respaldo",
      monto: 60000,
      fecha_operacion: "2026-10-26",
      pagador: "FLUJOS",
      tipo_operacion: "FLUJOS",
      timbrar: false,
      comision_pct: 2.5,
      dispersiones: [
        { beneficiario: "COMERCIAL BRAIN FENIX", cuenta: "6461803528523520323", banco: "STP", importe: 57000, etiqueta: "PROVEEDOR" },
        { beneficiario: "TRF CARD SAPI SA DE CV", cuenta: "646180352590100116", banco: "STP", importe: 303, etiqueta: "GASTOS" },
        { beneficiario: "MGN INTRUST", importe: 1500, etiqueta: "COMISION" },
      ],
      ...extras,
    });
  return { id: res.body?.operacion?.id ?? null, res };
}

/** Id del primer depósito pendiente de una operación. */
async function primerDeposito(operacionId: number): Promise<number> {
  const tAdmin = await login("admin", "admin");
  const det = await request(app).get(`/api/operaciones/${operacionId}`).set(auth(tAdmin));
  expect(det.status).toBe(200);
  const deps = det.body.depositos as Array<{ id: number; validado_por: number | null }>;
  return deps[0].id;
}

/** Operación pagada con broker participante; devuelve la comisión del broker. */
async function operacionPagadaConBroker(): Promise<{ operacionId: number; brokerId: number; comisionEsperada: number }> {
  const clienteId = await clienteConAsignacion("Cliente Brokers SA");
  const tOperador = await login("operador", "operador");
  const tAdminOps = await login("admin_ops", "admin_ops");
  const broker = await request(app)
    .post("/api/brokers")
    .set(auth(tAdminOps))
    .send({ nombre: "Broker Principal", porcentaje: 50 });
  expect(broker.status).toBe(201);
  const brokerId = broker.body.broker.id as number;

  // Cuenta del catálogo sembrado (FLUJOS 01) para el depósito de respaldo.
  const tAdminT = await login("admin_tesoreria", "admin_tesoreria");
  const catalogo = await request(app).get("/api/cuentas/catalogo").set(auth(tAdminT));
  const cuentaId = (catalogo.body.cuentas as Array<{ id: number; nombre: string }>).find((c) => c.nombre === "FLUJOS 01")!.id;

  const { id } = await capturarFlujo(tOperador, {
    cliente_id: clienteId,
    brokers: [{ broker_id: brokerId, porcentaje: 50 }],
    respaldo: { depositos: [{ cuenta_id: cuentaId, monto: 58803, comprobante: "SPEI-BR1" }] },
  });
  expect(id).not.toBeNull();
  const operacionId = id as number;

  await request(app).post(`/api/operaciones/${operacionId}/enviar-validacion`).set(auth(tOperador));
  const tValidador = await login("validador", "validador");
  await request(app)
    .post(`/api/operaciones/${operacionId}/revision`)
    .set(auth(tValidador))
    .send({ resultado: "aprobada", comentario: "en orden" });

  const depositoId = await primerDeposito(operacionId);
  await request(app).post(`/api/depositos/${depositoId}/comprobantes`).set(auth(tOperador)).send({
    comprobantes: [{ nombre: "spei.png", mime: "image/png", contenido: PNG }],
  });
  const tConfirmador = await login("confirmador", "confirmador");
  const val = await request(app).post(`/api/depositos/${depositoId}/validar`).set(auth(tConfirmador));
  expect(val.status).toBe(200);

  // Fase 12: el Fondeador libera y se registran las altas bancarias de las
  // líneas de dispersión (sin ellas Tesorería no dispersa).
  const liberar = await request(app).post(`/api/operaciones/${operacionId}/liberar`).set(auth(await login("fondeador", "fondeador")));
  expect(liberar.status).toBe(200);
  const det = await request(app).get(`/api/operaciones/${operacionId}`).set(auth(tOperador));
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

  const tTesoreria = await login("tesoreria", "tesoreria");
  const pago = await request(app)
    .post(`/api/operaciones/${operacionId}/pago`)
    .set(auth(tTesoreria))
    .send({ medio: "transferencia", monto: 58803, comprobante: "TRF-1", cuenta_id: cuentaId });
  expect(pago.status).toBe(201);
  expect(pago.body.completado).toBe(true);

  // Comisión total 1,500; el broker tiene 50% → 750 a su resguardo.
  return { operacionId, brokerId, comisionEsperada: 750 };
}

beforeEach(() => {
  db = abrirBase(":memory:");
  app = crearApp(db);
});

describe("rol Confirmador de Depósitos", () => {
  it("existe en la semilla y entra al sistema", async () => {
    const res = await request(app).post("/api/auth/login").send({ username: "confirmador", password: "confirmador" });
    expect(res.status).toBe(200);
    expect(res.body.usuario.rol).toBe("confirmador");
    expect(res.body.usuario.nombre).toBe("Confirmador de Depósitos");
  });

  it("consulta su cola de depósitos pendientes con conteo de comprobantes", async () => {
    const clienteId = await clienteConAsignacion();
    const tOperador = await login("operador", "operador");
    const tAdminT = await login("admin_tesoreria", "admin_tesoreria");
    const catalogo = await request(app).get("/api/cuentas/catalogo").set(auth(tAdminT));
    const cuentaId = (catalogo.body.cuentas as Array<{ id: number }>).find((c, i) => i === 0)!.id;
    const { id } = await capturarFlujo(tOperador, {
      cliente_id: clienteId,
      respaldo: { depositos: [{ cuenta_id: cuentaId, monto: 58803, comprobante: "SPEI-C1" }] },
    });
    expect(id).not.toBeNull();

    const tConfirmador = await login("confirmador", "confirmador");
    const cola = await request(app).get("/api/resguardos/depositos-pendientes").set(auth(tConfirmador));
    expect(cola.status).toBe(200);
    const fila = (cola.body.depositos as Array<Record<string, unknown>>).find((d) => d.operacion_id === id);
    expect(fila).toBeDefined();
    expect(fila!.comprobantes_count).toBe(0);
    expect(fila!.folio).toBeTruthy();
  });

  it("no puede validar un depósito sin comprobantes (409) y sí valida con ellos", async () => {
    const clienteId = await clienteConAsignacion();
    const tOperador = await login("operador", "operador");
    const tAdminT = await login("admin_tesoreria", "admin_tesoreria");
    const catalogo = await request(app).get("/api/cuentas/catalogo").set(auth(tAdminT));
    const cuentaId = (catalogo.body.cuentas as Array<{ id: number }>).find((c, i) => i === 0)!.id;
    const { id } = await capturarFlujo(tOperador, {
      cliente_id: clienteId,
      respaldo: { depositos: [{ cuenta_id: cuentaId, monto: 58803, comprobante: "SPEI-C2" }] },
    });
    const depositoId = await primerDeposito(id as number);
    const tConfirmador = await login("confirmador", "confirmador");

    const sinRespaldo = await request(app).post(`/api/depositos/${depositoId}/validar`).set(auth(tConfirmador));
    expect(sinRespaldo.status).toBe(409);
    expect(sinRespaldo.body.error).toContain("comprobantes");

    const subida = await request(app).post(`/api/depositos/${depositoId}/comprobantes`).set(auth(tOperador)).send({
      comprobantes: [
        { nombre: "spei-1.png", mime: "image/png", contenido: PNG },
        { nombre: "spei-2.png", mime: "image/png", contenido: PNG },
      ],
    });
    expect(subida.status).toBe(201);
    expect(subida.body.comprobantes).toHaveLength(2);

    const validacion = await request(app).post(`/api/depositos/${depositoId}/validar`).set(auth(tConfirmador));
    expect(validacion.status).toBe(200);
    expect(validacion.body.saldo).toBeCloseTo(58803, 2);
  });

  it("descarga el contenido del comprobante y la cola refleja el conteo", async () => {
    const clienteId = await clienteConAsignacion();
    const tOperador = await login("operador", "operador");
    const tAdminT = await login("admin_tesoreria", "admin_tesoreria");
    const catalogo = await request(app).get("/api/cuentas/catalogo").set(auth(tAdminT));
    const cuentaId = (catalogo.body.cuentas as Array<{ id: number }>).find((c, i) => i === 0)!.id;
    const { id } = await capturarFlujo(tOperador, {
      cliente_id: clienteId,
      respaldo: { depositos: [{ cuenta_id: cuentaId, monto: 58803, comprobante: "SPEI-C3" }] },
    });
    const depositoId = await primerDeposito(id as number);
    await request(app).post(`/api/depositos/${depositoId}/comprobantes`).set(auth(tOperador)).send({
      comprobantes: [{ nombre: "ficha.pdf", mime: "application/pdf", contenido: PNG }],
    });

    const tConfirmador = await login("confirmador", "confirmador");
    const lista = await request(app).get(`/api/depositos/${depositoId}/comprobantes`).set(auth(tConfirmador));
    expect(lista.status).toBe(200);
    expect(lista.body.comprobantes).toHaveLength(1);
    const comprobanteId = lista.body.comprobantes[0].id as number;

    const descarga = await request(app).get(`/api/comprobantes/${comprobanteId}`).set(auth(tConfirmador));
    expect(descarga.status).toBe(200);
    expect(descarga.body.comprobante.nombre).toBe("ficha.pdf");
    expect(Buffer.from(descarga.body.comprobante.contenido_base64, "base64").length).toBeGreaterThan(0);

    const cola = await request(app).get("/api/resguardos/depositos-pendientes").set(auth(tConfirmador));
    const fila = (cola.body.depositos as Array<{ id: number; comprobantes_count: number }>).find(
      (d) => d.id === depositoId
    );
    expect(fila!.comprobantes_count).toBe(1);
  });

  it("el validador de operaciones (rol validacion) no consulta comprobantes ni valida depósitos", async () => {
    const clienteId = await clienteConAsignacion();
    const tOperador = await login("operador", "operador");
    const tAdminT = await login("admin_tesoreria", "admin_tesoreria");
    const catalogo = await request(app).get("/api/cuentas/catalogo").set(auth(tAdminT));
    const cuentaId = (catalogo.body.cuentas as Array<{ id: number }>).find((c, i) => i === 0)!.id;
    const { id } = await capturarFlujo(tOperador, {
      cliente_id: clienteId,
      respaldo: { depositos: [{ cuenta_id: cuentaId, monto: 58803, comprobante: "SPEI-C4" }] },
    });
    const depositoId = await primerDeposito(id as number);
    const tValidacion = await login("validador", "validador");
    expect((await request(app).get(`/api/depositos/${depositoId}/comprobantes`).set(auth(tValidacion))).status).toBe(403);
    expect((await request(app).post(`/api/depositos/${depositoId}/validar`).set(auth(tValidacion))).status).toBe(403);
  });
});

describe("catálogo de cuentas por tipo (sólo el administrador crea)", () => {
  it("siembra 10 cuentas de flujos y 2 de cada otro tipo", async () => {
    const t = await login("admin_tesoreria", "admin_tesoreria");
    const res = await request(app).get("/api/cuentas").set(auth(t));
    expect(res.status).toBe(200);
    const cuentas = res.body.cuentas as Array<{ nombre: string; tipo: string }>;
    expect(cuentas.filter((c) => c.tipo === "flujo")).toHaveLength(10);
    expect(cuentas.filter((c) => c.tipo === "frente")).toHaveLength(2);
    expect(cuentas.filter((c) => c.tipo === "prestamo")).toHaveLength(2);
    expect(cuentas.filter((c) => c.tipo === "anticipo_rendimiento")).toHaveLength(2);
    expect(cuentas.filter((c) => c.tipo === "sofom")).toHaveLength(2);
    expect(cuentas.filter((c) => c.tipo === "asimilado")).toHaveLength(2);
    expect(cuentas.find((c) => c.nombre === "FLUJOS 01")!.tipo).toBe("flujo");
    expect(cuentas.find((c) => c.nombre === "SOFOM 02")!.tipo).toBe("sofom");
  });

  it("sólo admin_tesoreria y admin crean cuentas; el analista de tesorería no", async () => {
    const tT = await login("tesoreria", "tesoreria");
    const rechazo = await request(app).post("/api/cuentas").set(auth(tT)).send({ nombre: "NUEVA 1" });
    expect(rechazo.status).toBe(403);

    const tAT = await login("admin_tesoreria", "admin_tesoreria");
    const ok = await request(app)
      .post("/api/cuentas")
      .set(auth(tAT))
      .send({ nombre: "FRENTES 03", tipo: "frente", banco: "HSBC", saldo_inicial: 5000 });
    expect(ok.status).toBe(201);
    expect(ok.body.cuenta.tipo).toBe("frente");

    const tA = await login("admin", "admin");
    const okAdmin = await request(app).post("/api/cuentas").set(auth(tA)).send({ nombre: "SOFOM 03", tipo: "sofom" });
    expect(okAdmin.status).toBe(201);
  });

  it("rechaza un tipo inválido y omite el tipo por defecto (flujo)", async () => {
    const tAT = await login("admin_tesoreria", "admin_tesoreria");
    const malo = await request(app).post("/api/cuentas").set(auth(tAT)).send({ nombre: "X", tipo: "ahorro" });
    expect(malo.status).toBe(400);
    expect(malo.body.detalles.join(" ")).toContain("tipo");
    const ok = await request(app).post("/api/cuentas").set(auth(tAT)).send({ nombre: "FLUJOS 11" });
    expect(ok.status).toBe(201);
    expect(ok.body.cuenta.tipo).toBe("flujo");
  });
});

describe("asignación de cuentas a tesoreros (Administrador de Tesorería)", () => {
  it("asigna, reasigna conservando historial y el tesorero no puede autoasignarse", async () => {
    const tAT = await login("admin_tesoreria", "admin_tesoreria");
    const cuentas = (await request(app).get("/api/cuentas").set(auth(tAT))).body.cuentas as Array<{ id: number }>;
    const tesoreros = (await request(app).get("/api/usuarios/tesoreros").set(auth(tAT))).body.tesoreros as Array<{
      id: number;
      username: string;
    }>;
    const t1 = tesoreros.find((u) => u.username === "tesoreria")!;
    const t2 = tesoreros.find((u) => u.username === "tesoreria2") ?? t1;

    const alta = await request(app)
      .post(`/api/cuentas/${cuentas[0].id}/asignar`)
      .set(auth(tAT))
      .send({ tesorero_id: t1.id, motivo: "banca BBVA" });
    expect(alta.status).toBe(201);

    // Reasignación a otro tesorero (o re-apertura si sólo hay uno): append-only.
    const reasignacion = await request(app)
      .post(`/api/cuentas/${cuentas[0].id}/asignar`)
      .set(auth(tAT))
      .send({ tesorero_id: t2.id, motivo: "cambio de turno" });
    expect(reasignacion.status).toBe(201);

    const historial = await request(app).get(`/api/cuentas/${cuentas[0].id}/asignaciones`).set(auth(tAT));
    expect(historial.body.asignaciones).toHaveLength(2);
    expect(historial.body.asignaciones[0].activo).toBe(1);
    expect(historial.body.asignaciones[1].activo).toBe(0);

    const tT = await login("tesoreria", "tesoreria");
    const auto = await request(app).post(`/api/cuentas/${cuentas[1].id}/asignar`).set(auth(tT)).send({ tesorero_id: t1.id });
    expect(auto.status).toBe(403);
  });

  it("el tesorero con asignaciones sólo ve sus cuentas y sus movimientos", async () => {
    const tAT = await login("admin_tesoreria", "admin_tesoreria");
    const cuentas = (await request(app).get("/api/cuentas").set(auth(tAT))).body.cuentas as Array<{ id: number }>;
    const tesoreros = (await request(app).get("/api/usuarios/tesoreros").set(auth(tAT))).body.tesoreros as Array<{
      id: number;
    }>;
    await request(app).post(`/api/cuentas/${cuentas[0].id}/asignar`).set(auth(tAT)).send({ tesorero_id: tesoreros[0].id });

    // Movimiento en otra cuenta (el confirmador lo alimenta).
    const tConf = await login("confirmador", "confirmador");
    await request(app)
      .post(`/api/cuentas/${cuentas[5].id}/movimientos`)
      .set(auth(tConf))
      .send({ tipo: "deposito", monto: 1000, concepto: "ajuste" });

    const tT = await login("tesoreria", "tesoreria");
    const propias = await request(app).get("/api/cuentas").set(auth(tT));
    const lista = propias.body.cuentas as Array<{ id: number }>;
    expect(lista.length).toBeLessThan(22);
    expect(lista.map((c) => c.id)).toContain(cuentas[0].id);
    expect(lista.map((c) => c.id)).not.toContain(cuentas[5].id);

    const concentrado = await request(app).get("/api/movimientos").set(auth(tT));
    const movimientos = concentrado.body.movimientos as Array<{ cuenta_id: number }>;
    expect(movimientos.every((m) => m.cuenta_id === cuentas[0].id)).toBe(true);

    const ajena = await request(app)
      .post(`/api/cuentas/${cuentas[5].id}/movimientos`)
      .set(auth(tT))
      .send({ tipo: "deposito", monto: 50, concepto: "no permitido" });
    expect(ajena.status).toBe(403);
  });
});

describe("concentrado de movimientos (panel tipo Excel)", () => {
  it("tesorería, validador de tesorería y confirmador alimentan el concentrado; el origen queda registrado", async () => {
    const tAT = await login("admin_tesoreria", "admin_tesoreria");
    const cuentaId = ((await request(app).get("/api/cuentas").set(auth(tAT))).body.cuentas as Array<{ id: number }>)[0].id;

    const tT = await login("tesoreria", "tesoreria");
    const uno = await request(app)
      .post(`/api/cuentas/${cuentaId}/movimientos`)
      .set(auth(tT))
      .send({ tipo: "deposito", monto: 5000, concepto: "SPEI recibido", referencia: "AB-1", fecha: "2026-10-26" });
    expect(uno.status).toBe(201);
    expect(uno.body.movimiento.origen).toBe("tesoreria");

    const tVal = await login("val_tesoreria", "val_tesoreria");
    const lote = await request(app)
      .post(`/api/cuentas/${cuentaId}/movimientos/lote`)
      .set(auth(tVal))
      .send({
        movimientos: [
          { tipo: "deposito", monto: 1200.5, concepto: "depósito cliente", referencia: "R-1", fecha: "2026-10-27" },
          { tipo: "retiro", monto: 300, concepto: "comisión banco", referencia: "R-2", fecha: "2026-10-27" },
        ],
      });
    expect(lote.status).toBe(201);
    expect(lote.body.insertados).toBe(2);

    const tConf = await login("confirmador", "confirmador");
    const desdeConf = await request(app)
      .post(`/api/cuentas/${cuentaId}/movimientos`)
      .set(auth(tConf))
      .send({ tipo: "deposito", monto: 800, concepto: "aporte adicional" });
    expect(desdeConf.status).toBe(201);
    expect(desdeConf.body.movimiento.origen).toBe("confirmador");

    const loteMal = await request(app)
      .post(`/api/cuentas/${cuentaId}/movimientos/lote`)
      .set(auth(tConf))
      .send({ movimientos: [{ tipo: "deposito", monto: 10, concepto: "ok" }, { tipo: "extrano", monto: 5, concepto: "malo" }] });
    expect(loteMal.status).toBe(400);

    // Todo o nada: la fila inválida impidió insertar ninguna de ese lote.
    const tA = await login("admin", "admin");
    const todos = await request(app).get("/api/movimientos").set(auth(tA));
    const montos = (todos.body.movimientos as Array<{ monto: number }>).map((m) => m.monto);
    expect(montos).toContain(5000);
    expect(montos).not.toContain(10);
    expect(montos).not.toContain(5);
  });

  it("el ejecutivo de operaciones no alimenta el concentrado", async () => {
    const tOp = await login("operador", "operador");
    const tAT = await login("admin_tesoreria", "admin_tesoreria");
    const cuentaId = ((await request(app).get("/api/cuentas").set(auth(tAT))).body.cuentas as Array<{ id: number }>)[0].id;
    const res = await request(app)
      .post(`/api/cuentas/${cuentaId}/movimientos`)
      .set(auth(tOp))
      .send({ tipo: "deposito", monto: 100, concepto: "x" });
    expect(res.status).toBe(403);
  });

  it("el saldo de la cuenta refleja depósitos, retiros y pagos", async () => {
    const tT = await login("tesoreria", "tesoreria");
    const cuenta = (
      await request(app)
        .post("/api/cuentas")
        .set(auth(await login("admin_tesoreria", "admin_tesoreria")))
        .send({ nombre: "FLUJOS TEST", saldo_inicial: 10000 })
    ).body.cuenta as { id: number };
    await request(app).post(`/api/cuentas/${cuenta.id}/movimientos`).set(auth(tT)).send({ tipo: "deposito", monto: 2000, concepto: "a" });
    await request(app).post(`/api/cuentas/${cuenta.id}/movimientos`).set(auth(tT)).send({ tipo: "retiro", monto: 500, concepto: "b" });
    const detalle = await request(app).get(`/api/cuentas/${cuenta.id}`).set(auth(tT));
    expect(detalle.body.movimientos.length).toBeGreaterThanOrEqual(2);
    const lista = await request(app).get("/api/cuentas").set(auth(tT));
    const fila = (lista.body.cuentas as Array<{ id: number; saldo_actual: number }>).find((c) => c.id === cuenta.id);
    expect(fila!.saldo_actual).toBeCloseTo(11500, 2);
  });
});

describe("marcas de trabajo sobre el concentrado (confirmador)", () => {
  async function preparar(): Promise<{ cuentaId: number; movimientoId: number; depositoId: number; operacionId: number }> {
    const clienteId = await clienteConAsignacion();
    const tOperador = await login("operador", "operador");
    const tAT = await login("admin_tesoreria", "admin_tesoreria");
    const catalogo = await request(app).get("/api/cuentas/catalogo").set(auth(tAT));
    const cuentaId = (catalogo.body.cuentas as Array<{ id: number }>).find((c, i) => i === 0)!.id;
    const { id } = await capturarFlujo(tOperador, {
      cliente_id: clienteId,
      respaldo: { depositos: [{ cuenta_id: cuentaId, monto: 58803, comprobante: "SPEI-M1" }] },
    });
    const depositoId = await primerDeposito(id as number);
    const tT = await login("tesoreria", "tesoreria");
    const mov = await request(app)
      .post(`/api/cuentas/${cuentaId}/movimientos`)
      .set(auth(tT))
      .send({ tipo: "deposito", monto: 58803, concepto: "SPEI entrante cliente", referencia: "MM-1" });
    return { cuentaId, movimientoId: mov.body.movimiento.id as number, depositoId, operacionId: id as number };
  }

  it("el confirmador marca el movimiento con el depósito y comentario; quitar marca queda en bitácora", async () => {
    const { movimientoId, depositoId } = await preparar();
    const tConf = await login("confirmador", "confirmador");

    const sinDatos = await request(app).post(`/api/movimientos/${movimientoId}/marca`).set(auth(tConf)).send({});
    expect(sinDatos.status).toBe(400);

    const marca = await request(app)
      .post(`/api/movimientos/${movimientoId}/marca`)
      .set(auth(tConf))
      .send({ deposito_id: depositoId, comentario: "Confirmado contra ficha SPEI del cliente" });
    expect(marca.status).toBe(200);
    expect(marca.body.movimiento.deposito_id).toBe(depositoId);
    expect(marca.body.movimiento.marca).toContain("Confirmado contra ficha");
    expect(marca.body.movimiento.marcado_por_nombre).toBeTruthy();

    // Retiros no se marcan contra depósitos.
    const tT = await login("tesoreria", "tesoreria");
    const cuentaId = marca.body.movimiento.cuenta_id as number;
    const retiro = await request(app)
      .post(`/api/cuentas/${cuentaId}/movimientos`)
      .set(auth(tT))
      .send({ tipo: "retiro", monto: 100, concepto: "comisión" });
    const marcaRetiro = await request(app)
      .post(`/api/movimientos/${retiro.body.movimiento.id}/marca`)
      .set(auth(tConf))
      .send({ deposito_id: depositoId, comentario: "x" });
    expect(marcaRetiro.status).toBe(400);

    const desmarcar = await request(app).delete(`/api/movimientos/${movimientoId}/marca`).set(auth(tConf));
    expect(desmarcar.status).toBe(200);
    const bitacora = await request(app).get("/api/auditoria").set(auth(await login("admin", "admin")));
    const acciones = (bitacora.body.eventos as Array<{ accion: string }>).map((e) => e.accion);
    expect(acciones).toContain("movimiento_marcado");
    expect(acciones).toContain("movimiento_desmarcado");
  });

  it("la versión LIMPIA de auditoría y Dirección no muestra marcas; tesorería sí las ve", async () => {
    const { movimientoId, depositoId } = await preparar();
    const tConf = await login("confirmador", "confirmador");
    await request(app)
      .post(`/api/movimientos/${movimientoId}/marca`)
      .set(auth(tConf))
      .send({ deposito_id: depositoId, comentario: "trabajo interno" });

    const tT = await login("tesoreria", "tesoreria");
    const copiaTrabajo = await request(app).get("/api/movimientos").set(auth(tT));
    expect(copiaTrabajo.body.version_limpia).toBe(false);
    const conMarca = (copiaTrabajo.body.movimientos as Array<Record<string, unknown>>).find((m) => m.id === movimientoId);
    expect(conMarca!.marca).toBe("trabajo interno");
    expect(conMarca!.deposito_id).toBe(depositoId);

    for (const [usuario, clave] of [["auditor", "auditor"], ["direccion", "direccion"]] as const) {
      const tLimpio = await login(usuario, clave);
      const limpia = await request(app).get("/api/movimientos").set(auth(tLimpio));
      expect(limpia.body.version_limpia).toBe(true);
      const fila = (limpia.body.movimientos as Array<Record<string, unknown>>).find((m) => m.id === movimientoId);
      expect(fila!.marca).toBe("");
      expect(fila!.deposito_id).toBeNull();
      expect(fila!.marcado_por).toBeNull();
    }

    // Auditoría y Dirección no pueden marcar ni desmarcar.
    const tAud = await login("auditor", "auditor");
    expect((await request(app).post(`/api/movimientos/${movimientoId}/marca`).set(auth(tAud)).send({ comentario: "x" })).status).toBe(403);
  });
});

describe("comprobantes de depósitos (reglas documentales)", () => {
  async function depositoConCuenta(): Promise<{ operacionId: number; depositoId: number }> {
    const clienteId = await clienteConAsignacion();
    const tOperador = await login("operador", "operador");
    const tAT = await login("admin_tesoreria", "admin_tesoreria");
    const catalogo = await request(app).get("/api/cuentas/catalogo").set(auth(tAT));
    const cuentaId = (catalogo.body.cuentas as Array<{ id: number }>).find((c, i) => i === 0)!.id;
    const { id } = await capturarFlujo(tOperador, {
      cliente_id: clienteId,
      respaldo: { depositos: [{ cuenta_id: cuentaId, monto: 58803, comprobante: "SPEI-DOC" }] },
    });
    return { operacionId: id as number, depositoId: await primerDeposito(id as number) };
  }

  it("rechaza lotes sin archivos, con base64 vacío y excede el máximo por depósito", async () => {
    const { depositoId } = await depositoConCuenta();
    const tOp = await login("operador", "operador");
    const vacio = await request(app).post(`/api/depositos/${depositoId}/comprobantes`).set(auth(tOp)).send({ comprobantes: [] });
    expect(vacio.status).toBe(400);
    const sinContenido = await request(app)
      .post(`/api/depositos/${depositoId}/comprobantes`)
      .set(auth(tOp))
      .send({ comprobantes: [{ nombre: "a.png", mime: "image/png", contenido: "" }] });
    expect(sinContenido.status).toBe(400);
    const once = Array.from({ length: 11 }, (_, i) => ({ nombre: `f${i}.png`, mime: "image/png", contenido: PNG }));
    const exceso = await request(app).post(`/api/depositos/${depositoId}/comprobantes`).set(auth(tOp)).send({ comprobantes: once });
    expect(exceso.status).toBe(400);
    expect(exceso.body.error).toContain("Máximo 10");
  });

  it("quita un comprobante pendiente y bloquea cambios sobre el depósito ya validado", async () => {
    const { depositoId } = await depositoConCuenta();
    const tOp = await login("operador", "operador");
    const alta = await request(app)
      .post(`/api/depositos/${depositoId}/comprobantes`)
      .set(auth(tOp))
      .send({ comprobantes: [{ nombre: "uno.png", mime: "image/png", contenido: PNG }] });
    const id1 = alta.body.comprobantes[0].id as number;
    await request(app)
      .post(`/api/depositos/${depositoId}/comprobantes`)
      .set(auth(tOp))
      .send({ comprobantes: [{ nombre: "dos.png", mime: "image/png", contenido: PNG }] });

    const baja = await request(app).delete(`/api/comprobantes/${id1}`).set(auth(tOp));
    expect(baja.status).toBe(200);

    const tConf = await login("confirmador", "confirmador");
    expect((await request(app).post(`/api/depositos/${depositoId}/validar`).set(auth(tConf))).status).toBe(200);

    const trasValidar = await request(app)
      .post(`/api/depositos/${depositoId}/comprobantes`)
      .set(auth(tOp))
      .send({ comprobantes: [{ nombre: "tres.png", mime: "image/png", contenido: PNG }] });
    expect(trasValidar.status).toBe(409);
    const lista = await request(app).get(`/api/depositos/${depositoId}/comprobantes`).set(auth(tOp));
    expect(lista.body.comprobantes).toHaveLength(1);
  });

  it("validar el depósito genera movimiento bancario y suma al resguardo del cliente", async () => {
    const { depositoId } = await depositoConCuenta();
    const tOp = await login("operador", "operador");
    await request(app)
      .post(`/api/depositos/${depositoId}/comprobantes`)
      .set(auth(tOp))
      .send({ comprobantes: [{ nombre: "ficha.png", mime: "image/png", contenido: PNG }] });
    const tConf = await login("confirmador", "confirmador");
    const ok = await request(app).post(`/api/depositos/${depositoId}/validar`).set(auth(tConf));
    expect(ok.status).toBe(200);
    expect(ok.body.saldo).toBeCloseTo(58803, 2);
    // Doble validación → 409.
    const otra = await request(app).post(`/api/depositos/${depositoId}/validar`).set(auth(tConf));
    expect(otra.status).toBe(409);
  });
});

describe("resguardos de brokers (comisiones cobradas)", () => {
  it("la comisión del broker entra a su resguardo cuando la operación queda PAGADA", async () => {
    const { brokerId, comisionEsperada } = await operacionPagadaConBroker();
    const tAT = await login("admin_tesoreria", "admin_tesoreria");
    const res = await request(app).get("/api/brokers/resguardos").set(auth(tAT));
    expect(res.status).toBe(200);
    const fila = (res.body.resguardos as Array<Record<string, unknown>>).find((r) => r.broker_id === brokerId);
    expect(fila!.comisiones).toBeCloseTo(comisionEsperada, 2);
    expect(fila!.saldo).toBeCloseTo(comisionEsperada, 2);
    expect((fila!.movimientos as Array<Record<string, unknown>>).some((m) => m.tipo === "comision")).toBe(true);
  });

  it("los retiros disminuyen el resguardo y no pueden exceder el saldo", async () => {
    const { brokerId, comisionEsperada } = await operacionPagadaConBroker();
    const tAT = await login("admin_tesoreria", "admin_tesoreria");

    const excesivo = await request(app)
      .post(`/api/brokers/${brokerId}/retiros`)
      .set(auth(tAT))
      .send({ monto: comisionEsperada + 1, notas: "no debe proceder" });
    expect(excesivo.status).toBe(409);

    const retiro = await request(app)
      .post(`/api/brokers/${brokerId}/retiros`)
      .set(auth(tAT))
      .send({ monto: 250, notas: "pago de comisión" });
    expect(retiro.status).toBe(201);
    expect(retiro.body.saldo).toBeCloseTo(comisionEsperada - 250, 2);

    const res = await request(app).get("/api/brokers/resguardos").set(auth(tAT));
    const fila = (res.body.resguardos as Array<Record<string, unknown>>).find((r) => r.broker_id === brokerId);
    expect(fila!.retiros).toBeCloseTo(250, 2);
    expect(fila!.saldo).toBeCloseTo(comisionEsperada - 250, 2);
  });

  it("permisos: tesorería (analista) no consulta resguardos de brokers; admin_operaciones sí puede retirar", async () => {
    const { brokerId } = await operacionPagadaConBroker();
    const tT = await login("tesoreria", "tesoreria");
    expect((await request(app).get("/api/brokers/resguardos").set(auth(tT))).status).toBe(403);

    const tAO = await login("admin_ops", "admin_ops");
    const consulta = await request(app).get("/api/brokers/resguardos").set(auth(tAO));
    expect(consulta.status).toBe(200);
    const retiro = await request(app).post(`/api/brokers/${brokerId}/retiros`).set(auth(tAO)).send({ monto: 100 });
    expect(retiro.status).toBe(201);
  });
});

describe("listado de operaciones con respaldos y cuadre (validador de tesorería)", () => {
  it("muestra resguardo, depósitos, financiamientos y el cuadre; el confirmador y Dirección lo consultan", async () => {
    const clienteId = await clienteConAsignacion();
    const tOperador = await login("operador", "operador");
    const tAT = await login("admin_tesoreria", "admin_tesoreria");
    const catalogo = await request(app).get("/api/cuentas/catalogo").set(auth(tAT));
    const cuentaId = (catalogo.body.cuentas as Array<{ id: number }>).find((c, i) => i === 0)!.id;
    const { id } = await capturarFlujo(tOperador, {
      cliente_id: clienteId,
      respaldo: { depositos: [{ cuenta_id: cuentaId, monto: 58803, comprobante: "SPEI-R1" }] },
    });
    const operacionId = id as number;

    const tVal = await login("val_tesoreria", "val_tesoreria");
    const lista = await request(app).get("/api/operaciones/respaldos").set(auth(tVal));
    expect(lista.status).toBe(200);
    let fila = (lista.body.operaciones as Array<Record<string, unknown>>).find((o) => o.id === operacionId);
    expect(fila).toBeDefined();
    expect(fila!.depositos_pendientes).toBeCloseTo(58803, 2);
    expect(fila!.depositos_validados).toBeCloseTo(0, 2);
    expect(fila!.cuadre).toBe(false);
    expect(fila!.depositos_sin_comprobante).toBe(1);

    // Validar el depósito con comprobante: el cuadre se vuelve VERDADERO.
    await request(app)
      .post(`/api/depositos/${await primerDeposito(operacionId)}/comprobantes`)
      .set(auth(tOperador))
      .send({ comprobantes: [{ nombre: "f.png", mime: "image/png", contenido: PNG }] });
    const tConf = await login("confirmador", "confirmador");
    await request(app).post(`/api/depositos/${await primerDeposito(operacionId)}/validar`).set(auth(tConf));

    const lista2 = await request(app).get("/api/operaciones/respaldos").set(auth(tConf));
    fila = (lista2.body.operaciones as Array<Record<string, unknown>>).find((o) => o.id === operacionId);
    expect(fila!.depositos_validados).toBeCloseTo(58803, 2);
    expect(fila!.cuadre).toBe(true);

    const tDir = await login("direccion", "direccion");
    expect((await request(app).get("/api/operaciones/respaldos").set(auth(tDir))).status).toBe(200);
    const tValidacion = await login("validador", "validador");
    expect((await request(app).get("/api/operaciones/respaldos").set(auth(tValidacion))).status).toBe(403);
  });
});
