import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import { crearApp } from "../src/app.js";
import { abrirBase } from "../src/db.js";

/**
 * Bloque funcional de Operaciones (área de Operaciones + Tesorería):
 * - Cobertura temporal de clientes (§3.1 + 00-VISION §6): segunda asignación
 *   por vacaciones/permisos; el ejecutivo temporal ve al cliente, sus
 *   operaciones y su resguardo; cerrarla revoca el acceso.
 * - Resguardo por cliente (§14): saldo = suma de movimientos (nunca guardado).
 *   Depósito (+) validado por Tesorería; cargo (−) al pagar la operación.
 * - Depósito indicado por el ejecutivo cuando el saldo es 0: cuenta del
 *   catálogo + comprobante; Tesorería lo valida y suma al resguardo.
 * - Catálogo ligero de cuentas (§5.3) para indicar dónde depositó el cliente.
 */
let db: Database.Database;
let app: ReturnType<typeof crearApp>;

async function login(username: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ username, password: username });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

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

beforeEach(() => {
  db = abrirBase(":memory:");
  app = crearApp(db);
});

/** ID del usuario a partir de su login. */
async function idDe(username: string): Promise<number> {
  const res = await request(app).get("/api/auth/me").set(auth(await login(username)));
  return res.body.usuario.id as number;
}

/** Usuario nuevo creado por admin (rol operacion por defecto). */
async function crearUsuario(username: string, rol = "operacion"): Promise<number> {
  const res = await request(app)
    .post("/api/usuarios")
    .set(auth(await login("admin")))
    .send({ username, nombre: username.toUpperCase(), rol, password: username });
  expect(res.status).toBe(201);
  return res.body.usuario.id as number;
}

/** Cliente creado por el Administrador de Operaciones. */
async function crearCliente(nombre = "Cliente Norte SA"): Promise<number> {
  const res = await request(app)
    .post("/api/clientes")
    .set(auth(await login("admin_ops")))
    .send({ nombre, rfc: "CNO880101XX1" });
  expect(res.status).toBe(201);
  return res.body.cliente.id as number;
}

async function asignar(clienteId: number, ejecutivoId: number): Promise<void> {
  const res = await request(app)
    .post(`/api/clientes/${clienteId}/asignaciones`)
    .set(auth(await login("admin_ops")))
    .send({ ejecutivo_id: ejecutivoId, motivo: "cartera" });
  expect(res.status).toBe(201);
}

/** Cuenta bancaria creada por el Administrador de Tesorería (catálogo §5.3). */
async function crearCuenta(nombre = "BBVA Operativa"): Promise<number> {
  const res = await request(app)
    .post("/api/cuentas")
    .set(auth(await login("admin_tesoreria")))
    .send({ nombre, banco: "BBVA", saldo_inicial: 0 });
  expect(res.status).toBe(201);
  return res.body.cuenta.id as number;
}

/** Operación con cliente capturada por el ejecutivo (estado borrador). */
async function capturarConCliente(clienteId: number, monto = 1200): Promise<number> {
  const res = await request(app)
    .post("/api/operaciones")
    .set(auth(await login("operador")))
    .send({
      tipo: "pago",
      concepto: "Pago a proveedor del cliente",
      proveedor: "Proveedor SA",
      monto,
      fecha_operacion: "2026-10-26",
      cliente_id: clienteId,
    });
  expect(res.status).toBe(201);
  return res.body.operacion.id as number;
}

/** Flujo completo borrador → en_validacion → aprobada (monto bajo el umbral). */
async function aprobarOperacion(id: number): Promise<void> {
  await request(app).post(`/api/operaciones/${id}/enviar-validacion`).set(auth(await login("operador")));
  const rev = await request(app)
    .post(`/api/operaciones/${id}/revision`)
    .set(auth(await login("validador")))
    .send({ resultado: "aprobada", comentario: "ok" });
  expect(rev.status).toBe(200);
  // Fase 12: el Fondeador libera; Tesorería sólo paga lo liberado.
  const liberar = await request(app).post(`/api/operaciones/${id}/liberar`).set(auth(await login("fondeador")));
  expect(liberar.status).toBe(200);
}

/** Depósito al resguardo validado directamente por Tesorería. */
async function depositarResguardo(clienteId: number, cuentaId: number, monto: number): Promise<void> {
  const res = await request(app)
    .post("/api/resguardos/depositos")
    .set(auth(await login("val_tesoreria")))
    .send({ cliente_id: clienteId, cuenta_id: cuentaId, monto, comprobante: "SPEI-100", fecha: "2026-10-25" });
  expect(res.status).toBe(201);
}

// ---- Catálogo de cuentas (§5.3) ----

describe("Catálogo de cuentas para indicar depósitos", () => {
  it("el ejecutivo consulta el catálogo ligero (sin saldos)", async () => {
    await crearCuenta("BBVA Operativa");
    const res = await request(app).get("/api/cuentas/catalogo").set(auth(await login("operador")));
    expect(res.status).toBe(200);
    // El catálogo incluye la semilla de cuentas del negocio (flujos, frentes…).
    const catalogo = res.body.cuentas as Array<{ nombre: string; saldo_inicial?: number }>;
    const creada = catalogo.find((c) => c.nombre === "BBVA Operativa");
    expect(creada).toBeDefined();
    expect(creada!).not.toHaveProperty("saldo_inicial");
  });
});

// ---- Cobertura de clientes (§3.1 + 00-VISION §6) ----

describe("Cobertura temporal de clientes", () => {
  it("el ejecutivo temporal ve al cliente, sus operaciones y su resguardo; otro ejecutivo no", async () => {
    const idOperador = await idDe("operador");
    const idTemporal = await crearUsuario("operador2");
    const idAjeno = await crearUsuario("operador3");
    const clienteId = await crearCliente();
    await asignar(clienteId, idOperador);
    const opId = await capturarConCliente(clienteId, 1200);

    const cobertura = await request(app)
      .post(`/api/clientes/${clienteId}/coberturas`)
      .set(auth(await login("admin_ops")))
      .send({
        ejecutivo_habitual_id: idOperador,
        ejecutivo_temporal_id: idTemporal,
        fecha_inicio: "2026-10-01",
        fecha_fin: null,
        motivo: "vacaciones",
      });
    expect(cobertura.status).toBe(201);

    // El temporal alcanza al cliente (lista, resguardo y operaciones).
    const clientes = await request(app).get("/api/clientes").set(auth(await login("operador2")));
    expect(clientes.status).toBe(200);
    expect(clientes.body.clientes.map((c: { id: number }) => c.id)).toContain(clienteId);
    const resguardo = await request(app).get(`/api/clientes/${clienteId}/resguardo`).set(auth(await login("operador2")));
    expect(resguardo.status).toBe(200);
    expect(resguardo.body.saldo).toBe(0);
    const lista = await request(app).get("/api/operaciones").set(auth(await login("operador2")));
    expect(lista.body.operaciones.map((o: { id: number }) => o.id)).toContain(opId);

    // Un ejecutivo sin asignación ni cobertura queda fuera del alcance.
    const ajeno = await request(app).get(`/api/clientes/${clienteId}/resguardo`).set(auth(await login("operador3")));
    expect(ajeno.status).toBe(403);
  });

  it("rechaza la cobertura cuando habitual y temporal son el mismo usuario", async () => {
    const idOperador = await idDe("operador");
    const clienteId = await crearCliente();
    const res = await request(app)
      .post(`/api/clientes/${clienteId}/coberturas`)
      .set(auth(await login("admin_ops")))
      .send({
        ejecutivo_habitual_id: idOperador,
        ejecutivo_temporal_id: idOperador,
        fecha_inicio: "2026-10-01",
      });
    expect(res.status).toBe(400);
  });

  it("cerrar la cobertura anticipadamente revoca el acceso del temporal", async () => {
    const idOperador = await idDe("operador");
    const idTemporal = await crearUsuario("operador2");
    const clienteId = await crearCliente();
    await asignar(clienteId, idOperador);
    const cobertura = await request(app)
      .post(`/api/clientes/${clienteId}/coberturas`)
      .set(auth(await login("admin_ops")))
      .send({ ejecutivo_habitual_id: idOperador, ejecutivo_temporal_id: idTemporal, fecha_inicio: "2026-10-01" });
    const coberturaId = cobertura.body.cobertura.id as number;

    const cierre = await request(app)
      .post(`/api/clientes/${clienteId}/coberturas/${coberturaId}/cerrar`)
      .set(auth(await login("admin_ops")))
      .send({ motivo: "regresó antes" });
    expect(cierre.status).toBe(200);

    const resguardo = await request(app).get(`/api/clientes/${clienteId}/resguardo`).set(auth(await login("operador2")));
    expect(resguardo.status).toBe(403);
  });

  it("el validador de operaciones no consulta resguardos (fuera de su función)", async () => {
    const clienteId = await crearCliente();
    const res = await request(app).get(`/api/clientes/${clienteId}/resguardo`).set(auth(await login("validador")));
    expect(res.status).toBe(403);
  });
});

// ---- Resguardo por cliente (§14) ----

describe("Resguardo por cliente", () => {
  it("saldo inicial 0; el depósito validado por Tesorería lo suma y crea el movimiento bancario", async () => {
    const clienteId = await crearCliente();
    const cuentaId = await crearCuenta();

    const inicio = await request(app).get(`/api/clientes/${clienteId}/resguardo`).set(auth(await login("admin_ops")));
    expect(inicio.body.saldo).toBe(0);

    const dep = await request(app)
      .post("/api/resguardos/depositos")
      .set(auth(await login("val_tesoreria")))
      .send({ cliente_id: clienteId, cuenta_id: cuentaId, monto: 5000, comprobante: "SPEI-100", fecha: "2026-10-25" });
    expect(dep.status).toBe(201);
    expect(dep.body.saldo).toBe(5000);

    // El movimiento bancario queda registrado en la cuenta.
    const movimientos = db.prepare("SELECT * FROM movimientos_cuentas WHERE cuenta_id = ?").all(cuentaId) as Array<{
      tipo: string;
      monto: number;
    }>;
    expect(movimientos).toHaveLength(1);
    expect(movimientos[0]).toMatchObject({ tipo: "deposito", monto: 5000 });

    const detalle = await request(app).get(`/api/clientes/${clienteId}/resguardo`).set(auth(await login("admin_ops")));
    expect(detalle.body.saldo).toBe(5000);
    expect(detalle.body.movimientos).toHaveLength(1);
    expect(detalle.body.movimientos[0].comprobante).toBe("SPEI-100");
  });

  it("rechaza depósitos sin comprobante", async () => {
    const clienteId = await crearCliente();
    const cuentaId = await crearCuenta();
    const res = await request(app)
      .post("/api/resguardos/depositos")
      .set(auth(await login("val_tesoreria")))
      .send({ cliente_id: clienteId, cuenta_id: cuentaId, monto: 500, comprobante: "  " });
    expect(res.status).toBe(400);
  });

  it("el pago de la operación resta del resguardo y deja el saldo exacto", async () => {
    const idOperador = await idDe("operador");
    const clienteId = await crearCliente();
    await asignar(clienteId, idOperador);
    const cuentaId = await crearCuenta();
    await depositarResguardo(clienteId, cuentaId, 5000);
    const opId = await capturarConCliente(clienteId, 1200);
    await aprobarOperacion(opId);

    const pago = await request(app)
      .post(`/api/operaciones/${opId}/pago`)
      .set(auth(await login("tesoreria")))
      .send({ medio: "transferencia", monto: 1200, comprobante: "TRF-777", fecha_pago: "2026-10-26" });
    expect(pago.status).toBe(201);

    const detalle = await request(app).get(`/api/clientes/${clienteId}/resguardo`).set(auth(await login("admin_ops")));
    expect(detalle.body.saldo).toBe(3800);
    const tipos = (detalle.body.movimientos as Array<{ tipo: string }>).map((m) => m.tipo).sort();
    expect(tipos).toEqual(["cargo", "deposito"]);
  });

  it("pago sin resguardo suficiente → 409; la operación queda aprobada y se puede pagar tras depositar", async () => {
    const idOperador = await idDe("operador");
    const clienteId = await crearCliente();
    await asignar(clienteId, idOperador);
    const cuentaId = await crearCuenta();
    await depositarResguardo(clienteId, cuentaId, 5000);
    const opId = await capturarConCliente(clienteId, 9000);
    await aprobarOperacion(opId);

    const rechazo = await request(app)
      .post(`/api/operaciones/${opId}/pago`)
      .set(auth(await login("tesoreria")))
      .send({ medio: "transferencia", monto: 9000, comprobante: "TRF-888" });
    expect(rechazo.status).toBe(409);
    expect(rechazo.body.saldo_resguardo).toBe(5000);

    // La operación no cambió de estado: sigue aprobada y pagable.
    const op = await request(app).get(`/api/operaciones/${opId}`).set(auth(await login("tesoreria")));
    expect(op.body.operacion.estado).toBe("aprobada");

    await depositarResguardo(clienteId, cuentaId, 5000);
    const pago = await request(app)
      .post(`/api/operaciones/${opId}/pago`)
      .set(auth(await login("tesoreria")))
      .send({ medio: "transferencia", monto: 9000, comprobante: "TRF-889" });
    expect(pago.status).toBe(201);
    const detalle = await request(app).get(`/api/clientes/${clienteId}/resguardo`).set(auth(await login("admin_ops")));
    expect(detalle.body.saldo).toBe(1000);
  });
});

// ---- Depósito indicado por el ejecutivo (saldo 0) ----

describe("Depósito indicado por el ejecutivo al capturar (saldo 0)", () => {
  it("indica cuenta + comprobante; Tesorería lo valida y suma al resguardo", async () => {
    const idOperador = await idDe("operador");
    const clienteId = await crearCliente();
    await asignar(clienteId, idOperador);
    const cuentaId = await crearCuenta();
    const opId = await capturarConCliente(clienteId, 3000);

    const indicacion = await request(app)
      .post(`/api/operaciones/${opId}/deposito`)
      .set(auth(await login("operador")))
      .send({ cuenta_id: cuentaId, monto: 3000, comprobante: "FICHA-9", fecha_deposito: "2026-10-24" });
    expect(indicacion.status).toBe(201);

    const pendientes = await request(app)
      .get("/api/resguardos/depositos-pendientes")
      .set(auth(await login("val_tesoreria")));
    expect(pendientes.status).toBe(200);
    expect(pendientes.body.depositos).toHaveLength(1);
    expect(pendientes.body.depositos[0]).toMatchObject({ folio: pendientes.body.depositos[0].folio, comprobante: "FICHA-9" });

    // El respaldo documental es obligatorio para validar (§5.3).
    await adjuntarComprobantes(opId, await login("operador"));

    const validacion = await request(app)
      .post(`/api/operaciones/${opId}/deposito/validar`)
      .set(auth(await login("val_tesoreria")));
    expect(validacion.status).toBe(200);
    expect(validacion.body.saldo).toBe(3000);

    // Ya no está pendiente y quedó marcado como validado.
    const tras = await request(app).get("/api/resguardos/depositos-pendientes").set(auth(await login("val_tesoreria")));
    expect(tras.body.depositos).toHaveLength(0);
    const registro = db.prepare("SELECT * FROM operaciones_depositos WHERE operacion_id = ?").get(opId) as {
      validado_por: number | null;
    };
    expect(registro.validado_por).not.toBeNull();

    // El detalle de la operación expone el depósito indicado.
    const op = await request(app).get(`/api/operaciones/${opId}`).set(auth(await login("operador")));
    expect(op.body.deposito.comprobante).toBe("FICHA-9");
  });

  it("el depósito indicado es editable mientras Tesorería no lo valide", async () => {
    const idOperador = await idDe("operador");
    const clienteId = await crearCliente();
    await asignar(clienteId, idOperador);
    const cuentaId = await crearCuenta();
    const opId = await capturarConCliente(clienteId, 3000);

    await request(app)
      .post(`/api/operaciones/${opId}/deposito`)
      .set(auth(await login("operador")))
      .send({ cuenta_id: cuentaId, monto: 3000, comprobante: "FICHA-9" });
    const correccion = await request(app)
      .post(`/api/operaciones/${opId}/deposito`)
      .set(auth(await login("operador")))
      .send({ cuenta_id: cuentaId, monto: 3500, comprobante: "FICHA-9-BIS" });
    expect(correccion.status).toBe(201);

    const pendientes = await request(app)
      .get("/api/resguardos/depositos-pendientes")
      .set(auth(await login("val_tesoreria")));
    expect(pendientes.body.depositos).toHaveLength(1);
    expect(pendientes.body.depositos[0].monto).toBe(3500);
  });

  it("rechaza doble validación del mismo depósito", async () => {
    const idOperador = await idDe("operador");
    const clienteId = await crearCliente();
    await asignar(clienteId, idOperador);
    const cuentaId = await crearCuenta();
    const opId = await capturarConCliente(clienteId, 1000);
    await request(app)
      .post(`/api/operaciones/${opId}/deposito`)
      .set(auth(await login("operador")))
      .send({ cuenta_id: cuentaId, monto: 1000, comprobante: "FICHA-1" });
    await adjuntarComprobantes(opId, await login("operador"));
    await request(app).post(`/api/operaciones/${opId}/deposito/validar`).set(auth(await login("val_tesoreria")));
    const segunda = await request(app)
      .post(`/api/operaciones/${opId}/deposito/validar`)
      .set(auth(await login("val_tesoreria")));
    expect(segunda.status).toBe(409);
  });

  it("validaciones de datos: sin comprobante → 400; operación sin cliente → 400; validar sin depósito → 404", async () => {
    const idOperador = await idDe("operador");
    const clienteId = await crearCliente();
    await asignar(clienteId, idOperador);
    const cuentaId = await crearCuenta();
    const opId = await capturarConCliente(clienteId, 1000);

    const sinComprobante = await request(app)
      .post(`/api/operaciones/${opId}/deposito`)
      .set(auth(await login("operador")))
      .send({ cuenta_id: cuentaId, monto: 1000, comprobante: "" });
    expect(sinComprobante.status).toBe(400);

    // Operación sin cliente: el resguardo es por cliente.
    const sinCliente = await request(app)
      .post("/api/operaciones")
      .set(auth(await login("operador")))
      .send({
        tipo: "pago",
        concepto: "Gasto general",
        proveedor: "Proveedor SA",
        monto: 500,
        fecha_operacion: "2026-10-26",
      });
    const sinClienteDep = await request(app)
      .post(`/api/operaciones/${sinCliente.body.operacion.id}/deposito`)
      .set(auth(await login("operador")))
      .send({ cuenta_id: cuentaId, monto: 500, comprobante: "X-1" });
    expect(sinClienteDep.status).toBe(400);

    const sinIndicar = await request(app)
      .post(`/api/operaciones/${opId}/deposito/validar`)
      .set(auth(await login("val_tesoreria")));
    expect(sinIndicar.status).toBe(404);
  });

  it("un ejecutivo sin alcance no indica depósitos en operaciones ajenas", async () => {
    const idOperador = await idDe("operador");
    await crearUsuario("operador2");
    const clienteId = await crearCliente();
    await asignar(clienteId, idOperador);
    const cuentaId = await crearCuenta();
    const opId = await capturarConCliente(clienteId, 1000);

    const ajeno = await request(app)
      .post(`/api/operaciones/${opId}/deposito`)
      .set(auth(await login("operador2")))
      .send({ cuenta_id: cuentaId, monto: 1000, comprobante: "X-2" });
    expect(ajeno.status).toBe(403);
  });

  it("el depósito directo ligado a una operación de otro cliente → 409", async () => {
    const idOperador = await idDe("operador");
    const clienteA = await crearCliente("Cliente A");
    const clienteB = await crearCliente("Cliente B");
    await asignar(clienteA, idOperador);
    const cuentaId = await crearCuenta();
    const opA = await capturarConCliente(clienteA, 2000);

    const res = await request(app)
      .post("/api/resguardos/depositos")
      .set(auth(await login("val_tesoreria")))
      .send({ cliente_id: clienteB, cuenta_id: cuentaId, monto: 2000, comprobante: "SPEI-201", operacion_id: opA });
    expect(res.status).toBe(409);
  });
});
