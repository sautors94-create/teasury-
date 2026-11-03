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

beforeEach(() => {
  db = abrirBase(":memory:");
  app = crearApp(db);
});

const payloadLocal = {
  folio: "OP-LOCAL-00001",
  tipo: "pago",
  concepto: "Captura offline",
  proveedor: "Cliente sin red",
  monto: 1234.5,
  moneda: "MXN",
  fecha_operacion: "2026-11-01",
  estado: "borrador",
};

describe("protocolo de sincronización", () => {
  it("acepta cambios nuevos, reasigna folio local y los publica en pull", async () => {
    const token = await login("operador", "operador");
    const push = await request(app)
      .post("/api/sync/push")
      .set("Authorization", `Bearer ${token}`)
      .send({ cambios: [{ tabla: "operaciones", uuid: "uuid-abc", version: 1, payload: payloadLocal }] });
    expect(push.status).toBe(200);
    expect(push.body.resultados[0]).toMatchObject({ uuid: "uuid-abc", estado: "aplicado", accion: "insert" });

    const lista = await request(app).get("/api/operaciones").set("Authorization", `Bearer ${token}`);
    const op = lista.body.operaciones.find((o: { concepto: string }) => o.concepto === "Captura offline");
    expect(op).toBeTruthy();
    expect(op.folio).toMatch(/^OP-\d{4}-\d{5}$/); // reasignado
    expect(op.folio.startsWith("OP-LOCAL")).toBe(false);

    // Pull entrega el cambio y el cursor avanza
    const pull1 = await request(app).get("/api/sync/pull?desde=0").set("Authorization", `Bearer ${token}`);
    expect(pull1.status).toBe(200);
    expect(pull1.body.cambios.length).toBeGreaterThanOrEqual(1);
    expect(pull1.body.cambios[0]).toMatchObject({ tabla: "operaciones", uuid: "uuid-abc", version: 1 });
    expect(pull1.body.cambios[0].payload.concepto).toBe("Captura offline");
    const cursor = pull1.body.cursor as number;

    const pull2 = await request(app)
      .get(`/api/sync/pull?desde=${cursor}`)
      .set("Authorization", `Bearer ${token}`);
    expect(pull2.body.cambios.length).toBe(0); // sin duplicados

    // Auditoría registra la aplicación del cambio
    const auditor = await login("auditor", "auditor");
    const audit = await request(app).get("/api/auditoria").set("Authorization", `Bearer ${auditor}`);
    const acciones = audit.body.eventos.map((e: { accion: string }) => e.accion);
    expect(acciones).toContain("sync_aplicacion");
  });

  it("es idempotente: repetir el mismo cambio no duplica registros", async () => {
    const token = await login("operador", "operador");
    const mismo = { cambios: [{ tabla: "operaciones", uuid: "uuid-idem", version: 1, payload: payloadLocal }] };
    const primero = await request(app)
      .post("/api/sync/push")
      .set("Authorization", `Bearer ${token}`)
      .send(mismo);
    expect(primero.body.resultados[0].estado).toBe("aplicado");
    const otra = await request(app).post("/api/sync/push").set("Authorization", `Bearer ${token}`).send(mismo);
    // misma versión: o duplicado o conflicto (nunca un segundo insert)
    expect(["duplicado", "conflicto"]).toContain(otra.body.resultados[0].estado);

    const lista = await request(app).get("/api/operaciones").set("Authorization", `Bearer ${token}`);
    const iguales = lista.body.operaciones.filter((o: { concepto: string }) => o.concepto === "Captura offline");
    expect(iguales).toHaveLength(1);
  });

  it("aplica versiones mayores y devuelve conflicto a menores", async () => {
    const token = await login("operador", "operador");
    await request(app)
      .post("/api/sync/push")
      .set("Authorization", `Bearer ${token}`)
      .send({ cambios: [{ tabla: "operaciones", uuid: "uuid-v2", version: 1, payload: payloadLocal }] });

    const update = await request(app)
      .post("/api/sync/push")
      .set("Authorization", `Bearer ${token}`)
      .send({
        cambios: [
          {
            tabla: "operaciones",
            uuid: "uuid-v2",
            version: 2,
            payload: { ...payloadLocal, folio: undefined, concepto: "Captura offline (corregida)" },
          },
        ],
      });
    expect(update.body.resultados[0]).toMatchObject({ estado: "aplicado", accion: "update" });

    const lista = await request(app).get("/api/operaciones").set("Authorization", `Bearer ${token}`);
    const op = lista.body.operaciones.find((o: { concepto: string }) => o.concepto.includes("corregida"));
    expect(op).toBeTruthy();

    // Versión vieja → conflicto con el registro local
    const vieja = await request(app)
      .post("/api/sync/push")
      .set("Authorization", `Bearer ${token}`)
      .send({ cambios: [{ tabla: "operaciones", uuid: "uuid-v2", version: 1, payload: payloadLocal }] });
    expect(vieja.body.resultados[0].estado).toBe("conflicto");
    expect(vieja.body.resultados[0].version_servidor).toBe(2);
    expect(vieja.body.resultados[0].registro_local.concepto).toContain("corregida");
  });

  it("emite al capturar localmente y al cambiar de estado", async () => {
    const tokenOp = await login("operador", "operador");
    const creacion = await request(app)
      .post("/api/operaciones")
      .set("Authorization", `Bearer ${tokenOp}`)
      .send({
        tipo: "cobro",
        concepto: "Emisión local",
        proveedor: "X",
        monto: 100,
        fecha_operacion: "2026-11-02",
      });
    const id = creacion.body.operacion.id as number;
    await request(app)
      .post(`/api/operaciones/${id}/enviar-validacion`)
      .set("Authorization", `Bearer ${tokenOp}`);

    const pull = await request(app).get("/api/sync/pull?desde=0").set("Authorization", `Bearer ${tokenOp}`);
    const cambios = pull.body.cambios.filter((c: { tabla: string }) => c.tabla === "operaciones");
    expect(cambios.length).toBe(2); // captura (v1) + cambio de estado (v2)
    expect(cambios[0].version).toBe(1);
    expect(cambios[1].version).toBe(2);
    expect(cambios[1].payload.estado).toBe("en_validacion");
  });

  it("valida tabla, campos y versión", async () => {
    const token = await login("operador", "operador");
    const res = await request(app)
      .post("/api/sync/push")
      .set("Authorization", `Bearer ${token}`)
      .send({
        cambios: [
          { tabla: "usuarios", uuid: "u1", version: 1, payload: { username: "hack" } },
          { tabla: "operaciones", uuid: "u2", version: 0, payload: payloadLocal },
          { tabla: "operaciones", uuid: "u3", version: 1, payload: { ...payloadLocal, saldo: 9 } },
        ],
      });
    expect(res.status).toBe(200);
    const estados = res.body.resultados.map((r: { estado: string }) => r.estado);
    expect(estados).toEqual(["error", "error", "error"]);
  });

  it("restringe push al rol auditoría y exige token", async () => {
    const auditor = await login("auditor", "auditor");
    const res = await request(app)
      .post("/api/sync/push")
      .set("Authorization", `Bearer ${auditor}`)
      .send({ cambios: [] });
    expect(res.status).toBe(403);

    const anon = await request(app).get("/api/sync/pull?desde=0");
    expect(anon.status).toBe(401);
  });
});