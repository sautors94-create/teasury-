import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Database } from "better-sqlite3";
import { crearApp } from "../src/app.js";
import { abrirBase } from "../src/db.js";

/**
 * Fase 17 — Cargos de Tesorería:
 *   · Las funciones de la Tesorería (validador, altas, confirmador, fondeador)
 *     son CARGOS asignables: todos son tesoreros y cada persona puede tener uno
 *     o varios cargos; cada cargo puede recaer en una o varias personas.
 *   · El cargo otorga las mismas funciones que su rol equivalente
 *     (requiereRol y visibilidad de /operaciones con roles efectivos).
 *   · Lo asignan el Administrador y el Administrador de Tesorería
 *     (PATCH /usuarios/:id/cargos); sólo aplica a personal de Tesorería.
 *   · Sembrado: val_tesoreria→validador, confirmador→confirmador,
 *     fondeador→fondeador, altas→altas; el analista 'tesoreria' nace sin cargos.
 */
let db: Database;
let app: ReturnType<typeof crearApp>;

async function login(username: string, password: string): Promise<{ token: string; cargos: string[] }> {
  const res = await request(app).post("/api/auth/login").send({ username, password });
  expect(res.status).toBe(200);
  return { token: res.body.token as string, cargos: res.body.usuario.cargos as string[] };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const hoy = (): string => new Date().toISOString().slice(0, 10);

async function idDe(username: string): Promise<number> {
  const { token } = await login("admin", "admin");
  const res = await request(app).get("/api/usuarios").set(auth(token));
  expect(res.status).toBe(200);
  const u = (res.body.usuarios as Array<{ username: string; id: number }>).find(
    (x) => x.username === username
  );
  expect(u, `usuario '${username}' debe existir`).toBeTruthy();
  return (u as { id: number }).id;
}

/** Captura una operación FLUJO mínima y la manda a validación (en_validacion). */
async function capturarEnValidacion(token: string): Promise<number> {
  const monto = 50000;
  const alta = await request(app)
    .post("/api/operaciones")
    .set(auth(token))
    .send({
      tipo: "flujo",
      concepto: "Operación de cargos",
      monto,
      fecha_operacion: hoy(),
      timbrar: false,
      comision_pct: 2.5,
      destinos: [{ tipo: "flujo" }],
      dispersiones: [
        {
          beneficiario: "COMERCIAL BRAIN FENIX",
          cuenta: "6461803528523520323",
          banco: "STP",
          importe: monto - 303,
          etiqueta: "PROVEEDOR",
        },
      ],
    });
  expect([200, 201]).toContain(alta.status);
  const id = (alta.body.operacion ?? alta.body).id as number;
  const envio = await request(app).post(`/api/operaciones/${id}/enviar-validacion`).set(auth(token));
  expect(envio.status).toBe(200);
  return id;
}

beforeEach(() => {
  db = abrirBase(":memory:");
  app = crearApp(db);
});

describe("Cargos de Tesorería — sembrado y sesión", () => {
  it("cada usuario tesorero nace con su cargo natural; el analista sin cargos", async () => {
    expect((await login("val_tesoreria", "val_tesoreria")).cargos).toEqual(["validador"]);
    expect((await login("confirmador", "confirmador")).cargos).toEqual(["confirmador"]);
    expect((await login("fondeador", "fondeador")).cargos).toEqual(["fondeador"]);
    expect((await login("altas", "altas")).cargos).toEqual(["altas"]);
    expect((await login("tesoreria", "tesoreria")).cargos).toEqual([]);
    expect((await login("admin", "admin")).cargos).toEqual([]);
  });

  it("el listado de personal de Tesorería incluye los cargos", async () => {
    const { token } = await login("admin", "admin");
    const res = await request(app).get("/api/usuarios/cargos").set(auth(token));
    expect(res.status).toBe(200);
    const personal = res.body.personal as Array<{ username: string; cargos: string[] }>;
    const tesorero = personal.find((p) => p.username === "val_tesoreria");
    expect(tesorero?.cargos).toEqual(["validador"]);
    expect(res.body.cargos_posibles).toEqual(["validador", "altas", "confirmador", "fondeador"]);
  });

  it("sólo admin y admin_tesoreria consultan el personal de Tesorería", async () => {
    const adminTesoreria = await login("admin_tesoreria", "admin_tesoreria");
    const ok = await request(app).get("/api/usuarios/cargos").set(auth(adminTesoreria.token));
    expect(ok.status).toBe(200);

    const operador = await login("operador", "operador");
    const negado = await request(app).get("/api/usuarios/cargos").set(auth(operador.token));
    expect(negado.status).toBe(403);

    const tesorero = await login("tesoreria", "tesoreria");
    const negado2 = await request(app).get("/api/usuarios/cargos").set(auth(tesorero.token));
    expect(negado2.status).toBe(403);
  });
});

describe("Cargos de Tesorería — asignación", () => {
  it("admin asigna dos cargos a un analista; surten efecto al reingresar", async () => {
    const idTesorero = await idDe("tesoreria");

    // Antes del cargo: el analista no entra a funciones de Fondeador.
    const antes = await login("tesoreria", "tesoreria");
    const negado = await request(app).get("/api/fondeador/resumen").set(auth(antes.token));
    expect(negado.status).toBe(403);

    const { token } = await login("admin", "admin");
    const res = await request(app)
      .patch(`/api/usuarios/${idTesorero}/cargos`)
      .set(auth(token))
      .send({ cargos: ["fondeador", "confirmador"] });
    expect(res.status).toBe(200);
    expect(res.body.usuario.cargos).toEqual(["fondeador", "confirmador"]);

    // Reingreso: el token nuevo trae los cargos y las funciones quedan activas.
    const despues = await login("tesoreria", "tesoreria");
    expect(despues.cargos).toEqual(["fondeador", "confirmador"]);
    const fondeo = await request(app).get("/api/fondeador/resumen").set(auth(despues.token));
    expect(fondeo.status).toBe(200);
  });

  it("admin_tesoreria también asigna; el resto queda negado", async () => {
    const idTesorero = await idDe("tesoreria");

    const adminTesoreria = await login("admin_tesoreria", "admin_tesoreria");
    const ok = await request(app)
      .patch(`/api/usuarios/${idTesorero}/cargos`)
      .set(auth(adminTesoreria.token))
      .send({ cargos: ["altas"] });
    expect(ok.status).toBe(200);

    const tesorero = await login("tesoreria", "tesoreria");
    const negado = await request(app)
      .patch(`/api/usuarios/${idTesorero}/cargos`)
      .set(auth(tesorero.token))
      .send({ cargos: [] });
    expect(negado.status).toBe(403);

    const operador = await login("operador", "operador");
    const negado2 = await request(app)
      .patch(`/api/usuarios/${idTesorero}/cargos`)
      .set(auth(operador.token))
      .send({ cargos: [] });
    expect(negado2.status).toBe(403);
  });

  it("rechaza cargos inválidos, duplicados los normaliza y exigencias de rol", async () => {
    const idTesorero = await idDe("tesoreria");
    const idOperador = await idDe("operador");
    const { token } = await login("admin", "admin");

    const invalido = await request(app)
      .patch(`/api/usuarios/${idTesorero}/cargos`)
      .set(auth(token))
      .send({ cargos: ["gerente"] });
    expect(invalido.status).toBe(400);

    const noArreglo = await request(app)
      .patch(`/api/usuarios/${idTesorero}/cargos`)
      .set(auth(token))
      .send({ cargos: "fondeador" });
    expect(noArreglo.status).toBe(400);

    // Los cargos sólo aplican a personal de Tesorería.
    const fuera = await request(app)
      .patch(`/api/usuarios/${idOperador}/cargos`)
      .set(auth(token))
      .send({ cargos: ["fondeador"] });
    expect(fuera.status).toBe(409);

    // Duplicados → se guardan una sola vez.
    const dup = await request(app)
      .patch(`/api/usuarios/${idTesorero}/cargos`)
      .set(auth(token))
      .send({ cargos: ["validador", "validador", "altas"] });
    expect(dup.status).toBe(200);
    expect(dup.body.usuario.cargos).toEqual(["validador", "altas"]);

    // Vaciar los cargos es válido (analista sin funciones extra).
    const vacio = await request(app)
      .patch(`/api/usuarios/${idTesorero}/cargos`)
      .set(auth(token))
      .send({ cargos: [] });
    expect(vacio.status).toBe(200);
    expect(vacio.body.usuario.cargos).toEqual([]);

    const inexistente = await request(app)
      .patch("/api/usuarios/999999/cargos")
      .set(auth(token))
      .send({ cargos: [] });
    expect(inexistente.status).toBe(404);
  });

  it("alta de usuario con cargos desde POST /usuarios", async () => {
    const { token } = await login("admin", "admin");
    const alta = await request(app)
      .post("/api/usuarios")
      .set(auth(token))
      .send({
        username: "tesorero.multi",
        nombre: "Tesorero con dos cargos",
        rol: "tesoreria",
        password: "secreto1",
        cargos: ["fondeador", "validador"],
      });
    expect(alta.status).toBe(201);
    expect(alta.body.usuario.cargos).toEqual(["fondeador", "validador"]);

    const sesion = await login("tesorero.multi", "secreto1");
    expect(sesion.cargos).toEqual(["fondeador", "validador"]);
    const fondeo = await request(app).get("/api/fondeador/resumen").set(auth(sesion.token));
    expect(fondeo.status).toBe(200);

    // Un usuario con cargos debe existir para entrar; la contraseña sí se pide.
    const malPass = await request(app)
      .post("/api/auth/login")
      .send({ username: "tesorero.multi", password: "incorrecta" });
    expect(malPass.status).toBe(401);
  });
});

describe("Cargos de Tesorería — funciones otorgadas", () => {
  it("el cargo fondeador habilita liberar operaciones aprobadas", async () => {
    // Flujo completo mínimo: captura → Calidad aprueba → dirección no interviene
    // (monto bajo el umbral) → queda aprobada; el cargo fondeador la libera.
    const operador = await login("operador", "operador");
    const id = await capturarEnValidacion(operador.token);

    const validador = await login("validador", "validador");
    const revision = await request(app)
      .post(`/api/operaciones/${id}/revision`)
      .set(auth(validador.token))
      .send({ resultado: "aprobada", comentario: "Ok (prueba de cargos)" });
    expect(revision.status).toBe(200);

    // El analista SIN cargo no ve la operación en su lista ni puede liberar.
    const analista = await login("tesoreria", "tesoreria");
    const listaSinCargo = await request(app).get("/api/operaciones").set(auth(analista.token));
    expect(listaSinCargo.status).toBe(200);
    expect(
      (listaSinCargo.body.operaciones as Array<{ id: number }>).some((o) => o.id === id)
    ).toBe(false);
    const liberarSinCargo = await request(app)
      .post(`/api/operaciones/${id}/liberar`)
      .set(auth(analista.token));
    expect(liberarSinCargo.status).toBe(403);

    // Con el cargo 'fondeador': la VE (alcance del fondeador) y la LIBERA.
    const idTesorero = await idDe("tesoreria");
    const admin = await login("admin", "admin");
    const asigna = await request(app)
      .patch(`/api/usuarios/${idTesorero}/cargos`)
      .set(auth(admin.token))
      .send({ cargos: ["fondeador"] });
    expect(asigna.status).toBe(200);

    const conCargo = await login("tesoreria", "tesoreria");
    const lista = await request(app).get("/api/operaciones").set(auth(conCargo.token));
    expect(lista.status).toBe(200);
    expect(
      (lista.body.operaciones as Array<{ id: number }>).some((o) => o.id === id)
    ).toBe(true);

    const liberar = await request(app)
      .post(`/api/operaciones/${id}/liberar`)
      .set(auth(conCargo.token));
    expect(liberar.status).toBe(200);
  });

  it("el cargo validador habilita validar en Tesorería (endpoints de validador_tesoreria)", async () => {
    const idTesorero = await idDe("tesoreria");
    const admin = await login("admin", "admin");
    const asigna = await request(app)
      .patch(`/api/usuarios/${idTesorero}/cargos`)
      .set(auth(admin.token))
      .send({ cargos: ["validador"] });
    expect(asigna.status).toBe(200);

    // Endpoint típico del Validador de Tesorería: recursos disponibles.
    const conCargo = await login("tesoreria", "tesoreria");
    const ok = await request(app)
      .get("/api/recursos/disponibles")
      .set(auth(conCargo.token));
    expect(ok.status).toBe(200);

    // Sin el cargo, el mismo endpoint queda negado (se comprueba con otro
    // analista limpio reingresando tras vaciar el cargo).
    const vacia = await request(app)
      .patch(`/api/usuarios/${idTesorero}/cargos`)
      .set(auth(admin.token))
      .send({ cargos: [] });
    expect(vacia.status).toBe(200);
    const sinCargo = await login("tesoreria", "tesoreria");
    const negado = await request(app)
      .get("/api/recursos/disponibles")
      .set(auth(sinCargo.token));
    expect(negado.status).toBe(403);
  });
});
