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

describe("salud y catálogos", () => {
  it("responde el health check", async () => {
    const res = await request(app).get("/api/salud");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("rechaza catálogos sin token", async () => {
    const res = await request(app).get("/api/catalogos");
    expect(res.status).toBe(401);
  });
});

describe("autenticación", () => {
  it("rechaza credenciales inválidas", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ username: "operador", password: "mala" });
    expect(res.status).toBe(401);
  });

  it("devuelve usuario y token válidos", async () => {
    const token = await login("operador", "operador");
    const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.usuario.rol).toBe("operacion");
  });
});

describe("flujo Operaciones → Validación", () => {
  it("captura, envía a validación, aprueba y registra auditoría", async () => {
    const tokenOperador = await login("operador", "operador");

    // Captura
    const creacion = await request(app)
      .post("/api/operaciones")
      .set("Authorization", `Bearer ${tokenOperador}`)
      .send({
        tipo: "pago",
        concepto: "Pago de renta trimestral",
        proveedor: "Inmobiliaria Centro",
        monto: 150000.5,
        moneda: "MXN",
        fecha_operacion: "2026-10-20",
      });
    expect(creacion.status).toBe(201);
    expect(creacion.body.operacion.estado).toBe("borrador");
    expect(creacion.body.operacion.folio).toMatch(/^OP-\d{4}-\d{5}$/);
    const id = creacion.body.operacion.id as number;

    // El validador NO puede capturar
    const tokenValidador = await login("validador", "validador");
    const creacionNegada = await request(app)
      .post("/api/operaciones")
      .set("Authorization", `Bearer ${tokenValidador}`)
      .send({
        tipo: "pago",
        concepto: "x",
        proveedor: "y",
        monto: 10,
        fecha_operacion: "2026-10-20",
      });
    expect(creacionNegada.status).toBe(403);

    // El validador NO puede enviar a validación
    const envioNegado = await request(app)
      .post(`/api/operaciones/${id}/enviar-validacion`)
      .set("Authorization", `Bearer ${tokenValidador}`);
    expect(envioNegado.status).toBe(403);

    // Enviar a validación
    const envio = await request(app)
      .post(`/api/operaciones/${id}/enviar-validacion`)
      .set("Authorization", `Bearer ${tokenOperador}`);
    expect(envio.status).toBe(200);
    expect(envio.body.operacion.estado).toBe("en_validacion");

    // El operador NO puede revisar
    const revisionNegada = await request(app)
      .post(`/api/operaciones/${id}/revision`)
      .set("Authorization", `Bearer ${tokenOperador}`)
      .send({ resultado: "aprobada", comentario: "ok" });
    expect(revisionNegada.status).toBe(403);

    // Revisión sin comentario se rechaza
    const sinComentario = await request(app)
      .post(`/api/operaciones/${id}/revision`)
      .set("Authorization", `Bearer ${tokenValidador}`)
      .send({ resultado: "aprobada" });
    expect(sinComentario.status).toBe(400);

    // Aprobación
    const aprobacion = await request(app)
      .post(`/api/operaciones/${id}/revision`)
      .set("Authorization", `Bearer ${tokenValidador}`)
      .send({ resultado: "aprobada", comentario: "Documentación completa" });
    expect(aprobacion.status).toBe(200);
    expect(aprobacion.body.operacion.estado).toBe("aprobada");

    // Transición inválida: de 'aprobada' no se vuelve a validación
    const invalida = await request(app)
      .post(`/api/operaciones/${id}/enviar-validacion`)
      .set("Authorization", `Bearer ${tokenOperador}`);
    expect(invalida.status).toBe(409);

    // Detalle con revisiones e historial
    const detalle = await request(app)
      .get(`/api/operaciones/${id}`)
      .set("Authorization", `Bearer ${tokenOperador}`);
    expect(detalle.status).toBe(200);
    expect(detalle.body.revisiones).toHaveLength(1);
    const acciones = detalle.body.historial.map((h: { accion: string }) => h.accion);
    expect(acciones).toContain("captura");
    expect(acciones).toContain("cambio_estado");

    // Auditoría visible solo para auditoría / dirección
    const auditNegada = await request(app)
      .get("/api/auditoria")
      .set("Authorization", `Bearer ${tokenOperador}`);
    expect(auditNegada.status).toBe(403);
    const tokenAuditor = await login("auditor", "auditor");
    const audit = await request(app).get("/api/auditoria").set("Authorization", `Bearer ${tokenAuditor}`);
    expect(audit.status).toBe(200);
    expect(audit.body.eventos.length).toBeGreaterThan(0);
  });

  it("permite corregir una operación observada y reenviarla", async () => {
    const tokenOperador = await login("operador", "operador");
    const tokenValidador = await login("validador", "validador");

    const creacion = await request(app)
      .post("/api/operaciones")
      .set("Authorization", `Bearer ${tokenOperador}`)
      .send({
        tipo: "cobro",
        concepto: "Cobro por anticipo",
        proveedor: "Cliente Norte",
        monto: 5000,
        fecha_operacion: "2026-10-21",
      });
    const id = creacion.body.operacion.id as number;

    await request(app)
      .post(`/api/operaciones/${id}/enviar-validacion`)
      .set("Authorization", `Bearer ${tokenOperador}`);

    const observada = await request(app)
      .post(`/api/operaciones/${id}/revision`)
      .set("Authorization", `Bearer ${tokenValidador}`)
      .send({ resultado: "observada", comentario: "Falta contrato firmado" });
    expect(observada.body.operacion.estado).toBe("observada");

    const reenvio = await request(app)
      .post(`/api/operaciones/${id}/enviar-validacion`)
      .set("Authorization", `Bearer ${tokenOperador}`);
    expect(reenvio.status).toBe(200);
    expect(reenvio.body.operacion.estado).toBe("en_validacion");
  });

  it("valida los datos de captura", async () => {
    const tokenOperador = await login("operador", "operador");
    const res = await request(app)
      .post("/api/operaciones")
      .set("Authorization", `Bearer ${tokenOperador}`)
      .send({ tipo: "otro", concepto: "", proveedor: "", monto: -5, fecha_operacion: "20/10/2026" });
    expect(res.status).toBe(400);
    expect(res.body.detalles.length).toBeGreaterThanOrEqual(4);
  });

  it("filtra por estado y búsqueda", async () => {
    const tokenOperador = await login("operador", "operador");
    await request(app)
      .post("/api/operaciones")
      .set("Authorization", `Bearer ${tokenOperador}`)
      .send({
        tipo: "pago",
        concepto: "Honorarios contabilidad",
        proveedor: "Estudio Fiscal SA",
        monto: 25000,
        fecha_operacion: "2026-10-22",
      });
    await request(app)
      .post("/api/operaciones")
      .set("Authorization", `Bearer ${tokenOperador}`)
      .send({
        tipo: "pago",
        concepto: "Papelería",
        proveedor: "Suministros Norte",
        monto: 1200,
        fecha_operacion: "2026-10-23",
      });

    const borradores = await request(app)
      .get("/api/operaciones?estado=borrador")
      .set("Authorization", `Bearer ${tokenOperador}`);
    expect(borradores.body.operaciones).toHaveLength(2);

    const busqueda = await request(app)
      .get("/api/operaciones?q=Honorarios")
      .set("Authorization", `Bearer ${tokenOperador}`);
    expect(busqueda.body.operaciones).toHaveLength(1);
    expect(busqueda.body.operaciones[0].proveedor).toBe("Estudio Fiscal SA");
  });
});