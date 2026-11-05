import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Database } from "better-sqlite3";
import { crearApp } from "../src/app.js";
import { abrirBase } from "../src/db.js";

/**
 * Layout simple de cuentas (regla del negocio: SÓLO el Administrador de
 * Tesorería agrega cuentas). El archivo pide 4 columnas — BANCO, NOMBRE,
 * CLAVE (CLABE a 18 dígitos) y CUENTA CORTA (número de cuenta):
 *   · admin_tesoreria / admin cargan el layout; cualquier otro rol → 403.
 *   · Crea la cuenta o la ACTUALIZA si ya existe (misma CLABE o mismo banco +
 *     cuenta corta): nunca duplica.
 *   · La cuenta corta se deriva de la CLABE cuando falta (regla por banco).
 *   · Filas incompletas (sin banco/nombre/clave/cuenta) se reportan por fila.
 */
let db: Database;
let app: ReturnType<typeof crearApp>;

async function login(username: string, password: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ username, password });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const CLABE_BANORTE = "072180004912345678"; // → cuenta derivada 0491234567
const CLABE_STP = "646180401200001407"; // STP no deriva cuenta (manual)

beforeEach(() => {
  db = abrirBase(":memory:");
  app = crearApp(db);
});

describe("Layout de cuentas (carga por archivo)", () => {
  it("sólo admin_tesoreria (o admin) carga el layout; tesorero y operador reciben 403", async () => {
    const tAdmin = await login("admin_tesoreria", "admin_tesoreria");
    const tTeso = await login("tesoreria", "tesoreria");
    const tOp = await login("operador", "operador");
    const filas = [{ banco: "BANORTE", nombre: "Frente Norte", clave: CLABE_BANORTE, cuenta_corta: "" }];
    const denegadoTeso = await request(app).post("/api/cuentas/layout").set(auth(tTeso)).send({ filas });
    expect(denegadoTeso.status).toBe(403);
    const denegadoOp = await request(app).post("/api/cuentas/layout").set(auth(tOp)).send({ filas });
    expect(denegadoOp.status).toBe(403);
    const ok = await request(app).post("/api/cuentas/layout").set(auth(tAdmin)).send({ filas });
    expect(ok.status).toBe(201);
    expect(ok.body.creadas).toEqual(["Frente Norte"]);
  });

  it("crea cuentas: con CLABE deriva la cuenta corta; sin CLABE usa la cuenta corta dada; reporta filas incompletas", async () => {
    const t = await login("admin_tesoreria", "admin_tesoreria");
    const res = await request(app)
      .post("/api/cuentas/layout")
      .set(auth(t))
      .send({
        filas: [
          { banco: "BANORTE", nombre: "Flujo A", clave: CLABE_BANORTE, cuenta_corta: "" },
          { banco: "STP", nombre: "Flujo B", clave: "", cuenta_corta: "1407" },
          { banco: "", nombre: "Sin banco", clave: "", cuenta_corta: "123" },
          { banco: "STP", nombre: "", clave: "", cuenta_corta: "555" },
          { banco: "STP", nombre: "Sin números", clave: "", cuenta_corta: "" },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.creadas).toEqual(["Flujo A", "Flujo B"]);
    expect(res.body.errores).toHaveLength(3);
    const flujoA = db.prepare("SELECT * FROM cuentas WHERE nombre = 'Flujo A'").get() as {
      numero_cuenta: string;
      clabe: string;
      origen: string;
      estatus: string;
    };
    expect(flujoA.clabe).toBe(CLABE_BANORTE);
    expect(flujoA.numero_cuenta).toBe("0491234567");
    expect(flujoA.origen).toBe("layout");
    expect(flujoA.estatus).toBe("ACTIVA");
    const flujoB = db.prepare("SELECT * FROM cuentas WHERE nombre = 'Flujo B'").get() as {
      numero_cuenta: string;
      clabe: string;
    };
    expect(flujoB.numero_cuenta).toBe("1407");
    expect(flujoB.clabe).toBe("");
  });

  it("no duplica: recargar el mismo layout actualiza en lugar de crear", async () => {
    const t = await login("admin_tesoreria", "admin_tesoreria");
    const filas = [
      { banco: "STP", nombre: "Operaciones MX", clave: CLABE_STP, cuenta_corta: "" },
      { banco: "STP", nombre: "Fondeo", clave: "", cuenta_corta: "9001" },
    ];
    const primera = await request(app).post("/api/cuentas/layout").set(auth(t)).send({ filas });
    expect(primera.status).toBe(201);
    expect(primera.body.creadas).toHaveLength(2);
    const segunda = await request(app).post("/api/cuentas/layout").set(auth(t)).send({ filas });
    expect(segunda.status).toBe(201);
    expect(segunda.body.creadas).toHaveLength(0);
    expect(segunda.body.actualizadas).toEqual(["Operaciones MX", "Fondeo"]);
    // Las semillas traen cuentas demo: sólo cuentan las creadas por el layout.
    const total = (db.prepare("SELECT COUNT(*) AS n FROM cuentas WHERE origen = 'layout'").get() as { n: number }).n;
    expect(total).toBe(2);
  });

  it("rechaza CLAVES que no son CLABE a 18 dígitos y la CLABE de otro banco", async () => {
    const t = await login("admin_tesoreria", "admin_tesoreria");
    const res = await request(app)
      .post("/api/cuentas/layout")
      .set(auth(t))
      .send({
        filas: [
          { banco: "STP", nombre: "Cruce de banco", clave: CLABE_BANORTE, cuenta_corta: "" },
          { banco: "STP", nombre: "Clave corta", clave: "12345", cuenta_corta: "" },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.creadas).toHaveLength(0);
    expect(res.body.errores).toHaveLength(2);
    expect(res.body.errores[0].errores.join(" ")).toMatch(/la CLABE es de BANORTE/);
    expect(res.body.errores[1].errores.join(" ")).toMatch(/CLABE de 18 dígitos/);
  });

  it("comprobantes de depósito: el .DOC se rechaza con mensaje claro; cualquier otro formato pasa", async () => {
    /** PNG 1x1 válido para comprobantes de prueba. */
    const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const hoy = (): string => new Date().toISOString().slice(0, 10);

    // Cliente asignado al operador + operación de pago con depósito indicado.
    const tOps = await login("admin_ops", "admin_ops");
    const cliente = await request(app)
      .post("/api/clientes")
      .set(auth(tOps))
      .send({ nombre: "Cliente Layout SA" });
    expect(cliente.status).toBe(201);
    const tOp = await login("operador", "operador");
    const idOp = (await request(app).get("/api/auth/me").set(auth(tOp))).body.usuario.id as number;
    const asignacion = await request(app)
      .post(`/api/clientes/${cliente.body.cliente.id}/asignaciones`)
      .set(auth(tOps))
      .send({ ejecutivo_id: idOp });
    expect(asignacion.status).toBe(201);
    const op = await request(app)
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
    expect(op.status).toBe(201);
    const tAdminT = await login("admin_tesoreria", "admin_tesoreria");
    const cuenta = await request(app)
      .post("/api/cuentas")
      .set(auth(tAdminT))
      .send({ nombre: "FLUJOS 91", banco: "BBVA", saldo_inicial: 0 });
    expect(cuenta.status).toBe(201);
    const dep = await request(app)
      .post(`/api/operaciones/${op.body.operacion.id}/deposito`)
      .set(auth(tOp))
      .send({ cuenta_id: cuenta.body.cuenta.id, monto: 1000, comprobante: "FICHA-1", fecha_deposito: hoy() });
    expect(dep.status).toBe(201);
    const idDep = dep.body.deposito.id as number;

    // .DOC (minúsculas y mayúsculas) → 400 con mensaje claro.
    const doc = await request(app)
      .post(`/api/depositos/${idDep}/comprobantes`)
      .set(auth(tOp))
      .send({ comprobantes: [{ nombre: "ficha.doc", mime: "application/msword", contenido: PNG }] });
    expect(doc.status).toBe(400);
    expect(doc.body.error).toMatch(/\.DOC no admitido/);
    const docMayus = await request(app)
      .post(`/api/depositos/${idDep}/comprobantes`)
      .set(auth(tOp))
      .send({ comprobantes: [{ nombre: "FICHA.DOC", mime: "application/msword", contenido: PNG }] });
    expect(docMayus.status).toBe(400);
    expect(docMayus.body.error).toMatch(/cualquier otro formato es válido/);

    // Cualquier otro formato pasa (un XML de CFDI, por ejemplo).
    const xml = await request(app)
      .post(`/api/depositos/${idDep}/comprobantes`)
      .set(auth(tOp))
      .send({ comprobantes: [{ nombre: "cfdi.xml", mime: "application/xml", contenido: PNG }] });
    expect(xml.status).toBe(201);
  });
});
