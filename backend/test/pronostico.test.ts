import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Database } from "better-sqlite3";
import { crearApp } from "../src/app.js";
import { abrirBase } from "../src/db.js";

/**
 * Barra de PRONÓSTICO (Tesorería): las operaciones capturadas que siguen en
 * proceso se agrupan por categoría del negocio — FLUJOS, ASIMILADOS, FRENTES,
 * PAGOS ESPECIALES y OTROS — con número de operaciones, monto y flujo total.
 * Visibilidad: Tesorería y áreas de control; el Ejecutivo NO la consulta.
 */

let db: Database;
let app: ReturnType<typeof crearApp>;

async function login(username: string, password: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ username, password });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Captura un flujo básico (dos líneas, monto ≥ flujo total). */
async function capturarFlujo(token: string, monto = 60000, importes = [51500, 8500]): Promise<number> {
  const res = await request(app)
    .post("/api/operaciones")
    .set(auth(token))
    .send({
      tipo: "flujo",
      concepto: "Flujo semana pronóstico",
      monto,
      fecha_operacion: "2026-11-05",
      pagador: "FLUJOS",
      tipo_operacion: "FLUJOS",
      timbrar: false,
      comision_pct: 2.5,
      dispersiones: [
        { beneficiario: "COMERCIAL BRAIN FENIX", banco: "STP", importe: importes[0], etiqueta: "PROVEEDOR" },
        { beneficiario: "MGN INTRUST", importe: importes[1], etiqueta: "COMISION" },
      ],
    });
  expect(res.status).toBe(201);
  return res.body.operacion.id as number;
}

beforeEach(() => {
  db = abrirBase(":memory:");
  app = crearApp(db);
});

describe("pronóstico de operaciones capturadas (Tesorería)", () => {
  it("agrupa por categoría: FLUJOS con captura en borrador y en calidad, resto en ceros", async () => {
    const tOp = await login("operador", "operador");
    const id1 = await capturarFlujo(tOp, 60000, [51500, 8500]);
    const id2 = await capturarFlujo(tOp, 40000, [34000, 6000]);
    // Una se envía a Calidad; la otra queda como borrador.
    const envio = await request(app).post(`/api/operaciones/${id1}/enviar-validacion`).set(auth(tOp));
    expect(envio.status).toBe(200);

    const tTes = await login("tesoreria", "tesoreria");
    const res = await request(app).get("/api/pronostico").set(auth(tTes));
    expect(res.status).toBe(200);

    const cats = res.body.categorias as Array<{
      categoria: string;
      operaciones: number;
      monto: number;
      flujo_total: number;
    }>;
    expect(cats.map((c) => c.categoria)).toEqual(["FLUJOS", "ASIMILADOS", "FRENTES", "PAGOS ESPECIALES", "OTROS"]);
    const flujos = cats.find((c) => c.categoria === "FLUJOS")!;
    expect(flujos.operaciones).toBe(2);
    expect(flujos.monto).toBe(100000);
    expect(flujos.flujo_total).toBe(100000); // 51500 + 8500 + 34000 + 6000
    // Las categorías sin captura permanecen en el orden, en ceros.
    for (const c of cats.filter((x) => x.categoria !== "FLUJOS")) {
      expect(c.operaciones).toBe(0);
      expect(c.monto).toBe(0);
    }
    // Total y desglose por estado.
    expect(res.body.total).toEqual({ operaciones: 2, monto: 100000, flujo_total: 100000 });
    const estados = res.body.por_estado as Array<{ estado: string; operaciones: number; monto: number }>;
    expect(estados.find((e) => e.estado === "borrador")?.operaciones).toBe(1);
    expect(estados.find((e) => e.estado === "en_validacion")?.operaciones).toBe(1);

    // id2 sigue en borrador: el Ejecutivo puede enviarlo desde Operaciones.
    const detalle = await request(app).get(`/api/operaciones/${id2}`).set(auth(tOp));
    expect(detalle.body.operacion.estado).toBe("borrador");
  });

  it("las pagadas y canceladas ya no entran al pronóstico", async () => {
    const tOp = await login("operador", "operador");
    const id = await capturarFlujo(tOp);
    await request(app).post(`/api/operaciones/${id}/enviar-validacion`).set(auth(tOp));
    const tVal = await login("validador", "validador");
    const rev = await request(app)
      .post(`/api/operaciones/${id}/revision`)
      .set(auth(tVal))
      .send({ resultado: "observada", comentario: "corregir importes" });
    expect(rev.status).toBe(200);
    // Observada SÍ sigue en proceso; al cancelarla sale del pronóstico.
    const tTes = await login("tesoreria", "tesoreria");
    let res = await request(app).get("/api/pronostico").set(auth(tTes));
    let flujos = (res.body.categorias as Array<{ categoria: string; operaciones: number }>).find(
      (c) => c.categoria === "FLUJOS"
    )!;
    expect(flujos.operaciones).toBe(1);
    const cancela = await request(app).post(`/api/operaciones/${id}/cancelar`).set(auth(tOp));
    expect(cancela.status).toBe(200);
    res = await request(app).get("/api/pronostico").set(auth(tTes));
    flujos = (res.body.categorias as Array<{ categoria: string; operaciones: number }>).find(
      (c) => c.categoria === "FLUJOS"
    )!;
    expect(flujos.operaciones).toBe(0);
    expect(res.body.total.operaciones).toBe(0);
  });

  it("el Ejecutivo (operación) no consulta el pronóstico (403); Tesorería y Dirección sí", async () => {
    const tOp = await login("operador", "operador");
    const prohibido = await request(app).get("/api/pronostico").set(auth(tOp));
    expect(prohibido.status).toBe(403);

    for (const [u, p] of [
      ["tesoreria", "tesoreria"],
      ["admin_tesoreria", "admin_tesoreria"],
      ["val_tesoreria", "val_tesoreria"],
      ["fondeador", "fondeador"],
      ["direccion", "direccion"],
      ["auditor", "auditor"],
      ["admin", "admin"],
    ] as Array<[string, string]>) {
      const res = await request(app).get("/api/pronostico").set(auth(await login(u, p)));
      expect(res.status).toBe(200);
    }
  });
});
