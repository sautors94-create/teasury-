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

async function crearCuenta(token: string, saldoInicial = 100000): Promise<number> {
  const res = await request(app)
    .post("/api/cuentas")
    .set("Authorization", `Bearer ${token}`)
    .send({ nombre: "BBVA Operativa", banco: "BBVA", numero_cuenta: "0123456789", saldo_inicial: saldoInicial });
  expect(res.status).toBe(201);
  return res.body.cuenta.id as number;
}

async function operacionAprobada(monto: number): Promise<number> {
  const tokenOperador = await login("operador", "operador");
  const creacion = await request(app)
    .post("/api/operaciones")
    .set("Authorization", `Bearer ${tokenOperador}`)
    .send({
      tipo: "pago",
      concepto: "Pago desde cuenta",
      proveedor: "Proveedor SA",
      monto,
      fecha_operacion: "2026-10-30",
    });
  const id = creacion.body.operacion.id as number;
  await request(app)
    .post(`/api/operaciones/${id}/enviar-validacion`)
    .set("Authorization", `Bearer ${tokenOperador}`);
  const tokenValidador = await login("validador", "validador");
  await request(app)
    .post(`/api/operaciones/${id}/revision`)
    .set("Authorization", `Bearer ${tokenValidador}`)
    .send({ resultado: "aprobada", comentario: "ok" });
  return id;
}

beforeEach(() => {
  db = abrirBase(":memory:");
  app = crearApp(db);
});

describe("cuentas de tesorería", () => {
  it("crea cuentas y calcula saldo con depósitos, retiros y pagos", async () => {
    const token = await login("tesoreria", "tesoreria");
    const cuentaId = await crearCuenta(token, 100000);

    const dep = await request(app)
      .post(`/api/cuentas/${cuentaId}/movimientos`)
      .set("Authorization", `Bearer ${token}`)
      .send({ tipo: "deposito", monto: 50000, concepto: "Ingreso cliente", fecha: "2026-10-28" });
    expect(dep.status).toBe(201);

    const ret = await request(app)
      .post(`/api/cuentas/${cuentaId}/movimientos`)
      .set("Authorization", `Bearer ${token}`)
      .send({ tipo: "retiro", monto: 20000, concepto: "Comisión banco" });
    expect(ret.status).toBe(201);

    // Pago ligado a la cuenta
    const opId = await operacionAprobada(4321.5);
    const pago = await request(app)
      .post(`/api/operaciones/${opId}/pago`)
      .set("Authorization", `Bearer ${token}`)
      .send({ medio: "transferencia", monto: 4321.5, comprobante: "TRF-CTA-1", cuenta_id: cuentaId });
    expect(pago.status).toBe(201);
    expect(pago.body.pago.cuenta_id).toBe(cuentaId);

    const lista = await request(app)
      .get("/api/cuentas")
      .set("Authorization", `Bearer ${token}`);
    expect(lista.status).toBe(200);
    const c = lista.body.cuentas.find((x: { id: number }) => x.id === cuentaId);
    // 100000 + 50000 - 20000 - 4321.5 = 125678.5
    expect(c.saldo_actual).toBeCloseTo(125678.5, 2);
    expect(c.total_pagado).toBeCloseTo(4321.5, 2);

    const detalle = await request(app)
      .get(`/api/cuentas/${cuentaId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(detalle.status).toBe(200);
    const fuentes = detalle.body.movimientos.map((m: { fuente: string }) => m.fuente);
    expect(fuentes).toContain("pago");
    expect(fuentes).toContain("movimiento");
  });

  it("valida datos de cuenta y movimientos", async () => {
    const token = await login("tesoreria", "tesoreria");
    const sinNombre = await request(app)
      .post("/api/cuentas")
      .set("Authorization", `Bearer ${token}`)
      .send({ nombre: "  ", saldo_inicial: "mucho" });
    expect(sinNombre.status).toBe(400);
    expect(sinNombre.body.detalles.length).toBeGreaterThanOrEqual(2);

    const cuentaId = await crearCuenta(token);
    const movMalo = await request(app)
      .post(`/api/cuentas/${cuentaId}/movimientos`)
      .set("Authorization", `Bearer ${token}`)
      .send({ tipo: "traspaso", monto: -5, concepto: "" });
    expect(movMalo.status).toBe(400);
    expect(movMalo.body.detalles.length).toBeGreaterThanOrEqual(3);
  });

  it("sólo tesorería crea cuentas y movimientos; el resto sólo consulta", async () => {
    const cuentaId = await crearCuenta(await login("tesoreria", "tesoreria"));
    for (const usuario of ["operador", "validador", "direccion", "auditor"]) {
      const token = await login(usuario, usuario);
      const crear = await request(app)
        .post("/api/cuentas")
        .set("Authorization", `Bearer ${token}`)
        .send({ nombre: "Fraude" });
      expect(crear.status, `usuario ${usuario} no debe crear cuentas`).toBe(403);
      const mov = await request(app)
        .post(`/api/cuentas/${cuentaId}/movimientos`)
        .set("Authorization", `Bearer ${token}`)
        .send({ tipo: "deposito", monto: 100, concepto: "x" });
      expect(mov.status, `usuario ${usuario} no debe movilizar`).toBe(403);
    }
    // auditoría y dirección sí leen
    for (const usuario of ["auditor", "direccion"]) {
      const token = await login(usuario, usuario);
      const leer = await request(app).get("/api/cuentas").set("Authorization", `Bearer ${token}`);
      expect(leer.status, `usuario ${usuario} debe leer cuentas`).toBe(200);
    }
  });

  it("rechaza pagos con cuenta_id inexistente o inactiva", async () => {
    const token = await login("tesoreria", "tesoreria");
    const opId = await operacionAprobada(500);
    const res = await request(app)
      .post(`/api/operaciones/${opId}/pago`)
      .set("Authorization", `Bearer ${token}`)
      .send({ medio: "cheque", monto: 500, comprobante: "CHQ-9", cuenta_id: 9999 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cuenta_id/);
  });

  it("404 al consultar cuenta inexistente", async () => {
    const token = await login("tesoreria", "tesoreria");
    const res = await request(app).get("/api/cuentas/4242").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});