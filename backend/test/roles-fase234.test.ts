import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crearApp } from "../src/app.js";
import { abrirBase } from "../src/db.js";

/**
 * Fases 2-4 de roles (01-ROLES.md):
 * - §4.1/§4.2 Administrador de Validación y cola con asignaciones.
 * - §5.1/§5.2/§5.3 Administrador de Tesorería, Validador de Tesorería y
 *   alcance de cuentas del tesorero, coberturas y aplicaciones de recursos.
 * - §6.1/§7.1 Dirección y Auditoría (bitácora para admin, observaciones,
 *   concentrado descargable).
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

/** Operación enviada a validación (en_validacion). */
async function operacionEnValidacion(monto = 1000): Promise<number> {
  const tOp = await login("operador", "operador");
  const creacion = await request(app)
    .post("/api/operaciones")
    .set(auth(tOp))
    .send({
      tipo: "pago",
      concepto: "Prueba de flujo",
      proveedor: "Proveedor SA",
      monto,
      fecha_operacion: "2026-10-26",
    });
  const id = creacion.body.operacion.id as number;
  await request(app).post(`/api/operaciones/${id}/enviar-validacion`).set(auth(tOp));
  return id;
}

/** Operación aprobada (bajo umbral, sin pasar por Dirección). */
async function operacionAprobada(monto = 5000): Promise<number> {
  const id = await operacionEnValidacion(monto);
  const tVal = await login("validador", "validador");
  const rev = await request(app)
    .post(`/api/operaciones/${id}/revision`)
    .set(auth(tVal))
    .send({ resultado: "aprobada", comentario: "ok" });
  expect(rev.status).toBe(200);
  return id;
}

async function crearCuentaYDeposito(montoDeposito = 100000): Promise<{ cuentaId: number; movimientoId: number }> {
  // Sólo el Administrador de Tesorería crea cuentas; él mismo puede movilizarlas.
  const t = await login("admin_tesoreria", "admin_tesoreria");
  const cuenta = await request(app)
    .post("/api/cuentas")
    .set(auth(t))
    .send({ nombre: "BBVA Operativa", banco: "BBVA", saldo_inicial: 0 });
  expect(cuenta.status).toBe(201);
  const cuentaId = cuenta.body.cuenta.id as number;
  const mov = await request(app)
    .post(`/api/cuentas/${cuentaId}/movimientos`)
    .set(auth(t))
    .send({ tipo: "deposito", monto: montoDeposito, concepto: "Ingreso de cliente", fecha: "2026-10-25" });
  expect(mov.status).toBe(201);
  return { cuentaId, movimientoId: mov.body.movimiento.id as number };
}

// ---- Fase 2: Administrador de Validación (§4.1) y cola (§4.2) ----

describe("Administrador de Validación (rol admin_validacion)", () => {
  it("asigna una operación en validación a un validador y la cola lo refleja", async () => {
    const id = await operacionEnValidacion();
    const tAdmin = await login("admin_validacion", "admin_validacion");
    const validadores = await request(app).get("/api/usuarios/validadores").set(auth(tAdmin));
    const idValidador = validadores.body.validadores[0].id as number;

    const colaVacia = await request(app).get("/api/validacion/cola").set(auth(tAdmin));
    expect(colaVacia.status).toBe(200);
    expect(colaVacia.body.cola).toHaveLength(1);
    expect(colaVacia.body.cola[0].validador_asignado).toBeNull();

    const asignacion = await request(app)
      .post(`/api/operaciones/${id}/asignar-validacion`)
      .set(auth(tAdmin))
      .send({ validador_id: idValidador, motivo: "carga balanceada" });
    expect(asignacion.status).toBe(201);

    const cola = await request(app).get("/api/validacion/cola").set(auth(tAdmin));
    expect(cola.body.cola[0].validador_asignado).toBe("Validador de Operaciones");
  });

  it("reasigna conservando el historial (append-only)", async () => {
    const id = await operacionEnValidacion();
    const tAdmin = await login("admin_validacion", "admin_validacion");
    // Validador adicional
    await request(app)
      .post("/api/usuarios")
      .set(auth(await login("admin", "admin")))
      .send({ username: "validador2", nombre: "Segundo Validador", rol: "validacion", password: "clave4" });
    const lista = await request(app).get("/api/usuarios/validadores").set(auth(tAdmin));
    const ids = lista.body.validadores.map((v: { username: string; id: number }) => [v.username, v.id]);
    const idVal1 = ids.find(([u]: [string, number]) => u === "validador")![1];
    const idVal2 = ids.find(([u]: [string, number]) => u === "validador2")![1];

    await request(app)
      .post(`/api/operaciones/${id}/asignar-validacion`)
      .set(auth(tAdmin))
      .send({ validador_id: idVal1 });
    const reasignacion = await request(app)
      .post(`/api/operaciones/${id}/asignar-validacion`)
      .set(auth(tAdmin))
      .send({ validador_id: idVal2, motivo: "ausencia" });
    expect(reasignacion.status).toBe(201);

    const historial = await request(app).get(`/api/operaciones/${id}/asignaciones-validacion`).set(auth(tAdmin));
    expect(historial.body.asignaciones).toHaveLength(2);
    expect(historial.body.asignaciones[0].activo).toBe(1);
    expect(historial.body.asignaciones[1].activo).toBe(0);
  });

  it("el validador asignado puede revisar; otro validador recibe 403", async () => {
    const id = await operacionEnValidacion();
    const tAdmin = await login("admin_validacion", "admin_validacion");
    await request(app)
      .post("/api/usuarios")
      .set(auth(await login("admin", "admin")))
      .send({ username: "validador2", nombre: "Segundo Validador", rol: "validacion", password: "clave4" });
    const lista = await request(app).get("/api/usuarios/validadores").set(auth(tAdmin));
    const idVal2 = lista.body.validadores.find((v: { username: string }) => v.username === "validador2").id;
    await request(app)
      .post(`/api/operaciones/${id}/asignar-validacion`)
      .set(auth(tAdmin))
      .send({ validador_id: idVal2 });

    // El validador base (no asignado) no puede revisarla.
    const rechazo = await request(app)
      .post(`/api/operaciones/${id}/revision`)
      .set(auth(await login("validador", "validador")))
      .send({ resultado: "aprobada", comentario: "intento sin asignación" });
    expect(rechazo.status).toBe(403);
    expect(rechazo.body.error).toMatch(/asignada a otro validador/);

    // El asignado sí puede.
    const revision = await request(app)
      .post(`/api/operaciones/${id}/revision`)
      .set(auth(await login("validador2", "clave4")))
      .send({ resultado: "aprobada", comentario: "revisada por el asignado" });
    expect(revision.status).toBe(200);
    expect(revision.body.operacion.estado).toBe("aprobada");
  });

  it("muestra cargas por validador (asignadas y revisadas)", async () => {
    const id = await operacionEnValidacion();
    const tAdmin = await login("admin_validacion", "admin_validacion");
    const validadores = await request(app).get("/api/usuarios/validadores").set(auth(tAdmin));
    const idValidador = validadores.body.validadores[0].id as number;
    await request(app)
      .post(`/api/operaciones/${id}/asignar-validacion`)
      .set(auth(tAdmin))
      .send({ validador_id: idValidador });
    const cargas = await request(app).get("/api/validacion/cargas").set(auth(tAdmin));
    expect(cargas.status).toBe(200);
    const fila = cargas.body.cargas.find((c: { username: string }) => c.username === "validador");
    expect(fila.asignadas).toBe(1);
  });

  it("sólo admin_validacion asigna; validador y admin reciben 403", async () => {
    const id = await operacionEnValidacion();
    for (const usuario of ["validador", "admin", "operador"]) {
      const token = await login(usuario, usuario);
      const res = await request(app)
        .post(`/api/operaciones/${id}/asignar-validacion`)
        .set(auth(token))
        .send({ validador_id: 4 });
      expect(res.status, `usuario ${usuario} no debe asignar validaciones`).toBe(403);
    }
  });

  it("separación de funciones: admin_validacion no captura, no paga ni moviliza", async () => {
    const token = await login("admin_validacion", "admin_validacion");
    const captura = await request(app)
      .post("/api/operaciones")
      .set(auth(token))
      .send({ tipo: "pago", concepto: "x", proveedor: "y", monto: 100, fecha_operacion: "2026-10-26" });
    expect(captura.status).toBe(403);
    const pagos = await request(app).get("/api/pagos").set(auth(token));
    expect(pagos.status).toBe(403);
    const cuenta = await request(app).post("/api/cuentas").set(auth(token)).send({ nombre: "Fraude" });
    expect(cuenta.status).toBe(403);
  });
});

// ---- Fase 3: Tesorería (§5.1, §5.2, §5.3) ----

describe("Administrador de Tesorería (rol admin_tesoreria) y asignación de cuentas", () => {
  it("asigna una cuenta a un tesorero; el tesorero con asignaciones sólo ve las suyas", async () => {
    const tTes = await login("tesoreria", "tesoreria");
    // Sólo el Administrador de Tesorería crea cuentas.
    const tCrea = await login("admin_tesoreria", "admin_tesoreria");
    const c1 = await request(app).post("/api/cuentas").set(auth(tCrea)).send({ nombre: "Cuenta A" });
    const c2 = await request(app).post("/api/cuentas").set(auth(tCrea)).send({ nombre: "Cuenta B" });
    expect(c1.status).toBe(201);
    expect(c2.status).toBe(201);

    // Sin asignaciones: modo compatibilidad, ve todas (incluye la semilla).
    const todas = await request(app).get("/api/cuentas").set(auth(tTes));
    expect(todas.body.cuentas.length).toBeGreaterThanOrEqual(2);

    // Segundo tesorero y asignación de la Cuenta B a él.
    await request(app)
      .post("/api/usuarios")
      .set(auth(await login("admin", "admin")))
      .send({ username: "teso2", nombre: "Segundo Tesorero", rol: "tesoreria", password: "clave4" });
    const tAdmin = await login("admin_tesoreria", "admin_tesoreria");
    const tesoreros = await request(app).get("/api/usuarios/tesoreros").set(auth(tAdmin));
    const idTeso2 = tesoreros.body.tesoreros.find((t: { username: string }) => t.username === "teso2").id;
    const asignacion = await request(app)
      .post(`/api/cuentas/${c2.body.cuenta.id}/asignar`)
      .set(auth(tAdmin))
      .send({ tesorero_id: idTeso2, motivo: "distribución de cartera" });
    expect(asignacion.status).toBe(201);

    // tesoreria (sin asignaciones) sigue viendo todo; teso2 sólo la Cuenta B.
    const vistaBase = await request(app).get("/api/cuentas").set(auth(tTes));
    expect(vistaBase.body.cuentas.length).toBe(todas.body.cuentas.length);
    const vistaTeso2 = await request(app)
      .get("/api/cuentas")
      .set(auth(await login("teso2", "clave4")));
    expect(vistaTeso2.body.cuentas).toHaveLength(1);
    expect(vistaTeso2.body.cuentas[0].nombre).toBe("Cuenta B");
    expect(vistaTeso2.body.cuentas[0].tesorero).toBe("Segundo Tesorero");

    // teso2 no puede movilizar una cuenta fuera de su alcance.
    const ajena = await request(app)
      .post(`/api/cuentas/${c1.body.cuenta.id}/movimientos`)
      .set(auth(await login("teso2", "clave4")))
      .send({ tipo: "deposito", monto: 100, concepto: "intento" });
    expect(ajena.status).toBe(403);
    // ...ni consultarla.
    const detalleAjeno = await request(app)
      .get(`/api/cuentas/${c1.body.cuenta.id}`)
      .set(auth(await login("teso2", "clave4")));
    expect(detalleAjeno.status).toBe(403);
  });

  it("reasignación de cuenta conserva el historial (append-only)", async () => {
    const cuenta = await request(app)
      .post("/api/cuentas")
      .set(auth(await login("admin_tesoreria", "admin_tesoreria")))
      .send({ nombre: "Cuenta Única" });
    await request(app)
      .post("/api/usuarios")
      .set(auth(await login("admin", "admin")))
      .send({ username: "teso2", nombre: "Segundo Tesorero", rol: "tesoreria", password: "clave4" });
    const tAdmin = await login("admin_tesoreria", "admin_tesoreria");
    const tesoreros = await request(app).get("/api/usuarios/tesoreros").set(auth(tAdmin));
    const ids = tesoreros.body.tesoreros.map((t: { username: string; id: number }) => [t.username, t.id]);
    const id1 = ids.find(([u]: [string, number]) => u === "tesoreria")![1];
    const id2 = ids.find(([u]: [string, number]) => u === "teso2")![1];
    await request(app).post(`/api/cuentas/${cuenta.body.cuenta.id}/asignar`).set(auth(tAdmin)).send({ tesorero_id: id1 });
    await request(app).post(`/api/cuentas/${cuenta.body.cuenta.id}/asignar`).set(auth(tAdmin)).send({ tesorero_id: id2 });
    const historial = await request(app).get(`/api/cuentas/${cuenta.body.cuenta.id}/asignaciones`).set(auth(tAdmin));
    expect(historial.body.asignaciones).toHaveLength(2);
    expect(historial.body.asignaciones[0].activo).toBe(1);
    expect(historial.body.asignaciones[1].activo).toBe(0);
  });

  it("crea cobertura temporal; el tesorero temporal accede a la cuenta cubierta", async () => {
    const cuenta = await request(app)
      .post("/api/cuentas")
      .set(auth(await login("admin_tesoreria", "admin_tesoreria")))
      .send({ nombre: "Cuenta Cubierta" });
    await request(app)
      .post("/api/usuarios")
      .set(auth(await login("admin", "admin")))
      .send({ username: "teso2", nombre: "Segundo Tesorero", rol: "tesoreria", password: "clave4" });
    const tAdmin = await login("admin_tesoreria", "admin_tesoreria");
    const tesoreros = await request(app).get("/api/usuarios/tesoreros").set(auth(tAdmin));
    const idHab = tesoreros.body.tesoreros.find((t: { username: string }) => t.username === "tesoreria").id;
    const idTemp = tesoreros.body.tesoreros.find((t: { username: string }) => t.username === "teso2").id;

    const fechasMalas = await request(app)
      .post("/api/coberturas")
      .set(auth(tAdmin))
      .send({
        cuenta_id: cuenta.body.cuenta.id,
        tesorero_habitual_id: idHab,
        tesorero_temporal_id: idTemp,
        fecha_inicio: "2026-11-10",
        fecha_fin: "2026-11-01",
        motivo: "vacaciones",
      });
    expect(fechasMalas.status).toBe(400);

    const cobertura = await request(app)
      .post("/api/coberturas")
      .set(auth(tAdmin))
      .send({
        cuenta_id: cuenta.body.cuenta.id,
        tesorero_habitual_id: idHab,
        tesorero_temporal_id: idTemp,
        fecha_inicio: "2026-11-01",
        fecha_fin: "2026-11-15",
        motivo: "vacaciones",
      });
    expect(cobertura.status).toBe(201);

    // El temporal ve la cuenta aunque no tenga asignación directa.
    const vista = await request(app).get("/api/cuentas").set(auth(await login("teso2", "clave4")));
    expect(vista.body.cuentas.some((c: { nombre: string }) => c.nombre === "Cuenta Cubierta")).toBe(true);

    const lista = await request(app).get("/api/coberturas").set(auth(tAdmin));
    expect(lista.body.coberturas).toHaveLength(1);
    expect(lista.body.coberturas[0].habitual).toBe("Analista de Tesorería");
  });

  it("admin_tesoreria crea cuentas y movimientos; tesorero también (sin regresión)", async () => {
    const tAdmin = await login("admin_tesoreria", "admin_tesoreria");
    const cuenta = await request(app).post("/api/cuentas").set(auth(tAdmin)).send({ nombre: "Cuenta Admin" });
    expect(cuenta.status).toBe(201);
    const mov = await request(app)
      .post(`/api/cuentas/${cuenta.body.cuenta.id}/movimientos`)
      .set(auth(tAdmin))
      .send({ tipo: "deposito", monto: 5000, concepto: "apertura" });
    expect(mov.status).toBe(201);
  });
});

describe("Validador de Tesorería (rol validador_tesoreria) y aplicaciones de recursos", () => {
  it("aplica un depósito a una operación aprobada y el disponible se reduce", async () => {
    const { movimientoId } = await crearCuentaYDeposito(100000);
    const opId = await operacionAprobada(30000);
    const tVal = await login("val_tesoreria", "val_tesoreria");

    const aplicacion = await request(app)
      .post("/api/recursos/aplicar")
      .set(auth(tVal))
      .send({ movimiento_id: movimientoId, operacion_id: opId, importe: 30000, observaciones: "aplicación total" });
    expect(aplicacion.status).toBe(201);
    expect(aplicacion.body.aplicacion.moneda).toBe("MXN");

    const recursos = await request(app).get("/api/recursos").set(auth(tVal));
    expect(recursos.status).toBe(200);
    const fila = recursos.body.aplicaciones[0];
    expect(fila.disponible_movimiento).toBeCloseTo(70000, 2);
    expect(fila.folio).toMatch(/^OP-\d{4}-/);
  });

  it("impide la doble utilización del depósito (409)", async () => {
    const { movimientoId } = await crearCuentaYDeposito(50000);
    const op1 = await operacionAprobada(20000);
    const tVal = await login("val_tesoreria", "val_tesoreria");
    const primera = await request(app)
      .post("/api/recursos/aplicar")
      .set(auth(tVal))
      .send({ movimiento_id: movimientoId, operacion_id: op1, importe: 20000 });
    expect(primera.status).toBe(201);
    const op2 = await operacionAprobada(40000);
    const exceso = await request(app)
      .post("/api/recursos/aplicar")
      .set(auth(tVal))
      .send({ movimiento_id: movimientoId, operacion_id: op2, importe: 40000 });
    expect(exceso.status).toBe(409);
    expect(exceso.body.error).toMatch(/Doble utilización/);
    // Dentro del disponible sí procede (aplicación parcial, §5.2).
    const parcial = await request(app)
      .post("/api/recursos/aplicar")
      .set(auth(tVal))
      .send({ movimiento_id: movimientoId, operacion_id: op2, importe: 30000 });
    expect(parcial.status).toBe(201);
  });

  it("impide sobregirar la operación (409) y admite aplicaciones parciales", async () => {
    const { movimientoId } = await crearCuentaYDeposito(500000);
    const opId = await operacionAprobada(10000);
    const tVal = await login("val_tesoreria", "val_tesoreria");
    const parcial1 = await request(app)
      .post("/api/recursos/aplicar")
      .set(auth(tVal))
      .send({ movimiento_id: movimientoId, operacion_id: opId, importe: 7000 });
    expect(parcial1.status).toBe(201);
    const exceso = await request(app)
      .post("/api/recursos/aplicar")
      .set(auth(tVal))
      .send({ movimiento_id: movimientoId, operacion_id: opId, importe: 5000 });
    expect(exceso.status).toBe(409);
    expect(exceso.body.aplicado).toBeCloseTo(7000, 2);
  });

  it("rechaza aplicar retiros, operaciones en borrador y montos inválidos", async () => {
    const cuenta = await request(app)
      .post("/api/cuentas")
      .set(auth(await login("admin_tesoreria", "admin_tesoreria")))
      .send({ nombre: "C" });
    const retiro = await request(app)
      .post(`/api/cuentas/${cuenta.body.cuenta.id}/movimientos`)
      .set(auth(await login("admin_tesoreria", "admin_tesoreria")))
      .send({ tipo: "retiro", monto: 1000, concepto: "comisión" });
    const tVal = await login("val_tesoreria", "val_tesoreria");
    const opId = await operacionAprobada(500);

    const conRetiro = await request(app)
      .post("/api/recursos/aplicar")
      .set(auth(tVal))
      .send({ movimiento_id: retiro.body.movimiento.id, operacion_id: opId, importe: 100 });
    expect(conRetiro.status).toBe(409);

    const enBorrador = await request(app)
      .post("/api/operaciones")
      .set(auth(await login("operador", "operador")))
      .send({ tipo: "pago", concepto: "x", proveedor: "y", monto: 200, fecha_operacion: "2026-10-26" });
    const conBorrador = await request(app)
      .post("/api/recursos/aplicar")
      .set(auth(tVal))
      .send({
        movimiento_id: retiro.body.movimiento.id,
        operacion_id: enBorrador.body.operacion.id,
        importe: 50,
      });
    expect(conBorrador.status).toBe(409);

    const { movimientoId } = await crearCuentaYDeposito();
    const montoCero = await request(app)
      .post("/api/recursos/aplicar")
      .set(auth(tVal))
      .send({ movimiento_id: movimientoId, operacion_id: opId, importe: 0 });
    expect(montoCero.status).toBe(400);
  });

  it("doble control en la liberación: la hace otra persona y con motivo", async () => {
    const { movimientoId } = await crearCuentaYDeposito(10000);
    const opId = await operacionAprobada(2000);
    const tVal = await login("val_tesoreria", "val_tesoreria");
    const aplicacion = await request(app)
      .post("/api/recursos/aplicar")
      .set(auth(tVal))
      .send({ movimiento_id: movimientoId, operacion_id: opId, importe: 2000 });
    const id = aplicacion.body.aplicacion.id as number;

    // El validador de tesorería no tiene el rol para liberar.
    const sinRol = await request(app)
      .post(`/api/recursos/${id}/liberar`)
      .set(auth(tVal))
      .send({ motivo: "yo lo apliqué" });
    expect(sinRol.status).toBe(403);

    // Sin motivo → 400.
    const tAdmin = await login("admin_tesoreria", "admin_tesoreria");
    const sinMotivo = await request(app).post(`/api/recursos/${id}/liberar`).set(auth(tAdmin)).send({});
    expect(sinMotivo.status).toBe(400);

    // El administrador (otra persona) libera con motivo.
    const liberada = await request(app)
      .post(`/api/recursos/${id}/liberar`)
      .set(auth(tAdmin))
      .send({ motivo: "error de captura de la operación" });
    expect(liberada.status).toBe(200);
    expect(liberada.body.aplicacion.liberado_por).toBeGreaterThan(0);
    expect(liberada.body.aplicacion.liberado_motivo).toBe("error de captura de la operación");

    // Ya liberada → 409; y el depósito recupera su disponible.
    const repetida = await request(app)
      .post(`/api/recursos/${id}/liberar`)
      .set(auth(tAdmin))
      .send({ motivo: "otra vez" });
    expect(repetida.status).toBe(409);
    const recursos = await request(app).get("/api/recursos").set(auth(tAdmin));
    expect(recursos.body.aplicaciones[0].disponible_movimiento).toBeCloseTo(10000, 2);
  });

  it("sólo los roles de tesorería consultan/aplican recursos; ejecutivo y validador no", async () => {
    const tEje = await login("operador", "operador");
    const lista = await request(app).get("/api/recursos").set(auth(tEje));
    expect(lista.status).toBe(403);
    const tVal = await login("validador", "validador");
    const aplicar = await request(app)
      .post("/api/recursos/aplicar")
      .set(auth(tVal))
      .send({ movimiento_id: 1, operacion_id: 1, importe: 10 });
    expect(aplicar.status).toBe(403);
    // El admin del sistema no consulta depósitos disponibles (rol financiero de tesorería).
    const disponibles = await request(app).get("/api/recursos/disponibles").set(auth(await login("admin", "admin")));
    expect(disponibles.status).toBe(403);
  });
});

// ---- Fase 4: Dirección, Auditoría y bitácora para admin (§6.1, §7.1, §8.1) ----

describe("Fase 4: bitácora, observaciones de auditoría y concentrado", () => {
  it("admin consulta la bitácora técnica (decisión documentada §8.1)", async () => {
    const res = await request(app).get("/api/auditoria").set(auth(await login("admin", "admin")));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.eventos)).toBe(true);
    // El ejecutivo sigue sin poder verla.
    const eje = await request(app).get("/api/auditoria").set(auth(await login("operador", "operador")));
    expect(eje.status).toBe(403);
  });

  it("auditoría es SÓLO LECTURA: ve todas las operaciones pero no registra observaciones (Fase 12)", async () => {
    const opId = await operacionAprobada(1000);
    const tAud = await login("auditor", "auditor");
    // El auditor SÍ ve la operación (detalle completo con estatus).
    const detalle = await request(app).get(`/api/operaciones/${opId}`).set(auth(tAud));
    expect(detalle.status).toBe(200);
    expect(detalle.body.operacion.estado).toBe("aprobada");
    // El endpoint de observaciones fue retirado: auditoría no modifica nada.
    const observacion = await request(app)
      .post(`/api/operaciones/${opId}/observacion-auditoria`)
      .set(auth(tAud))
      .send({ comentario: "Revisar soporte del proveedor" });
    expect(observacion.status).toBe(404);
    // Y no puede capturar ni pagar ni revisar (sólo lectura operativa).
    const captura = await request(app)
      .post("/api/operaciones")
      .set(auth(tAud))
      .send({ tipo: "pago", concepto: "x", proveedor: "y", monto: 100, fecha_operacion: "2026-10-26" });
    expect(captura.status).toBe(403);
    const revision = await request(app)
      .post(`/api/operaciones/${opId}/revision`)
      .set(auth(tAud))
      .send({ resultado: "aprobada", comentario: "no" });
    expect(revision.status).toBe(403);
  });

  it("descarga el concentrado CSV (tesorería, dirección, auditoría) y otros roles no", async () => {
    await crearCuentaYDeposito(1000);
    await operacionAprobada(500);
    const tTes = await login("tesoreria", "tesoreria");
    const csv = await request(app).get("/api/reportes/concentrado").set(auth(tTes));
    expect(csv.status).toBe(200);
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    expect(csv.text).toContain("PAGOS");
    expect(csv.text).toContain("MOVIMIENTOS_DE_CUENTAS");
    for (const usuario of ["direccion", "auditor"]) {
      const res = await request(app).get("/api/reportes/concentrado").set(auth(await login(usuario, usuario)));
      expect(res.status, `${usuario} debe descargar el concentrado`).toBe(200);
    }
    for (const usuario of ["operador", "admin", "admin_tesoreria"]) {
      const res = await request(app).get("/api/reportes/concentrado").set(auth(await login(usuario, usuario)));
      expect(res.status, `${usuario} no debe descargar el concentrado`).toBe(403);
    }
  });
});

// ---- Migración desde la base de la Fase 1 (7 roles) ----

describe("Migración de base con 7 roles hacia los 10 roles", () => {
  it("reconstruye usuarios, siembra los roles nuevos y conserva datos", () => {
    const dir = mkdtempSync(join(tmpdir(), "tesoreria-migr234-"));
    const ruta = join(dir, "tesoreria.db");
    const archivo = new Database(ruta);
    archivo.exec(`
      CREATE TABLE usuarios (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        nombre        TEXT NOT NULL,
        rol           TEXT NOT NULL CHECK (rol IN ('admin','admin_operaciones','operacion','validacion','tesoreria','direccion','auditoria')),
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
        ('operador', 'hash-previo', 'Ejecutivo previo', 'operacion');
      INSERT INTO operaciones (folio, tipo, concepto, proveedor, monto, fecha_operacion, estado, creado_por)
        VALUES ('OP-2026-00042', 'pago', 'Previa F1', 'Proveedor', 2500, '2026-10-01', 'borrador', 1);
    `);
    archivo.close();

    const abierta = abrirBase(ruta);
    const usuarios = abierta.prepare("SELECT username, rol FROM usuarios ORDER BY id").all() as Array<{
      username: string;
      rol: string;
    }>;
    expect(usuarios[0]).toEqual({ username: "operador", rol: "operacion" });
    const nombres = usuarios.map((u) => u.username);
    expect(nombres).toContain("admin_validacion");
    expect(nombres).toContain("admin_tesoreria");
    expect(nombres).toContain("val_tesoreria");
    expect(usuarios.filter((u) => u.username === "operador")).toHaveLength(1);

    // El CHECK nuevo acepta los roles de las fases 2-3.
    for (const rol of ["admin_validacion", "admin_tesoreria", "validador_tesoreria"]) {
      abierta
        .prepare("INSERT INTO usuarios (username, password_hash, nombre, rol) VALUES (?, 'h', 'T', ?)")
        .run(`x_${rol}`, rol);
    }
    // Las tablas nuevas existen.
    for (const tabla of ["asignaciones_validacion", "cuentas_asignaciones", "coberturas", "aplicaciones_recursos"]) {
      const existe = abierta
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(tabla);
      expect(existe, `tabla ${tabla}`).toBeTruthy();
    }
    const previa = abierta.prepare("SELECT folio FROM operaciones WHERE id = 1").get() as { folio: string };
    expect(previa.folio).toBe("OP-2026-00042");
    abierta.close();
  });
});
