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

async function operacionAprobada(monto = 10000): Promise<number> {
  const tokenOperador = await login("operador", "operador");
  const creacion = await request(app)
    .post("/api/operaciones")
    .set("Authorization", `Bearer ${tokenOperador}`)
    .send({
      tipo: "pago",
      concepto: "Honorarios notariales",
      proveedor: "Notaría 45",
      monto,
      fecha_operacion: "2026-10-25",
    });
  expect(creacion.status).toBe(201);
  const id = creacion.body.operacion.id as number;
  await request(app)
    .post(`/api/operaciones/${id}/enviar-validacion`)
    .set("Authorization", `Bearer ${tokenOperador}`);
  const tokenValidador = await login("validador", "validador");
  const aprobacion = await request(app)
    .post(`/api/operaciones/${id}/revision`)
    .set("Authorization", `Bearer ${tokenValidador}`)
    .send({ resultado: "aprobada", comentario: "_en orden" });
  expect(aprobacion.status).toBe(200);
  return id;
}

beforeEach(() => {
  db = abrirBase(":memory:");
  app = crearApp(db);
});

describe("módulo Tesorería (pago con comprobante)", () => {
  it("paga una operación aprobada, registra comprobante y pasa a pagada", async () => {
    const id = await operacionAprobada(10000);
    const tokenTesoreria = await login("tesoreria", "tesoreria");

    const pago = await request(app)
      .post(`/api/operaciones/${id}/pago`)
      .set("Authorization", `Bearer ${tokenTesoreria}`)
      .send({
        medio: "transferencia",
        monto: 10000,
        comprobante: "TRF-889123",
        fecha_pago: "2026-10-26",
        notas: "Transferencia SPEI",
      });
    expect(pago.status).toBe(201);
    expect(pago.body.operacion.estado).toBe("pagada");
    expect(pago.body.pago.medio).toBe("transferencia");
    expect(pago.body.pago.comprobante).toBe("TRF-889123");
    expect(pago.body.pago.monto).toBe(10000);

    // Detalle incluye el pago y la auditoría registra el evento
    const detalle = await request(app)
      .get(`/api/operaciones/${id}`)
      .set("Authorization", `Bearer ${tokenTesoreria}`);
    expect(detalle.body.pago.comprobante).toBe("TRF-889123");
    const acciones = detalle.body.historial.map((h: { accion: string }) => h.accion);
    expect(acciones).toContain("pago");
    expect(acciones).toContain("cambio_estado");
  });

  it("rechaza pagos con monto distinto al de la operación", async () => {
    const id = await operacionAprobada(10000);
    const token = await login("tesoreria", "tesoreria");
    const res = await request(app)
      .post(`/api/operaciones/${id}/pago`)
      .set("Authorization", `Bearer ${token}`)
      .send({ medio: "cheque", monto: 9000, comprobante: "CHQ-1" });
    expect(res.status).toBe(400);
    expect(res.body.monto_operacion).toBe(10000);
  });

  it("valida medio, comprobante y fecha del pago", async () => {
    const id = await operacionAprobada();
    const token = await login("tesoreria", "tesoreria");
    const res = await request(app)
      .post(`/api/operaciones/${id}/pago`)
      .set("Authorization", `Bearer ${token}`)
      .send({ medio: "bitcoin", monto: -1, comprobante: " ", fecha_pago: "26/10/2026" });
    expect(res.status).toBe(400);
    expect(res.body.detalles.length).toBeGreaterThanOrEqual(4);
  });

  it("sólo el rol tesoreria puede pagar", async () => {
    const id = await operacionAprobada();
    for (const [usuario, rol] of [
      ["operador", "operacion"],
      ["validador", "validacion"],
      ["auditor", "auditoria"],
      ["direccion", "direccion"],
    ] as const) {
      const token = await login(usuario, usuario);
      const res = await request(app)
        .post(`/api/operaciones/${id}/pago`)
        .set("Authorization", `Bearer ${token}`)
        .send({ medio: "transferencia", monto: 10000, comprobante: "X" });
      expect(res.status, `rol ${rol} no debe pagar`).toBe(403);
    }
  });

  it("no paga operaciones que no estén aprobadas", async () => {
    const tokenOperador = await login("operador", "operador");
    const creacion = await request(app)
      .post("/api/operaciones")
      .set("Authorization", `Bearer ${tokenOperador}`)
      .send({
        tipo: "pago",
        concepto: "Sin aprobar",
        proveedor: "X",
        monto: 500,
        fecha_operacion: "2026-10-27",
      });
    const id = creacion.body.operacion.id as number;
    const token = await login("tesoreria", "tesoreria");

    const borrador = await request(app)
      .post(`/api/operaciones/${id}/pago`)
      .set("Authorization", `Bearer ${token}`)
      .send({ medio: "efectivo", monto: 500, comprobante: "FAC-1" });
    expect(borrador.status).toBe(409);
  });

  it("impide el doble pago", async () => {
    const id = await operacionAprobada(7500);
    const token = await login("tesoreria", "tesoreria");
    const primero = await request(app)
      .post(`/api/operaciones/${id}/pago`)
      .set("Authorization", `Bearer ${token}`)
      .send({ medio: "domiciliacion", monto: 7500, comprobante: "DOM-1" });
    expect(primero.status).toBe(201);

    const segundo = await request(app)
      .post(`/api/operaciones/${id}/pago`)
      .set("Authorization", `Bearer ${token}`)
      .send({ medio: "domiciliacion", monto: 7500, comprobante: "DOM-2" });
    expect(segundo.status).toBe(409);
  });

  it("lista pagos para tesorería, dirección y auditoría; los excluye a otros roles", async () => {
    const id = await operacionAprobada(2500);
    const token = await login("tesoreria", "tesoreria");
    await request(app)
      .post(`/api/operaciones/${id}/pago`)
      .set("Authorization", `Bearer ${token}`)
      .send({ medio: "transferencia", monto: 2500, comprobante: "TRF-777" });

    const tokenAuditor = await login("auditor", "auditor");
    const auditoria = await request(app)
      .get("/api/pagos")
      .set("Authorization", `Bearer ${tokenAuditor}`);
    expect(auditoria.status).toBe(200);
    expect(auditoria.body.pagos).toHaveLength(1);
    expect(auditoria.body.pagos[0].folio).toMatch(/^OP-\d{4}-\d{5}$/);
    expect(auditoria.body.pagos[0].pagador).toBe("Analista de Tesorería");

    const tokenOperador = await login("operador", "operador");
    const operador = await request(app)
      .get("/api/pagos")
      .set("Authorization", `Bearer ${tokenOperador}`);
    expect(operador.status).toBe(403);
  });
});