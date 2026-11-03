import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Database } from "better-sqlite3";
import { crearApp } from "../src/app.js";
import { abrirBase } from "../src/db.js";

/**
 * Fase 12 — Visibilidad de operaciones por rol:
 *   · admin/admin_operaciones/admin_validacion/admin_tesoreria/validador_tesoreria/
 *     direccion/auditoria → todas.
 *   · operacion → su historial por día, hasta 1 mes atrás.
 *   · validacion → asignadas por ejecutivo (o flujo simple si no hay distribución).
 *   · fondeador → por validar y ya validadas; su liberación habilita a Tesorería.
 *   · tesoreria → sólo lo liberado por el Tesorero Fondeador.
 *   · confirmador → sólo operaciones con depósitos por confirmar.
 * Cancelación: el dueño (pre-validación) o Tesorería; Dirección ya no cancela.
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
const diaRelativo = (delta: number): string =>
  new Date(Date.now() + delta * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

/** PNG 1x1 válido para comprobantes documentales de depósitos (§5.3). */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Captura FLUJO sin datos bancarios (sin bloqueo de altas) para visibilidad. */
async function capturaFlujo(token: string, fecha = hoy()): Promise<number> {
  const res = await request(app)
    .post("/api/operaciones")
    .set(auth(token))
    .send({
      tipo: "flujo",
      concepto: "Flujo de visibilidad",
      monto: 60000,
      fecha_operacion: fecha,
      pagador: "FLUJOS",
      tipo_operacion: "FLUJOS",
      timbrar: false,
      comision_pct: 2.5,
      dispersiones: [
        { beneficiario: "BENEFICIARIO A", importe: 57000, etiqueta: "PROVEEDOR" },
        { beneficiario: "BENEFICIARIO B", importe: 1500, etiqueta: "COMISION" },
      ],
    });
  expect(res.status).toBe(201);
  return res.body.operacion.id as number;
}

/** Captura simple del formato anterior (sin dispersiones). */
async function capturaSimple(token: string, concepto = "Pago simple"): Promise<number> {
  const res = await request(app)
    .post("/api/operaciones")
    .set(auth(token))
    .send({ tipo: "pago", concepto, proveedor: "Proveedor SA", monto: 1000, fecha_operacion: hoy() });
  expect(res.status).toBe(201);
  return res.body.operacion.id as number;
}

/** Envía a validación y aprueba (monto bajo el umbral de Dirección). */
async function aprobar(id: number): Promise<void> {
  await request(app).post(`/api/operaciones/${id}/enviar-validacion`).set(auth(await login("operador", "operador")));
  const rev = await request(app)
    .post(`/api/operaciones/${id}/revision`)
    .set(auth(await login("validador", "validador")))
    .send({ resultado: "aprobada", comentario: "en orden" });
  expect(rev.status).toBe(200);
}

const ids = (lista: Array<{ id: number }>): number[] => lista.map((o) => o.id);

beforeEach(() => {
  db = abrirBase(":memory:");
  app = crearApp(db);
});

describe("Alcance del Ejecutivo: historial por día (hasta 1 mes)", () => {
  it("ve su captura del día por defecto y rechaza consultar más de 1 mes atrás", async () => {
    const tOp = await login("operador", "operador");
    const idHoy = await capturaSimple(tOp, "Del día");

    const lista = await request(app).get("/api/operaciones").set(auth(tOp));
    expect(lista.status).toBe(200);
    expect(ids(lista.body.operaciones)).toContain(idHoy);

    // Consulta explícita por día.
    const porDia = await request(app)
      .get(`/api/operaciones?desde=${hoy()}&hasta=${hoy()}`)
      .set(auth(tOp));
    expect(porDia.status).toBe(200);
    expect(ids(porDia.body.operaciones)).toContain(idHoy);

    // Más de 1 mes atrás → rechazado.
    const muyAtras = await request(app).get(`/api/operaciones?desde=${diaRelativo(-40)}`).set(auth(tOp));
    expect(muyAtras.status).toBe(400);
    expect(muyAtras.body.error).toMatch(/1 mes/);

    // Fecha inválida → 400.
    const mala = await request(app).get("/api/operaciones?desde=ayer").set(auth(tOp));
    expect(mala.status).toBe(400);
  });

  it("el admin ve todas; el operador no ve las ajenas (ni su detalle)", async () => {
    const tOp1 = await login("operador", "operador");
    const id1 = await capturaSimple(tOp1, "Del ejecutivo 1");
    const tSis = await login("admin", "admin");
    await request(app)
      .post("/api/usuarios")
      .set(auth(tSis))
      .send({ username: "ops2", nombre: "Segundo Ejecutivo", rol: "operacion", password: "clave4" });
    const tOp2 = await login("ops2", "clave4");
    const id2 = await capturaSimple(tOp2, "Del ejecutivo 2");

    const todas = await request(app).get("/api/operaciones").set(auth(tSis));
    expect(ids(todas.body.operaciones)).toEqual(expect.arrayContaining([id1, id2]));

    const propias = await request(app).get("/api/operaciones").set(auth(tOp1));
    expect(ids(propias.body.operaciones)).toContain(id1);
    expect(ids(propias.body.operaciones)).not.toContain(id2);

    const detalleAjena = await request(app).get(`/api/operaciones/${id2}`).set(auth(tOp1));
    expect(detalleAjena.status).toBe(403);
  });
});

describe("Tesorero Fondeador: visibilidad y liberación", () => {
  it("ve por validar y validadas (no borradores); sin liberar, Tesorería no ve ni paga", async () => {
    const tOp = await login("operador", "operador");
    const id = await capturaFlujo(tOp);
    const tFon = await login("fondeador", "fondeador");
    const tTes = await login("tesoreria", "tesoreria");

    // Borrador: fuera del alcance del Fondeador.
    let lista = await request(app).get("/api/operaciones").set(auth(tFon));
    expect(ids(lista.body.operaciones)).not.toContain(id);
    const detalleBorrador = await request(app).get(`/api/operaciones/${id}`).set(auth(tFon));
    expect(detalleBorrador.status).toBe(403);

    // En validación: el Fondeador ya la ve (por validar).
    await request(app).post(`/api/operaciones/${id}/enviar-validacion`).set(auth(tOp));
    lista = await request(app).get("/api/operaciones").set(auth(tFon));
    expect(ids(lista.body.operaciones)).toContain(id);

    // Aprobada: por liberar. Tesorería AÚN no la ve ni puede pagarla.
    await aprobar(id);
    const resumen = await request(app).get("/api/fondeador/resumen").set(auth(tFon));
    expect(resumen.status).toBe(200);
    const aprobadas = resumen.body.por_estado[3];
    expect(aprobadas.operaciones).toBe(1);
    expect(resumen.body.por_liberar.operaciones).toBe(1);

    lista = await request(app).get("/api/operaciones").set(auth(tTes));
    expect(ids(lista.body.operaciones)).not.toContain(id);
    const detalle = await request(app).get(`/api/operaciones/${id}`).set(auth(tTes));
    expect(detalle.status).toBe(403);
    const pagoAntes = await request(app)
      .post(`/api/operaciones/${id}/pago`)
      .set(auth(tTes))
      .send({ medio: "transferencia", monto: 58500, comprobante: "TRF-1" });
    expect(pagoAntes.status).toBe(409);
    expect(pagoAntes.body.error).toMatch(/liberación del Tesorero Fondeador/);

    // Liberación: sólo el Fondeador; Tesorería ya ve la operación y puede pagar.
    const noAutorizado = await request(app).post(`/api/operaciones/${id}/liberar`).set(auth(tTes));
    expect(noAutorizado.status).toBe(403);
    const liberar = await request(app).post(`/api/operaciones/${id}/liberar`).set(auth(tFon));
    expect(liberar.status).toBe(200);
    expect(liberar.body.operacion.liberada_en).toBeTruthy();
    const doble = await request(app).post(`/api/operaciones/${id}/liberar`).set(auth(tFon));
    expect(doble.status).toBe(409);

    lista = await request(app).get("/api/operaciones").set(auth(tTes));
    expect(ids(lista.body.operaciones)).toContain(id);
    const detalleLibre = await request(app).get(`/api/operaciones/${id}`).set(auth(tTes));
    expect(detalleLibre.status).toBe(200);
    expect(detalleLibre.body.liberada_por_nombre).toBe("Tesorero Fondeador");
  });

  it("el resumen del fondeador agrupa por estado y por tipo de operación", async () => {
    const tOp = await login("operador", "operador");
    const id = await capturaFlujo(tOp);
    // El Fondeador planifica con lo que está (o estuvo) en el proceso de validación.
    await request(app).post(`/api/operaciones/${id}/enviar-validacion`).set(auth(tOp));
    const tFon = await login("fondeador", "fondeador");
    const resumen = await request(app).get("/api/fondeador/resumen").set(auth(tFon));
    expect(resumen.status).toBe(200);
    const flujos = resumen.body.por_tipo.find((t: { tipo_operacion: string }) => t.tipo_operacion === "FLUJOS");
    expect(flujos).toBeTruthy();
    expect(flujos.moneda).toBe("MXN");
    expect(Number(flujos.monto)).toBe(60000);
    // Otras vistas de fondeo no las abre otro rol.
    const negado = await request(app).get("/api/fondeador/resumen").set(auth(await login("operador", "operador")));
    expect(negado.status).toBe(403);
  });
});

describe("Validación por ejecutivos asignados", () => {
  it("el admin_validacion asigna ejecutivos y el validador sólo ve lo suyo", async () => {
    const tAdminV = await login("admin_validacion", "admin_validacion");
    const tSis = await login("admin", "admin");
    const tOp1 = await login("operador", "operador");
    const idEje1 = (await request(app).get("/api/auth/me").set(auth(tOp1))).body.usuario.id as number;
    await request(app)
      .post("/api/usuarios")
      .set(auth(tSis))
      .send({ username: "ops2", nombre: "Segundo Ejecutivo", rol: "operacion", password: "clave4" });
    const tOp2 = await login("ops2", "clave4");
    const idEje2 = (await request(app).get("/api/auth/me").set(auth(tOp2))).body.usuario.id as number;
    await request(app)
      .post("/api/usuarios")
      .set(auth(tSis))
      .send({ username: "validador2", nombre: "Segundo Validador", rol: "validacion", password: "clave4" });

    const op1 = await capturaSimple(tOp1, "Op del ejecutivo 1");
    const op2 = await capturaSimple(tOp2, "Op del ejecutivo 2");

    // Sin distribución: ambos validadores ven ambas (flujo simple).
    const listaLibre = await request(app).get("/api/operaciones").set(auth(await login("validador", "validador")));
    expect(ids(listaLibre.body.operaciones)).toEqual(expect.arrayContaining([op1, op2]));

    // Asignaciones: ejecutivo 1 → validador base; ejecutivo 2 → validador 2.
    const validadores = await request(app).get("/api/usuarios/validadores").set(auth(tAdminV));
    const val1 = validadores.body.validadores.find((v: { username: string }) => v.username === "validador").id;
    const val2 = validadores.body.validadores.find((v: { username: string }) => v.username === "validador2").id;
    const asig1 = await request(app).post("/api/validacion/asignar-ejecutivo").set(auth(tAdminV)).send({
      validador_id: val1,
      ejecutivo_id: idEje1,
      motivo: "cuenta principal",
    });
    expect(asig1.status).toBe(201);
    const asig2 = await request(app).post("/api/validacion/asignar-ejecutivo").set(auth(tAdminV)).send({
      validador_id: val2,
      ejecutivo_id: idEje2,
    });
    expect(asig2.status).toBe(201);
    // Duplicada → 409; sólo admin_validacion asigna.
    const duplicada = await request(app)
      .post("/api/validacion/asignar-ejecutivo")
      .set(auth(tAdminV))
      .send({ validador_id: val1, ejecutivo_id: idEje1 });
    expect(duplicada.status).toBe(409);
    const noAutorizado = await request(app)
      .post("/api/validacion/asignar-ejecutivo")
      .set(auth(await login("admin_ops", "admin_ops")))
      .send({ validador_id: val1, ejecutivo_id: idEje2 });
    expect(noAutorizado.status).toBe(403);

    // Cada validador ve sólo las operaciones de sus ejecutivos.
    const lista1 = await request(app).get("/api/operaciones").set(auth(await login("validador", "validador")));
    expect(ids(lista1.body.operaciones)).toContain(op1);
    expect(ids(lista1.body.operaciones)).not.toContain(op2);
    const lista2 = await request(app).get("/api/operaciones").set(auth(await login("validador2", "clave4")));
    expect(ids(lista2.body.operaciones)).toContain(op2);
    expect(ids(lista2.body.operaciones)).not.toContain(op1);

    // Ambas en validación: el admin de validación ve la cola completa.
    await request(app).post(`/api/operaciones/${op1}/enviar-validacion`).set(auth(tOp1));
    await request(app).post(`/api/operaciones/${op2}/enviar-validacion`).set(auth(tOp2));
    const listaAdmin = await request(app).get("/api/validacion/cola").set(auth(tAdminV));
    expect(listaAdmin.body.cola).toHaveLength(2);
    const ajeno = await request(app)
      .post(`/api/operaciones/${op2}/revision`)
      .set(auth(await login("validador", "validador")))
      .send({ resultado: "aprobada", comentario: "no es mío" });
    expect(ajeno.status).toBe(403);
    const propio = await request(app)
      .post(`/api/operaciones/${op2}/revision`)
      .set(auth(await login("validador2", "clave4")))
      .send({ resultado: "aprobada", comentario: "asignado al ejecutivo" });
    expect(propio.status).toBe(200);

    // Cerrar la asignación: el ejecutivo vuelve al flujo simple.
    const cerrar = await request(app).post(`/api/validacion/asignaciones-ejecutivos/${asig1.body.asignacion.id}/cerrar`).set(auth(tAdminV));
    expect(cerrar.status).toBe(200);
    const listaTrasCierre = await request(app).get("/api/operaciones").set(auth(await login("validador2", "clave4")));
    expect(ids(listaTrasCierre.body.operaciones)).toContain(op1);
  });
});

describe("Cancelación: dueño o Tesorería (Dirección ya no cancela)", () => {
  it("el dueño cancela en borrador; Tesorería cancela en validación; dirección y ajenos 403", async () => {
    const tOp = await login("operador", "operador");
    const tSis = await login("admin", "admin");
    await request(app)
      .post("/api/usuarios")
      .set(auth(tSis))
      .send({ username: "ops2", nombre: "Segundo Ejecutivo", rol: "operacion", password: "clave4" });
    const tOp2 = await login("ops2", "clave4");

    // Dueño en borrador → OK.
    const id1 = await capturaSimple(tOp, "Por cancelar en borrador");
    const ajeno = await request(app).post(`/api/operaciones/${id1}/cancelar`).set(auth(tOp2));
    expect(ajeno.status).toBe(403);
    const direccion = await request(app).post(`/api/operaciones/${id1}/cancelar`).set(auth(await login("direccion", "direccion")));
    expect(direccion.status).toBe(403);
    const propia = await request(app).post(`/api/operaciones/${id1}/cancelar`).set(auth(tOp));
    expect(propia.status).toBe(200);
    expect(propia.body.operacion.estado).toBe("cancelada");

    // En validación: el dueño ya no puede; Tesorería sí.
    const id2 = await capturaSimple(tOp, "Por cancelar en validación");
    await request(app).post(`/api/operaciones/${id2}/enviar-validacion`).set(auth(tOp));
    const dueñoEnValidacion = await request(app).post(`/api/operaciones/${id2}/cancelar`).set(auth(tOp));
    expect(dueñoEnValidacion.status).toBe(409);
    const tesoreria = await request(app)
      .post(`/api/operaciones/${id2}/cancelar`)
      .set(auth(await login("tesoreria", "tesoreria")));
    expect(tesoreria.status).toBe(200);
    expect(tesoreria.body.operacion.estado).toBe("cancelada");
  });
});

describe("Confirmador: sólo operaciones con depósitos por confirmar", () => {
  it("ve la operación con depósito pendiente y deja de verla al confirmarlo", async () => {
    const tOp = await login("operador", "operador");
    const tAdminOps = await login("admin_ops", "admin_ops");
    const cliente = await request(app).post("/api/clientes").set(auth(tAdminOps)).send({ nombre: "Cliente Conf" });
    const idOp = (await request(app).get("/api/auth/me").set(auth(tOp))).body.usuario.id as number;
    await request(app)
      .post(`/api/clientes/${cliente.body.cliente.id}/asignaciones`)
      .set(auth(tAdminOps))
      .send({ ejecutivo_id: idOp });
    const res = await request(app)
      .post("/api/operaciones")
      .set(auth(tOp))
      .send({
        tipo: "pago",
        concepto: "Con depósito por confirmar",
        proveedor: "Proveedor SA",
        monto: 1000,
        fecha_operacion: hoy(),
        cliente_id: cliente.body.cliente.id,
      });
    expect(res.status).toBe(201);
    const id = res.body.operacion.id as number;

    const tAdminT = await login("admin_tesoreria", "admin_tesoreria");
    const cuenta = await request(app)
      .post("/api/cuentas")
      .set(auth(tAdminT))
      .send({ nombre: "FLUJOS 90", banco: "BBVA", saldo_inicial: 0 });
    expect(cuenta.status).toBe(201);
    const dep = await request(app)
      .post(`/api/operaciones/${id}/deposito`)
      .set(auth(tOp))
      .send({ cuenta_id: cuenta.body.cuenta.id, monto: 1000, comprobante: "FICHA-1", fecha_deposito: hoy() });
    expect(dep.status).toBe(201);

    const tConf = await login("confirmador", "confirmador");
    const lista = await request(app).get("/api/operaciones").set(auth(tConf));
    expect(ids(lista.body.operaciones)).toContain(id);
    const detalle = await request(app).get(`/api/operaciones/${id}`).set(auth(tConf));
    expect(detalle.status).toBe(200);

    // Con comprobante documental adjunto, el Administrador de Tesorería valida
    // el depósito y la operación sale del alcance del confirmador.
    const subir = await request(app)
      .post(`/api/depositos/${dep.body.deposito.id}/comprobantes`)
      .set(auth(tOp))
      .send({ comprobantes: [{ nombre: "ficha.png", mime: "image/png", contenido: PNG }] });
    expect(subir.status).toBe(201);
    const validar = await request(app).post(`/api/depositos/${dep.body.deposito.id}/validar`).set(auth(tAdminT));
    expect(validar.status).toBe(200);
    const listaTras = await request(app).get("/api/operaciones").set(auth(tConf));
    expect(ids(listaTras.body.operaciones)).not.toContain(id);
  });
});
