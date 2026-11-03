import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Database } from "better-sqlite3";
import { crearApp } from "../src/app.js";
import { abrirBase } from "../src/db.js";

/**
 * Fase 15 — Catálogo maestro de cuentas, bóveda de credenciales y altas en
 * portales (formato "ALTA CUENTA"):
 *   · Catálogo SPEI (92 bancos) + validador/derivador de CLABE (banco por
 *     prefijo; cuenta derivada: Santander 11 dígitos pos. 7-17, resto 10 pos. 8-17).
 *   · Catálogo maestro de cuentas (CLABE, moneda, origen, estatus, cliente,
 *     formato de reporte, fechas) + importador con dedupe.
 *   · Bóveda 1:N cifrada (AES-256-GCM) con auditoría de accesos y multi-usuario.
 *   · Captura por lotes de altas + matriz alta × portal; al completar todos los
 *     portales la alta queda 'registrada' y Tesorería puede dispersar.
 */
let db: Database;
let app: ReturnType<typeof crearApp>;

async function login(username: string, password: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ username, password });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const hoy = (): string => new Date().toISOString().slice(0, 10);

const CLABE_BANORTE = "072180004912345678"; // → cuenta 0491234567 (MID 8-10, como el formato)
const CLABE_SANTANDER = "014180123456789012"; // → cuenta 12345678901 (MID 7-17, 11 dígitos)
const CLABE_DESCONOCIDO = "999180004912345678"; // prefijo fuera del catálogo

beforeEach(() => {
  db = abrirBase(":memory:");
  app = crearApp(db);
});

describe("Catálogo SPEI y utilidades de CLABE", () => {
  it("siembra los 92 bancos del formato de alta", async () => {
    const t = await login("operador", "operador");
    const res = await request(app).get("/api/bancos").set(auth(t));
    expect(res.status).toBe(200);
    expect(res.body.bancos).toHaveLength(92);
    const claves = new Set<string>(res.body.bancos.map((b: { clave: string }) => b.clave));
    expect(claves.has("072")).toBe(true); // Banorte
    expect(claves.has("014")).toBe(true); // Santander
    expect(claves.has("646")).toBe(true); // STP
    const banorte = res.body.bancos.find((b: { clave: string }) => b.clave === "072");
    expect(banorte.nombre_corto).toBe("BANORTE");
  });

  it("valida la CLABE, resuelve el banco y deriva la cuenta (regla por banco)", async () => {
    const t = await login("operador", "operador");
    // Banorte: cuenta = dígitos 8-17
    const bn = await request(app).post("/api/clabe/validar").set(auth(t)).send({ clabe: " 072 1800049-12345678 " });
    expect(bn.status).toBe(200);
    expect(bn.body.ok).toBe(true);
    expect(bn.body.clabe).toBe(CLABE_BANORTE);
    expect(bn.body.banco.nombre).toBe("BANORTE");
    expect(bn.body.cuenta).toBe("0491234567");
    // Santander: cuenta = dígitos 7-17 (11 dígitos)
    const sn = await request(app).post("/api/clabe/validar").set(auth(t)).send({ clabe: CLABE_SANTANDER });
    expect(sn.body.ok).toBe(true);
    expect(sn.body.banco.nombre).toBe("SANTANDER");
    expect(sn.body.cuenta).toBe("12345678901");
    expect(sn.body.cuenta).toHaveLength(11);
    // Longitud incorrecta
    const corta = await request(app).post("/api/clabe/validar").set(auth(t)).send({ clabe: "072123" });
    expect(corta.body.ok).toBe(false);
    expect(corta.body.errores.join(" ")).toMatch(/18 dígitos/);
    // Banco fuera del catálogo
    const raro = await request(app).post("/api/clabe/validar").set(auth(t)).send({ clabe: CLABE_DESCONOCIDO });
    expect(raro.body.ok).toBe(false);
    expect(raro.body.banco).toBeNull();
    expect(raro.body.errores.join(" ")).toMatch(/banco no reconocido/);
  });
});

describe("Catálogo maestro de cuentas", () => {
  it("nace con CLABE: auto-llena banco y número; PATCH catalogo completa campos", async () => {
    const t = await login("admin_tesoreria", "admin_tesoreria");
    const creada = await request(app)
      .post("/api/cuentas")
      .set(auth(t))
      .send({ nombre: "VERONA 6055", clabe: CLABE_BANORTE });
    expect(creada.status).toBe(201);
    expect(creada.body.cuenta.banco).toBe("BANORTE");
    expect(creada.body.cuenta.numero_cuenta).toBe("0491234567");
    expect(creada.body.cuenta.clabe).toBe(CLABE_BANORTE);
    const id = creada.body.cuenta.id as number;

    const patch = await request(app)
      .patch(`/api/cuentas/${id}/catalogo`)
      .set(auth(t))
      .send({ moneda: "MXN", origen: "JS", estatus: "ACTIVA", cliente: "VERONA", formato_reporte: "C", fecha_alta: hoy() });
    expect(patch.status).toBe(200);
    expect(patch.body.cuenta.origen).toBe("JS");
    expect(patch.body.cuenta.formato_reporte).toBe("C");

    // CLABE de otro banco sin corregir el banco → 400 (protege el catálogo).
    const conflicto = await request(app)
      .patch(`/api/cuentas/${id}/catalogo`)
      .set(auth(t))
      .send({ clabe: CLABE_SANTANDER });
    expect(conflicto.status).toBe(400);
    expect(conflicto.body.detalles.join(" ")).toMatch(/SANTANDER/);

    // CANCELADA fija fecha de baja automáticamente.
    const baja = await request(app).patch(`/api/cuentas/${id}/catalogo`).set(auth(t)).send({ estatus: "CANCELADA" });
    expect(baja.status).toBe(200);
    expect(baja.body.cuenta.fecha_baja).toBeTruthy();

    // El analista de Tesorería no edita el catálogo.
    const tTes = await login("tesoreria", "tesoreria");
    const denegado = await request(app).patch(`/api/cuentas/${id}/catalogo`).set(auth(tTes)).send({ origen: "X" });
    expect(denegado.status).toBe(403);
  });

  it("importador con dedupe: crea, actualiza por CLABE y reporta errores", async () => {
    const t = await login("admin_tesoreria", "admin_tesoreria");
    const lote = [
      "ORION JS\tSTP\t1407\t646180401200001407\tMXN\tJS\tACTIVA\tORION",
      "GALLART\tBBVA BANCOMER\t\t012180001234567890\t\tJS MTY\tACTIVA\tGALLART",
      "MALA\t\t\t072123\t\t\tACTIVA\t", // CLABE corta → error
    ];
    const primera = await request(app).post("/api/cuentas/importar-lote").set(auth(t)).send({ lineas: lote });
    expect(primera.status).toBe(201);
    expect(primera.body.creadas).toHaveLength(2);
    expect(primera.body.errores).toHaveLength(1);
    expect(primera.body.errores[0].errores.join(" ")).toMatch(/18 dígitos/);

    // Re-importar la misma CLABE → actualiza, no duplica.
    const segunda = await request(app)
      .post("/api/cuentas/importar-lote")
      .set(auth(t))
      .send({ lineas: ["ORION JS RENOMBRADA\t\t\t646180401200001407\t\t\tSUSPENDIDA\t"] });
    expect(segunda.status).toBe(201);
    expect(segunda.body.creadas).toHaveLength(0);
    expect(segunda.body.actualizadas).toHaveLength(1);
    const cuenta = db.prepare("SELECT * FROM cuentas WHERE clabe = ?").get("646180401200001407") as {
      nombre: string;
      estatus: string;
    };
    expect(cuenta.nombre).toBe("ORION JS");
    expect(cuenta.estatus).toBe("SUSPENDIDA");
  });
});

describe("Bóveda de credenciales", () => {
  async function crearCuentaConCredenciales(tAdmin: string): Promise<{ cuentaId: number; cred1: number; cred2: number }> {
    const cuenta = await request(app).post("/api/cuentas").set(auth(tAdmin)).send({ nombre: "EPLATA 1407" });
    const cuentaId = cuenta.body.cuenta.id as number;
    const c1 = await request(app)
      .post(`/api/cuentas/${cuentaId}/credenciales`)
      .set(auth(tAdmin))
      .send({ tipo: "portal", etiqueta: "ADMIN1", usuario: "admin.orion", secreto: "Secreto-Claro-123", nip: "4321" });
    expect(c1.status).toBe(201);
    const c2 = await request(app)
      .post(`/api/cuentas/${cuentaId}/credenciales`)
      .set(auth(tAdmin))
      .send({ tipo: "portal", etiqueta: "USUARIO1", usuario: "usuario.orion", secreto: "Otro-Plano-456" });
    expect(c2.status).toBe(201);
    return { cuentaId, cred1: c1.body.credencial.id as number, cred2: c2.body.credencial.id as number };
  }

  it("multi-usuario: N credenciales por cuenta, cifradas en BD, listado sin secretos", async () => {
    const t = await login("admin_tesoreria", "admin_tesoreria");
    const { cuentaId, cred1 } = await crearCuentaConCredenciales(t);

    // En la base NUNCA está el texto plano.
    const fila = db.prepare("SELECT secreto FROM cuentas_credenciales WHERE id = ?").get(cred1) as { secreto: string };
    expect(fila.secreto).not.toContain("Secreto-Claro-123");
    expect(fila.secreto.startsWith("v1:")).toBe(true);

    // El listado expone banderas, no valores.
    const lista = await request(app).get(`/api/cuentas/${cuentaId}/credenciales`).set(auth(t));
    expect(lista.status).toBe(200);
    expect(lista.body.credenciales).toHaveLength(2);
    for (const c of lista.body.credenciales) {
      expect(c.tiene_secreto).toBe(true);
      expect(JSON.stringify(c)).not.toContain("Secreto-Claro-123");
      expect(JSON.stringify(c)).not.toContain("Otro-Plano-456");
    }
  });

  it("revelar secreto queda auditado; sin permiso 403; desactivada 409", async () => {
    const tAdmin = await login("admin_tesoreria", "admin_tesoreria");
    const { cuentaId, cred1 } = await crearCuentaConCredenciales(tAdmin);

    const revelado = await request(app).get(`/api/credenciales/${cred1}/secreto?campo=secreto`).set(auth(tAdmin));
    expect(revelado.status).toBe(200);
    expect(revelado.body.valor).toBe("Secreto-Claro-123");

    const tOp = await login("operador", "operador");
    const denegadoRol = await request(app).get(`/api/credenciales/${cred1}/secreto?campo=secreto`).set(auth(tOp));
    expect(denegadoRol.status).toBe(403);

    // Analista de Tesorería SIN cuenta asignada → 403.
    const tTes = await login("tesoreria", "tesoreria");
    const sinAsignacion = await request(app).get(`/api/credenciales/${cred1}/secreto?campo=secreto`).set(auth(tTes));
    expect(sinAsignacion.status).toBe(403);

    // Con la cuenta asignada (cuentas_asignaciones) → puede revelar.
    const idTes = (db.prepare("SELECT id FROM usuarios WHERE username = 'tesoreria'").get() as { id: number }).id;
    const asignar = await request(app)
      .post(`/api/cuentas/${cuentaId}/asignar`)
      .set(auth(tAdmin))
      .send({ tesorero_id: idTes, motivo: "operación diaria" });
    expect(asignar.status).toBe(201);
    const conAsignacion = await request(app).get(`/api/credenciales/${cred1}/secreto?campo=secreto`).set(auth(tTes));
    expect(conAsignacion.status).toBe(200);
    expect(conAsignacion.body.valor).toBe("Secreto-Claro-123");

    // Auditoría de la bóveda: quién consultó qué.
    const accesos = await request(app).get(`/api/cuentas/${cuentaId}/credenciales/accesos`).set(auth(tAdmin));
    expect(accesos.status).toBe(200);
    const ver = accesos.body.accesos.filter((a: { accion: string }) => a.accion === "ver");
    expect(ver.length).toBeGreaterThanOrEqual(2); // admin + tesorero
    expect(ver.every((a: { campo: string }) => a.campo === "secreto")).toBe(true);
    // Auditoría consulta; no puede revelar.
    const tAud = await login("auditor", "auditor");
    const audVe = await request(app).get(`/api/cuentas/${cuentaId}/credenciales/accesos`).set(auth(tAud));
    expect(audVe.status).toBe(200);
    const audNo = await request(app).get(`/api/credenciales/${cred1}/secreto?campo=secreto`).set(auth(tAud));
    expect(audNo.status).toBe(403);

    // Desactivar → el secreto ya no se entrega.
    await request(app).patch(`/api/credenciales/${cred1}`).set(auth(tAdmin)).send({ activo: 0 });
    const desactivada = await request(app).get(`/api/credenciales/${cred1}/secreto?campo=secreto`).set(auth(tAdmin));
    expect(desactivada.status).toBe(409);
  });
});

describe("Altas en portales: captura por lotes y matriz alta × portal", () => {
  const LINEA_OK = { paterno: "Pérez", materno: "García", nombre: "José Ñoño", clabe: CLABE_BANORTE };
  const LINEA_SANTANDER = { paterno: "LÓPEZ", materno: "Ríos", nombre: "MARÍA JOSE", clabe: CLABE_SANTANDER };

  it("lote: normaliza nombres (sin acentos/Ñ), crea altas+portales y reporta duplicadas/errores", async () => {
    const t = await login("altas", "altas");
    const portales = await request(app).get("/api/cuentas/portales").set(auth(t));
    expect(portales.status).toBe(200);
    const portalId = portales.body.portales[0].id as number;

    const lote = await request(app)
      .post("/api/altas-bancarias/lote")
      .set(auth(t))
      .send({ lineas: [LINEA_OK, LINEA_SANTANDER, { ...LINEA_OK, nombre: "corta", clabe: "072" }], portales: [portalId] });
    expect(lote.status).toBe(201);
    expect(lote.body.creadas).toHaveLength(2);
    expect(lote.body.errores).toHaveLength(1);
    // Nombre normalizado: mayúsculas, sin acentos, Ñ→N.
    const ok = lote.body.creadas.find((c: { clabe: string }) => c.clabe === CLABE_BANORTE);
    expect(ok.beneficiario).toBe("PEREZ GARCIA JOSE NONO");
    expect(ok.banco).toBe("BANORTE");
    expect(ok.cuenta).toBe("0491234567");
    const santander = lote.body.creadas.find((c: { clabe: string }) => c.clabe === CLABE_SANTANDER);
    expect(santander.beneficiario).toBe("LOPEZ RIOS MARIA JOSE");
    expect(santander.cuenta).toHaveLength(11);

    // Duplicada: mismo banco+cuenta ya está en la cola.
    const repetido = await request(app)
      .post("/api/altas-bancarias/lote")
      .set(auth(t))
      .send({ lineas: [LINEA_OK], portales: [] });
    expect(repetido.status).toBe(201);
    expect(repetido.body.duplicadas).toHaveLength(1);
    expect(repetido.body.duplicadas[0].estado).toBe("solicitada");

    // Permisos: el operador no captura lotes.
    const tOp = await login("operador", "operador");
    const denegado = await request(app)
      .post("/api/altas-bancarias/lote")
      .set(auth(tOp))
      .send({ lineas: [LINEA_OK], portales: [] });
    expect(denegado.status).toBe(403);
  });

  it("vista tipo Excel: /altas-bancarias/matriz devuelve altas con sus portales y catálogo en una llamada", async () => {
    const t = await login("altas", "altas");
    const portales = await request(app).get("/api/cuentas/portales").set(auth(t));
    const idA = portales.body.portales[0].id as number;
    const idB = portales.body.portales[1]?.id as number;
    await request(app)
      .post("/api/altas-bancarias/lote")
      .set(auth(t))
      .send({ lineas: [LINEA_OK], portales: [idA, idB].filter(Boolean) });

    const matriz = await request(app).get("/api/altas-bancarias/matriz").set(auth(t));
    expect(matriz.status).toBe(200);
    const alta = matriz.body.altas.find(
      (a: { clabe: string }) => a.clabe === CLABE_BANORTE
    );
    expect(alta).toBeTruthy();
    expect(alta.portales.length).toBeGreaterThanOrEqual(1);
    expect(alta.portales[0].portal).toBeTruthy();
    expect(alta.portales[0].estado).toBe("pendiente");
    expect(Array.isArray(matriz.body.portales)).toBe(true);
    expect(matriz.body.portales.length).toBeGreaterThanOrEqual(1);

    // El admin (rol que antes no veía la pestaña) ahora consulta la matriz.
    const tAdmin = await login("admin", "admin");
    const matrizAdmin = await request(app).get("/api/altas-bancarias/matriz").set(auth(tAdmin));
    expect(matrizAdmin.status).toBe(200);
    expect(matrizAdmin.body.altas.length).toBeGreaterThanOrEqual(1);
  });

  it("matriz por portal: al completar todos los portales la alta queda REGISTRADA; un rechazo la regresa", async () => {
    const t = await login("altas", "altas");
    const portales = await request(app).get("/api/cuentas/portales").set(auth(t));
    const [p1, p2] = portales.body.portales as Array<{ id: number; nombre: string }>;
    const lote = await request(app)
      .post("/api/altas-bancarias/lote")
      .set(auth(t))
      .send({ lineas: [LINEA_OK], portales: [p1.id, p2.id] });
    const altaId = lote.body.creadas[0].alta_id as number;

    const matriz = await request(app).get(`/api/altas-bancarias/${altaId}/portales`).set(auth(t));
    expect(matriz.status).toBe(200);
    expect(matriz.body.portales).toHaveLength(2);
    expect(matriz.body.portales.every((p: { estado: string }) => p.estado === "pendiente")).toBe(true);

    // Primera dada de alta → la alta sigue solicitada.
    const ap1 = matriz.body.portales.find((p: { portal_cuenta_id: number }) => p.portal_cuenta_id === p1.id);
    const r1 = await request(app).post(`/api/altas-portales/${ap1.id}/estado`).set(auth(t)).send({ estado: "dada_de_alta" });
    expect(r1.status).toBe(200);
    expect(r1.body.alta.estado).toBe("solicitada");

    // Segunda → REGISTRADA.
    const ap2 = matriz.body.portales.find((p: { portal_cuenta_id: number }) => p.portal_cuenta_id === p2.id);
    const r2 = await request(app).post(`/api/altas-portales/${ap2.id}/estado`).set(auth(t)).send({ estado: "dada_de_alta" });
    expect(r2.body.alta.estado).toBe("registrada");

    // Un rechazo con motivo → la alta vuelve a SOLICITADA (Tesorería no dispersa).
    const rechazo = await request(app)
      .post(`/api/altas-portales/${ap2.id}/estado`)
      .set(auth(t))
      .send({ estado: "rechazada", motivo: "Nombre sin coincidencia con ID oficial" });
    expect(rechazo.status).toBe(200);
    expect(rechazo.body.alta.estado).toBe("solicitada");

    // Rechazar sin motivo → 400.
    const sinMotivo = await request(app).post(`/api/altas-portales/${ap2.id}/estado`).set(auth(t)).send({ estado: "rechazada" });
    expect(sinMotivo.status).toBe(400);

    // Vista por portal: las filas del portal 1 con la CLABE/cuenta listas.
    const filas = await request(app).get(`/api/altas-portales?portal_cuenta_id=${p1.id}`).set(auth(t));
    expect(filas.status).toBe(200);
    const fila = filas.body.filas.find((f: { alta_id: number }) => f.alta_id === altaId);
    expect(fila.estado_portal).toBe("dada_de_alta");
    expect(fila.clabe).toBe(CLABE_BANORTE);
    expect(fila.cuenta).toBe("0491234567");

    // Quitar el portal rechazado → vuelve a estar todo dado de alta.
    const quitar = await request(app).delete(`/api/altas-portales/${ap2.id}`).set(auth(t));
    expect(quitar.status).toBe(200);
    expect(quitar.body.alta.estado).toBe("registrada");
  });

  it("Tesorería no dispersa mientras los portales del lote están pendientes; al completarlos, paga", async () => {
    const tOp = await login("operador", "operador");
    const tAltas = await login("altas", "altas");
    const tTes = await login("tesoreria", "tesoreria");

    // Alta por lote de la cuenta que usará la dispersión.
    const portales = await request(app).get("/api/cuentas/portales").set(auth(tAltas));
    const portalId = portales.body.portales[0].id as number;
    const lote = await request(app)
      .post("/api/altas-bancarias/lote")
      .set(auth(tAltas))
      .send({ lineas: [LINEA_OK], portales: [portalId] });
    const altaId = lote.body.creadas[0].alta_id as number;

    // Flujo con una línea al banco/cuenta del lote (BANORTE 4912345678).
    const op = await request(app)
      .post("/api/operaciones")
      .set(auth(tOp))
      .send({
        tipo: "flujo",
        concepto: "Flujo con alta por lote",
        monto: 10000,
        fecha_operacion: hoy(),
        pagador: "FLUJOS",
        tipo_operacion: "FLUJOS",
        timbrar: false,
        comision_pct: 0,
        dispersiones: [{ beneficiario: "PEREZ GARCIA JOSE NONO", cuenta: "0491234567", banco: "BANORTE", importe: 10000 }],
      });
    expect(op.status).toBe(201);
    const id = op.body.operacion.id as number;

    await request(app).post(`/api/operaciones/${id}/enviar-validacion`).set(auth(tOp));
    const rev = await request(app)
      .post(`/api/operaciones/${id}/revision`)
      .set(auth(await login("validador", "validador")))
      .send({ resultado: "aprobada", comentario: "ok" });
    expect(rev.status).toBe(200);
    await request(app).post(`/api/operaciones/${id}/liberar`).set(auth(await login("fondeador", "fondeador")));

    // Portal pendiente → pago bloqueado.
    const bloqueado = await request(app)
      .post(`/api/operaciones/${id}/pago`)
      .set(auth(tTes))
      .send({ medio: "transferencia", monto: 10000, comprobante: "TRF-15" });
    expect(bloqueado.status).toBe(409);
    expect(bloqueado.body.error).toMatch(/1 cuenta\(s\) sin alta bancaria registrada/);

    // Completa el portal → alta REGISTRADA → el pago pasa.
    const matriz = await request(app).get(`/api/altas-bancarias/${altaId}/portales`).set(auth(tAltas));
    const ap = matriz.body.portales[0];
    const r = await request(app).post(`/api/altas-portales/${ap.id}/estado`).set(auth(tAltas)).send({ estado: "dada_de_alta" });
    expect(r.body.alta.estado).toBe("registrada");
    const pago = await request(app)
      .post(`/api/operaciones/${id}/pago`)
      .set(auth(tTes))
      .send({ medio: "transferencia", monto: 10000, comprobante: "TRF-16" });
    expect(pago.status).toBe(201);
    expect(pago.body.operacion.estado).toBe("pagada");
  });
});
