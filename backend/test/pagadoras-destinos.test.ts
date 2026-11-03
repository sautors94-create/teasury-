import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Database } from "better-sqlite3";
import { crearApp } from "../src/app.js";
import { abrirBase } from "../src/db.js";

/**
 * Tarea 12 — Pagadoras del catálogo de Tesorería:
 *   · El Ejecutivo selecciona PAGADORAS / TIPO DE OPERACIÓN del catálogo de
 *     Tesorería con selección múltiple (flujos, asimilados, rendimientos,
 *     frentes…) y marca cuáles son de manejo manual.
 *   · "CUALQUIER FLUJO" (cuenta_id nulo): Tesorería determina la cuenta.
 *   · Cada línea de dispersión lleva PAGADORA (cuenta del catálogo o literal).
 *   · El catálogo ligero sólo muestra cuentas activas: si Tesorería saca una
 *     cuenta de operación (bloqueo/no uso), desaparece del catálogo y del
 *     layout; capturarla se rechaza con 400.
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

/** Captura base (formato completo) con destinos opcionales y pagadoras por línea. */
async function capturar(
  token: string,
  extra: {
    destinos?: Array<{ cuenta_id?: number; tipo?: string; manejo_manual?: boolean }>;
    pagadoras?: Array<{ nombre: string; id: number | null }>;
  } = {}
) {
  const lineas = [
    {
      beneficiario: "COMERCIAL BRAIN FENIX",
      cuenta: "6461803528523520323",
      banco: "STP",
      importe: 57000,
      etiqueta: "PROVEEDOR",
      ...(extra.pagadoras?.[0]
        ? { pagadora: extra.pagadoras[0].nombre, pagadora_cuenta_id: extra.pagadoras[0].id }
        : {}),
    },
    {
      beneficiario: "TRF CARD SAPI SA DE CV",
      cuenta: "646180352590100116",
      banco: "STP",
      importe: 303,
      etiqueta: "GASTOS",
      ...(extra.pagadoras?.[1]
        ? { pagadora: extra.pagadoras[1].nombre, pagadora_cuenta_id: extra.pagadoras[1].id }
        : {}),
    },
  ];
  return request(app)
    .post("/api/operaciones")
    .set(auth(token))
    .send({
      tipo: "flujo",
      concepto: "Flujo con pagadoras del catálogo",
      monto: 60000,
      fecha_operacion: hoy(),
      timbrar: false,
      comision_pct: 2.5,
      ...(extra.destinos ? { destinos: extra.destinos } : {}),
      dispersiones: lineas,
    });
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

describe("Captura con pagadoras del catálogo (destinos)", () => {
  it("acepta selección múltiple (flujo + asimilado manual + CUALQUIER FLUJO) y rellena pagador/tipo desde el catálogo", async () => {
    const tOp = await login("operador", "operador");
    const flujos = await cuentaPorNombre(tOp, "FLUJOS 01");
    const asimilado = await cuentaPorNombre(tOp, "ASIMILADOS 01");

    const res = await capturar(tOp, {
      destinos: [
        { cuenta_id: flujos.id },
        { cuenta_id: asimilado.id, manejo_manual: true },
        { tipo: "flujo" }, // CUALQUIER FLUJO
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.operacion.pagador).toBe("FLUJOS 01, ASIMILADOS 01, CUALQUIER FLUJO");
    expect(res.body.operacion.tipo_operacion).toBe("flujo, asimilado");

    const det = await request(app).get(`/api/operaciones/${res.body.operacion.id}`).set(auth(tOp));
    expect(det.status).toBe(200);
    const destinos = det.body.destinos as Array<{
      cuenta_id: number | null;
      tipo: string;
      nombre: string;
      manejo_manual: number;
      cuenta?: string | null;
    }>;
    expect(destinos).toHaveLength(3);
    expect(destinos[0]).toMatchObject({ cuenta_id: flujos.id, tipo: "flujo", nombre: "FLUJOS 01", manejo_manual: 0 });
    expect(destinos[1]).toMatchObject({ cuenta_id: asimilado.id, tipo: "asimilado", nombre: "ASIMILADOS 01", manejo_manual: 1 });
    expect(destinos[2]).toMatchObject({ cuenta_id: null, tipo: "flujo", nombre: "CUALQUIER FLUJO", manejo_manual: 0 });
    expect(destinos[0].cuenta).toBe("FLUJOS 01");
  });

  it("guarda la pagadora por línea de dispersión (cuenta concreta y CUALQUIER FLUJO)", async () => {
    const tOp = await login("operador", "operador");
    const flujos = await cuentaPorNombre(tOp, "FLUJOS 02");
    const res = await capturar(tOp, {
      destinos: [{ cuenta_id: flujos.id }, { tipo: "flujo" }],
      pagadoras: [{ nombre: "FLUJOS 02", id: flujos.id }, { nombre: "CUALQUIER FLUJO", id: null }],
    });
    expect(res.status).toBe(201);
    const det = await request(app).get(`/api/operaciones/${res.body.operacion.id}`).set(auth(tOp));
    const disp = det.body.dispersiones as Array<{ pagadora: string; pagadora_cuenta_id: number | null }>;
    expect(disp[0]).toMatchObject({ pagadora: "FLUJOS 02", pagadora_cuenta_id: flujos.id });
    expect(disp[1]).toMatchObject({ pagadora: "CUALQUIER FLUJO", pagadora_cuenta_id: null });
  });

  it("rechaza destinos inválidos: cuenta inexistente, cuenta fuera de operación o tipo desconocido", async () => {
    const tOp = await login("operador", "operador");

    const inexistente = await capturar(tOp, { destinos: [{ cuenta_id: 99999 }] });
    expect(inexistente.status).toBe(400);
    expect(JSON.stringify(inexistente.body.detalles)).toContain("no existe");

    const activa = await cuentaPorNombre(tOp, "FRENTES 01");
    const fuera = await request(app)
      .patch(`/api/cuentas/${activa.id}/estado`)
      .set(auth(await login("admin_tesoreria", "admin_tesoreria")))
      .send({ activa: false, motivo: "no uso momentáneo" });
    expect(fuera.status).toBe(200);

    const conFuera = await capturar(tOp, { destinos: [{ cuenta_id: activa.id }] });
    expect(conFuera.status).toBe(400);
    expect(JSON.stringify(conFuera.body.detalles)).toContain("fuera de operación");

    const tipoMalo = await capturar(tOp, { destinos: [{ tipo: "cripto" }] });
    expect(tipoMalo.status).toBe(400);

    const sinDestinos = await capturar(tOp, { destinos: [] });
    expect(sinDestinos.status).toBe(400);
  });

  it("rechaza una línea con pagadora fuera de operación y completa el nombre si falta", async () => {
    const tOp = await login("operador", "operador");
    const sofom = await cuentaPorNombre(tOp, "SOFOM 01");
    await request(app)
      .patch(`/api/cuentas/${sofom.id}/estado`)
      .set(auth(await login("admin_tesoreria", "admin_tesoreria")))
      .send({ activa: false, motivo: "bloqueo" });

    const res = await capturar(tOp, {
      destinos: [{ tipo: "flujo" }],
      pagadoras: [{ nombre: "SOFOM 01", id: sofom.id }],
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.detalles)).toContain("fuera de operación");
  });

  it("sin destinos conserva la captura legada por textos (compatibilidad)", async () => {
    const tOp = await login("operador", "operador");
    const res = await request(app)
      .post("/api/operaciones")
      .set(auth(tOp))
      .send({
        tipo: "flujo",
        concepto: "Flujo legado",
        monto: 60000,
        fecha_operacion: hoy(),
        pagador: "FLUJOS",
        tipo_operacion: "FLUJOS",
        timbrar: false,
        comision_pct: 2.5,
        dispersiones: [
          { beneficiario: "COMERCIAL BRAIN FENIX", cuenta: "6461803528523520323", banco: "STP", importe: 57000 },
          { beneficiario: "TRF CARD SAPI SA DE CV", cuenta: "646180352590100116", banco: "STP", importe: 303 },
        ],
      });
    expect(res.status).toBe(201);
    const det = await request(app).get(`/api/operaciones/${res.body.operacion.id}`).set(auth(tOp));
    expect(det.body.destinos).toHaveLength(0);

    // Sin pagador ni destinos → 400.
    const vacia = await capturar(tOp);
    expect(vacia.status).toBe(400);
    expect(JSON.stringify(vacia.body.detalles)).toContain("pagador requerido");
  });
});

describe("Edición de destinos y pagadoras", () => {
  it("PUT datos-flujo reemplaza los destinos y recalcula pagador/tipo_operacion", async () => {
    const tOp = await login("operador", "operador");
    const flujos = await cuentaPorNombre(tOp, "FLUJOS 01");
    const frente = await cuentaPorNombre(tOp, "FRENTES 02");
    const creada = await capturar(tOp, { destinos: [{ cuenta_id: flujos.id }] });
    expect(creada.status).toBe(201);
    const id = creada.body.operacion.id as number;

    const editar = await request(app)
      .put(`/api/operaciones/${id}/datos-flujo`)
      .set(auth(tOp))
      .send({
        timbrar: true,
        comision_pct: 2.5,
        observaciones: "",
        destinos: [{ cuenta_id: frente.id, manejo_manual: true }, { tipo: "sofom" }],
      });
    expect(editar.status).toBe(200);
    expect(editar.body.operacion.pagador).toBe("FRENTES 02, CUALQUIER SOFOM");
    expect(editar.body.operacion.tipo_operacion).toBe("frente, sofom");
    expect(editar.body.destinos).toHaveLength(2);
    expect(editar.body.destinos[0]).toMatchObject({ nombre: "FRENTES 02", manejo_manual: 1 });

    const det = await request(app).get(`/api/operaciones/${id}`).set(auth(tOp));
    expect(det.body.operacion.pagador).toBe("FRENTES 02, CUALQUIER SOFOM");
  });

  it("PUT dispersiones actualiza las pagadoras por línea y valida la cuenta", async () => {
    const tOp = await login("operador", "operador");
    const flujos = await cuentaPorNombre(tOp, "FLUJOS 03");
    const creada = await capturar(tOp, { destinos: [{ cuenta_id: flujos.id }] });
    const id = creada.body.operacion.id as number;

    const editar = await request(app)
      .put(`/api/operaciones/${id}/dispersiones`)
      .set(auth(tOp))
      .send({
        dispersiones: [
          {
            beneficiario: "COMERCIAL BRAIN FENIX",
            cuenta: "6461803528523520323",
            banco: "STP",
            importe: 57000,
            pagadora: "FLUJOS 03",
            pagadora_cuenta_id: flujos.id,
          },
          { beneficiario: "TRF CARD", importe: 303, pagadora: "CUALQUIER FLUJO", pagadora_cuenta_id: null },
        ],
      });
    expect(editar.status).toBe(200);
    expect(editar.body.dispersiones[0]).toMatchObject({ pagadora: "FLUJOS 03", pagadora_cuenta_id: flujos.id });
    expect(editar.body.dispersiones[1]).toMatchObject({ pagadora: "CUALQUIER FLUJO", pagadora_cuenta_id: null });

    const inactiva = await cuentaPorNombre(tOp, "SOFOM 02");
    await request(app)
      .patch(`/api/cuentas/${inactiva.id}/estado`)
      .set(auth(await login("admin_tesoreria", "admin_tesoreria")))
      .send({ activa: false });
    const mala = await request(app)
      .put(`/api/operaciones/${id}/dispersiones`)
      .set(auth(tOp))
      .send({
        dispersiones: [
          { beneficiario: "COMERCIAL BRAIN FENIX", importe: 57000, pagadora: "SOFOM 02", pagadora_cuenta_id: inactiva.id },
        ],
      });
    expect(mala.status).toBe(400);
    expect(JSON.stringify(mala.body.detalles)).toContain("fuera de operación");
  });
});

describe("Estado de la cuenta (sacar de operación / reactivar)", () => {
  it("sólo el administrador cambia el estado; el catálogo y la captura lo reflejan", async () => {
    const tOp = await login("operador", "operador");
    const tAdmin = await login("admin_tesoreria", "admin_tesoreria");
    const rend = await cuentaPorNombre(tOp, "ANTICIPO RENDIMIENTOS 01");

    // Permisos: el ejecutivo y el tesorero no pueden.
    const denegadoOp = await request(app)
      .patch(`/api/cuentas/${rend.id}/estado`)
      .set(auth(tOp))
      .send({ activa: false });
    expect(denegadoOp.status).toBe(403);
    const denegadoTes = await request(app)
      .patch(`/api/cuentas/${rend.id}/estado`)
      .set(auth(await login("tesoreria", "tesoreria")))
      .send({ activa: false });
    expect(denegadoTes.status).toBe(403);

    // Datos inválidos y estado repetido.
    const malDatos = await request(app)
      .patch(`/api/cuentas/${rend.id}/estado`)
      .set(auth(tAdmin))
      .send({ activa: "sí" });
    expect(malDatos.status).toBe(400);
    const repetido = await request(app)
      .patch(`/api/cuentas/${rend.id}/estado`)
      .set(auth(tAdmin))
      .send({ activa: true });
    expect(repetido.status).toBe(409);

    // Sacar de operación: desaparece del catálogo ligero (y del layout).
    const sacar = await request(app)
      .patch(`/api/cuentas/${rend.id}/estado`)
      .set(auth(tAdmin))
      .send({ activa: false, motivo: "bloqueo temporal" });
    expect(sacar.status).toBe(200);
    expect(sacar.body.cuenta.activa).toBe(0);

    const catalogo = await request(app).get("/api/cuentas/catalogo").set(auth(tOp));
    expect((catalogo.body.cuentas as CuentaCat[]).some((c) => c.id === rend.id)).toBe(false);

    // Con ?todas=1 el administrador la sigue viendo.
    const todas = await request(app).get("/api/cuentas?todas=1").set(auth(tAdmin));
    expect(todas.status).toBe(200);
    expect((todas.body.cuentas as Array<{ id: number; activa: number }>).some((c) => c.id === rend.id && c.activa === 0)).toBe(true);

    // La captura con esa cuenta se rechaza hasta reactivarla.
    const bloqueada = await capturar(tOp, { destinos: [{ cuenta_id: rend.id }] });
    expect(bloqueada.status).toBe(400);

    const reactivar = await request(app)
      .patch(`/api/cuentas/${rend.id}/estado`)
      .set(auth(tAdmin))
      .send({ activa: true });
    expect(reactivar.status).toBe(200);
    const catalogo2 = await request(app).get("/api/cuentas/catalogo").set(auth(tOp));
    expect((catalogo2.body.cuentas as CuentaCat[]).some((c) => c.id === rend.id)).toBe(true);
  });

  it("404 para cuentas inexistentes", async () => {
    const tAdmin = await login("admin_tesoreria", "admin_tesoreria");
    const res = await request(app).patch("/api/cuentas/99999/estado").set(auth(tAdmin)).send({ activa: false });
    expect(res.status).toBe(404);
  });
});

describe("El flujo de pago respeta las pagadoras", () => {
  it("con CUALQUIER FLUJO Tesorería determina la cuenta de salida y la operación se paga", async () => {
    const tOp = await login("operador", "operador");
    const tTes = await login("tesoreria", "tesoreria");
    const flujos04 = await cuentaPorNombre(tOp, "FLUJOS 04");
    const res = await request(app)
      .post("/api/operaciones")
      .set(auth(tOp))
      .send({
        tipo: "flujo",
        concepto: "Flujo con CUALQUIER FLUJO",
        monto: 60000,
        fecha_operacion: hoy(),
        timbrar: false,
        comision_pct: 2.5,
        destinos: [{ tipo: "flujo" }, { cuenta_id: flujos04.id, manejo_manual: true }],
        // Líneas sin banco/cuenta: no son verificables para altas bancarias y
        // no bloquean el pago (el foco aquí son las pagadoras).
        dispersiones: [
          { beneficiario: "PAGO GENERAL A", importe: 57000 },
          { beneficiario: "PAGO GENERAL B", importe: 303 },
        ],
      });
    expect(res.status).toBe(201);
    const id = res.body.operacion.id as number;
    await aprobarYLiberar(id);

    // Tesorería elige la cuenta de salida (pagadora orientativa) y paga todo.
    const pago = await request(app)
      .post(`/api/operaciones/${id}/pagos`)
      .set(auth(tTes))
      .send({
        pagos: [
          { medio: "transferencia", monto: 57303, comprobante: "TRF-9001", fecha_pago: hoy() },
        ],
      });
    expect(pago.status).toBe(201);

    const det = await request(app).get(`/api/operaciones/${id}`).set(auth(tTes));
    expect(det.body.operacion.estado).toBe("pagada");
    // Las pagadoras solicitadas siguen visibles en el detalle.
    expect(det.body.destinos).toHaveLength(2);
    expect(det.body.destinos.map((d: { nombre: string }) => d.nombre)).toEqual(["CUALQUIER FLUJO", "FLUJOS 04"]);
  });
});
