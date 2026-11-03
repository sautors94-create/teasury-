import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crearApp } from "../src/app.js";
import { abrirBase } from "../src/db.js";

/**
 * Fase roles (01-ROLES.md): Administrador del sistema, Administrador de
 * Operaciones y Ejecutivo de Operaciones con alcance por clientes asignados.
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

beforeEach(() => {
  db = abrirBase(":memory:");
  app = crearApp(db);
});

describe("Administrador del sistema (rol admin)", () => {
  it("admin y admin_ops existen entre los usuarios base", async () => {
    const token = await login("admin", "admin");
    const res = await request(app).get("/api/usuarios").set(auth(token));
    expect(res.status).toBe(200);
    const roles = res.body.usuarios.map((u: { rol: string }) => u.rol);
    expect(roles).toContain("admin");
    expect(roles).toContain("admin_operaciones");
  });

  it("crea usuarios y el usuario creado puede iniciar sesión", async () => {
    const token = await login("admin", "admin");
    const res = await request(app)
      .post("/api/usuarios")
      .set(auth(token))
      .send({ username: "ops2", nombre: "Segundo Ejecutivo", rol: "operacion", password: "clave4" });
    expect(res.status).toBe(201);
    const sesion = await request(app)
      .post("/api/auth/login")
      .send({ username: "ops2", password: "clave4" });
    expect(sesion.status).toBe(200);
    expect(sesion.body.usuario.rol).toBe("operacion");
  });

  it("rechaza alta con rol inexistente y username duplicado", async () => {
    const token = await login("admin", "admin");
    const rolMalo = await request(app)
      .post("/api/usuarios")
      .set(auth(token))
      .send({ username: "x1", nombre: "Nombre Valido", rol: "superadmin", password: "clave4" });
    expect(rolMalo.status).toBe(400);
    const dup = await request(app)
      .post("/api/usuarios")
      .set(auth(token))
      .send({ username: "operador", nombre: "Duplicado", rol: "operacion", password: "clave4" });
    expect(dup.status).toBe(409);
  });

  it("un rol no admin no puede administrar usuarios", async () => {
    const token = await login("operador", "operador");
    const res = await request(app).get("/api/usuarios").set(auth(token));
    expect(res.status).toBe(403);
  });

  it("desactiva un usuario y el usuario no puede iniciar sesión", async () => {
    const token = await login("admin", "admin");
    const lista = await request(app).get("/api/usuarios").set(auth(token));
    const operador = lista.body.usuarios.find((u: { username: string }) => u.username === "operador");
    const des = await request(app)
      .patch(`/api/usuarios/${operador.id}/estado`)
      .set(auth(token))
      .send({ activo: false });
    expect(des.status).toBe(200);
    expect(des.body.usuario.activo).toBe(0);
    const loginFallido = await request(app)
      .post("/api/auth/login")
      .send({ username: "operador", password: "operador" });
    expect(loginFallido.status).toBe(401);
  });

  it("doble control: admin no puede desactivarse ni cambiarse su propio rol", async () => {
    const token = await login("admin", "admin");
    const me = await request(app).get("/api/auth/me").set(auth(token));
    const id = me.body.usuario.id as number;
    const des = await request(app)
      .patch(`/api/usuarios/${id}/estado`)
      .set(auth(token))
      .send({ activo: false });
    expect(des.status).toBe(409);
    const rol = await request(app)
      .patch(`/api/usuarios/${id}/rol`)
      .set(auth(token))
      .send({ rol: "operacion" });
    expect(rol.status).toBe(409);
  });

  it("separación de funciones: admin NO captura operaciones ni consulta pagos", async () => {
    const token = await login("admin", "admin");
    const captura = await request(app)
      .post("/api/operaciones")
      .set(auth(token))
      .send({
        tipo: "pago",
        concepto: "Intento de captura",
        proveedor: "Proveedor",
        monto: 100,
        fecha_operacion: "2026-10-26",
      });
    expect(captura.status).toBe(403);
    const pagos = await request(app).get("/api/pagos").set(auth(token));
    expect(pagos.status).toBe(403);
  });

  it("admin edita el umbral de Dirección y la validación lo aplica", async () => {
    const token = await login("admin", "admin");
    const param = await request(app)
      .patch("/api/parametros/umbral_direccion")
      .set(auth(token))
      .send({ valor: "2000000" });
    expect(param.status).toBe(200);

    // Un monto que antes pedía Dirección (750k >= 500k) ya no la requiere.
    const tOp = await login("operador", "operador");
    const op = await request(app)
      .post("/api/operaciones")
      .set(auth(tOp))
      .send({
        tipo: "pago",
        concepto: "Monto sobre umbral viejo",
        proveedor: "Proveedor",
        monto: 750000,
        fecha_operacion: "2026-10-26",
      });
    await request(app)
      .post(`/api/operaciones/${op.body.operacion.id}/enviar-validacion`)
      .set(auth(tOp));
    const tVal = await login("validador", "validador");
    const rev = await request(app)
      .post(`/api/operaciones/${op.body.operacion.id}/revision`)
      .set(auth(tVal))
      .send({ resultado: "aprobada", comentario: "Dentro del nuevo umbral" });
    expect(rev.status).toBe(200);
    expect(rev.body.operacion.estado).toBe("aprobada");
  });
});

describe("Administrador de Operaciones (rol admin_operaciones)", () => {
  it("crea clientes y los ve con su ejecutivo asignado", async () => {
    const tAdmin = await login("admin_ops", "admin_ops");
    const tEje = await login("operador", "operador");
    const me = await request(app).get("/api/auth/me").set(auth(tEje));
    const ejecutivoId = me.body.usuario.id as number;

    const cli = await request(app)
      .post("/api/clientes")
      .set(auth(tAdmin))
      .send({ nombre: "Comercializadora del Golfo", rfc: "CGO850101AB1", contacto: "contacto@golfo.mx" });
    expect(cli.status).toBe(201);

    const asig = await request(app)
      .post(`/api/clientes/${cli.body.cliente.id}/asignaciones`)
      .set(auth(tAdmin))
      .send({ ejecutivo_id: ejecutivoId, motivo: "Cartera inicial" });
    expect(asig.status).toBe(201);

    const lista = await request(app).get("/api/clientes").set(auth(tAdmin));
    const encontrado = lista.body.clientes.find((c: { id: number }) => c.id === cli.body.cliente.id);
    expect(encontrado.ejecutivo).toBe("Ejecutivo de Operaciones");
  });

  it("sólo admin_operaciones crea clientes (operador y admin reciben 403)", async () => {
    const tEje = await login("operador", "operador");
    const r1 = await request(app)
      .post("/api/clientes")
      .set(auth(tEje))
      .send({ nombre: "Intento Ejecutivo" });
    expect(r1.status).toBe(403);
    const tAdmin = await login("admin", "admin");
    const r2 = await request(app).post("/api/clientes").set(auth(tAdmin)).send({ nombre: "Intento Admin" });
    expect(r2.status).toBe(403);
  });

  it("reasigna conservando el historial (append-only)", async () => {
    const tAdmin = await login("admin_ops", "admin_ops");
    const tEje1 = await login("operador", "operador");

    // Segundo ejecutivo creado por el admin del sistema.
    const tSis = await login("admin", "admin");
    const nuevo = await request(app)
      .post("/api/usuarios")
      .set(auth(tSis))
      .send({ username: "ops2", nombre: "Segundo Ejecutivo", rol: "operacion", password: "clave4" });
    const idEje2 = nuevo.body.usuario.id as number;
    const tEje2 = await login("ops2", "clave4");
    const idEje1 = (await request(app).get("/api/auth/me").set(auth(tEje1))).body.usuario.id as number;

    const cli = await request(app).post("/api/clientes").set(auth(tAdmin)).send({ nombre: "Cliente Reasignado" });
    const idCli = cli.body.cliente.id as number;
    await request(app)
      .post(`/api/clientes/${idCli}/asignaciones`)
      .set(auth(tAdmin))
      .send({ ejecutivo_id: idEje1, motivo: "Primera asignación" });
    await request(app)
      .post(`/api/clientes/${idCli}/asignaciones`)
      .set(auth(tAdmin))
      .send({ ejecutivo_id: idEje2, motivo: "Cambio de cartera" });

    const hist = await request(app).get(`/api/clientes/${idCli}/asignaciones`).set(auth(tAdmin));
    expect(hist.body.asignaciones).toHaveLength(2);
    expect(hist.body.asignaciones[0].activo).toBe(1); // la última es vigente
    expect(hist.body.asignaciones[1].activo).toBe(0); // la original quedó cerrada, no borrada
    expect(hist.body.asignaciones[1].cerrado_en).not.toBeNull();
  });
});

describe("Ejecutivo de Operaciones con alcance por cliente (01-ROLES.md §3.2, §12)", () => {
  it("captura para un cliente asignado y el folio queda ligado", async () => {
    const tAdmin = await login("admin_ops", "admin_ops");
    const tEje = await login("operador", "operador");
    const idEje = (await request(app).get("/api/auth/me").set(auth(tEje))).body.usuario.id as number;
    const cli = await request(app).post("/api/clientes").set(auth(tAdmin)).send({ nombre: "Cliente Asignado" });
    await request(app)
      .post(`/api/clientes/${cli.body.cliente.id}/asignaciones`)
      .set(auth(tAdmin))
      .send({ ejecutivo_id: idEje });

    const op = await request(app)
      .post("/api/operaciones")
      .set(auth(tEje))
      .send({
        tipo: "pago",
        concepto: "Renta",
        proveedor: "Inmobiliaria",
        monto: 1000,
        fecha_operacion: "2026-10-26",
        cliente_id: cli.body.cliente.id,
      });
    expect(op.status).toBe(201);
    expect(op.body.operacion.cliente_id).toBe(cli.body.cliente.id);
  });

  it("rechaza capturar para un cliente NO asignado (403)", async () => {
    const tAdmin = await login("admin_ops", "admin_ops");
    const cli = await request(app).post("/api/clientes").set(auth(tAdmin)).send({ nombre: "Cliente Ajeno" });
    const tEje = await login("operador", "operador");
    const op = await request(app)
      .post("/api/operaciones")
      .set(auth(tEje))
      .send({
        tipo: "pago",
        concepto: "Renta",
        proveedor: "Inmobiliaria",
        monto: 1000,
        fecha_operacion: "2026-10-26",
        cliente_id: cli.body.cliente.id,
      });
    expect(op.status).toBe(403);
  });

  it("sólo ve sus operaciones: creadas por él o de clientes asignados", async () => {
    const tAdmin = await login("admin_ops", "admin_ops");
    const tSis = await login("admin", "admin");
    const tEje1 = await login("operador", "operador");
    const idEje1 = (await request(app).get("/api/auth/me").set(auth(tEje1))).body.usuario.id as number;

    const nuevo = await request(app)
      .post("/api/usuarios")
      .set(auth(tSis))
      .send({ username: "ops2", nombre: "Segundo Ejecutivo", rol: "operacion", password: "clave4" });
    const tEje2 = await login("ops2", "clave4");

    // Cliente asignado a ops2 (no al operador original).
    const cli = await request(app).post("/api/clientes").set(auth(tAdmin)).send({ nombre: "Cliente de Ops2" });
    await request(app)
      .post(`/api/clientes/${cli.body.cliente.id}/asignaciones`)
      .set(auth(tAdmin))
      .send({ ejecutivo_id: nuevo.body.usuario.id });
    const opAjena = await request(app)
      .post("/api/operaciones")
      .set(auth(tEje2))
      .send({
        tipo: "pago",
        concepto: "Operación ajena",
        proveedor: "Proveedor",
        monto: 500,
        fecha_operacion: "2026-10-26",
        cliente_id: cli.body.cliente.id,
      });
    expect(opAjena.status).toBe(201);

    // Operación propia del operador original, sin cliente.
    const opPropia = await request(app)
      .post("/api/operaciones")
      .set(auth(tEje1))
      .send({
        tipo: "cobro",
        concepto: "Operación propia",
        proveedor: "Proveedor",
        monto: 700,
        fecha_operacion: "2026-10-26",
      });
    expect(opPropia.status).toBe(201);

    // La lista del ejecutivo 1 incluye la propia y excluye la de ops2.
    const lista = await request(app).get("/api/operaciones").set(auth(tEje1));
    const ids = lista.body.operaciones.map((o: { id: number }) => o.id);
    expect(ids).toContain(opPropia.body.operacion.id);
    expect(ids).not.toContain(opAjena.body.operacion.id);

    // El detalle de la operación ajena responde 403.
    const detalle = await request(app)
      .get(`/api/operaciones/${opAjena.body.operacion.id}`)
      .set(auth(tEje1));
    expect(detalle.status).toBe(403);

    // El Administrador de Operaciones supervisa TODO el área (§3.1).
    const todas = await request(app).get("/api/operaciones").set(auth(tAdmin));
    const idsAdmin = todas.body.operaciones.map((o: { id: number }) => o.id);
    expect(idsAdmin).toContain(opPropia.body.operacion.id);
    expect(idsAdmin).toContain(opAjena.body.operacion.id);
  });

  it("ve comprobantes sólo de sus operaciones (GET /pagos con alcance)", async () => {
    const tVal = await login("validador", "validador");
    const tTes = await login("tesoreria", "tesoreria");
    const tEje = await login("operador", "operador");
    const tSis = await login("admin", "admin");

    // Ejecutivo 2 con cliente asignado.
    const nuevo = await request(app)
      .post("/api/usuarios")
      .set(auth(tSis))
      .send({ username: "ops2", nombre: "Segundo Ejecutivo", rol: "operacion", password: "clave4" });
    const tEje2 = await login("ops2", "clave4");
    const opAjena = await request(app)
      .post("/api/operaciones")
      .set(auth(tEje2))
      .send({
        tipo: "pago",
        concepto: "De otro ejecutivo",
        proveedor: "Proveedor",
        monto: 300,
        fecha_operacion: "2026-10-26",
      });

    // Flujo completo de la operación ajena hasta el pago.
    await request(app)
      .post(`/api/operaciones/${opAjena.body.operacion.id}/enviar-validacion`)
      .set(auth(tEje2));
    await request(app)
      .post(`/api/operaciones/${opAjena.body.operacion.id}/revision`)
      .set(auth(tVal))
      .send({ resultado: "aprobada", comentario: "ok" });
    // Fase 12: el Fondeador libera; Tesorería sólo paga lo liberado.
    await request(app)
      .post(`/api/operaciones/${opAjena.body.operacion.id}/liberar`)
      .set(auth(await login("fondeador", "fondeador")));
    const pago = await request(app)
      .post(`/api/operaciones/${opAjena.body.operacion.id}/pago`)
      .set(auth(tTes))
      .send({ medio: "transferencia", monto: 300, comprobante: "TRF-9001", fecha_pago: "2026-10-26" });
    expect(pago.status).toBe(201);

    // El ejecutivo 1 NO ve ese comprobante; tesorería sí.
    const pagosEje1 = await request(app).get("/api/pagos").set(auth(tEje));
    expect(pagosEje1.status).toBe(200);
    expect(pagosEje1.body.pagos).toHaveLength(0);
    const pagosTes = await request(app).get("/api/pagos").set(auth(tTes));
    expect(pagosTes.body.pagos).toHaveLength(1);
  });
});

describe("Migración de base existente (esquema previo a la fase de roles)", () => {
  it("reconstruye usuarios, agrega cliente_id, siembra admin y conserva datos", () => {
    // Simula la base que ya tiene el equipo en su PC (usuarios con 5 roles
    // y operaciones sin cliente_id), y verifica la migración automática.
    const dir = mkdtempSync(join(tmpdir(), "tesoreria-migr-"));
    const ruta = join(dir, "tesoreria.db");
    const archivo = new Database(ruta);
    archivo.exec(`
      CREATE TABLE usuarios (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        nombre        TEXT NOT NULL,
        rol           TEXT NOT NULL CHECK (rol IN ('operacion','validacion','tesoreria','direccion','auditoria')),
        activo        INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE operaciones (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        folio           TEXT NOT NULL UNIQUE,
        tipo            TEXT NOT NULL CHECK (tipo IN ('pago','cobro','financiamiento')),
        concepto        TEXT NOT NULL,
        proveedor       TEXT NOT NULL,
        monto           REAL NOT NULL CHECK (monto > 0),
        moneda          TEXT NOT NULL DEFAULT 'MXN',
        fecha_operacion TEXT NOT NULL,
        estado          TEXT NOT NULL DEFAULT 'borrador'
                        CHECK (estado IN ('borrador','en_validacion','observada','pendiente_direccion','aprobada','pagada','cancelada')),
        creado_por      INTEGER NOT NULL REFERENCES usuarios(id),
        creado_en       TEXT NOT NULL DEFAULT (datetime('now')),
        actualizado_en  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO usuarios (username, password_hash, nombre, rol) VALUES
        ('operador', 'hash-operador', 'Ejecutivo de Operaciones', 'operacion');
      INSERT INTO operaciones (folio, tipo, concepto, proveedor, monto, fecha_operacion, estado, creado_por)
        VALUES ('OP-2026-00001', 'pago', 'Previa', 'Proveedor', 1000, '2026-10-01', 'borrador', 1);
    `);
    archivo.close();

    const abierta = abrirBase(ruta);
    const usuarios = abierta.prepare("SELECT username, rol FROM usuarios ORDER BY id").all() as Array<{
      username: string;
      rol: string;
    }>;
    // El usuario previo se conserva y se agregan admin / admin_ops sin duplicar.
    expect(usuarios[0]).toEqual({ username: "operador", rol: "operacion" });
    expect(usuarios.map((u) => u.username)).toContain("admin");
    expect(usuarios.map((u) => u.username)).toContain("admin_ops");
    expect(usuarios.filter((u) => u.username === "operador")).toHaveLength(1);

    // operaciones.cliente_id existe y los datos previos siguen ahí.
    const columnas = (abierta.pragma("table_info(operaciones)") as Array<{ name: string }>).map((c) => c.name);
    expect(columnas).toContain("cliente_id");
    const previa = abierta.prepare("SELECT folio FROM operaciones WHERE id = 1").get() as { folio: string };
    expect(previa.folio).toBe("OP-2026-00001");

    // El CHECK nuevo acepta roles nuevos.
    abierta
      .prepare("INSERT INTO usuarios (username, password_hash, nombre, rol) VALUES ('t', 'h', 'T', 'admin')")
      .run();
    expect((abierta.prepare("SELECT rol FROM usuarios WHERE username = 't'").get() as { rol: string }).rol).toBe(
      "admin"
    );
    abierta.close();
  });
});

describe("Catálogos administrables", () => {
  it("admin crea y edita registros; operador sólo consulta", async () => {
    const tAdmin = await login("admin", "admin");
    const alta = await request(app)
      .post("/api/catalogos/registros")
      .set(auth(tAdmin))
      .send({ dominio: "pagadora", clave: "HSBC", valor: "HSBC México" });
    expect(alta.status).toBe(201);

    const dup = await request(app)
      .post("/api/catalogos/registros")
      .set(auth(tAdmin))
      .send({ dominio: "pagadora", clave: "HSBC", valor: "Duplicado" });
    expect(dup.status).toBe(409);

    const patch = await request(app)
      .patch(`/api/catalogos/registros/${alta.body.registro.id}`)
      .set(auth(tAdmin))
      .send({ activo: false });
    expect(patch.status).toBe(200);
    expect(patch.body.registro.activo).toBe(0);

    const tEje = await login("operador", "operador");
    const lectura = await request(app).get("/api/catalogos/registros").set(auth(tEje));
    expect(lectura.status).toBe(200);
    const escritura = await request(app)
      .post("/api/catalogos/registros")
      .set(auth(tEje))
      .send({ dominio: "pagadora", clave: "SCOTIA", valor: "Scotiabank" });
    expect(escritura.status).toBe(403);
  });

  it("semilla de pagadoras disponible para consulta", async () => {
    const tEje = await login("operador", "operador");
    const res = await request(app).get("/api/catalogos/registros?dominio=pagadora").set(auth(tEje));
    expect(res.status).toBe(200);
    const claves = res.body.registros.map((r: { clave: string }) => r.clave);
    expect(claves).toContain("BBVA");
  });
});
