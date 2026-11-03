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
  // Fase 12: el Fondeador libera y se registran las altas bancarias de las
  // líneas de dispersión (sin ellas Tesorería no dispersa).
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

/** Cliente con asignación vigente al operador. */
async function clienteConAsignacion(): Promise<number> {
  const tAdmin = await login("admin_ops", "admin_ops");
  const creacion = await request(app).post("/api/clientes").set(auth(tAdmin)).send({ nombre: "Cliente Respaldo SA" });
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

/** Cuenta bancaria creada por el Administrador de Tesorería (sólo él crea cuentas). */
async function crearCuenta(nombre = "STP Respaldos"): Promise<number> {
  const tAdmin = await login("admin_tesoreria", "admin_tesoreria");
  const cuenta = await request(app).post("/api/cuentas").set(auth(tAdmin)).send({ nombre, banco: "STP" });
  expect(cuenta.status).toBe(201);
  return cuenta.body.cuenta.id as number;
}

/** Captura flujo con los números del negocio (57,000 + 303 + 1,500 = 58,803).
 * Devuelve el id de la operación (o null si no se creó). */
async function capturarFlujo(token: string, extras: Record<string, unknown> = {}): Promise<number | null> {
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
  return res.body?.operacion?.id ?? null;
}

beforeEach(() => {
  db = abrirBase(":memory:");
  app = crearApp(db);
});

describe("respaldo obligatorio al capturar (§6.1)", () => {
  it("captura con cliente sin resguardo ni respaldo → 400 con faltante", async () => {
    const clienteId = await clienteConAsignacion();
    const tOperador = await login("operador", "operador");
    expect(await capturarFlujo(tOperador, { cliente_id: clienteId })).toBeNull();
    // Con el detalle del faltante: flujo 58,803 vs disponible 0
    const res = await request(app)
      .post("/api/operaciones")
      .set(auth(tOperador))
      .send({
        tipo: "flujo",
        concepto: "x",
        monto: 60000,
        fecha_operacion: "2026-10-26",
        pagador: "FLUJOS",
        tipo_operacion: "FLUJOS",
        comision_pct: 2.5,
        cliente_id: clienteId,
        dispersiones: [{ beneficiario: "A", importe: 58803 }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Respaldo insuficiente");
    expect(res.body.respaldo.faltante).toBeCloseTo(58803, 2);
  });

  it("varios depósitos en la captura cubren el flujo; quedan pendientes y el detalle los lista con la balanza", async () => {
    const clienteId = await clienteConAsignacion();
    const cuentaId = await crearCuenta();
    const tOperador = await login("operador", "operador");
    const id = await capturarFlujo(tOperador, {
      cliente_id: clienteId,
      respaldo: {
        depositos: [
          { cuenta_id: cuentaId, monto: 40000, comprobante: "SPEI-A1" },
          { cuenta_id: cuentaId, monto: 18803, comprobante: "SPEI-A2", fecha_deposito: "2026-10-25" },
        ],
      },
    });
    expect(id).not.toBeNull();
    const detalle = await request(app).get(`/api/operaciones/${id}`).set(auth(tOperador));
    expect(detalle.body.depositos).toHaveLength(2);
    expect(detalle.body.depositos[0].comprobante).toBe("SPEI-A1");
    expect(detalle.body.depositos[1].fecha_deposito).toBe("2026-10-25");
    expect(detalle.body.respaldo).toMatchObject({
      saldo_resguardo: 0,
      depositos_pendientes: 58803,
      financiamiento_solicitado: 0,
      disponible: 58803,
      requerido: 58803,
      faltante: 0,
    });
    // Cola de Tesorería: una fila por depósito
    const pendientes = await request(app).get("/api/resguardos/depositos-pendientes").set(auth(await login("val_tesoreria", "val_tesoreria")));
    expect(pendientes.body.depositos).toHaveLength(2);
  });

  it("validación por fila y en lote: cada depósito suma su movimiento bancario y de resguardo", async () => {
    const clienteId = await clienteConAsignacion();
    const cuentaId = await crearCuenta();
    const tOperador = await login("operador", "operador");
    const id = await capturarFlujo(tOperador, {
      cliente_id: clienteId,
      respaldo: {
        depositos: [
          { cuenta_id: cuentaId, monto: 40000, comprobante: "SPEI-B1" },
          { cuenta_id: cuentaId, monto: 18803, comprobante: "SPEI-B2" },
        ],
      },
    });
    expect(id).not.toBeNull();
    const detalle = await request(app).get(`/api/operaciones/${id}`).set(auth(tOperador));
    const dep1 = detalle.body.depositos[0];
    const tValTes = await login("val_tesoreria", "val_tesoreria");

    // El respaldo documental es obligatorio para validar (§5.3).
    await adjuntarComprobantes(id, tOperador);

    // Validación por fila (uno de los dos)
    const una = await request(app).post(`/api/depositos/${dep1.id}/validar`).set(auth(tValTes));
    expect(una.status).toBe(200);
    expect(una.body.saldo).toBe(40000);
    const doble = await request(app).post(`/api/depositos/${dep1.id}/validar`).set(auth(tValTes));
    expect(doble.status).toBe(409);

    // Validación del resto en lote (endpoint por operación)
    const resto = await request(app).post(`/api/operaciones/${id}/deposito/validar`).set(auth(tValTes));
    expect(resto.status).toBe(200);
    expect(resto.body.depositos).toBe(1);
    expect(resto.body.saldo).toBeCloseTo(58803, 2);

    const resguardo = await request(app).get(`/api/clientes/${clienteId}/resguardo`).set(auth(tOperador));
    expect(resguardo.body.saldo).toBeCloseTo(58803, 2);
    expect(resguardo.body.movimientos).toHaveLength(2);
  });

  it("agregar y quitar depósitos indicados mientras no estén validados", async () => {
    const clienteId = await clienteConAsignacion();
    const cuentaId = await crearCuenta();
    const tOperador = await login("operador", "operador");
    // Saldo previo 55,000; flujo 58,803 → faltan 3,803
    await request(app)
      .post("/api/resguardos/depositos")
      .set(auth(await login("val_tesoreria", "val_tesoreria")))
      .send({ cliente_id: clienteId, cuenta_id: cuentaId, monto: 55000, comprobante: "INI-1" });
    const id = await capturarFlujo(tOperador, {
      cliente_id: clienteId,
      respaldo: { depositos: [{ cuenta_id: cuentaId, monto: 3803, comprobante: "SPEI-C1" }] },
    });
    expect(id).not.toBeNull();

    // Agrega otro depósito indicado
    const otro = await request(app)
      .post(`/api/operaciones/${id}/depositos`)
      .set(auth(tOperador))
      .send({ cuenta_id: cuentaId, monto: 1000, comprobante: "SPEI-C2" });
    expect(otro.status).toBe(201);

    // Lo quita (sigue pendiente)
    const quitar = await request(app).delete(`/api/operaciones/${id}/depositos/${otro.body.deposito.id}`).set(auth(tOperador));
    expect(quitar.status).toBe(200);

    // Tesorería valida todos; quitar un validado → 409
    await adjuntarComprobantes(id, tOperador);
    await request(app).post(`/api/operaciones/${id}/deposito/validar`).set(auth(await login("val_tesoreria", "val_tesoreria")));
    const detalle = await request(app).get(`/api/operaciones/${id}`).set(auth(tOperador));
    const quitarValidado = await request(app)
      .delete(`/api/operaciones/${id}/depositos/${detalle.body.depositos[0].id}`)
      .set(auth(tOperador));
    expect(quitarValidado.status).toBe(409);
    const resguardo = await request(app).get(`/api/clientes/${clienteId}/resguardo`).set(auth(tOperador));
    expect(resguardo.body.saldo).toBeCloseTo(58803, 2);
  });

  it("edición de dispersiones que rompe el respaldo → 409; ajuste que respalda → 200", async () => {
    const clienteId = await clienteConAsignacion();
    const cuentaId = await crearCuenta();
    const tOperador = await login("operador", "operador");
    const id = await capturarFlujo(tOperador, {
      cliente_id: clienteId,
      respaldo: { depositos: [{ cuenta_id: cuentaId, monto: 58803, comprobante: "SPEI-D1" }] },
    });
    expect(id).not.toBeNull();
    const rompe = await request(app)
      .put(`/api/operaciones/${id}/dispersiones`)
      .set(auth(tOperador))
      .send({ dispersiones: [{ beneficiario: "A", importe: 59000 }] });
    expect(rompe.status).toBe(409);
    expect(rompe.body.respaldo.faltante).toBeCloseTo(197, 2);
    const bien = await request(app)
      .put(`/api/operaciones/${id}/dispersiones`)
      .set(auth(tOperador))
      .send({ dispersiones: [{ beneficiario: "A", importe: 58000 }] });
    expect(bien.status).toBe(200);
    expect(bien.body.calculos.flujo_total).toBe(58000);
  });
});

describe("financiamientos (§6.1): aprobación de Dirección y exenciones", () => {
  it("sin política: queda 'solicitado'; Dirección aprueba y el monto entra al resguardo; doble aprobación → 409", async () => {
    const clienteId = await clienteConAsignacion();
    const tOperador = await login("operador", "operador");
    const id = await capturarFlujo(tOperador, {
      cliente_id: clienteId,
      respaldo: { financiamiento: { monto: 60000, notas: "línea de crédito temporal" } },
    });
    expect(id).not.toBeNull();
    const detalle = await request(app).get(`/api/operaciones/${id}`).set(auth(tOperador));
    expect(detalle.body.financiamientos).toHaveLength(1);
    const fin = detalle.body.financiamientos[0];
    expect(fin.estado).toBe("solicitado");
    expect(fin.requiere_aprobacion).toBe(1);
    expect(detalle.body.respaldo.disponible).toBe(60000);

    // Cola de Dirección
    const tDireccion = await login("direccion", "direccion");
    const cola = await request(app).get("/api/financiamientos?estado=solicitado").set(auth(tDireccion));
    expect(cola.body.financiamientos).toHaveLength(1);

    // El operador no puede aprobar
    const negado = await request(app).post(`/api/financiamientos/${fin.id}/aprobar`).set(auth(tOperador));
    expect(negado.status).toBe(403);

    const aprobacion = await request(app).post(`/api/financiamientos/${fin.id}/aprobar`).set(auth(tDireccion));
    expect(aprobacion.status).toBe(200);
    expect(aprobacion.body.financiamiento.estado).toBe("aprobado");
    expect(aprobacion.body.saldo).toBe(60000);
    const doble = await request(app).post(`/api/financiamientos/${fin.id}/aprobar`).set(auth(tDireccion));
    expect(doble.status).toBe(409);

    const resguardo = await request(app).get(`/api/clientes/${clienteId}/resguardo`).set(auth(tOperador));
    expect(resguardo.body.saldo).toBe(60000);
    expect(resguardo.body.movimientos[0].tipo).toBe("financiamiento");
  });

  it("rechazo de financiamiento por Dirección: sin movimiento de resguardo", async () => {
    const clienteId = await clienteConAsignacion();
    const cuentaId = await crearCuenta();
    const tOperador = await login("operador", "operador");
    // Depósito 30,000 + financiamiento 30,000 = 60,000 ≥ 58,803
    const id = await capturarFlujo(tOperador, {
      cliente_id: clienteId,
      respaldo: {
        depositos: [{ cuenta_id: cuentaId, monto: 30000, comprobante: "SPEI-E1" }],
        financiamiento: { monto: 30000 },
      },
    });
    expect(id).not.toBeNull();
    const detalle = await request(app).get(`/api/operaciones/${id}`).set(auth(tOperador));
    const fin = detalle.body.financiamientos[0];
    expect(fin.estado).toBe("solicitado");

    const tDireccion = await login("direccion", "direccion");
    const rechazo = await request(app)
      .post(`/api/financiamientos/${fin.id}/rechazar`)
      .set(auth(tDireccion))
      .send({ motivo: "cliente con historial irregular" });
    expect(rechazo.status).toBe(200);
    expect(rechazo.body.financiamiento.estado).toBe("rechazado");
    const resguardo = await request(app).get(`/api/clientes/${clienteId}/resguardo`).set(auth(tOperador));
    expect(resguardo.body.saldo).toBe(0);
  });

  it("cliente exento de aprobación previa: financiamiento automático con movimiento inmediato", async () => {
    const clienteId = await clienteConAsignacion();
    const tDireccion = await login("direccion", "direccion");
    const politica = await request(app)
      .patch(`/api/clientes/${clienteId}/financiamiento`)
      .set(auth(tDireccion))
      .send({ sin_aprobacion: true });
    expect(politica.status).toBe(200);
    expect(politica.body.cliente.financiamiento_sin_aprobacion).toBe(1);

    const tOperador = await login("operador", "operador");
    const status = await capturarFlujo(tOperador, {
      cliente_id: clienteId,
      respaldo: { financiamiento: { monto: 60000 } },
    });
    expect(status).not.toBeNull();
    const lista = await request(app).get("/api/operaciones").set(auth(tOperador));
    const id = lista.body.operaciones[0].id as number;
    const detalle = await request(app).get(`/api/operaciones/${id}`).set(auth(tOperador));
    const fin = detalle.body.financiamientos[0];
    expect(fin.estado).toBe("aprobado");
    expect(fin.exento_motivo).toBe("sin_aprobacion_previa");
    expect(fin.movimiento_id).not.toBeNull();
    const resguardo = await request(app).get(`/api/clientes/${clienteId}/resguardo`).set(auth(tOperador));
    expect(resguardo.body.saldo).toBe(60000);
  });

  it("monto máximo aprobado: dentro entra automático; por encima requiere aprobación de Dirección", async () => {
    const clienteId = await clienteConAsignacion();
    const tDireccion = await login("direccion", "direccion");
    const politica = await request(app)
      .patch(`/api/clientes/${clienteId}/financiamiento`)
      .set(auth(tDireccion))
      .send({ monto_maximo: 60000 });
    expect(politica.status).toBe(200);

    const tOperador = await login("operador", "operador");
    // Dentro del máximo: automático
    const idA = await capturarFlujo(tOperador, {
      cliente_id: clienteId,
      concepto: "Dentro del máximo",
      respaldo: { financiamiento: { monto: 60000 } },
    });
    expect(idA).not.toBeNull();
    let detalle = await request(app).get(`/api/operaciones/${idA}`).set(auth(tOperador));
    expect(detalle.body.financiamientos[0].estado).toBe("aprobado");
    expect(detalle.body.financiamientos[0].exento_motivo).toBe("monto_maximo");

    // Por encima del máximo: a aprobación (el saldo 60,000 ayuda al respaldo)
    const idB = await capturarFlujo(tOperador, {
      cliente_id: clienteId,
      concepto: "Encima del máximo",
      respaldo: { financiamiento: { monto: 100000 } },
    });
    expect(idB).not.toBeNull();
    detalle = await request(app).get(`/api/operaciones/${idB}`).set(auth(tOperador));
    expect(detalle.body.financiamientos[0].estado).toBe("solicitado");
  });

  it("la política por cliente sólo la define Dirección (y admin)", async () => {
    const clienteId = await clienteConAsignacion();
    const tOperador = await login("operador", "operador");
    const negado = await request(app)
      .patch(`/api/clientes/${clienteId}/financiamiento`)
      .set(auth(tOperador))
      .send({ sin_aprobacion: true });
    expect(negado.status).toBe(403);
    const tAdmin = await login("admin", "admin");
    const ok = await request(app)
      .patch(`/api/clientes/${clienteId}/financiamiento`)
      .set(auth(tAdmin))
      .send({ sin_aprobacion: false, monto_maximo: 25000 });
    expect(ok.status).toBe(200);
    const quitar = await request(app)
      .patch(`/api/clientes/${clienteId}/financiamiento`)
      .set(auth(tAdmin))
      .send({ monto_maximo: null });
    expect(quitar.status).toBe(200);
    expect(quitar.body.cliente.financiamiento_maximo).toBeNull();
  });

  it("pagos bloqueados sin respaldo real; tras aprobar el financiamiento la tanda procede y cuadra el resguardo", async () => {
    const clienteId = await clienteConAsignacion();
    const cuentaId = await crearCuenta();
    const tOperador = await login("operador", "operador");
    const id = await capturarFlujo(tOperador, {
      cliente_id: clienteId,
      respaldo: {
        depositos: [{ cuenta_id: cuentaId, monto: 18803, comprobante: "SPEI-F1" }],
        financiamiento: { monto: 40000 },
      },
    });
    expect(id).not.toBeNull();
    // Tesorería valida el depósito: saldo real 18,803 (el financiamiento sigue pendiente)
    await adjuntarComprobantes(id, tOperador);
    await request(app)
      .post(`/api/operaciones/${id}/deposito/validar`)
      .set(auth(await login("val_tesoreria", "val_tesoreria")));
    await aprobar(id);
    const tTesoreria = await login("tesoreria", "tesoreria");
    const bloqueado = await request(app)
      .post(`/api/operaciones/${id}/pago`)
      .set(auth(tTesoreria))
      .send({ medio: "transferencia", monto: 58803, comprobante: "TRF-X" });
    expect(bloqueado.status).toBe(409);
    expect(bloqueado.body.error).toContain("Resguardo insuficiente");

    // Dirección aprueba el financiamiento → saldo real 58,803 → la tanda procede
    const detalle = await request(app).get(`/api/operaciones/${id}`).set(auth(tOperador));
    const fin = detalle.body.financiamientos[0];
    const tDireccion = await login("direccion", "direccion");
    const aprobacion = await request(app).post(`/api/financiamientos/${fin.id}/aprobar`).set(auth(tDireccion));
    expect(aprobacion.status).toBe(200);
    const tanda = await request(app)
      .post(`/api/operaciones/${id}/pago`)
      .set(auth(tTesoreria))
      .send({ medio: "transferencia", monto: 58803, comprobante: "TRF-Y" });
    expect(tanda.status).toBe(201);
    expect(tanda.body.operacion.estado).toBe("pagada");
    // Resguardo: 18,803 (depósito) + 40,000 (financiamiento) − 58,803 (tanda) = 0
    const resguardo = await request(app).get(`/api/clientes/${clienteId}/resguardo`).set(auth(tOperador));
    expect(resguardo.body.saldo).toBeCloseTo(0, 2);
  });

  it("cancelar la operación cancela sus financiamientos solicitados", async () => {
    const clienteId = await clienteConAsignacion();
    const cuentaId = await crearCuenta();
    const tOperador = await login("operador", "operador");
    const id = await capturarFlujo(tOperador, {
      cliente_id: clienteId,
      respaldo: { depositos: [{ cuenta_id: cuentaId, monto: 58803, comprobante: "SPEI-G1" }] },
    });
    expect(id).not.toBeNull();
    // Financiamiento adicional en una segunda operación que luego se cancela
    // (depósito 48,803 + financiamiento 10,000 = flujo 58,803)
    const id2 = await capturarFlujo(tOperador, {
      cliente_id: clienteId,
      concepto: "Se cancela",
      respaldo: {
        depositos: [{ cuenta_id: cuentaId, monto: 48803, comprobante: "SPEI-G2" }],
        financiamiento: { monto: 10000 },
      },
    });
    expect(id2).not.toBeNull();
    await request(app).post(`/api/operaciones/${id2}/cancelar`).set(auth(tOperador));
    const detalle2 = await request(app).get(`/api/operaciones/${id2}`).set(auth(tOperador));
    expect(detalle2.body.financiamientos[0].estado).toBe("cancelado");
    // El respaldo del cliente no cambió
    const resguardo = await request(app).get(`/api/clientes/${clienteId}/resguardo`).set(auth(tOperador));
    expect(resguardo.body.saldo).toBe(0);
  });

  it("GET /financiamientos: Dirección lo consulta; el operador no", async () => {
    const clienteId = await clienteConAsignacion();
    const tOperador = await login("operador", "operador");
    await capturarFlujo(tOperador, {
      cliente_id: clienteId,
      respaldo: { financiamiento: { monto: 60000 } },
    });
    const negado = await request(app).get("/api/financiamientos").set(auth(tOperador));
    expect(negado.status).toBe(403);
    const tDireccion = await login("direccion", "direccion");
    const ok = await request(app).get("/api/financiamientos").set(auth(tDireccion));
    expect(ok.status).toBe(200);
    expect(ok.body.financiamientos).toHaveLength(1);
    expect(ok.body.financiamientos[0].cliente).toBe("Cliente Respaldo SA");
    const tAuditor = await login("auditor", "auditor");
    const auditor = await request(app).get("/api/financiamientos").set(auth(tAuditor));
    expect(auditor.status).toBe(200);
  });
});
