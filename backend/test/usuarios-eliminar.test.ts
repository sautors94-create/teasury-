import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import { crearApp } from "../src/app.js";
import { abrirBase } from "../src/db.js";

/**
 * Eliminación definitiva de usuarios (DELETE /api/usuarios/:id):
 * doble control §10 (no auto-eliminarse, no dejar el sistema sin admin
 * activo, usuarios base protegidos) y trazabilidad append-only: los usuarios
 * con actividad registrada no se eliminan (se desactivan), y el evento
 * usuario_eliminado queda en la bitácora a nombre de quien ejecuta la baja.
 */
let db: Database;
let app: ReturnType<typeof crearApp>;

async function login(username: string, password: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ username, password });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function crearUsuario(
  token: string,
  username: string,
  rol: string = "operacion"
): Promise<{ id: number; username: string; rol: string }> {
  const res = await request(app)
    .post("/api/usuarios")
    .set(auth(token))
    .send({ username, nombre: `Usuario ${username}`, rol, password: username });
  expect(res.status).toBe(201);
  return res.body.usuario;
}

beforeEach(() => {
  db = abrirBase(":memory:");
  app = crearApp(db);
});

describe("Eliminar usuarios (admin, DELETE /api/usuarios/:id)", () => {
  it("elimina un usuario sin actividad: desaparece del listado y no puede iniciar sesión", async () => {
    const token = await login("admin", "admin");
    const u = await crearUsuario(token, "temporal1");
    const del = await request(app).delete(`/api/usuarios/${u.id}`).set(auth(token));
    expect(del.status).toBe(200);
    expect(del.body.eliminado).toBe(true);
    expect(del.body.username).toBe("temporal1");
    const lista = await request(app).get("/api/usuarios").set(auth(token));
    expect(lista.body.usuarios.some((x: { id: number }) => x.id === u.id)).toBe(false);
    const sesion = await request(app)
      .post("/api/auth/login")
      .send({ username: "temporal1", password: "temporal1" });
    expect(sesion.status).toBe(401);
  });

  it("un usuario que sólo inició sesión (sin acciones auditadas) sigue siendo eliminable", async () => {
    // El login no se audita: abrir sesión no genera actividad que bloquee la baja.
    const token = await login("admin", "admin");
    const u = await crearUsuario(token, "temporal2");
    const sesion = await request(app)
      .post("/api/auth/login")
      .send({ username: "temporal2", password: "temporal2" });
    expect(sesion.status).toBe(200);
    const del = await request(app).delete(`/api/usuarios/${u.id}`).set(auth(token));
    expect(del.status).toBe(200);
  });

  it("registra el evento 'usuario_eliminado' en la bitácora a nombre del admin", async () => {
    const token = await login("admin", "admin");
    const u = await crearUsuario(token, "temporal3");
    const del = await request(app).delete(`/api/usuarios/${u.id}`).set(auth(token));
    expect(del.status).toBe(200);
    const audToken = await login("auditor", "auditor");
    const aud = await request(app).get("/api/auditoria").set(auth(audToken));
    expect(aud.status).toBe(200);
    const evento = aud.body.eventos.find((e: { accion: string }) => e.accion === "usuario_eliminado");
    expect(evento).toBeTruthy();
    expect(evento.detalle).toContain("temporal3");
    expect(evento.usuario).toBe("Administrador del Sistema");
  });

  it("rechaza la eliminación por rol distinto de admin", async () => {
    const token = await login("admin", "admin");
    const u = await crearUsuario(token, "temporal4");
    const opToken = await login("operador", "operador");
    const del = await request(app).delete(`/api/usuarios/${u.id}`).set(auth(opToken));
    expect(del.status).toBe(403);
  });

  it("responde 404 para un usuario inexistente", async () => {
    const token = await login("admin", "admin");
    const del = await request(app).delete("/api/usuarios/99999").set(auth(token));
    expect(del.status).toBe(404);
  });

  it("no permite eliminar el propio usuario (doble control §10)", async () => {
    const token = await login("admin", "admin");
    const me = await request(app).get("/api/auth/me").set(auth(token));
    const del = await request(app).delete(`/api/usuarios/${me.body.usuario.id}`).set(auth(token));
    expect(del.status).toBe(409);
    expect(del.body.error).toContain("propio usuario");
  });

  it("protege a los usuarios base del sistema", async () => {
    const token = await login("admin", "admin");
    const lista = await request(app).get("/api/usuarios").set(auth(token));
    const adminOps = lista.body.usuarios.find((u: { username: string }) => u.username === "admin_ops");
    const del = await request(app).delete(`/api/usuarios/${adminOps.id}`).set(auth(token));
    expect(del.status).toBe(409);
    expect(del.body.error).toContain("usuario base");
  });

  it("un admin puede eliminar a otro admin quedando al menos uno activo", async () => {
    // La regla "no dejar 0 admins activos" es defensa en profundidad: vía API
    // es inalcanzable (el propio actor cuenta como admin activo en 'otros' y
    // el auto-borrado ya está bloqueado por §10), así que aquí se verifica el
    // caso alcanzable: la baja de un admin con otro admin activo restante.
    const token = await login("admin", "admin");
    await crearUsuario(token, "admin2", "admin");
    const admin3 = await crearUsuario(token, "admin3", "admin");
    const admin3Token = await login("admin3", "admin3");
    const lista = await request(app).get("/api/usuarios").set(auth(admin3Token));
    const admin2 = lista.body.usuarios.find((u: { username: string }) => u.username === "admin2");
    const del = await request(app).delete(`/api/usuarios/${admin2.id}`).set(auth(admin3Token));
    expect(del.status).toBe(200);
    expect(del.body.username).toBe("admin2");
    // admin3 y el admin base siguen existiendo.
    const final = await request(app).get("/api/usuarios").set(auth(token));
    const nombres = final.body.usuarios.map((u: { username: string }) => u.username);
    expect(nombres).toContain("admin");
    expect(nombres).toContain("admin3");
    expect(nombres).not.toContain("admin2");
  });

  it("bloquea la eliminación de usuarios con actividad y sugiere desactivar", async () => {
    const token = await login("admin", "admin");
    const u = await crearUsuario(token, "ops9");
    // Actividad: admin_ops crea un cliente y lo asigna a ops9
    // (cliente_asignaciones.ejecutivo_id referencia al usuario).
    const opsToken = await login("admin_ops", "admin_ops");
    const cli = await request(app)
      .post("/api/clientes")
      .set(auth(opsToken))
      .send({ nombre: "Cliente Prueba Eliminar" });
    expect(cli.status).toBe(201);
    const asig = await request(app)
      .post(`/api/clientes/${cli.body.cliente.id}/asignaciones`)
      .set(auth(opsToken))
      .send({ ejecutivo_id: u.id });
    expect(asig.status).toBe(201);
    const del = await request(app).delete(`/api/usuarios/${u.id}`).set(auth(token));
    expect(del.status).toBe(409);
    expect(del.body.error).toContain("actividad registrada");
    expect(del.body.error).toContain("asignaciones de clientes");
    expect(del.body.error).toContain("Desactívalo");
    // El usuario sigue existiendo tras el intento bloqueado.
    const lista = await request(app).get("/api/usuarios").set(auth(token));
    expect(lista.body.usuarios.some((x: { id: number }) => x.id === u.id)).toBe(true);
  });

  it("el token de un usuario eliminado deja de servir en rutas con usuarioVivo", async () => {
    const token = await login("admin", "admin");
    const u = await crearUsuario(token, "ops10");
    const opToken = await login("ops10", "ops10");
    const del = await request(app).delete(`/api/usuarios/${u.id}`).set(auth(token));
    expect(del.status).toBe(200);
    const res = await request(app)
      .post("/api/operaciones")
      .set(auth(opToken))
      .send({ tipo: "pago", concepto: "prueba", proveedor: "proveedor", monto: 100, fecha_operacion: "2026-01-15" });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("desactivado");
  });
});
