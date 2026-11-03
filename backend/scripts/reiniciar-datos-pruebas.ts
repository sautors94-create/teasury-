/**
 * REINICIO DE DATOS PARA PRUEBAS — Sistema de Tesorería
 *
 * Deja el sistema "como recién instalado" conservando:
 *   - Las CUENTAS de tesorería (catálogo sembrado y las que hayas creado).
 *   - Los usuarios administrativos base: admin, admin_ops, admin_validacion,
 *     admin_tesoreria, val_tesoreria y confirmador.
 *   - Los catálogos (pagadoras, pagador/tipo FLUJOS) y parámetros
 *     (umbral de Dirección).
 *
 * Elimina TODOS los registros de trabajo:
 *   operaciones, dispersiones, pagos, depósitos y sus comprobantes,
 *   financiamientos, movimientos de resguardo (clientes y brokers),
 *   movimientos bancarios del concentrado, aplicaciones de recursos,
 *   asignaciones (clientes, validación, cuentas) y coberturas,
 *   revisiones, bitácora/auditoría, clientes, brokers y colas de sync.
 *   También elimina cualquier usuario que no sea de los 6 base.
 *
 * Crea usuarios de prueba (contraseña = username):
 *   5 ejecutivos de operaciones (operador1..5), 2 validadores
 *   (validador1..2), 5 tesoreros (tesorero1..5), 2 de dirección
 *   (direccion1..2), 2 auditores (auditor1..2), 5 brokers
 *   (BROKER 01..05, 20% cada uno) y 5 clientes (CLIENTE 01..05,
 *   cada uno asignado a su ejecutivo operadorN).
 *
 * USO (desde la carpeta backend del proyecto):
 *   npx tsx scripts\reiniciar-datos-pruebas.ts             -> muestra el plan, NO hace nada
 *   npx tsx scripts\reiniciar-datos-pruebas.ts --aplicar   -> ejecuta el reinicio
 *
 * Opcional: --db "ruta\alterna.db" para otra base de datos.
 * Siempre crea primero un respaldo: data\tesoreria.db.respaldo-<fecha>.db
 */
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const aplicar = argv.includes("--aplicar");
let dbRuta = path.resolve("data", "tesoreria.db");
const iDb = argv.indexOf("--db");
if (iDb >= 0 && argv[iDb + 1]) dbRuta = path.resolve(argv[iDb + 1]);

const USUARIOS_BASE = [
  "admin",
  "admin_ops",
  "admin_validacion",
  "admin_tesoreria",
  "val_tesoreria",
  "confirmador",
];

/** Tablas de trabajo que se vacían por completo. */
const TABLAS_A_LIMPIAR = [
  "depositos_comprobantes",
  "operaciones_depositos",
  "movimientos_cuentas",
  "aplicaciones_recursos",
  "brokers_resguardos",
  "financiamientos",
  "resguardos_movimientos",
  "pagos",
  "dispersiones",
  "operaciones_brokers",
  "asignaciones_validacion",
  "cliente_coberturas",
  "cliente_asignaciones",
  "cuentas_asignaciones",
  "coberturas",
  "revisiones",
  "auditoria",
  "operaciones",
  "clientes",
  "brokers",
  "sync_registros",
  "sync_aplicados",
  "sync_envios",
];

/** [username, nombre, rol] — contraseña = username. */
const NUEVOS_USUARIOS: Array<[string, string, string]> = [
  ...Array.from({ length: 5 }, (_, i): [string, string, string] => [
    `operador${i + 1}`,
    `Ejecutivo de Operaciones ${i + 1}`,
    "operacion",
  ]),
  ...Array.from({ length: 2 }, (_, i): [string, string, string] => [
    `validador${i + 1}`,
    `Validador de Operaciones ${i + 1}`,
    "validacion",
  ]),
  ...Array.from({ length: 5 }, (_, i): [string, string, string] => [
    `tesorero${i + 1}`,
    `Tesorero ${i + 1}`,
    "tesoreria",
  ]),
  ...Array.from({ length: 2 }, (_, i): [string, string, string] => [
    `direccion${i + 1}`,
    `Dirección ${i + 1}`,
    "direccion",
  ]),
  ...Array.from({ length: 2 }, (_, i): [string, string, string] => [
    `auditor${i + 1}`,
    `Auditor ${i + 1}`,
    "auditoria",
  ]),
];

/** [nombre, porcentaje sobre la comisión total] */
const BROKERS: Array<[string, number]> = [
  ["BROKER 01", 20],
  ["BROKER 02", 20],
  ["BROKER 03", 20],
  ["BROKER 04", 20],
  ["BROKER 05", 20],
];

/** CLIENTE 01..05, el cliente N se asigna al ejecutivo operadorN. */
const CLIENTES = Array.from({ length: 5 }, (_, i) => `CLIENTE 0${i + 1}`);

function tablasExistentes(db: Database.Database): Set<string> {
  const filas = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>;
  return new Set(filas.map((f) => f.name));
}

function plan(): void {
  console.log("PLAN DE REINICIO (no se ha modificado nada)");
  console.log(`  Base de datos : ${dbRuta}`);
  console.log(`  Se vacían     : ${TABLAS_A_LIMPIAR.length} tablas de trabajo (operaciones, pagos,`);
  console.log("                  depósitos, comprobantes, financiamientos, resguardos,");
  console.log("                  concentrado bancario, asignaciones, bitácora, clientes, brokers...)");
  console.log("  Se conservan  : cuentas de tesorería, usuarios base (admin, admin_ops,");
  console.log("                  admin_validacion, admin_tesoreria, val_tesoreria, confirmador),");
  console.log("                  catálogos y parámetros.");
  console.log("  Se eliminan   : los demás usuarios (por ejemplo 'operador', 'validador',");
  console.log("                  'tesoreria', 'direccion', 'auditor' de la semilla original).");
  console.log(`  Se crean      : ${NUEVOS_USUARIOS.length} usuarios, ${BROKERS.length} brokers, ${CLIENTES.length} clientes (asignados a operador1..5).`);
  console.log("");
  console.log("Para ejecutarlo en serio:");
  console.log("  npx tsx scripts\\reiniciar-datos-pruebas.ts --aplicar");
}

function main(): void {
  if (!fs.existsSync(dbRuta)) {
    console.error(`No encontré la base de datos: ${dbRuta}`);
    console.error("Ejecuta este script desde la carpeta backend del proyecto (donde está data\\tesoreria.db),");
    console.error("o indica la ruta con:  --db \"C:\\ruta\\tesoreria.db\"");
    process.exit(1);
  }

  if (!aplicar) {
    plan();
    return;
  }

  // 1) Respaldo previo (siempre, sin excepción).
  const sello = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const respaldo = `${dbRuta}.respaldo-${sello}`;
  fs.copyFileSync(dbRuta, respaldo);
  console.log(`Respaldo creado: ${respaldo}`);

  const db = new Database(dbRuta);
  const existentes = tablasExistentes(db);
  const faltantes = TABLAS_A_LIMPIAR.filter((t) => !existentes.has(t));
  if (faltantes.length > 0) {
    console.error(`ATENCIÓN: la base no tiene estas tablas (esquema viejo?): ${faltantes.join(", ")}`);
    console.error("Actualiza primero con los entregables pendientes y vuelve a intentar.");
    db.close();
    process.exit(1);
  }

  const borrados: Record<string, number> = {};

  db.pragma("foreign_keys = OFF");
  const reiniciar = db.transaction(() => {
    // 2) Vaciar tablas de trabajo (guardando cuántas filas tenía cada una).
    for (const tabla of TABLAS_A_LIMPIAR) {
      const r = db.prepare(`DELETE FROM ${tabla}`).run();
      borrados[tabla] = Number(r.changes);
    }

    // 3) Usuarios: sólo quedan los 6 base; el resto se elimina.
    const placeholders = USUARIOS_BASE.map(() => "?").join(", ");
    const rUsuarios = db
      .prepare(`DELETE FROM usuarios WHERE username NOT IN (${placeholders})`)
      .run(...USUARIOS_BASE);
    borrados["usuarios (no base)"] = Number(rUsuarios.changes);

    // 4) Referencias a usuarios eliminados en tablas que sí se conservan.
    db.prepare(
      "UPDATE catalogos SET actualizado_por = NULL WHERE actualizado_por IS NOT NULL AND actualizado_por NOT IN (SELECT id FROM usuarios)"
    ).run();
    db.prepare(
      "UPDATE parametros SET actualizado_por = NULL WHERE actualizado_por IS NOT NULL AND actualizado_por NOT IN (SELECT id FROM usuarios)"
    ).run();

    // 5) Contadores AUTOINCREMENT en cero: el siguiente folio será OP-<año>-00001.
    if (existentes.has("sqlite_sequence")) {
      const nombres = TABLAS_A_LIMPIAR.map(() => "?").join(", ");
      db.prepare(`DELETE FROM sqlite_sequence WHERE name IN (${nombres})`).run(...TABLAS_A_LIMPIAR);
    }
    db.prepare("UPDATE sync_cursor SET ultimo_id = 0, sincronizado_en = NULL").run();

    // 6) Usuarios de prueba (contraseña = username).
    const insertarUsuario = db.prepare(
      "INSERT INTO usuarios (username, password_hash, nombre, rol) VALUES (?, ?, ?, ?)"
    );
    const ids = new Map<string, number>();
    for (const [username, nombre, rol] of NUEVOS_USUARIOS) {
      const r = insertarUsuario.run(username, bcrypt.hashSync(username, 10), nombre, rol);
      ids.set(username, Number(r.lastInsertRowid));
    }

    // 7) Brokers de prueba.
    const insertarBroker = db.prepare(
      "INSERT INTO brokers (nombre, porcentaje, activo) VALUES (?, ?, 1)"
    );
    for (const [nombre, pct] of BROKERS) insertarBroker.run(nombre, pct);

    // 8) Clientes de prueba, cada uno asignado a su ejecutivo operadorN.
    const adminOps = db.prepare("SELECT id FROM usuarios WHERE username = 'admin_ops'").get() as
      | { id: number }
      | undefined;
    if (!adminOps) throw new Error("No existe el usuario base 'admin_ops'; no puedo crear clientes.");
    const insertarCliente = db.prepare(
      "INSERT INTO clientes (nombre, rfc, contacto, notas, activo, creado_por) VALUES (?, '', '', 'Cliente de pruebas', 1, ?)"
    );
    const asignar = db.prepare(
      "INSERT INTO cliente_asignaciones (cliente_id, ejecutivo_id, motivo, asignado_por, activo) VALUES (?, ?, 'Asignación inicial (pruebas)', ?, 1)"
    );
    CLIENTES.forEach((nombre, i) => {
      const ejecutivo = ids.get(`operador${i + 1}`);
      if (!ejecutivo) throw new Error(`No encontré al ejecutivo operador${i + 1}.`);
      const r = insertarCliente.run(nombre, adminOps.id);
      asignar.run(Number(r.lastInsertRowid), ejecutivo, adminOps.id);
    });
  });
  reiniciar();
  db.pragma("foreign_keys = ON");

  // 9) Reporte.
  console.log("");
  console.log("REINICIO APLICADO. Filas eliminadas por tabla:");
  for (const [tabla, n] of Object.entries(borrados)) console.log(`  ${tabla.padEnd(28)} ${n}`);
  console.log("");
  const cuentas = db
    .prepare("SELECT tipo, COUNT(*) AS n FROM cuentas GROUP BY tipo ORDER BY tipo")
    .all() as Array<{ tipo: string; n: number }>;
  const totalCuentas = cuentas.reduce((a, c) => a + c.n, 0);
  console.log(
    `Cuentas de tesorería conservadas: ${totalCuentas}${cuentas.map((c) => ` · ${c.tipo}: ${c.n}`).join("")}`
  );
  console.log("  (sus movimientos del concentrado quedaron en cero: saldos en 0)");

  const roster = db
    .prepare(
      "SELECT username, nombre, rol FROM usuarios ORDER BY CASE rol WHEN 'admin' THEN 1 WHEN 'admin_operaciones' THEN 2 WHEN 'admin_validacion' THEN 3 WHEN 'admin_tesoreria' THEN 4 WHEN 'operacion' THEN 5 WHEN 'validacion' THEN 6 WHEN 'validador_tesoreria' THEN 7 WHEN 'confirmador' THEN 8 WHEN 'tesoreria' THEN 9 WHEN 'direccion' THEN 10 ELSE 11 END, username"
    )
    .all() as Array<{ username: string; nombre: string; rol: string }>;
  console.log("");
  console.log(`USUARIOS FINALES (${roster.length}) — contraseña = username:`);
  for (const u of roster) console.log(`  ${u.username.padEnd(18)} ${u.nombre.padEnd(30)} ${u.rol}`);
  console.log("");
  console.log("CLIENTES CREADOS (asignados a su ejecutivo):");
  const clientes = db
    .prepare(
      "SELECT c.nombre AS cliente, u.username AS ejecutivo FROM clientes c JOIN cliente_asignaciones ca ON ca.cliente_id = c.id AND ca.activo = 1 JOIN usuarios u ON u.id = ca.ejecutivo_id ORDER BY c.id"
    )
    .all() as Array<{ cliente: string; ejecutivo: string }>;
  for (const c of clientes) console.log(`  ${c.cliente.padEnd(12)} -> ${c.ejecutivo}`);
  console.log("");
  console.log("Próximos folios de operación: OP-2026-00001 en adelante.");
  console.log(`Respaldo por si necesitas volver atrás: ${respaldo}`);
  db.close();
}

main();
