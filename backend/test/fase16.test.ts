import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Database } from "better-sqlite3";
import { crearApp } from "../src/app.js";
import { abrirBase } from "../src/db.js";

/**
 * Fase 16:
 *   · Sección RESGUARDOS unificada (sustituye al apartado 'Resguardo TRF'):
 *     listado de todos los resguardos + movimientos del mes; sólo Tesorería,
 *     Auditoría y Dirección (y admin) ven el historial completo; admin_validacion
 *     accede a la sección y al resguardo de TRF.
 *   · Contaduría (rol nuevo + usuario 1contaduria): solicitudes de timbrado
 *     (sólo operaciones con timbrar=1), detalle sólo de esas operaciones.
 *   · Estructuras de cuentas (formato Ejercicio 2026): semilla del catálogo,
 *     CRUD por Contaduría, estatus (activa/inactiva) por admin_tesoreria,
 *     armado A MANO (sin layout): borrar una fila o toda la estructura,
 *     marcar cuentas que salen de la estructura (listado + reincorporar) y
 *     catálogo activo para la captura de Operaciones.
 *   · Limpiar el catálogo completo de cuentas (pruebas; admin_tesoreria).
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
const mesActual = (): string => new Date().toISOString().slice(0, 7);
const mesPasado = (): string => {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return d.toISOString().slice(0, 7);
};

async function crearCliente(token: string, nombre: string): Promise<number> {
  const res = await request(app).post("/api/clientes").set(auth(token)).send({ nombre });
  expect(res.status).toBe(201);
  return res.body.cliente.id as number;
}

async function cuentaId(token: string, nombre: string): Promise<number> {
  const res = await request(app).get("/api/cuentas").set(auth(token));
  expect(res.status).toBe(200);
  const c = (res.body.cuentas as Array<{ id: number; nombre: string }>).find((x) => x.nombre === nombre);
  expect(c, `la cuenta '${nombre}' debe existir`).toBeTruthy();
  return c!.id;
}

/** Depósito validado al resguardo del cliente (como lo hace Tesorería). */
async function depositar(token: string, clienteId: number, monto: number, cuenta: string): Promise<void> {
  const res = await request(app)
    .post("/api/resguardos/depositos")
    .set(auth(token))
    .send({
      cliente_id: clienteId,
      cuenta_id: await cuentaId(token, cuenta),
      monto,
      comprobante: `COMP-${clienteId}-${monto}`,
      fecha: hoy(),
    });
  expect(res.status).toBe(201);
}

/** Movimiento antiguo directo en el ledger (para probar el mes/historial). */
function insertarMovimientoAntiguo(
  clienteId: number,
  importe: number,
  creadoEn: string
): void {
  db.prepare(
    `INSERT INTO resguardos_movimientos (cliente_id, tipo, importe, comprobante, creado_por, creado_en)
     VALUES (?, 'deposito', ?, 'ANTIGUO', 1, ?)`
  ).run(clienteId, importe, creadoEn);
}

/** Captura una operación (flujo) con timbrar configurable. */
async function capturar(token: string, timbrar: boolean, concepto: string): Promise<number> {
  const res = await request(app)
    .post("/api/operaciones")
    .set(auth(token))
    .send({
      tipo: "flujo",
      concepto,
      monto: 60000,
      fecha_operacion: hoy(),
      timbrar,
      comision_pct: 2.5,
      destinos: [{ tipo: "flujo" }],
      dispersiones: [
        {
          beneficiario: "COMERCIAL BRAIN FENIX",
          cuenta: "6461803528523520323",
          banco: "STP",
          importe: 59697,
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
  expect(res.status).toBe(201);
  return res.body.operacion.id as number;
}

beforeEach(() => {
  db = abrirBase(":memory:");
  app = crearApp(db);
});

describe("Sección RESGUARDOS (unificada)", () => {
  it("lista todos los resguardos con saldo, conteo y resumen del resguardo TRF", async () => {
    const tAdminOps = await login("admin_ops", "admin_ops");
    const tVal = await login("val_tesoreria", "val_tesoreria");
    const alfa = await crearCliente(tAdminOps, "CLIENTE ALFA RESGUARDOS");
    const beta = await crearCliente(tAdminOps, "CLIENTE BETA RESGUARDOS");
    await depositar(tVal, alfa, 100000, "FLUJOS 01");
    await depositar(tVal, beta, 25000, "FLUJOS 02");

    const res = await request(app).get("/api/resguardos").set(auth(tAdminOps));
    expect(res.status).toBe(200);
    const lista = res.body.resguardos as Array<{
      cliente_id: number;
      saldo: number;
      movimientos_count: number;
    }>;
    const alfaFila = lista.find((r) => r.cliente_id === alfa);
    expect(alfaFila).toBeTruthy();
    expect(alfaFila!.saldo).toBe(100000);
    expect(alfaFila!.movimientos_count).toBe(1);
    expect(res.body.trf).toBeTruthy();
    expect(Array.isArray(res.body.trf.saldos)).toBe(true);
    // El ejecutivo simple NO tiene la sección.
    const tOp = await login("operador", "operador");
    const prohibido = await request(app).get("/api/resguardos").set(auth(tOp));
    expect(prohibido.status).toBe(403);
  });

  it("roles sin historial completo ven SOLO el mes en curso (el API lo fuerza)", async () => {
    const tAdminOps = await login("admin_ops", "admin_ops");
    const tVal = await login("val_tesoreria", "val_tesoreria");
    const alfa = await crearCliente(tAdminOps, "CLIENTE MES FORZADO");
    insertarMovimientoAntiguo(alfa, 7000, `${mesPasado()}-10 12:00:00`);
    await depositar(tVal, alfa, 30000, "FLUJOS 01");

    // Admin de Operaciones: mes en curso forzado; el movimiento antiguo queda
    // fuera pero sí cuenta en el saldo de apertura del mes.
    const res = await request(app).get(`/api/clientes/${alfa}/resguardo`).set(auth(tAdminOps));
    expect(res.status).toBe(200);
    expect(res.body.mes).toBe(mesActual());
    expect(res.body.historial_completo).toBe(false);
    const movs = res.body.movimientos as Array<{ importe: number }>;
    expect(movs.length).toBe(1);
    expect(movs[0].importe).toBe(30000);
    expect(res.body.saldo_anterior).toBe(7000);
    expect(res.body.saldo).toBe(37000);

    // Aun pidiendo un mes pasado, el API lo fuerza al mes en curso.
    const forzado = await request(app)
      .get(`/api/clientes/${alfa}/resguardo?mes=${mesPasado()}`)
      .set(auth(tAdminOps));
    expect(forzado.status).toBe(200);
    expect(forzado.body.mes).toBe(mesActual());
    expect((forzado.body.movimientos as unknown[]).length).toBe(1);
  });

  it("tesoreria, auditoria y direccion consultan cualquier mes y el historial completo", async () => {
    const tAdminOps = await login("admin_ops", "admin_ops");
    const tVal = await login("val_tesoreria", "val_tesoreria");
    const tTeso = await login("tesoreria", "tesoreria");
    const tAud = await login("auditor", "auditor");
    const alfa = await crearCliente(tAdminOps, "CLIENTE HISTORIAL COMPLETO");
    insertarMovimientoAntiguo(alfa, 7000, `${mesPasado()}-10 12:00:00`);
    await depositar(tVal, alfa, 30000, "FLUJOS 01");

    // Mes pasado completo para Tesorería.
    const pasado = await request(app)
      .get(`/api/clientes/${alfa}/resguardo?mes=${mesPasado()}`)
      .set(auth(tTeso));
    expect(pasado.status).toBe(200);
    expect(pasado.body.mes).toBe(mesPasado());
    expect(pasado.body.historial_completo).toBe(true);
    expect((pasado.body.movimientos as unknown[]).length).toBe(1);
    expect(pasado.body.saldo_anterior).toBe(0);

    // Historial completo (sin ?mes) para Auditoría: los dos movimientos.
    const todo = await request(app).get(`/api/clientes/${alfa}/resguardo`).set(auth(tAud));
    expect(todo.status).toBe(200);
    expect(todo.body.mes).toBeUndefined();
    expect((todo.body.movimientos as unknown[]).length).toBe(2);
  });

  it("admin_validacion entra a la sección y al resguardo de TRF", async () => {
    const tAdminVal = await login("admin_validacion", "admin_validacion");
    const lista = await request(app).get("/api/resguardos").set(auth(tAdminVal));
    expect(lista.status).toBe(200);
    const trf = await request(app).get("/api/trf/resguardo").set(auth(tAdminVal));
    expect(trf.status).toBe(200);
  });
});

describe("Contaduría: usuario y solicitudes de timbrado", () => {
  it("el usuario 1contaduria existe con rol contaduria", async () => {
    const t = await login("1contaduria", "1contaduria");
    const me = await request(app).get("/api/auth/me").set(auth(t));
    expect(me.status).toBe(200);
    expect(me.body.usuario.rol).toBe("contaduria");
  });

  it("lista SÓLO las operaciones con timbrar=sí y abre sólo esas", async () => {
    const tOp = await login("operador", "operador");
    const tCon = await login("1contaduria", "1contaduria");
    const conTimbrar = await capturar(tOp, true, "Facturable A");
    await capturar(tOp, false, "No facturable B");

    const lista = await request(app).get("/api/timbrado/solicitudes").set(auth(tCon));
    expect(lista.status).toBe(200);
    const solicitudes = lista.body.solicitudes as Array<{ id: number; folio: string }>;
    expect(lista.body.total).toBe(1);
    expect(solicitudes[0].id).toBe(conTimbrar);

    // Detalle: la facturable se ve; la que no pide timbrado queda prohibida.
    const detalle = await request(app).get(`/api/operaciones/${conTimbrar}`).set(auth(tCon));
    expect(detalle.status).toBe(200);
    const otra = await request(app).get("/api/operaciones").set(auth(tOp));
    const noFacturable = (otra.body.operaciones as Array<{ id: number; concepto: string }>).find(
      (o) => o.concepto === "No facturable B"
    );
    expect(noFacturable).toBeTruthy();
    const prohibido = await request(app).get(`/api/operaciones/${noFacturable!.id}`).set(auth(tCon));
    expect(prohibido.status).toBe(403);

    // El listado de timbrado no es público para otros roles.
    const tTeso = await login("tesoreria", "tesoreria");
    const ajeno = await request(app).get("/api/timbrado/solicitudes").set(auth(tTeso));
    expect(ajeno.status).toBe(403);
  });
});

describe("Estructuras de cuentas (formato Contaduría)", () => {
  it("nace sembrada con el catálogo Ejercicio 2026 y se consulta por rol", async () => {
    const tTeso = await login("admin_tesoreria", "admin_tesoreria");
    const res = await request(app).get("/api/estructuras").set(auth(tTeso));
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThan(100);
    const filas = res.body.estructuras as Array<{
      razon_social: string;
      tipo: string;
      bancos: Record<string, number>;
      estatus_operacion: number;
    }>;
    const cardenas = filas.find((f) => f.razon_social.startsWith("CARDENAS CONSULTORES"));
    expect(cardenas).toBeTruthy();
    expect(cardenas!.tipo).toBe("FRENTE");
    expect(Object.keys(cardenas!.bancos).length).toBeGreaterThan(0);

    // Operación no consulta el catálogo completo; sí el de captura.
    const tOp = await login("operador", "operador");
    const prohibido = await request(app).get("/api/estructuras").set(auth(tOp));
    expect(prohibido.status).toBe(403);
    const catalogo = await request(app).get("/api/estructuras/catalogo").set(auth(tOp));
    expect(catalogo.status).toBe(200);
    expect(
      (catalogo.body.estructuras as Array<{ estatus_operacion?: number }>).every(
        (e) => e.estatus_operacion === undefined || e.estatus_operacion === 1
      )
    ).toBe(true);
  });

  it("Contaduría crea y edita; admin_tesoreria edita y activa/desactiva", async () => {
    const tCon = await login("1contaduria", "1contaduria");
    const tTeso = await login("admin_tesoreria", "admin_tesoreria");
    const tTesoRol = await login("tesoreria", "tesoreria");

    const creada = await request(app)
      .post("/api/estructuras")
      .set(auth(tCon))
      .send({
        razon_social: "EJEMPLO PRUEBAS SA DE CV",
        tipo: "RB",
        giro: "PUBLICIDAD",
        nucleo: "PUBLICIDAD",
        empresa: "CARDENAS CONSULTORES EN ADMINISTRACION SRL DE CV",
        importe_maximo: "de un 25 a un 30 % del flujo",
        estatus_operacion: 1,
        bancos: { JS: 1, BANORTE: 0 },
        extras: { INE: 1 },
      });
    expect(creada.status).toBe(201);
    const id = creada.body.estructura.id as number;

    // Un tesorero común no toca el catálogo.
    const ajeno = await request(app)
      .post("/api/estructuras")
      .set(auth(tTesoRol))
      .send({ razon_social: "X Y SA", tipo: "RB" });
    expect(ajeno.status).toBe(403);

    // admin_tesoreria edita campos.
    const editada = await request(app)
      .patch(`/api/estructuras/${id}`)
      .set(auth(tTeso))
      .send({ importe_maximo: "de un 15 a un 20 % del flujo" });
    expect(editada.status).toBe(200);
    expect(editada.body.estructura.importe_maximo).toBe("de un 15 a un 20 % del flujo");

    // Contaduría NO cambia el estatus (lo maneja Tesorería).
    const estatusCont = await request(app)
      .patch(`/api/estructuras/${id}/estatus`)
      .set(auth(tCon))
      .send({ estatus_operacion: false });
    expect(estatusCont.status).toBe(403);

    // admin_tesoreria desactiva y el catálogo de captura la deja fuera.
    const estatus = await request(app)
      .patch(`/api/estructuras/${id}/estatus`)
      .set(auth(tTeso))
      .send({ estatus_operacion: false });
    expect(estatus.status).toBe(200);
    expect(estatus.body.estructura.estatus_operacion).toBe(0);
    const tOp = await login("operador", "operador");
    const catalogo = await request(app).get("/api/estructuras/catalogo").set(auth(tOp));
    const ids = (catalogo.body.estructuras as Array<{ id: number }>).map((e) => e.id);
    expect(ids).not.toContain(id);
  });

  it("salir de la estructura marca la cuenta y la saca de disponibles", async () => {
    const tCon = await login("1contaduria", "1contaduria");
    const tTeso = await login("admin_tesoreria", "admin_tesoreria");

    // La cuenta FRENTES 01 se liga a una estructura nueva.
    const idCuenta = await cuentaId(tTeso, "FRENTES 01");
    const creada = await request(app)
      .post("/api/estructuras")
      .set(auth(tCon))
      .send({
        razon_social: "SALIDA PRUEBAS SA DE CV",
        tipo: "FRENTE",
        giro: "PRUEBAS",
        nucleo: "PRUEBAS",
        empresa: "SALIDA PRUEBAS SA DE CV",
        importe_maximo: "de un 20 a un 30 % del flujo",
        cuenta_id: idCuenta,
      });
    expect(creada.status).toBe(201);
    const idEstructura = creada.body.estructura.id as number;

    // Ya NO está disponible para ligarse de nuevo.
    const dispo = await request(app).get("/api/cuentas/nombres?disponibles=1").set(auth(tCon));
    expect(dispo.status).toBe(200);
    expect((dispo.body.cuentas as Array<{ id: number }>).some((c) => c.id === idCuenta)).toBe(false);

    // GET /cuentas expone el estado de estructura para Tesorería.
    const lista = await request(app).get("/api/cuentas").set(auth(tTeso));
    const fila = (lista.body.cuentas as Array<Record<string, unknown>>).find((c) => c.id === idCuenta);
    expect(fila?.estructura_razon).toBe("SALIDA PRUEBAS SA DE CV");
    expect(fila?.estructura_tipo).toBe("FRENTE");
    expect(fila?.fuera_estructura).toBe(0);

    // Contaduría la saca de la estructura: fila borrada + cuenta marcada.
    const salida = await request(app).post(`/api/estructuras/${idEstructura}/salir`).set(auth(tCon));
    expect(salida.status).toBe(200);
    const queda = await request(app).get("/api/estructuras?q=SALIDA PRUEBAS").set(auth(tTeso));
    expect(queda.body.total).toBe(0);

    // La cuenta aparece en el listado de cuentas fuera de la estructura…
    const fuera = await request(app).get("/api/cuentas/fuera-estructura").set(auth(tCon));
    expect(fuera.status).toBe(200);
    expect((fuera.body.cuentas as Array<{ id: number }>).some((c) => c.id === idCuenta)).toBe(true);

    // …y sigue sin estar disponible hasta reincorporarla.
    const dispo2 = await request(app).get("/api/cuentas/nombres?disponibles=1").set(auth(tCon));
    expect((dispo2.body.cuentas as Array<{ id: number }>).some((c) => c.id === idCuenta)).toBe(false);

    const re = await request(app)
      .patch(`/api/cuentas/${idCuenta}/fuera-estructura`)
      .set(auth(tTeso))
      .send({ fuera: false });
    expect(re.status).toBe(200);
    const dispo3 = await request(app).get("/api/cuentas/nombres?disponibles=1").set(auth(tCon));
    expect((dispo3.body.cuentas as Array<{ id: number }>).some((c) => c.id === idCuenta)).toBe(true);

    // Un rol sin permiso no marca cuentas.
    const tOp = await login("operador", "operador");
    const prohibido = await request(app)
      .patch(`/api/cuentas/${idCuenta}/fuera-estructura`)
      .set(auth(tOp))
      .send({ fuera: true });
    expect(prohibido.status).toBe(403);
  });

  it("borrar estructura: una fila y toda la estructura (roles permitidos)", async () => {
    const tCon = await login("1contaduria", "1contaduria");
    const tTeso = await login("admin_tesoreria", "admin_tesoreria");
    const tTes = await login("tesoreria", "tesoreria");

    const creada = await request(app)
      .post("/api/estructuras")
      .set(auth(tCon))
      .send({
        razon_social: "BORRABLE SA DE CV",
        tipo: "RB",
        empresa: "CARDENAS CONSULTORES EN ADMINISTRACION SRL DE CV",
      });
    expect(creada.status).toBe(201);
    const id = creada.body.estructura.id as number;

    // Un tesorero común no borra.
    const ajeno = await request(app).delete(`/api/estructuras/${id}`).set(auth(tTes));
    expect(ajeno.status).toBe(403);

    // admin_tesoreria borra UNA fila.
    const uno = await request(app).delete(`/api/estructuras/${id}`).set(auth(tTeso));
    expect(uno.status).toBe(200);
    expect(uno.body.borrada).toBe(1);

    // Borrar TODA la estructura pide confirmación y la respeta.
    const sinConf = await request(app).delete("/api/estructuras").set(auth(tCon));
    expect(sinConf.status).toBe(400);
    const todas = await request(app)
      .delete("/api/estructuras")
      .set(auth(tCon))
      .query({ confirmar: "BORRAR" });
    expect(todas.status).toBe(200);
    expect(todas.body.borradas).toBeGreaterThan(100);
    const restante = await request(app).get("/api/estructuras").set(auth(tTeso));
    expect(restante.body.total).toBe(0);
  });

  it("limpiar el catálogo completo de cuentas (pruebas) con confirmación", async () => {
    const tTeso = await login("admin_tesoreria", "admin_tesoreria");
    const tCon = await login("1contaduria", "1contaduria");

    // Sin confirmación no borra nada.
    const sinConf = await request(app).delete("/api/cuentas").set(auth(tTeso));
    expect(sinConf.status).toBe(400);

    // Contaduría tampoco puede limpiar el catálogo (sólo admin_tesoreria).
    const ajeno = await request(app)
      .delete("/api/cuentas")
      .set(auth(tCon))
      .query({ confirmar: "LIMPIAR" });
    expect(ajeno.status).toBe(403);

    // Con confirmación borra todo el catálogo (con sus movimientos/asignaciones).
    const antes = await request(app).get("/api/cuentas").set(auth(tTeso));
    const total = (antes.body.cuentas as unknown[]).length;
    expect(total).toBeGreaterThan(0);
    const r = await request(app)
      .delete("/api/cuentas")
      .set(auth(tTeso))
      .query({ confirmar: "LIMPIAR" });
    expect(r.status).toBe(200);
    expect(r.body.cuentas).toBe(total);
    const despues = await request(app).get("/api/cuentas").set(auth(tTeso));
    expect((despues.body.cuentas as unknown[]).length).toBe(0);
  });

  it("cuentas/nombres para ligar estructuras no expone números bancarios", async () => {
    const tCon = await login("1contaduria", "1contaduria");
    const res = await request(app).get("/api/cuentas/nombres").set(auth(tCon));
    expect(res.status).toBe(200);
    const cuentas = res.body.cuentas as Array<Record<string, unknown>>;
    expect(cuentas.length).toBeGreaterThan(0);
    for (const c of cuentas) {
      expect(c.numero_cuenta).toBeUndefined();
      expect(c.clabe).toBeUndefined();
      expect(typeof c.nombre).toBe("string");
    }
    // Un rol sin permiso no consulta.
    const tOp = await login("operador", "operador");
    const prohibido = await request(app).get("/api/cuentas/nombres").set(auth(tOp));
    expect(prohibido.status).toBe(403);
  });
});
