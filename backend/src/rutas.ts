import { Router } from "express";
import bcrypt from "bcryptjs";
import type { Database } from "better-sqlite3";
import type { NextFunction, Request, Response } from "express";
import { autenticar, firmarToken, requiereRol } from "./auth.js";
import { UMBRAL_DIRECCION } from "./config.js";
import { cambiarEstado, ErrorDominio, registrarAuditoria } from "./dominio.js";
import { cuentaDesdeClabe, nombreCompleto, normalizarClabe, normalizarNombrePortal, validarClabe } from "./clabe.js";
import { cifrarSecreto, descifrarSecreto, estaCifrado } from "./boveda.js";
import {
  calcularFlujo,
  emitir,
  MEDIOS_PAGO,
  redondear2,
  ROLES,
  TABLAS_SYNC,
  TIPOS_CUENTA,
  TRANSICIONES,
  type CalculosFlujo,
  type EstadoOperacion,
  type Operacion,
  type Revision,
  type Rol,
} from "./db.js";

interface FilaUsuario {
  id: number;
  username: string;
  password_hash: string;
  nombre: string;
  rol: Rol;
  activo: number;
}

/**
 * Usuarios base sembrados por el sistema (db.ts → asegurarUsuariosBase): se
 * recrean en cada arranque con su contraseña inicial, así que eliminarlos no
 * sólo es inútil sino riesgoso (resurrección con password por defecto). Para
 * esos usuarios la vía correcta es desactivarlos.
 */
const USUARIOS_BASE = [
  "admin",
  "admin_ops",
  "admin_validacion",
  "admin_tesoreria",
  "val_tesoreria",
  "confirmador",
];

/**
 * Tablas y columnas que referencian usuarios(id) con FK activa
 * (db.pragma("foreign_keys = ON")). Si alguna tiene filas para el usuario,
 * la eliminación es imposible y el historial no debe perderse: se pide
 * desactivar en su lugar (bitácora y trazabilidad append-only).
 */
const REFERENCIAS_USUARIO: Array<[tabla: string, columnas: string[]]> = [
  ["auditoria", ["usuario_id"]],
  ["operaciones", ["creado_por"]],
  ["revisiones", ["revisor_id"]],
  ["pagos", ["pagado_por"]],
  ["clientes", ["creado_por"]],
  ["cliente_asignaciones", ["ejecutivo_id", "asignado_por"]],
  ["cliente_coberturas", ["ejecutivo_habitual_id", "ejecutivo_temporal_id", "asignado_por"]],
  ["asignaciones_validacion", ["validador_id", "asignado_por"]],
  ["cuentas_asignaciones", ["tesorero_id", "asignado_por"]],
  ["coberturas", ["tesorero_habitual_id", "tesorero_temporal_id", "asignado_por"]],
  ["resguardos_movimientos", ["creado_por"]],
  ["operaciones_depositos", ["indicado_por", "validado_por"]],
  ["depositos_comprobantes", ["subido_por"]],
  ["brokers_resguardos", ["creado_por"]],
  ["aplicaciones_recursos", ["aplicado_por", "liberado_por"]],
  ["movimientos_cuentas", ["creado_por", "marcado_por"]],
  ["catalogos", ["actualizado_por"]],
  ["parametros", ["actualizado_por"]],
  ["sync_aplicados", ["usuario_id"]],
];

/** Etiquetas legibles para el mensaje de bloqueo (respuesta 409). */
const ETIQUETAS_REFERENCIAS: Record<string, string> = {
  auditoria: "bitácora",
  operaciones: "operaciones capturadas",
  revisiones: "revisiones de validación",
  pagos: "pagos registrados",
  clientes: "clientes creados",
  cliente_asignaciones: "asignaciones de clientes",
  cliente_coberturas: "coberturas de clientes",
  asignaciones_validacion: "asignaciones de validación",
  cuentas_asignaciones: "asignaciones de cuentas",
  coberturas: "coberturas de cuentas",
  resguardos_movimientos: "movimientos de resguardo",
  operaciones_depositos: "depósitos indicados",
  aplicaciones_recursos: "aplicaciones de recursos",
  movimientos_cuentas: "movimientos bancarios",
  catalogos: "catálogos editados",
  parametros: "parámetros editados",
  sync_aplicados: "sincronización",
};

/** Línea de dispersión del formato FLUJO (entrada de captura/importación). */
interface LineaDispersion {
  beneficiario: string;
  razon_social: string;
  referencia: string;
  ine: string;
  numero: string;
  tarjeta: string;
  cuenta: string;
  clabe: string;
  banco: string;
  etiqueta: string;
  /** Fase 14: datos de la persona beneficiaria y del pago — TODOS OPCIONALES
   *  (el sistema no los hace obligatorios, ni en captura ni por layout). */
  nombre: string;
  apellido_paterno: string;
  apellido_materno: string;
  concepto: string;
  referencia_pago: string;
  /** Formato de Operaciones: RFC de la persona beneficiaria (opcional). */
  rfc: string;
  importe: number;
  pagadora: string;
  pagadora_cuenta_id: number | null;
}

interface DatosTanda {
  medio: string;
  monto: number;
  comprobante: string;
  fecha_pago: string;
  notas: string;
  cuenta_id: number | null;
}

const CAMPOS_TEXTO_DISPERSION: Array<[keyof Omit<LineaDispersion, "beneficiario" | "importe" | "pagadora" | "pagadora_cuenta_id">, string]> = [
  ["razon_social", "razón social"],
  ["referencia", "referencia"],
  ["ine", "INE"],
  ["numero", "número"],
  ["tarjeta", "tarjeta"],
  ["cuenta", "cuenta"],
  ["clabe", "CLABE"],
  ["banco", "banco"],
  ["etiqueta", "etiqueta"],
  // Fase 14: datos adicionales — todos OPCIONALES (sin obligatoriedad ni en
  // captura manual ni por layout, literal del requisito).
  ["nombre", "nombre"],
  ["apellido_paterno", "apellido paterno"],
  ["apellido_materno", "apellido materno"],
  ["concepto", "concepto"],
  ["referencia_pago", "referencia de pago"],
  ["rfc", "RFC"],
];

/**
 * Valida y normaliza las líneas de dispersión del formato FLUJO. La
 * comprobación del formato debe dar VERDADERO: el flujo total (suma de
 * importes) no puede exceder el monto pagado de la operación.
 */
function validarDispersiones(
  entrada: unknown,
  monto: number
): { ok: true; datos: LineaDispersion[] } | { ok: false; errores: string[] } {
  if (!Array.isArray(entrada) || entrada.length === 0) {
    return { ok: false, errores: ["al menos una línea de dispersión es requerida"] };
  }
  const errores: string[] = [];
  const datos: LineaDispersion[] = [];
  (entrada as Array<Record<string, unknown>>).forEach((fila, i) => {
    const f = i + 1;
    const linea: LineaDispersion = {
      beneficiario: "",
      razon_social: "",
      referencia: "",
      ine: "",
      numero: "",
      tarjeta: "",
      cuenta: "",
      clabe: "",
      banco: "",
      etiqueta: "",
      nombre: "",
      apellido_paterno: "",
      apellido_materno: "",
      concepto: "",
      referencia_pago: "",
      rfc: "",
      importe: 0,
      pagadora: "",
      pagadora_cuenta_id: null,
    };
    if (typeof fila?.beneficiario !== "string" || !fila.beneficiario.trim()) {
      errores.push(`dispersión ${f}: beneficiario requerido`);
    } else {
      linea.beneficiario = fila.beneficiario.trim();
    }
    const importe = typeof fila?.importe === "number" ? redondear2(fila.importe) : NaN;
    if (!Number.isFinite(importe) || importe <= 0) {
      errores.push(`dispersión ${f}: importe debe ser mayor a 0`);
    } else {
      linea.importe = importe;
    }
    for (const [campo] of CAMPOS_TEXTO_DISPERSION) {
      const valor = fila?.[campo];
      linea[campo] = typeof valor === "string" ? valor.trim() : "";
    }
    // Pagadora de la línea (Tarea 12): nombre del catálogo o "CUALQUIER <TIPO>"
    // con cuenta por determinar. La validación de la cuenta va en
    // normalizarPagadoras (necesita la base).
    linea.pagadora = typeof fila?.pagadora === "string" ? fila.pagadora.trim() : "";
    linea.pagadora_cuenta_id =
      typeof fila?.pagadora_cuenta_id === "number" && Number.isInteger(fila.pagadora_cuenta_id)
        ? (fila.pagadora_cuenta_id as number)
        : null;
    datos.push(linea);
  });
  if (errores.length) return { ok: false, errores };
  const total = redondear2(datos.reduce((s, d) => s + d.importe, 0));
  if (total > monto + 0.005) {
    return {
      ok: false,
      errores: [
        `comprobación EN CONTRA: el flujo total (${total.toFixed(2)}) excede el monto pagado (${monto.toFixed(2)}); ajusta las dispersiones`,
      ],
    };
  }
  return { ok: true, datos };
}

/** Destino (pagadora/frente) normalizado de la operación, Tarea 12. */
interface DestinoNormalizado {
  cuenta_id: number | null;
  tipo: string;
  nombre: string;
  manejo_manual: number;
}

/**
 * Tarea 12: valida los destinos (pagadoras/frentes) que el ejecutivo
 * seleccionó del catálogo de Tesorería. Cada destino es una cuenta ACTIVA del
 * catálogo (si Tesorería la sacó de operación se rechaza) o el literal
 * "CUALQUIER <tipo>" — sin cuenta concreta: Tesorería determina cuál usar.
 * `manejo_manual` marca los frentes que el negocio atenderá manualmente.
 */
function validarDestinos(
  db: Database,
  entrada: unknown
): { ok: true; datos: DestinoNormalizado[] } | { ok: false; errores: string[] } {
  if (!Array.isArray(entrada) || entrada.length === 0)
    return { ok: false, errores: ["selecciona al menos una pagadora del catálogo de Tesorería"] };
  if (entrada.length > 30) return { ok: false, errores: ["máximo 30 pagadoras por operación"] };
  const errores: string[] = [];
  const datos: DestinoNormalizado[] = [];
  const vistas = new Set<string>();
  (entrada as Array<Record<string, unknown>>).forEach((fila, i) => {
    const f = i + 1;
    const manual = fila?.manejo_manual === true || fila?.manejo_manual === 1 ? 1 : 0;
    if (fila?.cuenta_id !== undefined && fila?.cuenta_id !== null) {
      if (!Number.isInteger(fila.cuenta_id)) {
        errores.push(`destino ${f}: cuenta_id inválido`);
        return;
      }
      const cuenta = db
        .prepare("SELECT id, nombre, tipo, activa FROM cuentas WHERE id = ?")
        .get(fila.cuenta_id) as { id: number; nombre: string; tipo: string; activa: number } | undefined;
      if (!cuenta) {
        errores.push(`destino ${f}: la cuenta ${fila.cuenta_id} no existe en el catálogo de Tesorería`);
        return;
      }
      if (!cuenta.activa) {
        errores.push(
          `destino ${f}: la cuenta '${cuenta.nombre}' está fuera de operación (bloqueada o inactiva); descarga el layout actualizado`
        );
        return;
      }
      const clave = `c${cuenta.id}`;
      if (!vistas.has(clave)) {
        vistas.add(clave);
        datos.push({ cuenta_id: cuenta.id, tipo: cuenta.tipo, nombre: cuenta.nombre, manejo_manual: manual });
      }
      return;
    }
    // Sin cuenta concreta: "CUALQUIER <tipo>" (Tesorería determina la cuenta).
    const tipo = typeof fila?.tipo === "string" ? fila.tipo.trim().toLowerCase() : "";
    if (!(TIPOS_CUENTA as readonly string[]).includes(tipo)) {
      errores.push(
        `destino ${f}: indica una cuenta del catálogo o un tipo válido (${TIPOS_CUENTA.join(" | ")})`
      );
      return;
    }
    const clave = `t${tipo}`;
    if (!vistas.has(clave)) {
      vistas.add(clave);
      datos.push({ cuenta_id: null, tipo, nombre: `CUALQUIER ${tipo.toUpperCase()}`, manejo_manual: manual });
    }
  });
  if (errores.length) return { ok: false, errores };
  if (datos.length === 0)
    return { ok: false, errores: ["selecciona al menos una pagadora del catálogo de Tesorería"] };
  return { ok: true, datos };
}

/**
 * Tarea 12: valida las pagadoras indicadas por línea de dispersión. Si traen
 * cuenta concreta debe existir y estar activa (y se completa el nombre si
 * vino vacío); si sólo traen texto se conserva como orientación para
 * Tesorería ("CUALQUIER FLUJO", nombre del catálogo, etc.).
 */
function normalizarPagadoras(
  db: Database,
  lineas: LineaDispersion[]
): { ok: true; datos: LineaDispersion[] } | { ok: false; errores: string[] } {
  const errores: string[] = [];
  const datos = lineas.map((l, i) => {
    const linea = { ...l };
    if (linea.pagadora_cuenta_id !== null) {
      const cuenta = db
        .prepare("SELECT id, nombre, tipo, activa FROM cuentas WHERE id = ?")
        .get(linea.pagadora_cuenta_id) as
        | { id: number; nombre: string; tipo: string; activa: number }
        | undefined;
      if (!cuenta) {
        errores.push(`dispersión ${i + 1}: la pagadora ${linea.pagadora_cuenta_id} no existe en el catálogo`);
      } else if (!cuenta.activa) {
        errores.push(
          `dispersión ${i + 1}: la pagadora '${cuenta.nombre}' está fuera de operación (bloqueada o inactiva)`
        );
      }
      if (!linea.pagadora) linea.pagadora = cuenta?.nombre ?? "";
    }
    return linea;
  });
  if (errores.length) return { ok: false, errores };
  return { ok: true, datos };
}

/**
 * Fase 13: normaliza la moneda de una operación/movimiento. Sin valor se
 * devuelve null (el llamador aplica su default, normalmente 'MXN'); con valor
 * debe ser un código alfabético de 3 letras (MXN, USD, GBP, JPY, …) y se
 * devuelve en mayúsculas. Cadena vacía = inválida.
 */
function normalizarMoneda(valor: unknown): string | null {
  if (valor === undefined || valor === null || (typeof valor === "string" && !valor.trim())) return null;
  if (typeof valor !== "string") return "";
  const m = valor.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(m) ? m : "";
}

export function crearRouter(db: Database): Router {
  const r = Router();

  /**
   * Exige que el usuario de la sesión siga activo en la base. Se aplica en las
   * rutas de escritura críticas para que una desactivación surta efecto de
   * inmediato (no sólo al revalidar el token de 12 h).
   */
  const usuarioVivo = (req: Request, res: Response, next: NextFunction): void => {
    const fila = db
      .prepare("SELECT activo FROM usuarios WHERE id = ?")
      .get(req.usuario!.id) as { activo: number } | undefined;
    if (!fila || fila.activo !== 1) {
      res.status(403).json({ error: "Usuario desactivado: sesión no válida" });
      return;
    }
    next();
  };

  r.get("/salud", (_req, res) => {
    res.json({ ok: true, servicio: "teasury-backend", version: "0.2.0" });
  });

  // ---- Catálogos ----
  r.get("/catalogos", autenticar, (_req, res) => {
    res.json({
      estados: Object.entries(TRANSICIONES).map(([estado, permitidas]) => ({ estado, permitidas })),
      tipos: ["pago", "cobro", "financiamiento", "flujo", "pago_especial"],
      roles: ROLES,
      umbral_direccion: leerUmbralDireccion(db),
    });
  });

  // ---- Brokers (catálogo de intermediarios de comisión, formato FLUJO) ----
  r.get("/brokers", autenticar, (req, res) => {
    const filas =
      req.query.todos === "1"
        ? db.prepare("SELECT * FROM brokers ORDER BY nombre").all()
        : db.prepare("SELECT * FROM brokers WHERE activo = 1 ORDER BY nombre").all();
    res.json({ brokers: filas });
  });

  r.post("/brokers", autenticar, usuarioVivo, requiereRol("admin_operaciones", "admin"), (req, res) => {
    const { nombre, porcentaje } = req.body ?? {};
    if (typeof nombre !== "string" || !nombre.trim()) {
      res.status(400).json({ error: "nombre requerido" });
      return;
    }
    const pct = typeof porcentaje === "number" ? porcentaje : 0;
    if (!(pct >= 0 && pct <= 100)) {
      res.status(400).json({ error: "porcentaje debe estar entre 0 y 100" });
      return;
    }
    const dup = db.prepare("SELECT id FROM brokers WHERE nombre = ?").get(nombre.trim());
    if (dup) {
      res.status(409).json({ error: `Ya existe un broker '${nombre.trim()}'` });
      return;
    }
    const raiz = db
      .prepare("INSERT INTO brokers (nombre, porcentaje) VALUES (?, ?)")
      .run(nombre.trim(), pct);
    registrarAuditoria(
      db,
      req.usuario!.id,
      "broker_creado",
      `Alta del broker '${nombre.trim()}' (${pct.toFixed(2)}% de la comisión)`
    );
    res.status(201).json({ broker: db.prepare("SELECT * FROM brokers WHERE id = ?").get(raiz.lastInsertRowid) });
  });

  r.patch("/brokers/:id", autenticar, usuarioVivo, requiereRol("admin_operaciones", "admin"), (req, res) => {
    const fila = db.prepare("SELECT * FROM brokers WHERE id = ?").get(Number(req.params.id)) as
      | { id: number; nombre: string; porcentaje: number; activo: number }
      | undefined;
    if (!fila) {
      res.status(404).json({ error: "Broker no encontrado" });
      return;
    }
    const { nombre, porcentaje, activo } = req.body ?? {};
    if (typeof nombre !== "string" && typeof porcentaje !== "number" && typeof activo !== "boolean") {
      res.status(400).json({ error: "Envía 'nombre' (texto), 'porcentaje' (número) o 'activo' (true/false)" });
      return;
    }
    if (typeof porcentaje === "number" && !(porcentaje >= 0 && porcentaje <= 100)) {
      res.status(400).json({ error: "porcentaje debe estar entre 0 y 100" });
      return;
    }
    const nuevoNombre = typeof nombre === "string" && nombre.trim() ? nombre.trim() : fila.nombre;
    const nuevoPct = typeof porcentaje === "number" ? porcentaje : fila.porcentaje;
    const nuevoActivo = typeof activo === "boolean" ? (activo ? 1 : 0) : fila.activo;
    db.prepare("UPDATE brokers SET nombre = ?, porcentaje = ?, activo = ? WHERE id = ?").run(
      nuevoNombre,
      nuevoPct,
      nuevoActivo,
      fila.id
    );
    registrarAuditoria(
      db,
      req.usuario!.id,
      "broker_actualizado",
      `Broker '${fila.nombre}' (${fila.porcentaje.toFixed(2)}%, ${fila.activo ? "activo" : "inactivo"}) → '${nuevoNombre}' (${nuevoPct.toFixed(2)}%, ${nuevoActivo ? "activo" : "inactivo"})`
    );
    res.json({ broker: db.prepare("SELECT * FROM brokers WHERE id = ?").get(fila.id) });
  });

  // ---- Autenticación ----
  // ---- Resguardos de brokers (comisiones cobradas) ----
  // Cuando una operación queda PAGADA, la comisión de cada broker participante
  // entra a su resguardo (hook en registrarTanda); aquí se consulta y se
  // registran los retiros (pagos de comisiones al broker).
  r.get(
    "/brokers/resguardos",
    autenticar,
    requiereRol("operacion", "admin_operaciones", "admin", "admin_tesoreria", "validador_tesoreria", "confirmador", "direccion", "auditoria"),
    (_req, res) => {
      const brokers = db.prepare("SELECT * FROM brokers ORDER BY nombre").all() as Array<{
        id: number;
        nombre: string;
        porcentaje: number;
        activo: number;
      }>;
      const resguardos = brokers.map((b) => {
        const comisiones = (
          db.prepare("SELECT COALESCE(SUM(importe), 0) AS t FROM brokers_resguardos WHERE broker_id = ? AND tipo = 'comision'").get(b.id) as { t: number }
        ).t;
        const retiros = (
          db.prepare("SELECT COALESCE(SUM(importe), 0) AS t FROM brokers_resguardos WHERE broker_id = ? AND tipo = 'retiro'").get(b.id) as { t: number }
        ).t;
        const movimientos = db
          .prepare(
            `SELECT br.*, o.folio AS folio, u.nombre AS creador
             FROM brokers_resguardos br
             LEFT JOIN operaciones o ON o.id = br.operacion_id
             JOIN usuarios u ON u.id = br.creado_por
             WHERE br.broker_id = ? ORDER BY br.id DESC LIMIT 20`
          )
          .all(b.id);
        return {
          broker_id: b.id,
          nombre: b.nombre,
          porcentaje: b.porcentaje,
          activo: b.activo,
          comisiones: redondear2(comisiones),
          retiros: redondear2(retiros),
          saldo: redondear2(comisiones - retiros),
          movimientos,
        };
      });
      res.json({ resguardos });
    }
  );

  r.post(
    "/brokers/:id/retiros",
    autenticar,
    usuarioVivo,
    requiereRol("admin_operaciones", "admin", "admin_tesoreria"),
    (req, res) => {
      const broker = db.prepare("SELECT * FROM brokers WHERE id = ?").get(Number(req.params.id)) as
        | { id: number; nombre: string }
        | undefined;
      if (!broker) {
        res.status(404).json({ error: "Broker no encontrado" });
        return;
      }
      const { monto, notas } = req.body ?? {};
      const montoNum = typeof monto === "number" ? redondear2(monto) : NaN;
      if (!Number.isFinite(montoNum) || montoNum <= 0) {
        res.status(400).json({ error: "monto debe ser mayor a 0" });
        return;
      }
      const comisiones = (
        db.prepare("SELECT COALESCE(SUM(importe), 0) AS t FROM brokers_resguardos WHERE broker_id = ? AND tipo = 'comision'").get(broker.id) as { t: number }
      ).t;
      const retiros = (
        db.prepare("SELECT COALESCE(SUM(importe), 0) AS t FROM brokers_resguardos WHERE broker_id = ? AND tipo = 'retiro'").get(broker.id) as { t: number }
      ).t;
      const saldo = redondear2(comisiones - retiros);
      if (montoNum > saldo + 0.005) {
        res.status(409).json({ error: `Retiro de ${montoNum.toFixed(2)} excede el resguardo del broker (saldo ${saldo.toFixed(2)})`, saldo });
        return;
      }
      const raiz = db
        .prepare("INSERT INTO brokers_resguardos (broker_id, tipo, importe, operacion_id, notas, creado_por) VALUES (?, 'retiro', ?, NULL, ?, ?)")
        .run(broker.id, montoNum, typeof notas === "string" ? notas.trim() : "", req.usuario!.id);
      registrarAuditoria(
        db,
        req.usuario!.id,
        "broker_retiro",
        `Retiro de ${montoNum.toFixed(2)} del resguardo del broker '${broker.nombre}'${notas ? `: ${String(notas).trim()}` : ""}`
      );
      res.status(201).json({
        retiro: db.prepare("SELECT * FROM brokers_resguardos WHERE id = ?").get(raiz.lastInsertRowid),
        saldo: redondear2(saldo - montoNum),
      });
    }
  );

  // ---- Resguardo de TRF (la empresa, Fase 13) ----
  // Ledger append-only de ingresos y retiros de la empresa, en la moneda en
  // que ocurren. Los movimientos en moneda distinta de MXN guardan el TIPO DE
  // CAMBIO que aplicó el banco en la operación, para que los resguardos
  // cuadren: equivalente en pesos = importe × tipo_cambio. El saldo nunca se
  // guarda: se calcula por moneda como suma de movimientos (§14).
  // Ajuste del negocio: el EJECUTIVO de Operaciones ya NO ve el resguardo de
  // TRF (ni el ledger ni su detalle): el resguardo se modifica sólo al
  // registrar operaciones desde él y se aplica al AUTORIZARSE.
  const ROLES_LECTURA_TRF = [
    "admin",
    "admin_tesoreria",
    "validador_tesoreria",
    "tesoreria",
    "fondeador",
    "confirmador",
    "admin_operaciones",
    "direccion",
    "auditoria",
  ] as const;

  r.get("/trf/resguardo", autenticar, requiereRol(...ROLES_LECTURA_TRF), (_req, res) => {
    const movimientos = db
      .prepare(
        `SELECT t.*, u.nombre AS creador, o.folio AS folio
         FROM trf_resguardos_movimientos t
         JOIN usuarios u ON u.id = t.creado_por
         LEFT JOIN operaciones o ON o.id = t.operacion_id
         ORDER BY t.id DESC LIMIT 300`
      )
      .all() as Array<{
      id: number;
      tipo: "ingreso" | "retiro";
      importe: number;
      moneda: string;
      tipo_cambio: number | null;
      operacion_id: number | null;
      notas: string;
      creado_por: number;
      creado_en: string;
      creador: string;
      folio: string | null;
    }>;
    const equivalente = (m: { importe: number; moneda: string; tipo_cambio: number | null }): number =>
      m.moneda === "MXN" ? m.importe : redondear2(m.importe * (m.tipo_cambio ?? 0));
    // Saldo por moneda + equivalente en pesos de ese saldo (compartido con
    // /trf/resguardo/saldo).
    const saldos = saldoPorMonedaTrf(db);
    const equivalenteTotal = redondear2(saldos.reduce((s, x) => s + x.equivalente_mxn, 0));
    res.json({
      movimientos: movimientos.map((m) => ({ ...m, equivalente_mxn: equivalente(m) })),
      saldos,
      equivalente_total_mxn: equivalenteTotal,
    });
  });

  // Saldo del resguardo de TRF SIN el ledger (sin movimientos): lo necesita la
  // captura del PAGO ESPECIAL para elegir el resguardo de origen, pero el
  // detalle del resguardo ya no es visible para quien captura (rol operacion).
  r.get("/trf/resguardo/saldo", autenticar, requiereRol("operacion", "admin_operaciones", "admin"), (_req, res) => {
    const saldos = saldoPorMonedaTrf(db);
    res.json({ saldos, equivalente_total_mxn: redondear2(saldos.reduce((s, x) => s + x.equivalente_mxn, 0)) });
  });

  // Ajuste del negocio: el resguardo de TRF se modifica SÓLO al registrar
  // operaciones desde él (pago especial con origen TRF y comisión TRF de los
  // flujos), aplicándose AL AUTORIZARSE. Los ejecutivos ni lo ven ni lo
  // mueven; los movimientos manuales son correcciones exclusivas del admin.
  r.post("/trf/resguardo", autenticar, usuarioVivo, requiereRol("admin"), (req, res) => {
    const { tipo, importe, moneda, tipo_cambio, operacion_id, notas } = req.body ?? {};
    if (tipo !== "ingreso" && tipo !== "retiro") {
      res.status(400).json({ error: "tipo debe ser 'ingreso' o 'retiro'" });
      return;
    }
    const monto = typeof importe === "number" ? redondear2(importe) : NaN;
    if (!Number.isFinite(monto) || monto <= 0) {
      res.status(400).json({ error: "importe debe ser mayor a 0" });
      return;
    }
    const monedaNorm = normalizarMoneda(moneda) ?? "MXN";
    if (!monedaNorm) {
      res.status(400).json({ error: "moneda inválida: usa un código de 3 letras (MXN, USD, GBP, JPY, …)" });
      return;
    }
    // El tipo de cambio que dio el banco es OBLIGATORIO en moneda distinta de
    // MXN (es el registro que hace cuadrar el resguardo contra pesos).
    let tc: number | null = null;
    if (monedaNorm !== "MXN") {
      if (typeof tipo_cambio !== "number" || !(tipo_cambio > 0) || !Number.isFinite(tipo_cambio)) {
        res
          .status(400)
          .json({ error: "tipo_cambio requerido para monedas distintas de MXN: registra el tipo de cambio que aplicó el banco" });
        return;
      }
      tc = tipo_cambio;
    } else if (typeof tipo_cambio === "number" && tipo_cambio > 0) {
      tc = tipo_cambio; // opcional en MXN (informativo)
    }
    let opId: number | null = null;
    let opFolio = "";
    if (operacion_id !== undefined && operacion_id !== null) {
      if (!Number.isInteger(operacion_id)) {
        res.status(400).json({ error: "operacion_id debe ser un entero" });
        return;
      }
      const op = db.prepare("SELECT id, folio FROM operaciones WHERE id = ?").get(operacion_id) as
        | { id: number; folio: string }
        | undefined;
      if (!op) {
        res.status(400).json({ error: `La operación ${operacion_id} no existe` });
        return;
      }
      opId = op.id;
      opFolio = op.folio;
    }
    // El retiro no puede dejar el saldo de esa moneda en negativo.
    if (tipo === "retiro") {
      const saldo = (
        db
          .prepare(
            `SELECT COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN importe ELSE -importe END), 0) AS s
             FROM trf_resguardos_movimientos WHERE moneda = ?`
          )
          .get(monedaNorm) as { s: number }
      ).s;
      if (monto > redondear2(saldo) + 0.005) {
        res.status(409).json({
          error: `Retiro de ${monto.toFixed(2)} ${monedaNorm} excede el saldo del resguardo de TRF (${redondear2(saldo).toFixed(2)} ${monedaNorm})`,
          saldo: redondear2(saldo),
        });
        return;
      }
    }
    const raiz = db
      .prepare(
        `INSERT INTO trf_resguardos_movimientos (tipo, importe, moneda, tipo_cambio, operacion_id, notas, creado_por)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(tipo, monto, monedaNorm, tc, opId, typeof notas === "string" ? notas.trim() : "", req.usuario!.id);
    registrarAuditoria(
      db,
      req.usuario!.id,
      "trf_resguardo",
      `${tipo === "ingreso" ? "Ingreso" : "Retiro"} al resguardo de TRF: ${monto.toFixed(2)} ${monedaNorm}${
        tc ? ` (tipo de cambio ${tc})` : ""
      }${opFolio ? ` — operación ${opFolio}` : ""}${notas && String(notas).trim() ? ` — ${String(notas).trim()}` : ""}`
    );
    const movimiento = db
      .prepare(
        `SELECT t.*, u.nombre AS creador, o.folio AS folio
         FROM trf_resguardos_movimientos t
         JOIN usuarios u ON u.id = t.creado_por
         LEFT JOIN operaciones o ON o.id = t.operacion_id
         WHERE t.id = ?`
      )
      .get(raiz.lastInsertRowid) as Record<string, unknown> | undefined;
    // El equivalente en pesos sale de inmediato: es el registro que hace
    // cuadrar el resguardo (para MXN es el propio importe).
    const equivalenteMxn =
      monedaNorm === "MXN" ? monto : tc ? redondear2(monto * tc) : 0;
    res.status(201).json({ movimiento: { ...(movimiento ?? {}), equivalente_mxn: equivalenteMxn } });
  });

  r.post("/auth/login", (req, res) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== "string" || typeof password !== "string") {
      res.status(400).json({ error: "username y password son requeridos" });
      return;
    }
    const u = db
      .prepare("SELECT * FROM usuarios WHERE username = ? AND activo = 1")
      .get(username) as FilaUsuario | undefined;
    if (!u || !bcrypt.compareSync(password, u.password_hash)) {
      res.status(401).json({ error: "Credenciales inválidas" });
      return;
    }
    const usuario = { id: u.id, username: u.username, nombre: u.nombre, rol: u.rol };
    res.json({ token: firmarToken(usuario), usuario });
  });

  r.get("/auth/me", autenticar, (req, res) => {
    res.json({ usuario: req.usuario });
  });

  // ---- Operaciones ----
  // Alcance por rol (01-ROLES.md §12 + Fase 12 de visibilidad):
  //   admin / admin_operaciones / admin_validacion / admin_tesoreria /
  //   validador_tesoreria / direccion / auditoria → TODAS.
  //   operacion → propias y de sus clientes asignados, con historial por día
  //               (por defecto el último mes; no puede consultar más atrás).
  //   validacion → asignadas por operación ∪ ejecutivos asignados ∪
  //                ejecutivos sin distribución (flujo simple §4.2).
  //   fondeador → por validar y ya validadas (plan de flujos de efectivo).
  //   tesoreria → sólo las liberadas por el Tesorero Fondeador.
  //   confirmador → sólo las que tienen depósitos por confirmar.
  r.get("/operaciones", autenticar, (req, res) => {
    const { estado, q } = req.query;
    const rol = req.usuario!.rol;
    const filtros: string[] = [];
    const params: unknown[] = [];
    if (rol === "operacion") {
      // Alcance §12: asignación vigente ∪ cobertura temporal vigente.
      filtros.push(
        `(o.creado_por = ? OR o.cliente_id IN (
          SELECT cliente_id FROM cliente_asignaciones WHERE ejecutivo_id = ? AND activo = 1 AND cerrado_en IS NULL
          UNION
          SELECT cliente_id FROM cliente_coberturas WHERE ejecutivo_temporal_id = ? AND activo = 1 AND (fecha_fin IS NULL OR fecha_fin >= date('now'))
        ))`
      );
      params.push(req.usuario!.id, req.usuario!.id, req.usuario!.id);
      // Historial por día: sin ?desde consulta el último mes; con ?desde puede
      // mirar hacia atrás HASTA un mes (más atrás se rechaza).
      const desde = typeof req.query.desde === "string" ? req.query.desde : "";
      const hasta = typeof req.query.hasta === "string" ? req.query.hasta : "";
      if (desde) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(desde)) {
          res.status(400).json({ error: "desde en formato YYYY-MM-DD" });
          return;
        }
        const limite = (
          db.prepare("SELECT date('now', '-31 days') AS l").get() as { l: string }
        ).l;
        if (desde < limite) {
          res.status(400).json({
            error: `Como Ejecutivo sólo puedes consultar tu historial hasta 1 mes atrás (desde ${limite})`,
          });
          return;
        }
        filtros.push("o.fecha_operacion >= ?");
        params.push(desde);
        if (hasta) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(hasta) || hasta < desde) {
            res.status(400).json({ error: "hasta en formato YYYY-MM-DD y mayor o igual a desde" });
            return;
          }
          filtros.push("o.fecha_operacion <= ?");
          params.push(hasta);
        }
      } else {
        filtros.push("o.fecha_operacion >= date('now', '-31 days')");
      }
    } else if (rol === "validacion") {
      filtros.push(
        `(
          EXISTS (SELECT 1 FROM asignaciones_validacion av
                  WHERE av.operacion_id = o.id AND av.validador_id = ? AND av.activo = 1 AND av.cerrado_en IS NULL)
          OR o.creado_por IN (SELECT ejecutivo_id FROM validacion_ejecutivos WHERE validador_id = ? AND activo = 1 AND cerrado_en IS NULL)
          OR o.creado_por NOT IN (SELECT ejecutivo_id FROM validacion_ejecutivos WHERE activo = 1 AND cerrado_en IS NULL)
        )`
      );
      params.push(req.usuario!.id, req.usuario!.id);
    } else if (rol === "fondeador") {
      // El Fondeador planifica el efectivo: ve las por validar y las ya validadas.
      filtros.push(
        "o.estado IN ('en_validacion','observada','pendiente_direccion','aprobada','en_pago','pagada')"
      );
    } else if (rol === "tesoreria") {
      // El analista de Tesorería sólo ve lo liberado por el Tesorero Fondeador.
      filtros.push("o.liberada_en IS NOT NULL");
    } else if (rol === "confirmador") {
      // El Confirmador ve sólo operaciones con depósitos por confirmar.
      filtros.push(
        "EXISTS (SELECT 1 FROM operaciones_depositos od WHERE od.operacion_id = o.id AND od.validado_por IS NULL)"
      );
    }
    if (typeof estado === "string" && estado) {
      filtros.push("estado = ?");
      params.push(estado);
    }
    if (typeof q === "string" && q.trim()) {
      filtros.push("(folio LIKE ? OR concepto LIKE ? OR proveedor LIKE ?)");
      const like = `%${q.trim()}%`;
      params.push(like, like, like);
    }
    // Fase 13 (filtros de los listados): tipo, moneda y rango de monto. Se
    // combinan con el alcance del rol y con estado/q ya existentes.
    if (typeof req.query.tipo === "string" && req.query.tipo) {
      if (!["pago", "cobro", "financiamiento", "flujo", "pago_especial"].includes(req.query.tipo)) {
        res.status(400).json({ error: "tipo inválido (pago|cobro|financiamiento|flujo|pago_especial)" });
        return;
      }
      filtros.push("o.tipo = ?");
      params.push(req.query.tipo);
    }
    if (typeof req.query.moneda === "string" && req.query.moneda) {
      const moneda = normalizarMoneda(req.query.moneda);
      if (!moneda) {
        res.status(400).json({ error: "moneda inválida (código de 3 letras, ej. MXN, USD, GBP)" });
        return;
      }
      filtros.push("o.moneda = ?");
      params.push(moneda);
    }
    if (typeof req.query.monto_min === "string" && req.query.monto_min.trim()) {
      const min = Number(req.query.monto_min);
      if (!Number.isFinite(min) || min < 0) {
        res.status(400).json({ error: "monto_min debe ser un número mayor o igual a 0" });
        return;
      }
      filtros.push("o.monto >= ?");
      params.push(min);
    }
    if (typeof req.query.monto_max === "string" && req.query.monto_max.trim()) {
      const max = Number(req.query.monto_max);
      if (!Number.isFinite(max) || max <= 0) {
        res.status(400).json({ error: "monto_max debe ser un número mayor a 0" });
        return;
      }
      filtros.push("o.monto <= ?");
      params.push(max);
    }
    const where = filtros.length ? `WHERE ${filtros.join(" AND ")}` : "";
    const filas = db
      .prepare(
        `SELECT o.*, u.nombre AS capturista, c.nombre AS cliente, lu.nombre AS liberador
         FROM operaciones o JOIN usuarios u ON u.id = o.creado_por
         LEFT JOIN clientes c ON c.id = o.cliente_id
         LEFT JOIN usuarios lu ON lu.id = o.liberada_por
         ${where} ORDER BY o.actualizado_en DESC, o.id DESC`
      )
      .all(...params);
    res.json({ operaciones: filas });
  });

  r.post("/operaciones", autenticar, usuarioVivo, requiereRol("operacion"), (req, res) => {
    const {
      tipo,
      concepto,
      proveedor,
      monto,
      moneda,
      fecha_operacion,
      cliente_id,
      pagador,
      tipo_operacion,
      timbrar,
      comision_pct,
      comision_trf_pct,
      observaciones,
      dispersiones,
      brokers,
      respaldo,
      destinos,
      // Fase 14: pago especial (formato adjunto + resguardo de origen).
      pagadora_cuenta_id,
      origen,
      formato,
    } = req.body ?? {};
    const errores: string[] = [];
    // Modo completo (formato FLUJO): tipo 'flujo' o presencia de dispersiones.
    const esFlujo = tipo === "flujo" || Array.isArray(dispersiones) || Array.isArray(brokers);
    // Fase 14: pago especial — retiro respaldado por un resguardo (TRF o broker)
    // con formato adjunto; el efectivo sale del resguardo al quedar PAGADA.
    const esPagoEspecial = tipo === "pago_especial";
    // Tarea 12: con destinos (pagadoras del catálogo de Tesorería) el pagador y
    // el tipo de operación se deducen de las cuentas seleccionadas; sin ellos
    // se conserva la captura legada por textos.
    const conDestinos = esFlujo && Array.isArray(destinos);
    if (esFlujo && tipo !== "flujo") {
      errores.push("tipo 'flujo' requerido para la captura completa (con dispersiones)");
    }
    if (!["pago", "cobro", "financiamiento", "flujo", "pago_especial"].includes(tipo))
      errores.push("tipo inválido (pago|cobro|financiamiento|flujo|pago_especial)");
    if (typeof concepto !== "string" || !concepto.trim()) errores.push("concepto requerido");
    // En formato FLUJO el proveedor se toma del pagador (o de las pagadoras
    // del catálogo) si no se envía (el formulario del negocio no captura 'proveedor').
    const proveedorTexto = typeof proveedor === "string" ? proveedor.trim() : "";
    if (
      !proveedorTexto &&
      !esPagoEspecial &&
      !(
        esFlujo &&
        (conDestinos || (typeof pagador === "string" && pagador.trim()))
      )
    )
      errores.push("proveedor requerido");
    if (typeof monto !== "number" || !(monto > 0)) errores.push("monto debe ser mayor a 0");
    if (typeof fecha_operacion !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(fecha_operacion))
      errores.push("fecha_operacion en formato YYYY-MM-DD");
    // Fase 13 (otras monedas): se acepta cualquier código de 3 letras (MXN,
    // USD, GBP, JPY, …); si no se envía queda MXN.
    const monedaNorm = normalizarMoneda(moneda);
    if (monedaNorm === "") errores.push("moneda inválida: usa un código de 3 letras (MXN, USD, GBP, JPY, EUR, …)");
    // Fase 14: el pago especial se captura en pesos (MXN): el resguardo de
    // origen se descuenta en la moneda del movimiento y así todo cuadra.
    if (esPagoEspecial && monedaNorm !== null && monedaNorm !== "MXN")
      errores.push("los pagos especiales se capturan en pesos (MXN)");
    if (esFlujo) {
      if (!conDestinos) {
        if (typeof pagador !== "string" || !pagador.trim()) errores.push("pagador requerido (formato FLUJO)");
        if (typeof tipo_operacion !== "string" || !tipo_operacion.trim())
          errores.push("tipo_operacion requerido (catálogo del negocio, ej. FLUJOS)");
      }
      // Fase 14: comision_pct se valida DESPUÉS de conocer el cliente (si no
      // se envía, se usa la comisión preestablecida del cliente).
    }
    if (errores.length) {
      res.status(400).json({ error: "Datos inválidos", detalles: errores });
      return;
    }

    // Alcance por cliente asignado (01-ROLES.md §3.2: "Crear operaciones para
    // sus clientes asignados"). El campo es opcional para no romper la
    // operación sin cliente; si se envía, debe estar activamente asignado.
    let clienteId: number | null = null;
    let clienteFila:
      | {
          id: number;
          nombre: string;
          activo: number;
          financiamiento_sin_aprobacion: number;
          financiamiento_maximo: number | null;
          comision_broker_pct: number | null;
          comision_trf_pct: number | null;
        }
      | null = null;
    if (typeof cliente_id === "number" && Number.isInteger(cliente_id)) {
      const cliente = db
        .prepare(
          "SELECT id, nombre, activo, financiamiento_sin_aprobacion, financiamiento_maximo, comision_broker_pct, comision_trf_pct FROM clientes WHERE id = ?"
        )
        .get(cliente_id) as
        | {
            id: number;
            nombre: string;
            activo: number;
            financiamiento_sin_aprobacion: number;
            financiamiento_maximo: number | null;
            comision_broker_pct: number | null;
            comision_trf_pct: number | null;
          }
        | undefined;
      if (!cliente || cliente.activo !== 1) {
        res.status(400).json({ error: "cliente_id no existe o está inactivo" });
        return;
      }
      const asignado = clienteVisibleParaEjecutivo(db, cliente_id, req.usuario!.id);
      if (!asignado) {
        res.status(403).json({ error: `El cliente '${cliente.nombre}' no está asignado a tu usuario` });
        return;
      }
      clienteId = cliente_id;
      clienteFila = cliente;
    }

    // ---- Comisiones preestablecidas del cliente (Fase 14) ----
    // admin_operaciones puede fijar al cliente su comisión de broker y la que
    // va DIRECTO al resguardo de TRF. Al capturar, si el ejecutivo no envía
    // comision_pct se usa la preestablecida del cliente (y igual para la de
    // TRF); ambas siguen siendo editables al capturar.
    let comisionPctResuelta: number | null = null;
    let comisionTrfPct: number | null = null;
    if (esFlujo) {
      if (typeof comision_pct === "number") {
        comisionPctResuelta = comision_pct;
      } else if (comision_pct === undefined || comision_pct === null) {
        comisionPctResuelta = clienteFila?.comision_broker_pct ?? null;
      }
      if (comisionPctResuelta === null || comisionPctResuelta < 0)
        errores.push("comision_pct debe ser un número mayor o igual a 0 (o el cliente debe tener comisión de broker preestablecida)");
      if (typeof comision_trf_pct === "number") {
        if (comision_trf_pct < 0 || comision_trf_pct > 100)
          errores.push("comision_trf_pct debe estar entre 0 y 100");
        else comisionTrfPct = comision_trf_pct;
      } else if (comision_trf_pct === undefined || comision_trf_pct === null) {
        comisionTrfPct = clienteFila?.comision_trf_pct ?? null;
      } else {
        errores.push("comision_trf_pct debe ser un número entre 0 y 100");
      }
    }

    // ---- Pago especial (Fase 14): pagadora, resguardo de origen y formato ----
    let pePagadora: { id: number; nombre: string } | null = null;
    let peOrigen: { tipo: "trf" | "broker"; broker_id: number | null; broker_nombre: string } | null = null;
    let peFormato: { nombre: string; mime: string; contenido: string } | null = null;
    if (esPagoEspecial) {
      if (typeof pagadora_cuenta_id !== "number" || !Number.isInteger(pagadora_cuenta_id)) {
        errores.push("pagadora_cuenta_id requerido: indica la cuenta de Tesorería que paga");
      } else {
        const cuenta = db
          .prepare("SELECT id, nombre, activa FROM cuentas WHERE id = ?")
          .get(pagadora_cuenta_id) as { id: number; nombre: string; activa: number } | undefined;
        if (!cuenta || !cuenta.activa)
          errores.push(`la pagadora ${pagadora_cuenta_id} no existe o está fuera de operación`);
        else pePagadora = { id: cuenta.id, nombre: cuenta.nombre };
      }
      const o = (origen ?? {}) as Record<string, unknown>;
      const tipoOrigen = typeof o?.tipo === "string" ? o.tipo.trim().toLowerCase() : "";
      if (tipoOrigen === "trf") {
        peOrigen = { tipo: "trf", broker_id: null, broker_nombre: "TRF (la empresa)" };
      } else if (tipoOrigen === "broker") {
        if (typeof o?.broker_id !== "number" || !Number.isInteger(o.broker_id)) {
          errores.push("origen.broker_id requerido: indica de qué broker sale el efectivo");
        } else {
          const broker = db
            .prepare("SELECT id, nombre, activo FROM brokers WHERE id = ?")
            .get(o.broker_id) as { id: number; nombre: string; activo: number } | undefined;
          if (!broker || broker.activo !== 1)
            errores.push(`el broker ${o.broker_id} no existe o está inactivo`);
          else peOrigen = { tipo: "broker", broker_id: broker.id, broker_nombre: broker.nombre };
        }
      } else {
        errores.push("origen.tipo debe ser 'trf' o 'broker': el efectivo sale de un resguardo");
      }
      const f = (formato ?? {}) as Record<string, unknown>;
      const nombreF = typeof f?.nombre === "string" ? f.nombre.trim() : "";
      const mimeF = typeof f?.mime === "string" && f.mime.trim() ? f.mime.trim() : "application/octet-stream";
      const contenidoF = typeof f?.contenido === "string" ? f.contenido.trim() : "";
      if (!nombreF || !contenidoF) {
        errores.push("formato requerido: adjunta el formato del pago (p.ej. SAT) con nombre y contenido");
      } else if (contenidoF.length > 12_000_000) {
        errores.push("formato demasiado grande: máximo ~9 MB por archivo");
      } else {
        peFormato = { nombre: nombreF, mime: mimeF, contenido: contenidoF };
      }
    }
    // Segunda barrera de errores: comisiones preestablecidas y pago especial
    // se validan después de la primera, así que se revisan aquí.
    if (errores.length) {
      res.status(400).json({ error: "Datos inválidos", detalles: errores });
      return;
    }

    // Validaciones del formato FLUJO (dispersiones y brokers con el monto ya
    // conocido; la comprobación debe dar VERDADERO).
    let lineas: LineaDispersion[] = [];
    let brokersOp: Array<{ broker_id: number; nombre: string; porcentaje: number; monto: number }> = [];
    if (esFlujo) {
      const vd = validarDispersiones(dispersiones, monto as number);
      if (!vd.ok) {
        res.status(400).json({ error: "Dispersiones inválidas", detalles: vd.errores });
        return;
      }
      lineas = vd.datos;
      const vb = validarBrokers(db, brokers);
      if (!vb.ok) {
        res.status(400).json({ error: "Brokers inválidos", detalles: vb.errores });
        return;
      }
      const comisionTotal = redondear2(((monto as number) * (comisionPctResuelta as number)) / 100);
      brokersOp = vb.datos.map((b) => ({
        ...b,
        monto: redondear2((comisionTotal * b.porcentaje) / 100),
      }));
      // Pagadoras por línea (Tarea 12): si traen cuenta concreta, debe existir
      // y estar activa en el catálogo de Tesorería.
      const vp = normalizarPagadoras(db, lineas);
      if (!vp.ok) {
        res.status(400).json({ error: "Pagadoras inválidas", detalles: vp.errores });
        return;
      }
      lineas = vp.datos;
    }

    // ---- Destinos de la operación (Tarea 12): pagadoras/frentes del catálogo
    // de Tesorería, con marca de manejo manual. Una operación puede combinar
    // asimilados, flujos, rendimientos, frentes, etc.
    let destinosOp: DestinoNormalizado[] = [];
    if (conDestinos) {
      const vd2 = validarDestinos(db, destinos);
      if (!vd2.ok) {
        res.status(400).json({ error: "Destinos inválidos", detalles: vd2.errores });
        return;
      }
      destinosOp = vd2.datos;
    }

    // ---- Respaldo de la operación (depósitos y/o financiamiento, §6.1) ----
    // Con cliente asignado, el Flujo Total debe quedar respaldado por el saldo
    // de resguardo del cliente + los depósitos indicados en la captura + el
    // financiamiento solicitado. Sin cliente no hay resguardo: no aplica.
    const depositosEntrada: Array<{
      cuenta_id: number;
      monto: number;
      comprobante: string;
      fecha_deposito: string;
    }> = [];
    let financiamientoEntrada: { monto: number; notas: string } | null = null;
    const erroresRespaldo: string[] = [];
    if (esFlujo && typeof respaldo === "object" && respaldo !== null) {
      const r = respaldo as Record<string, unknown>;
      if (Array.isArray(r.depositos)) {
        if ((r.depositos as unknown[]).length > 20) erroresRespaldo.push("respaldo.depositos: máximo 20 depósitos");
        for (const [i, filaRaw] of (r.depositos as Array<Record<string, unknown>>).entries()) {
          const n = i + 1;
          if (!Number.isInteger(filaRaw?.cuenta_id)) {
            erroresRespaldo.push(`respaldo.depositos[${n}]: cuenta_id requerido`);
            continue;
          }
          const montoDep = typeof filaRaw?.monto === "number" ? redondear2(filaRaw.monto) : NaN;
          if (!Number.isFinite(montoDep) || montoDep <= 0) {
            erroresRespaldo.push(`respaldo.depositos[${n}]: monto debe ser mayor a 0`);
            continue;
          }
          const comp = typeof filaRaw?.comprobante === "string" ? filaRaw.comprobante.trim() : "";
          if (!comp) {
            erroresRespaldo.push(`respaldo.depositos[${n}]: comprobante requerido`);
            continue;
          }
          const fechaDep =
            typeof filaRaw?.fecha_deposito === "string" && /^\d{4}-\d{2}-\d{2}$/.test(filaRaw.fecha_deposito)
              ? filaRaw.fecha_deposito
              : (fecha_operacion as string);
          depositosEntrada.push({
            cuenta_id: filaRaw.cuenta_id as number,
            monto: montoDep,
            comprobante: comp,
            fecha_deposito: fechaDep,
          });
        }
      }
      if (r.financiamiento !== undefined && r.financiamiento !== null) {
        const f = r.financiamiento as Record<string, unknown>;
        const montoFin = typeof f?.monto === "number" ? redondear2(f.monto) : NaN;
        if (!Number.isFinite(montoFin) || montoFin <= 0) {
          erroresRespaldo.push("respaldo.financiamiento: monto debe ser mayor a 0");
        } else {
          financiamientoEntrada = { monto: montoFin, notas: typeof f?.notas === "string" ? f.notas.trim() : "" };
        }
      }
    }
    if (esFlujo && clienteId === null && (depositosEntrada.length || financiamientoEntrada)) {
      erroresRespaldo.push("el respaldo (depósitos / financiamiento) requiere cliente: el resguardo es por cliente");
    }
    if (erroresRespaldo.length) {
      res.status(400).json({ error: "Respaldo inválido", detalles: erroresRespaldo });
      return;
    }
    // Cuentas de los depósitos indicados: deben existir y estar activas.
    if (depositosEntrada.length) {
      for (const d of depositosEntrada) {
        const cuenta = db.prepare("SELECT id, activa FROM cuentas WHERE id = ?").get(d.cuenta_id) as
          | { id: number; activa: number }
          | undefined;
        if (!cuenta || !cuenta.activa) {
          res.status(400).json({ error: `respaldo.depositos: la cuenta ${d.cuenta_id} no existe o está inactiva` });
          return;
        }
      }
    }
    // Regla de respaldo (captura): saldo + depósitos indicados + financiamiento
    // debe cubrir el Flujo Total (lo que se dispersará).
    if (esFlujo && clienteId !== null) {
      const flujoNuevo = redondear2(lineas.reduce((s, l) => s + l.importe, 0));
      const saldoPrevio = saldoResguardo(db, clienteId);
      const totalDep = redondear2(depositosEntrada.reduce((s, d) => s + d.monto, 0));
      const totalFin = financiamientoEntrada ? financiamientoEntrada.monto : 0;
      const disponible = redondear2(saldoPrevio + totalDep + totalFin);
      const faltante = redondear2(flujoNuevo - disponible);
      if (faltante > 0.005) {
        res.status(400).json({
          error: `Respaldo insuficiente: disponible $${disponible.toFixed(2)} (saldo $${saldoPrevio.toFixed(2)} + depósitos $${totalDep.toFixed(2)} + financiamiento $${totalFin.toFixed(2)}) frente a un flujo total de $${flujoNuevo.toFixed(2)}. Agrega depósitos o un financiamiento por al menos $${faltante.toFixed(2)}.`,
          respaldo: {
            saldo_resguardo: saldoPrevio,
            depositos: totalDep,
            financiamiento: totalFin,
            disponible,
            requerido: flujoNuevo,
            faltante,
          },
        });
        return;
      }
    }

    // Pago especial (Fase 14): el resguardo de origen debe tener DEPÓSITO
    // suficiente ("debe de tener un depósito"): si el saldo no cubre el
    // importe, el pago especial no se captura.
    if (esPagoEspecial && peOrigen) {
      const importePE = redondear2(monto as number);
      if (peOrigen.tipo === "trf") {
        const saldoTrf = (
          db
            .prepare(
              "SELECT COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN importe ELSE -importe END), 0) AS s FROM trf_resguardos_movimientos WHERE moneda = 'MXN'"
            )
            .get() as { s: number }
        ).s;
        if (importePE > redondear2(saldoTrf) + 0.005) {
          res.status(409).json({
            error: `El resguardo de TRF no tiene depósito suficiente: saldo ${redondear2(saldoTrf).toFixed(2)} MXN frente a un pago especial de ${importePE.toFixed(2)} MXN`,
            saldo: redondear2(saldoTrf),
          });
          return;
        }
      } else if (peOrigen.broker_id !== null) {
        const comisiones = (
          db
            .prepare("SELECT COALESCE(SUM(importe), 0) AS t FROM brokers_resguardos WHERE broker_id = ? AND tipo = 'comision'")
            .get(peOrigen.broker_id) as { t: number }
        ).t;
        const retiros = (
          db
            .prepare("SELECT COALESCE(SUM(importe), 0) AS t FROM brokers_resguardos WHERE broker_id = ? AND tipo = 'retiro'")
            .get(peOrigen.broker_id) as { t: number }
        ).t;
        const saldoBroker = redondear2(comisiones - retiros);
        if (importePE > saldoBroker + 0.005) {
          res.status(409).json({
            error: `El resguardo del broker ${peOrigen.broker_nombre} no tiene depósito suficiente: saldo ${saldoBroker.toFixed(2)} MXN frente a un pago especial de ${importePE.toFixed(2)} MXN`,
            saldo: saldoBroker,
          });
          return;
        }
      }
    }

    const correlativo = (db.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS n FROM operaciones").get() as { n: number }).n;
    const folio = `OP-${new Date().getFullYear()}-${String(correlativo).padStart(5, "0")}`;
    // Tarea 12: con destinos, pagador y tipo de operación se rellenan desde el
    // catálogo (nombres de las cuentas / tipos únicos seleccionados).
    const pagadorFinal = esFlujo
      ? typeof pagador === "string" && pagador.trim()
        ? pagador.trim()
        : destinosOp.map((d) => d.nombre).join(", ")
      : "";
    const tipoOperacionFinal = esFlujo
      ? typeof tipo_operacion === "string" && tipo_operacion.trim()
        ? tipo_operacion.trim()
        : Array.from(new Set(destinosOp.map((d) => d.tipo))).join(", ")
      : "";
    const proveedorFinal = proveedorTexto || pagadorFinal || (esPagoEspecial && pePagadora ? pePagadora.nombre : "");
    const opId = db.transaction(() => {
      const resultado = db
        .prepare(
          `INSERT INTO operaciones (folio, tipo, concepto, proveedor, monto, moneda, fecha_operacion, cliente_id, pagador, tipo_operacion, timbrar, comision_pct, comision_trf_pct, observaciones, creado_por)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          folio,
          tipo,
          concepto.trim(),
          proveedorFinal,
          monto,
          monedaNorm ?? "MXN",
          fecha_operacion,
          clienteId,
          pagadorFinal,
          tipoOperacionFinal,
          esFlujo && timbrar === true ? 1 : 0,
          esFlujo ? (comisionPctResuelta as number) : 0,
          esFlujo ? comisionTrfPct : null,
          esFlujo && typeof observaciones === "string" ? observaciones.trim() : "",
          req.usuario!.id
        );
      const nuevoId = Number(resultado.lastInsertRowid);
      if (esFlujo) {
        const insDisp = db.prepare(
          `INSERT INTO dispersiones (operacion_id, orden, beneficiario, razon_social, referencia, ine, numero, tarjeta, cuenta, clabe, banco, etiqueta, nombre, apellido_paterno, apellido_materno, concepto, referencia_pago, rfc, importe, pagadora, pagadora_cuenta_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        lineas.forEach((l, i) =>
          insDisp.run(nuevoId, i + 1, l.beneficiario, l.razon_social, l.referencia, l.ine, l.numero, l.tarjeta, l.cuenta, l.clabe, l.banco, l.etiqueta, l.nombre, l.apellido_paterno, l.apellido_materno, l.concepto, l.referencia_pago, l.rfc, l.importe, l.pagadora, l.pagadora_cuenta_id)
        );
        const insBroker = db.prepare(
          "INSERT INTO operaciones_brokers (operacion_id, broker_id, nombre, porcentaje, monto) VALUES (?, ?, ?, ?, ?)"
        );
        for (const b of brokersOp) insBroker.run(nuevoId, b.broker_id, b.nombre, b.porcentaje, b.monto);
        // Destinos (Tarea 12): pagadoras/frentes seleccionados del catálogo.
        const insDest = db.prepare(
          "INSERT INTO operaciones_destinos (operacion_id, cuenta_id, tipo, nombre, manejo_manual) VALUES (?, ?, ?, ?, ?)"
        );
        for (const d of destinosOp) insDest.run(nuevoId, d.cuenta_id, d.tipo, d.nombre, d.manejo_manual);
      }
      // Pago especial (Fase 14): fotografía del formato adjunto y del resguardo
      // de origen; al quedar PAGADA la operación se descuenta del resguardo.
      if (esPagoEspecial && pePagadora && peOrigen && peFormato) {
        db.prepare(
          `INSERT INTO pagos_especiales (operacion_id, descripcion, pagadora_cuenta_id, pagadora, resguardo_origen, broker_origen_id, broker_origen, formato_nombre, formato_mime, formato_contenido, creado_por)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          nuevoId,
          concepto.trim(),
          pePagadora.id,
          pePagadora.nombre,
          peOrigen.tipo,
          peOrigen.broker_id,
          peOrigen.broker_nombre,
          peFormato.nombre,
          peFormato.mime,
          peFormato.contenido,
          req.usuario!.id
        );
      }
      // Respaldo: depósitos indicados (pendientes de validación de Tesorería).
      if (depositosEntrada.length) {
        const insDep = db.prepare(
          `INSERT INTO operaciones_depositos (operacion_id, cuenta_id, monto, comprobante, fecha_deposito, indicado_por)
           VALUES (?, ?, ?, ?, ?, ?)`
        );
        for (const d of depositosEntrada) {
          insDep.run(nuevoId, d.cuenta_id, d.monto, d.comprobante, d.fecha_deposito, req.usuario!.id);
        }
      }
      // Financiamiento: la política del cliente decide si va a aprobación de
      // Dirección o entra automático (exención / monto máximo, §6.1). Al
      // aprobarse — automático o por Dirección — ingresa al resguardo.
      if (financiamientoEntrada && clienteFila) {
        const politica = politicaFinanciamiento(clienteFila, financiamientoEntrada.monto);
        const raizFin = db
          .prepare(
            `INSERT INTO financiamientos (operacion_id, cliente_id, monto, notas, estado, requiere_aprobacion, exento_motivo, solicitado_por)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            nuevoId,
            clienteFila.id,
            financiamientoEntrada.monto,
            financiamientoEntrada.notas,
            politica.requiereAprobacion ? "solicitado" : "aprobado",
            politica.requiereAprobacion ? 1 : 0,
            politica.exentoMotivo,
            req.usuario!.id
          );
        if (!politica.requiereAprobacion) {
          const movId = db
            .prepare(
              `INSERT INTO resguardos_movimientos (cliente_id, tipo, importe, operacion_id, comprobante, observaciones, creado_por)
               VALUES (?, 'financiamiento', ?, ?, 'FINANCIAMIENTO', ?, ?)`
            )
            .run(
              clienteFila.id,
              financiamientoEntrada.monto,
              nuevoId,
              `Financiamiento aprobado por política del cliente (${politica.exentoMotivo})`,
              req.usuario!.id
            ).lastInsertRowid;
          db.prepare("UPDATE financiamientos SET movimiento_id = ?, resuelto_en = datetime('now') WHERE id = ?").run(
            movId,
            raizFin.lastInsertRowid
          );
        }
      }
      registrarAuditoria(
        db,
        req.usuario!.id,
        "captura",
        esPagoEspecial
          ? `Pago especial ${folio}: ${concepto.trim()} — importe ${(monto as number).toFixed(2)} MXN, pagadora ${pePagadora?.nombre ?? ""}, efectivo del resguardo de ${peOrigen?.broker_nombre ?? "TRF"}, formato adjunto`
          : esFlujo
          ? `Captura de la operación ${folio} (formato completo: ${lineas.length} dispersiones, comisión ${comisionPctResuelta}%${(comisionTrfPct ?? 0) > 0 ? `, comisión TRF ${comisionTrfPct}%` : ""}, timbrar ${timbrar === true ? "SÍ" : "NO"}${destinosOp.length ? `, pagadoras: ${destinosOp.map((d) => `${d.nombre}${d.manejo_manual ? " [manual]" : ""}`).join(", ")}` : ""}${depositosEntrada.length ? `, ${depositosEntrada.length} depósito(s) indicado(s)` : ""}${financiamientoEntrada ? `, financiamiento $${financiamientoEntrada.monto.toFixed(2)}` : ""})`
          : `Captura de la operación ${folio}`,
        nuevoId
      );
      emitir(db, "operaciones", nuevoId, req.usuario!.id);
      return nuevoId;
    })();
    const op = db.prepare("SELECT * FROM operaciones WHERE id = ?").get(opId);
    const peFila = esPagoEspecial
      ? (db
          .prepare(
            "SELECT operacion_id, descripcion, pagadora_cuenta_id, pagadora, resguardo_origen, broker_origen_id, broker_origen, formato_nombre, formato_mime, creado_por, creado_en FROM pagos_especiales WHERE operacion_id = ?"
          )
          .get(opId) as Record<string, unknown> | undefined)
      : undefined;
    res.status(201).json({
      operacion: op,
      ...(esPagoEspecial ? { pago_especial: peFila ?? null } : {}),
      ...(esFlujo
        ? { calculos: calcularFlujo(monto as number, comisionPctResuelta as number, lineas, brokersOp, comisionTrfPct ?? 0) }
        : {}),
    });
  });

  // Listado de operaciones con su cuadre de respaldos: lo revisa el Validador
  // de Tesorería (todo debe cuadrar y afectar correctamente los resguardos),
  // el Confirmador y la Administración. cuadre = saldo del resguardo +
  // depósitos ya validados + financiamientos aprobados ≥ Flujo Total.
  r.get(
    "/operaciones/respaldos",
    autenticar,
    requiereRol("validador_tesoreria", "confirmador", "admin_tesoreria", "admin", "direccion", "auditoria"),
    (req, res) => {
      const estadosParam = typeof req.query.estados === "string" && req.query.estados.trim() ? req.query.estados.trim() : "";
      const estados = estadosParam
        ? estadosParam.split(",").map((e) => e.trim()).filter(Boolean)
        : ["borrador", "en_validacion", "observada", "pendiente_direccion", "aprobada", "en_pago", "pagada"];
      const placeholders = estados.map(() => "?").join(",");
      const ops = db
        .prepare(
          `SELECT o.id, o.folio, o.estado, o.monto, o.tipo, o.fecha_operacion, c.nombre AS cliente
           FROM operaciones o LEFT JOIN clientes c ON c.id = o.cliente_id
           WHERE o.cliente_id IS NOT NULL AND o.estado IN (${placeholders})
           ORDER BY o.id DESC LIMIT 300`
        )
        .all(...estados) as Array<{
        id: number;
        folio: string;
        estado: EstadoOperacion;
        monto: number;
        tipo: string;
        fecha_operacion: string;
        cliente: string | null;
      }>;
      const filas = ops.map((op) => {
        const saldo = saldoResguardo(db, Number(
          (db.prepare("SELECT cliente_id FROM operaciones WHERE id = ?").get(op.id) as { cliente_id: number }).cliente_id
        ));
        const depositos = db
          .prepare(
            `SELECT
               COALESCE(SUM(CASE WHEN validado_por IS NULL THEN monto ELSE 0 END), 0) AS pendientes,
               COALESCE(SUM(CASE WHEN validado_por IS NOT NULL THEN monto ELSE 0 END), 0) AS validados,
               SUM(CASE WHEN validado_por IS NULL AND (SELECT COUNT(*) FROM depositos_comprobantes c WHERE c.deposito_id = operaciones_depositos.id) = 0 THEN 1 ELSE 0 END) AS sin_comprobante
             FROM operaciones_depositos WHERE operacion_id = ?`
          )
          .get(op.id) as { pendientes: number; validados: number; sin_comprobante: number | null };
        const fin = db
          .prepare(
            `SELECT
               COALESCE(SUM(CASE WHEN estado = 'solicitado' THEN monto ELSE 0 END), 0) AS solicitado,
               COALESCE(SUM(CASE WHEN estado = 'aprobado' THEN monto ELSE 0 END), 0) AS aprobado
             FROM financiamientos WHERE operacion_id = ?`
          )
          .get(op.id) as { solicitado: number; aprobado: number };
        const solido = redondear2(saldo + depositos.validados + fin.aprobado);
        return {
          ...op,
          resguardo_saldo: redondear2(saldo),
          depositos_pendientes: redondear2(depositos.pendientes),
          depositos_validados: redondear2(depositos.validados),
          depositos_sin_comprobante: depositos.sin_comprobante ?? 0,
          financiamiento_solicitado: redondear2(fin.solicitado),
          financiamiento_aprobado: redondear2(fin.aprobado),
          respaldo_solido: solido,
          cuadre: solido >= op.monto - 0.005,
        };
      });
      res.json({ operaciones: filas });
    }
  );

  r.get("/operaciones/:id", autenticar, (req, res) => {
    const id = Number(req.params.id);
    const op = db.prepare("SELECT * FROM operaciones WHERE id = ?").get(id) as Operacion | undefined;
    if (!op) {
      res.status(404).json({ error: "Operación no encontrada" });
      return;
    }
    // Alcance por rol (01-ROLES.md §12 + Fase 12): mismo alcance que el listado.
    if (!puedeVerOperacion(db, op, req.usuario!)) {
      res.status(403).json({ error: "Operación fuera de tu alcance" });
      return;
    }
    const revisiones = db
      .prepare(
        `SELECT rv.*, u.nombre AS revisor FROM revisiones rv JOIN usuarios u ON u.id = rv.revisor_id
         WHERE rv.operacion_id = ? ORDER BY rv.id`
      )
      .all(id) as Array<Revision & { revisor: string }>;
    const historial = db
      .prepare(
        `SELECT a.*, u.nombre AS usuario FROM auditoria a JOIN usuarios u ON u.id = a.usuario_id
         WHERE a.operacion_id = ? ORDER BY a.id`
      )
      .all(id);
    // Tandas de pago (formato FLUJO permite varias por operación). 'pago' se
    // conserva como el primer registro por compatibilidad con clientes antiguos.
    const pagos = db
      .prepare(
        `SELECT p.*, u.nombre AS pagador FROM pagos p JOIN usuarios u ON u.id = p.pagado_por
         WHERE p.operacion_id = ? ORDER BY p.id`
      )
      .all(id) as Array<import("./db.js").Pago & { pagador: string }>;
    const depositos = db
      .prepare(
        `SELECT od.*, cu.nombre AS cuenta FROM operaciones_depositos od
         LEFT JOIN cuentas cu ON cu.id = od.cuenta_id
         WHERE od.operacion_id = ? ORDER BY od.id`
      )
      .all(id) as Array<import("./db.js").DepositoOperacion & { cuenta?: string; comprobantes?: Array<unknown> }>;
    // Comprobantes adjuntos por depósito (1 o varios; sin contenido binario).
    const listaComprobantes = db
      .prepare(
        "SELECT id, deposito_id, nombre, mime, tamano, subido_por, creado_en FROM depositos_comprobantes WHERE deposito_id IN (SELECT id FROM operaciones_depositos WHERE operacion_id = ?) ORDER BY id"
      )
      .all(id) as Array<import("./db.js").ComprobanteDeposito>;
    for (const dep of depositos) {
      dep.comprobantes = listaComprobantes.filter((c) => c.deposito_id === dep.id);
    }
    const financiamientos = db
      .prepare(
        `SELECT f.*, u.nombre AS solicitador, ru.nombre AS resolutor
         FROM financiamientos f
         JOIN usuarios u ON u.id = f.solicitado_por
         LEFT JOIN usuarios ru ON ru.id = f.resuelto_por
         WHERE f.operacion_id = ? ORDER BY f.id`
      )
      .all(id) as Array<import("./db.js").Financiamiento & { solicitador: string; resolutor?: string | null }>;
    const dispersiones = db
      .prepare("SELECT * FROM dispersiones WHERE operacion_id = ? ORDER BY orden, id")
      .all(id) as Array<import("./db.js").Dispersion>;
    // Destinos de la operación (Tarea 12): pagadoras/frentes del catálogo con
    // su marca de manejo manual; cuenta trae el nombre vigente del catálogo.
    const destinos = db
      .prepare(
        `SELECT d.id, d.operacion_id, d.cuenta_id, d.tipo, d.nombre, d.manejo_manual,
                cu.nombre AS cuenta, cu.banco AS banco, cu.activa AS cuenta_activa
         FROM operaciones_destinos d LEFT JOIN cuentas cu ON cu.id = d.cuenta_id
         WHERE d.operacion_id = ? ORDER BY d.id`
      )
      .all(id);
    // Altas bancarias por línea de dispersión: si la línea tiene banco y
    // cuenta/CLABE, se informa si ya está registrada en el banco (sin ese alta
    // Tesorería no puede dispersar).
    const altasDispersiones = dispersiones.map((d) => {
      const ident = d.cuenta.trim() || d.clabe.trim();
      if (!d.banco.trim() || !ident) {
        return {
          dispersion_id: d.id,
          beneficiario: d.beneficiario,
          banco: d.banco,
          cuenta: ident,
          importe: d.importe,
          verificable: false,
          registrada: false,
          estado_alta: null as string | null,
        };
      }
      const alta = altaDeCuenta(db, d.banco, ident);
      return {
        dispersion_id: d.id,
        beneficiario: d.beneficiario,
        banco: d.banco,
        cuenta: ident,
        importe: d.importe,
        verificable: true,
        registrada: alta?.estado === "registrada",
        estado_alta: alta?.estado ?? null,
      };
    });
    const brokersOp = db
      .prepare("SELECT * FROM operaciones_brokers WHERE operacion_id = ? ORDER BY id")
      .all(id) as Array<import("./db.js").OperacionBroker>;
    const calculos = calcularFlujo(op.monto, op.comision_pct, dispersiones, brokersOp, op.comision_trf_pct ?? 0);
    const totalPorDispersar = dispersiones.length ? calculos.flujo_total : op.monto;
    const totalDispersado = redondear2(pagos.reduce((s, p) => s + p.monto, 0));
    // Respaldo de la operación (§6.1): sólo para operaciones con cliente y
    // formato completo. disponible = saldo real + depósitos pendientes de
    // validar + financiamientos por aprobar (los aprobados ya están en saldo).
    const respaldoCliente = respaldoDeOperacion(db, op);
    const respaldo =
      respaldoCliente && op.tipo === "flujo"
        ? {
            ...respaldoCliente,
            requerido: redondear2(totalPorDispersar),
            faltante: redondear2(Math.max(0, totalPorDispersar - respaldoCliente.disponible)),
          }
        : null;
    const liberador = op.liberada_por
      ? (db.prepare("SELECT nombre FROM usuarios WHERE id = ?").get(op.liberada_por) as
          | { nombre: string }
          | undefined)?.nombre ?? null
      : null;
    res.json({
      operacion: op,
      liberada_por_nombre: liberador,
      revisiones,
      historial,
      pagos,
      pago: pagos[0] ?? null,
      deposito: depositos[0] ?? null,
      depositos,
      financiamientos,
      respaldo,
      dispersiones,
      destinos,
      altas_dispersiones: altasDispersiones,
      brokers: brokersOp,
      calculos,
      // Fase 14: datos del pago especial (sin el contenido del formato; el
      // archivo se descarga por su propio endpoint).
      pago_especial: op.tipo === "pago_especial"
        ? (db
            .prepare(
              `SELECT pe.*, u.nombre AS creado_por_nombre
               FROM pagos_especiales pe JOIN usuarios u ON u.id = pe.creado_por
               WHERE pe.operacion_id = ?`
            )
            .get(id) as Record<string, unknown> | undefined) ?? null
        : null,
      totales_pago: {
        total_por_dispersar: redondear2(totalPorDispersar),
        total_dispersado: totalDispersado,
        restante: redondear2(totalPorDispersar - totalDispersado),
      },
    });
  });

  // ---- Fase 14: descarga del formato adjunto del pago especial (p.ej. SAT) ----
  r.get("/operaciones/:id/pago-especial/formato", autenticar, (req, res) => {
    const id = Number(req.params.id);
    const op = db.prepare("SELECT * FROM operaciones WHERE id = ?").get(id) as Operacion | undefined;
    if (!op) {
      res.status(404).json({ error: "Operación no encontrada" });
      return;
    }
    if (!puedeVerOperacion(db, op, req.usuario!)) {
      res.status(403).json({ error: "Operación fuera de tu alcance" });
      return;
    }
    const pe = db
      .prepare("SELECT formato_nombre, formato_mime, formato_contenido FROM pagos_especiales WHERE operacion_id = ?")
      .get(id) as { formato_nombre: string; formato_mime: string; formato_contenido: string } | undefined;
    if (!pe || !pe.formato_contenido) {
      res.status(404).json({ error: "Esta operación no tiene formato de pago especial adjunto" });
      return;
    }
    registrarAuditoria(db, req.usuario!.id, "consulta", `Descarga del formato del pago especial (operación ${id})`, id);
    res.json({ nombre: pe.formato_nombre, mime: pe.formato_mime, contenido: pe.formato_contenido });
  });

  // ---- Formato FLUJO: edición de dispersiones y datos de captura ----
  // Editable por el Ejecutivo mientras la operación está en borrador, en
  // validación u observada (corrección) y mientras no haya tandas registradas.
  const editableFlujo = (op: Operacion): string | null => {
    if (!["borrador", "en_validacion", "observada"].includes(op.estado)) {
      return `La operación está en '${op.estado}': sólo se puede editar en borrador, en validación u observada`;
    }
    if (op.tipo !== "flujo") {
      return "Sólo las operaciones tipo 'flujo' (formato completo) editan dispersiones";
    }
    const nPagos = (db.prepare("SELECT COUNT(*) AS n FROM pagos WHERE operacion_id = ?").get(op.id) as { n: number }).n;
    if (nPagos > 0) {
      return "La operación ya tiene tandas de pago registradas: las dispersiones quedaron fijas";
    }
    return null;
  };

  r.put("/operaciones/:id/dispersiones", autenticar, usuarioVivo, requiereRol("operacion"), (req, res) => {
    const op = db.prepare("SELECT * FROM operaciones WHERE id = ?").get(Number(req.params.id)) as
      | Operacion
      | undefined;
    if (!op) {
      res.status(404).json({ error: "Operación no encontrada" });
      return;
    }
    if (!visibleParaEjecutivo(db, op, req.usuario!.id)) {
      res.status(403).json({ error: "Operación fuera de tu alcance" });
      return;
    }
    const bloqueo = editableFlujo(op);
    if (bloqueo) {
      res.status(409).json({ error: bloqueo });
      return;
    }
    const vd = validarDispersiones(req.body?.dispersiones, op.monto);
    if (!vd.ok) {
      res.status(400).json({ error: "Dispersiones inválidas", detalles: vd.errores });
      return;
    }
    // Pagadoras por línea (Tarea 12): cuenta concreta debe existir y estar activa.
    const vp = normalizarPagadoras(db, vd.datos);
    if (!vp.ok) {
      res.status(400).json({ error: "Pagadoras inválidas", detalles: vp.errores });
      return;
    }
    // Respaldo (§6.1): si al subir el Flujo Total la operación queda sin
    // respaldo, se pide indicar más depósitos o solicitar financiamiento.
    if (op.cliente_id !== null) {
      const nuevoFlujo = redondear2(vd.datos.reduce((s, l) => s + l.importe, 0));
      const resp = respaldoDeOperacion(db, op);
      const disponible = resp?.disponible ?? 0;
      const faltante = redondear2(nuevoFlujo - disponible);
      if (faltante > 0.005) {
        res.status(409).json({
          error: `La edición deja la operación sin respaldo: disponible $${disponible.toFixed(2)}, flujo total $${nuevoFlujo.toFixed(2)}. Agrega depósitos o un financiamiento por al menos $${faltante.toFixed(2)}.`,
          respaldo: { ...(resp ?? { saldo_resguardo: 0, depositos_pendientes: 0, financiamiento_solicitado: 0, disponible: 0 }), requerido: nuevoFlujo, faltante },
        });
        return;
      }
    }
    db.transaction(() => {
      db.prepare("DELETE FROM dispersiones WHERE operacion_id = ?").run(op.id);
      const ins = db.prepare(
        `INSERT INTO dispersiones (operacion_id, orden, beneficiario, razon_social, referencia, ine, numero, tarjeta, cuenta, clabe, banco, etiqueta, nombre, apellido_paterno, apellido_materno, concepto, referencia_pago, rfc, importe, pagadora, pagadora_cuenta_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      vp.datos.forEach((l, i) =>
        ins.run(op.id, i + 1, l.beneficiario, l.razon_social, l.referencia, l.ine, l.numero, l.tarjeta, l.cuenta, l.clabe, l.banco, l.etiqueta, l.nombre, l.apellido_paterno, l.apellido_materno, l.concepto, l.referencia_pago, l.rfc, l.importe, l.pagadora, l.pagadora_cuenta_id)
      );
    })();
    const filas = db
      .prepare("SELECT * FROM dispersiones WHERE operacion_id = ? ORDER BY orden, id")
      .all(op.id) as Array<import("./db.js").Dispersion>;
    const brokersOp = db
      .prepare("SELECT * FROM operaciones_brokers WHERE operacion_id = ? ORDER BY id")
      .all(op.id) as Array<import("./db.js").OperacionBroker>;
    const total = redondear2(filas.reduce((s, d) => s + d.importe, 0));
    registrarAuditoria(
      db,
      req.usuario!.id,
      "dispersiones_actualizadas",
      `Dispersiones actualizadas: ${filas.length} líneas, flujo total ${total.toFixed(2)}`,
      op.id
    );
    res.json({ dispersiones: filas, calculos: calcularFlujo(op.monto, op.comision_pct, filas, brokersOp, op.comision_trf_pct ?? 0) });
  });

  r.put("/operaciones/:id/datos-flujo", autenticar, usuarioVivo, requiereRol("operacion"), (req, res) => {
    const op = db.prepare("SELECT * FROM operaciones WHERE id = ?").get(Number(req.params.id)) as
      | Operacion
      | undefined;
    if (!op) {
      res.status(404).json({ error: "Operación no encontrada" });
      return;
    }
    if (!visibleParaEjecutivo(db, op, req.usuario!.id)) {
      res.status(403).json({ error: "Operación fuera de tu alcance" });
      return;
    }
    const bloqueo = editableFlujo(op);
    if (bloqueo) {
      res.status(409).json({ error: bloqueo });
      return;
    }
    const { pagador, tipo_operacion, timbrar, comision_pct, observaciones, brokers, destinos } = req.body ?? {};
    const conDestinos = Array.isArray(destinos);
    if (
      typeof pagador === "undefined" &&
      typeof tipo_operacion === "undefined" &&
      typeof timbrar === "undefined" &&
      typeof comision_pct === "undefined" &&
      typeof observaciones === "undefined" &&
      typeof brokers === "undefined" &&
      !conDestinos
    ) {
      res.status(400).json({ error: "Envía al menos un campo: pagador, tipo_operacion, timbrar, comision_pct, observaciones, brokers o destinos" });
      return;
    }
    // Con destinos (Tarea 12), pagador/tipo_operacion se deducen del catálogo
    // si no vienen explícitos; en texto sólo son opcionales informativos.
    if (typeof pagador !== "undefined" && !conDestinos && (typeof pagador !== "string" || !pagador.trim())) {
      res.status(400).json({ error: "pagador debe ser texto" });
      return;
    }
    if (
      typeof tipo_operacion !== "undefined" &&
      !conDestinos &&
      (typeof tipo_operacion !== "string" || !tipo_operacion.trim())
    ) {
      res.status(400).json({ error: "tipo_operacion debe ser texto" });
      return;
    }
    if (typeof timbrar !== "undefined" && typeof timbrar !== "boolean") {
      res.status(400).json({ error: "timbrar debe ser true o false" });
      return;
    }
    if (typeof comision_pct !== "undefined" && (typeof comision_pct !== "number" || comision_pct < 0)) {
      res.status(400).json({ error: "comision_pct debe ser un número mayor o igual a 0" });
      return;
    }
    if (typeof observaciones !== "undefined" && typeof observaciones !== "string") {
      res.status(400).json({ error: "observaciones debe ser texto" });
      return;
    }
    const nuevoPct = typeof comision_pct === "number" ? comision_pct : op.comision_pct;
    const vb = validarBrokers(db, brokers);
    if (!vb.ok) {
      res.status(400).json({ error: "Brokers inválidos", detalles: vb.errores });
      return;
    }
    // Destinos (Tarea 12): reemplazo completo de las pagadoras del catálogo.
    let destinosOp: DestinoNormalizado[] = [];
    if (conDestinos) {
      const vd2 = validarDestinos(db, destinos);
      if (!vd2.ok) {
        res.status(400).json({ error: "Destinos inválidos", detalles: vd2.errores });
        return;
      }
      destinosOp = vd2.datos;
    }
    const comisionTotal = redondear2((op.monto * nuevoPct) / 100);
    const brokersOp = vb.datos.map((b) => ({
      broker_id: b.broker_id,
      nombre: b.nombre,
      porcentaje: b.porcentaje,
      monto: redondear2((comisionTotal * b.porcentaje) / 100),
    }));
    db.transaction(() => {
      const sets: string[] = [];
      const params: unknown[] = [];
      if (conDestinos && typeof pagador === "undefined") {
        sets.push("pagador = ?");
        params.push(destinosOp.map((d) => d.nombre).join(", "));
      } else if (typeof pagador !== "undefined") {
        sets.push("pagador = ?");
        params.push(pagador.trim());
      }
      if (conDestinos && typeof tipo_operacion === "undefined") {
        sets.push("tipo_operacion = ?");
        params.push(Array.from(new Set(destinosOp.map((d) => d.tipo))).join(", "));
      } else if (typeof tipo_operacion !== "undefined") {
        sets.push("tipo_operacion = ?");
        params.push(tipo_operacion.trim());
      }
      if (typeof timbrar === "boolean") {
        sets.push("timbrar = ?");
        params.push(timbrar ? 1 : 0);
      }
      if (typeof comision_pct === "number") {
        sets.push("comision_pct = ?");
        params.push(comision_pct);
      }
      if (typeof observaciones === "string") {
        sets.push("observaciones = ?");
        params.push(observaciones.trim());
      }
      if (sets.length) {
        db.prepare(`UPDATE operaciones SET ${sets.join(", ")}, actualizado_en = datetime('now') WHERE id = ?`).run(
          ...params,
          op.id
        );
      }
      if (brokers !== undefined) {
        // Reemplazo completo de los brokers participantes (con montos
        // recalculados al porcentaje de comisión vigente).
        db.prepare("DELETE FROM operaciones_brokers WHERE operacion_id = ?").run(op.id);
        const ins = db.prepare(
          "INSERT INTO operaciones_brokers (operacion_id, broker_id, nombre, porcentaje, monto) VALUES (?, ?, ?, ?, ?)"
        );
        for (const b of brokersOp) ins.run(op.id, b.broker_id, b.nombre, b.porcentaje, b.monto);
      } else if (typeof comision_pct === "number") {
        // Sin cambio de brokers: se recalculan sus montos con el nuevo %.
        const existentes = db
          .prepare("SELECT id, porcentaje FROM operaciones_brokers WHERE operacion_id = ?")
          .all(op.id) as Array<{ id: number; porcentaje: number }>;
        const upd = db.prepare("UPDATE operaciones_brokers SET monto = ? WHERE id = ?");
        for (const b of existentes) upd.run(redondear2((comisionTotal * b.porcentaje) / 100), b.id);
      }
      if (conDestinos) {
        // Reemplazo completo de los destinos (pagadoras del catálogo).
        db.prepare("DELETE FROM operaciones_destinos WHERE operacion_id = ?").run(op.id);
        const insDest = db.prepare(
          "INSERT INTO operaciones_destinos (operacion_id, cuenta_id, tipo, nombre, manejo_manual) VALUES (?, ?, ?, ?, ?)"
        );
        for (const d of destinosOp) insDest.run(op.id, d.cuenta_id, d.tipo, d.nombre, d.manejo_manual);
      }
    })();
    registrarAuditoria(
      db,
      req.usuario!.id,
      "datos_flujo_actualizados",
      `Datos del flujo actualizados (comisión ${nuevoPct.toFixed(2)}%${brokers !== undefined ? `, brokers: ${brokersOp.length}` : ""}${conDestinos ? `, pagadoras: ${destinosOp.map((d) => `${d.nombre}${d.manejo_manual ? " [manual]" : ""}`).join(", ")}` : ""})`,
      op.id
    );
    const actualizada = db.prepare("SELECT * FROM operaciones WHERE id = ?").get(op.id) as Operacion;
    const filasBrokers = db
      .prepare("SELECT * FROM operaciones_brokers WHERE operacion_id = ? ORDER BY id")
      .all(op.id) as Array<import("./db.js").OperacionBroker>;
    const dispersiones = db
      .prepare("SELECT * FROM dispersiones WHERE operacion_id = ? ORDER BY orden, id")
      .all(op.id) as Array<import("./db.js").Dispersion>;
    res.json({
      operacion: actualizada,
      brokers: filasBrokers,
      destinos: db
        .prepare(
          `SELECT d.id, d.operacion_id, d.cuenta_id, d.tipo, d.nombre, d.manejo_manual,
                  cu.nombre AS cuenta, cu.banco AS banco, cu.activa AS cuenta_activa
           FROM operaciones_destinos d LEFT JOIN cuentas cu ON cu.id = d.cuenta_id
           WHERE d.operacion_id = ? ORDER BY d.id`
        )
        .all(op.id),
      calculos: calcularFlujo(actualizada.monto, actualizada.comision_pct, dispersiones, filasBrokers),
    });
  });

  r.post("/operaciones/:id/enviar-validacion", autenticar, requiereRol("operacion"), (req, res) => {
    const op = db.prepare("SELECT * FROM operaciones WHERE id = ?").get(Number(req.params.id)) as
      | Operacion
      | undefined;
    if (!op) {
      res.status(404).json({ error: "Operación no encontrada" });
      return;
    }
    try {
      const actualizada = cambiarEstado(db, op, "en_validacion", req.usuario!.id);
      res.json({ operacion: actualizada });
    } catch (e) {
      res.status(e instanceof ErrorDominio ? e.status : 500).json({ error: (e as Error).message });
    }
  });

  r.post("/operaciones/:id/revision", autenticar, requiereRol("validacion"), (req, res) => {
    const { resultado, comentario } = req.body ?? {};
    if (!["aprobada", "observada"].includes(resultado)) {
      res.status(400).json({ error: "resultado debe ser 'aprobada' u 'observada'" });
      return;
    }
    if (typeof comentario !== "string" || !comentario.trim()) {
      res.status(400).json({ error: "comentario requerido (obligatorio en ambos casos)" });
      return;
    }
    const op = db.prepare("SELECT * FROM operaciones WHERE id = ?").get(Number(req.params.id)) as
      | Operacion
      | undefined;
    if (!op) {
      res.status(404).json({ error: "Operación no encontrada" });
      return;
    }
    if (op.estado !== "en_validacion") {
      res.status(409).json({ error: `La operación está en '${op.estado}', se requiere 'en_validacion'` });
      return;
    }
    // Distribución de carga (01-ROLES.md §4.1 + Fase 12): si la operación tiene
    // una asignación vigente, sólo ese validador puede revisarla. Sin
    // asignación por operación: si el ejecutivo que la capturó está asignado a
    // validadores (validacion_ejecutivos), sólo esos validadores la revisan;
    // si el ejecutivo no está distribuido, cualquier validador del área puede
    // revisarla (flujo simple, §4.2).
    const asignada = db
      .prepare(
        "SELECT validador_id FROM asignaciones_validacion WHERE operacion_id = ? AND activo = 1 AND cerrado_en IS NULL"
      )
      .get(op.id) as { validador_id: number } | undefined;
    if (asignada && asignada.validador_id !== req.usuario!.id) {
      res.status(403).json({ error: "La operación está asignada a otro validador" });
      return;
    }
    if (!asignada) {
      const distribuido = db
        .prepare(
          "SELECT 1 AS ok FROM validacion_ejecutivos WHERE ejecutivo_id = ? AND activo = 1 AND cerrado_en IS NULL LIMIT 1"
        )
        .get(op.creado_por);
      if (distribuido) {
        const mio = db
          .prepare(
            "SELECT 1 AS ok FROM validacion_ejecutivos WHERE validador_id = ? AND ejecutivo_id = ? AND activo = 1 AND cerrado_en IS NULL"
          )
          .get(req.usuario!.id, op.creado_por);
        if (!mio) {
          res
            .status(403)
            .json({ error: "La operación pertenece a un ejecutivo asignado a otro validador" });
          return;
        }
      }
    }
    db.prepare(
      "INSERT INTO revisiones (operacion_id, revisor_id, resultado, comentario) VALUES (?, ?, ?, ?)"
    ).run(op.id, req.usuario!.id, resultado, comentario.trim());
    // Sobre el umbral, aprobar deja la operación pendiente de Dirección.
    const destino: EstadoOperacion =
      resultado === "aprobada"
        ? op.monto >= leerUmbralDireccion(db)
          ? "pendiente_direccion"
          : "aprobada"
        : "observada";
    try {
      // Ajuste del negocio: al quedar APROBADA se aplican al resguardo de TRF
      // los movimientos de la operación (retiro del pago especial desde TRF,
      // ingreso de la comisión TRF). Si el retiro no tiene fondo, la
      // autorización NO procede (409) y la operación sigue en validación.
      const actualizada = db.transaction(() => {
        if (destino === "aprobada") aplicarTrfAlAutorizar(db, op, req.usuario!.id);
        return cambiarEstado(db, op, destino, req.usuario!.id);
      })();
      res.json({ operacion: actualizada });
    } catch (e) {
      res.status(e instanceof ErrorDominio ? e.status : 500).json({ error: (e as Error).message });
    }
  });

  // Cancelación (Fase 12): Tesorería es la única área —aparte del propio
  // ejecutivo que capturó— capaz de cancelar operaciones. Dirección ya no
  // cancela (sólo lectura salvo financiamientos y operaciones pendientes).
  r.post("/operaciones/:id/cancelar", autenticar, requiereRol("operacion", "tesoreria", "admin_tesoreria", "fondeador"), (req, res) => {
    const op = db.prepare("SELECT * FROM operaciones WHERE id = ?").get(Number(req.params.id)) as
      | Operacion
      | undefined;
    if (!op) {
      res.status(404).json({ error: "Operación no encontrada" });
      return;
    }
    const rol = req.usuario!.rol;
    if (rol === "operacion") {
      // El ejecutivo sólo cancela SU captura, antes de que la validación la apruebe.
      if (op.creado_por !== req.usuario!.id) {
        res.status(403).json({ error: "Sólo el ejecutivo que capturó la operación puede cancelarla" });
        return;
      }
      if (!["borrador", "observada"].includes(op.estado)) {
        res
          .status(409)
          .json({ error: `Como Ejecutivo sólo puedes cancelar en 'borrador' u 'observada' (está en '${op.estado}')` });
        return;
      }
    } else {
      // Tesorería (analista, Fondeador o Administrador de Tesorería).
      if (op.estado === "pagada" || op.estado === "cancelada") {
        res.status(409).json({ error: `La operación está en '${op.estado}': no se puede cancelar` });
        return;
      }
      if (op.estado === "en_pago") {
        const dispersado = (
          db
            .prepare("SELECT COALESCE(SUM(monto), 0) AS t FROM pagos WHERE operacion_id = ?")
            .get(op.id) as { t: number }
        ).t;
        if (dispersado > 0.005) {
          res.status(409).json({
            error: `La operación ya tiene tandas registradas por $${dispersado.toFixed(2)}: no se cancela`,
            dispersado,
          });
          return;
        }
      }
    }
    try {
      const actualizada = cambiarEstado(db, op, "cancelada", req.usuario!.id);
      // Ajuste del negocio: si la operación ya estaba AUTORIZADA, sus
      // movimientos del resguardo de TRF (aplicados al autorizarla) se reversan
      // con el movimiento contrario (ledger append-only).
      reversarTrfAlCancelar(db, actualizada, req.usuario!.id);
      // Los financiamientos aún sin resolver pierden sentido: se cancelan.
      const pendientes = (
        db
          .prepare("SELECT COUNT(*) AS n FROM financiamientos WHERE operacion_id = ? AND estado = 'solicitado'")
          .get(op.id) as { n: number }
      ).n;
      if (pendientes > 0) {
        db
          .prepare(
            "UPDATE financiamientos SET estado = 'cancelado', resuelto_por = ?, resuelto_en = datetime('now') WHERE operacion_id = ? AND estado = 'solicitado'"
          )
          .run(req.usuario!.id, op.id);
        registrarAuditoria(
          db,
          req.usuario!.id,
          "financiamiento_cancelado",
          `${pendientes} financiamiento(s) solicitado(s) de la operación ${op.folio} cancelados al cancelarse la operación`,
          op.id
        );
      }
      res.json({ operacion: actualizada });
    } catch (e) {
      res.status(e instanceof ErrorDominio ? e.status : 500).json({ error: (e as Error).message });
    }
  });

  // ---- Dirección: aprobación por monto y reportes ----
  r.post("/operaciones/:id/aprobacion-direccion", autenticar, requiereRol("direccion"), (req, res) => {
    const { aprobado, comentario } = req.body ?? {};
    if (typeof aprobado !== "boolean") {
      res.status(400).json({ error: "aprobado debe ser true o false" });
      return;
    }
    if (typeof comentario !== "string" || !comentario.trim()) {
      res.status(400).json({ error: "comentario requerido" });
      return;
    }
    const op = db.prepare("SELECT * FROM operaciones WHERE id = ?").get(Number(req.params.id)) as
      | Operacion
      | undefined;
    if (!op) {
      res.status(404).json({ error: "Operación no encontrada" });
      return;
    }
    if (op.estado !== "pendiente_direccion") {
      res.status(409).json({
        error: `La operación está en '${op.estado}', se requiere 'pendiente_direccion'`,
      });
      return;
    }
    registrarAuditoria(
      db,
      req.usuario!.id,
      "aprobacion_direccion",
      `${aprobado ? "Aprobó" : "Rechazó"} Dirección: ${comentario.trim()}`,
      op.id
    );
    try {
      // Ajuste del negocio: al AUTORIZAR Dirección se aplican los movimientos
      // de TRF de la operación (mismo criterio que la revisión de validación).
      const actualizada = db.transaction(() => {
        if (aprobado) aplicarTrfAlAutorizar(db, op, req.usuario!.id);
        return cambiarEstado(db, op, aprobado ? "aprobada" : "observada", req.usuario!.id);
      })();
      res.json({ operacion: actualizada });
    } catch (e) {
      res.status(e instanceof ErrorDominio ? e.status : 500).json({ error: (e as Error).message });
    }
  });

  // ---- Fase 12: liberación del Tesorero Fondeador y resumen de fondeo ----
  // El Fondeador revisa las operaciones validadas (y por validar) para planear
  // el efectivo (flujos, SOFOM, anticipos a rendimientos, etc.) y LIBERA cada
  // operación aprobada: el analista de Tesorería sólo ve y paga lo liberado.
  r.post("/operaciones/:id/liberar", autenticar, usuarioVivo, requiereRol("fondeador"), (req, res) => {
    const op = db.prepare("SELECT * FROM operaciones WHERE id = ?").get(Number(req.params.id)) as
      | Operacion
      | undefined;
    if (!op) {
      res.status(404).json({ error: "Operación no encontrada" });
      return;
    }
    if (op.liberada_en) {
      res.status(409).json({ error: `La operación ya fue liberada el ${op.liberada_en}` });
      return;
    }
    if (!["aprobada", "en_pago"].includes(op.estado)) {
      res
        .status(409)
        .json({ error: `La operación está en '${op.estado}': sólo se liberan las 'aprobada' (o en pago sin liberar)` });
      return;
    }
    db.prepare(
      "UPDATE operaciones SET liberada_por = ?, liberada_en = datetime('now'), actualizado_en = datetime('now') WHERE id = ?"
    ).run(req.usuario!.id, op.id);
    registrarAuditoria(
      db,
      req.usuario!.id,
      "operacion_liberada",
      `Tesorero Fondeador liberó ${op.folio} a Tesorería para dispersión`,
      op.id
    );
    emitir(db, "operaciones", op.id, req.usuario!.id);
    const actualizada = db.prepare("SELECT * FROM operaciones WHERE id = ?").get(op.id) as Operacion;
    res.json({ operacion: actualizada });
  });

  // Resumen del Fondeador: montos por estado y por tipo de operación del
  // negocio (FLUJOS, SOFOM, anticipos a rendimientos, etc.) para decidir de
  // dónde sale el efectivo de cada frente.
  r.get("/fondeador/resumen", autenticar, requiereRol("fondeador", "admin_tesoreria", "admin"), (_req, res) => {
    const estados = ["en_validacion", "observada", "pendiente_direccion", "aprobada", "en_pago", "pagada"];
    const porEstado = estados.map((e) =>
      db
        .prepare(
          `SELECT COUNT(*) AS operaciones, COALESCE(SUM(monto), 0) AS monto,
                  COALESCE((SELECT SUM(d.importe) FROM dispersiones d
                            JOIN operaciones o2 ON o2.id = d.operacion_id
                            WHERE o2.estado = ?), 0) AS flujo_total
           FROM operaciones o WHERE o.estado = ?`
        )
        .get(e, e) as { operaciones: number; monto: number; flujo_total: number }
    );
    const porTipo = db
      .prepare(
        `SELECT tipo_operacion, moneda, COUNT(*) AS operaciones,
                COALESCE(SUM(monto), 0) AS monto,
                COALESCE(SUM(CASE WHEN estado IN ('en_validacion','observada','pendiente_direccion') THEN monto ELSE 0 END), 0) AS por_validar,
                COALESCE(SUM(CASE WHEN estado IN ('aprobada','en_pago') THEN monto ELSE 0 END), 0) AS por_dispersar,
                COALESCE(SUM(CASE WHEN estado = 'pagada' THEN monto ELSE 0 END), 0) AS pagado
         FROM operaciones
         WHERE estado IN ('en_validacion','observada','pendiente_direccion','aprobada','en_pago','pagada')
         GROUP BY tipo_operacion, moneda
         ORDER BY tipo_operacion, moneda`
      )
      .all();
    const porLiberar = db
      .prepare(
        `SELECT COUNT(*) AS operaciones, COALESCE(SUM(monto), 0) AS monto
         FROM operaciones WHERE estado IN ('aprobada','en_pago') AND liberada_en IS NULL`
      )
      .get() as { operaciones: number; monto: number };
    const liberadas = db
      .prepare(
        `SELECT COUNT(*) AS operaciones, COALESCE(SUM(monto), 0) AS monto
         FROM operaciones WHERE liberada_en IS NOT NULL AND estado IN ('aprobada','en_pago')`
      )
      .get() as { operaciones: number; monto: number };
    res.json({ por_estado: porEstado, por_tipo: porTipo, por_liberar: porLiberar, liberadas });
  });

  // Barra de PRONÓSTICO para Tesorería: operaciones capturadas que siguen en
  // proceso (borrador → en pago) agrupadas por categoría del negocio —
  // FLUJOS, ASIMILADOS, FRENTES, PAGOS ESPECIALES y OTROS. Da el panorama de
  // lo que viene (por validar, por dispersar) según lo capturado por Operaciones.
  r.get(
    "/pronostico",
    autenticar,
    requiereRol("tesoreria", "admin_tesoreria", "validador_tesoreria", "fondeador", "direccion", "auditoria", "admin"),
    (_req, res) => {
      const enProceso = ["borrador", "en_validacion", "observada", "pendiente_direccion", "aprobada", "en_pago"];
      const marcadores = enProceso.map(() => "?").join(",");
      const porCategoria = db
        .prepare(
          `SELECT CASE
              WHEN o.tipo = 'pago_especial' THEN 'PAGOS ESPECIALES'
              WHEN o.tipo_operacion LIKE '%asimilado%' THEN 'ASIMILADOS'
              WHEN o.tipo_operacion LIKE '%frente%' THEN 'FRENTES'
              WHEN o.tipo_operacion LIKE '%flujo%' THEN 'FLUJOS'
              ELSE 'OTROS'
            END AS categoria,
            COUNT(*) AS operaciones,
            COALESCE(SUM(o.monto), 0) AS monto,
            COALESCE(SUM((SELECT COALESCE(SUM(d.importe), 0) FROM dispersiones d WHERE d.operacion_id = o.id)), 0) AS flujo_total
          FROM operaciones o
          WHERE o.estado IN (${marcadores})
          GROUP BY categoria`
        )
        .all(...enProceso) as Array<{
        categoria: string;
        operaciones: number;
        monto: number;
        flujo_total: number;
      }>;
      // Orden estable del negocio: las categorías sin captura salen en ceros.
      const orden = ["FLUJOS", "ASIMILADOS", "FRENTES", "PAGOS ESPECIALES", "OTROS"];
      const categorias = orden.map((c) => {
        const fila = porCategoria.find((x) => x.categoria === c);
        return {
          categoria: c,
          operaciones: fila?.operaciones ?? 0,
          monto: redondear2(fila?.monto ?? 0),
          flujo_total: redondear2(fila?.flujo_total ?? 0),
        };
      });
      const porEstado = db
        .prepare(
          `SELECT estado, COUNT(*) AS operaciones, COALESCE(SUM(monto), 0) AS monto
           FROM operaciones WHERE estado IN (${marcadores}) GROUP BY estado`
        )
        .all(...enProceso) as Array<{ estado: string; operaciones: number; monto: number }>;
      const total = categorias.reduce(
        (acc, c) => ({
          operaciones: acc.operaciones + c.operaciones,
          monto: redondear2(acc.monto + c.monto),
          flujo_total: redondear2(acc.flujo_total + c.flujo_total),
        }),
        { operaciones: 0, monto: 0, flujo_total: 0 }
      );
      res.json({
        categorias,
        por_estado: porEstado.map((e) => ({ ...e, monto: redondear2(e.monto) })),
        total,
      });
    }
  );

  // ---- Fase 12: altas bancarias (rol 'altas' — Tesorería de Altas) ----
  // El Ejecutivo solicita el registro de la cuenta de un beneficiario en el
  // banco (normalmente desde una línea de dispersión de su operación); el
  // Tesorero de Altas la registra en el portal bancario y lo marca aquí.
  // Tesorería NO dispersa a cuentas sin alta registrada.
  r.post("/altas-bancarias", autenticar, usuarioVivo, requiereRol("operacion"), (req, res) => {
    const { operacion_id, dispersion_id, beneficiario, banco, moneda, cuenta, notas } = req.body ?? {};
    let ben = typeof beneficiario === "string" ? beneficiario.trim() : "";
    let ban = typeof banco === "string" ? banco.trim() : "";
    let cue = typeof cuenta === "string" ? cuenta.trim() : "";
    const mon = typeof moneda === "string" && moneda.trim() ? moneda.trim().toUpperCase() : "MXN";
    let opId: number | null = null;
    let folio = "";
    // Desde una línea de dispersión: el catálogo del ejecutivo son las líneas
    // de sus operaciones; los datos bancarios se toman de ahí.
    if (typeof dispersion_id === "number") {
      const d = db.prepare("SELECT * FROM dispersiones WHERE id = ?").get(dispersion_id) as
        | import("./db.js").Dispersion
        | undefined;
      if (!d) {
        res.status(404).json({ error: "Línea de dispersión no encontrada" });
        return;
      }
      const op = db.prepare("SELECT * FROM operaciones WHERE id = ?").get(d.operacion_id) as
        | Operacion
        | undefined;
      if (!op) {
        res.status(404).json({ error: "Operación de la dispersión no encontrada" });
        return;
      }
      if (!visibleParaEjecutivo(db, op, req.usuario!.id)) {
        res.status(403).json({ error: "La operación está fuera de tu alcance" });
        return;
      }
      opId = op.id;
      folio = op.folio;
      if (!ben) ben = d.beneficiario;
      if (!ban) ban = d.banco;
      if (!cue) cue = d.cuenta.trim() || d.clabe.trim();
    }
    if (typeof operacion_id === "number") {
      const op = db.prepare("SELECT * FROM operaciones WHERE id = ?").get(operacion_id) as
        | Operacion
        | undefined;
      if (!op) {
        res.status(404).json({ error: "Operación no encontrada" });
        return;
      }
      if (!visibleParaEjecutivo(db, op, req.usuario!.id)) {
        res.status(403).json({ error: "La operación está fuera de tu alcance" });
        return;
      }
      opId = op.id;
      folio = op.folio;
    }
    const errores: string[] = [];
    if (!ben) errores.push("beneficiario requerido");
    if (!ban) errores.push("banco requerido");
    if (!cue) errores.push("cuenta (número de cuenta o CLABE) requerida");
    if (!/^[A-Z]{3}$/.test(mon)) errores.push("moneda con 3 letras (MXN, USD)");
    if (errores.length) {
      res.status(400).json({ error: "Datos inválidos", detalles: errores });
      return;
    }
    // Sin duplicados: no se solicita lo que ya está registrado ni se apilan
    // solicitudes idénticas.
    const previa = altaDeCuenta(db, ban, cue);
    if (previa && previa.estado === "registrada") {
      res
        .status(409)
        .json({ error: `La cuenta ya está registrada en ${previa.banco} (alta #${previa.id})` });
      return;
    }
    if (previa && previa.estado === "solicitada") {
      res
        .status(409)
        .json({ error: `Ya existe una solicitud pendiente para esa cuenta en ${previa.banco} (alta #${previa.id})` });
      return;
    }
    const idAlta = db
      .prepare(
        `INSERT INTO altas_bancarias (operacion_id, beneficiario, banco, moneda, cuenta, notas, solicitado_por)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(opId, ben, ban, mon, cue, typeof notas === "string" ? notas.trim() : "", req.usuario!.id)
      .lastInsertRowid;
    registrarAuditoria(
      db,
      req.usuario!.id,
      "alta_solicitada",
      `Alta bancaria solicitada: ${ben} (${ban}, ${cue}, ${mon})${folio ? ` — operación ${folio}` : ""}`,
      opId
    );
    const alta = db.prepare("SELECT * FROM altas_bancarias WHERE id = ?").get(idAlta);
    res.status(201).json({ alta });
  });

  // Base de altas: el Ejecutivo ve las suyas; Altas/Tesorería/Dirección/
  // Auditoría/Operaciones/Fondeador ven la base completa.
  r.get(
    "/altas-bancarias",
    autenticar,
    requiereRol(
      "operacion",
      "altas",
      "admin_tesoreria",
      "admin",
      "admin_operaciones",
      "fondeador",
      "validador_tesoreria",
      "direccion",
      "auditoria"
    ),
    (req, res) => {
      const estado = typeof req.query.estado === "string" ? req.query.estado : "";
      const operacionId = typeof req.query.operacion_id === "string" ? Number(req.query.operacion_id) : NaN;
      const filtros: string[] = [];
      const params: unknown[] = [];
      if (estado) {
        if (!["solicitada", "registrada", "rechazada"].includes(estado)) {
          res.status(400).json({ error: "estado inválido (solicitada | registrada | rechazada)" });
          return;
        }
        filtros.push("ab.estado = ?");
        params.push(estado);
      }
      if (Number.isInteger(operacionId)) {
        filtros.push("ab.operacion_id = ?");
        params.push(operacionId);
      }
      if (req.usuario!.rol === "operacion") {
        filtros.push("ab.solicitado_por = ?");
        params.push(req.usuario!.id);
      }
      const where = filtros.length ? `WHERE ${filtros.join(" AND ")}` : "";
      const filas = db
        .prepare(
          `SELECT ab.*, u.nombre AS solicitador, ru.nombre AS resolutor, o.folio, o.concepto
           FROM altas_bancarias ab
           JOIN usuarios u ON u.id = ab.solicitado_por
           LEFT JOIN usuarios ru ON ru.id = ab.resuelto_por
           LEFT JOIN operaciones o ON o.id = ab.operacion_id
           ${where}
           ORDER BY CASE WHEN ab.estado = 'solicitada' THEN 0 ELSE 1 END, ab.id DESC`
        )
        .all(...params);
      res.json({ altas: filas });
    }
  );

  // Fase 15 (vista tipo Excel): el tablero completo de altas en UNA llamada —
  // cada alta con su lista de portales + catálogo de portales (pagadoras
  // activas), igual que la hoja "SOLICITUD ALTAS" del formato de alta.
  r.get(
    "/altas-bancarias/matriz",
    autenticar,
    requiereRol(
      "operacion",
      "altas",
      "admin_tesoreria",
      "admin",
      "admin_operaciones",
      "fondeador",
      "validador_tesoreria",
      "direccion",
      "auditoria"
    ),
    (req, res) => {
      const filtros: string[] = [];
      const params: unknown[] = [];
      if (req.usuario!.rol === "operacion") {
        filtros.push("ab.solicitado_por = ?");
        params.push(req.usuario!.id);
      }
      const where = filtros.length ? `WHERE ${filtros.join(" AND ")}` : "";
      const altas = db
        .prepare(
          `SELECT ab.*, u.nombre AS solicitador, ru.nombre AS resolutor, o.folio, o.concepto
           FROM altas_bancarias ab
           JOIN usuarios u ON u.id = ab.solicitado_por
           LEFT JOIN usuarios ru ON ru.id = ab.resuelto_por
           LEFT JOIN operaciones o ON o.id = ab.operacion_id
           ${where}
           ORDER BY CASE WHEN ab.estado = 'solicitada' THEN 0 ELSE 1 END, ab.id DESC`
        )
        .all(...params) as Array<Record<string, unknown> & { id: number }>;
      const filasPortal = db
        .prepare(
          `SELECT ap.*, c.nombre AS portal, ur.nombre AS registrador
           FROM altas_portales ap
           JOIN cuentas c ON c.id = ap.portal_cuenta_id
           LEFT JOIN usuarios ur ON ur.id = ap.registrado_por
           ORDER BY c.nombre, ap.id`
        )
        .all() as Array<Record<string, unknown> & { alta_bancaria_id: number }>;
      const indice = new Map<number, Array<Record<string, unknown>>>();
      for (const ap of filasPortal) {
        const lista = indice.get(ap.alta_bancaria_id) ?? [];
        lista.push(ap);
        indice.set(ap.alta_bancaria_id, lista);
      }
      for (const a of altas) a.portales = indice.get(a.id) ?? [];
      const portales = db
        .prepare("SELECT id, nombre FROM cuentas WHERE activa = 1 ORDER BY nombre")
        .all();
      res.json({ altas, portales });
    }
  );

  r.post("/altas-bancarias/:id/registrada", autenticar, usuarioVivo, requiereRol("altas", "admin_tesoreria", "admin"), (req, res) => {
    const alta = db.prepare("SELECT * FROM altas_bancarias WHERE id = ?").get(Number(req.params.id)) as
      | import("./db.js").AltaBancaria
      | undefined;
    if (!alta) {
      res.status(404).json({ error: "Alta bancaria no encontrada" });
      return;
    }
    if (alta.estado !== "solicitada") {
      res.status(409).json({ error: `El alta está en '${alta.estado}'; sólo se registran las 'solicitada'` });
      return;
    }
    db.prepare(
      "UPDATE altas_bancarias SET estado = 'registrada', resuelto_por = ?, resuelto_en = datetime('now') WHERE id = ?"
    ).run(req.usuario!.id, alta.id);
    registrarAuditoria(
      db,
      req.usuario!.id,
      "alta_registrada",
      `Cuenta de '${alta.beneficiario}' registrada en ${alta.banco} (${alta.cuenta}, ${alta.moneda}) desde el portal bancario`,
      alta.operacion_id
    );
    const actualizada = db.prepare("SELECT * FROM altas_bancarias WHERE id = ?").get(alta.id);
    res.json({ alta: actualizada });
  });

  r.post("/altas-bancarias/:id/rechazar", autenticar, usuarioVivo, requiereRol("altas", "admin_tesoreria", "admin"), (req, res) => {
    const alta = db.prepare("SELECT * FROM altas_bancarias WHERE id = ?").get(Number(req.params.id)) as
      | import("./db.js").AltaBancaria
      | undefined;
    if (!alta) {
      res.status(404).json({ error: "Alta bancaria no encontrada" });
      return;
    }
    if (alta.estado !== "solicitada") {
      res.status(409).json({ error: `El alta está en '${alta.estado}'; sólo se rechazan las 'solicitada'` });
      return;
    }
    const motivo = typeof req.body?.motivo === "string" ? req.body.motivo.trim() : "";
    if (!motivo) {
      res.status(400).json({ error: "motivo requerido para rechazar el alta" });
      return;
    }
    db.prepare(
      "UPDATE altas_bancarias SET estado = 'rechazada', motivo_rechazo = ?, resuelto_por = ?, resuelto_en = datetime('now') WHERE id = ?"
    ).run(motivo, req.usuario!.id, alta.id);
    registrarAuditoria(
      db,
      req.usuario!.id,
      "alta_rechazada",
      `Alta bancaria de '${alta.beneficiario}' (${alta.banco}, ${alta.cuenta}) rechazada: ${motivo}`,
      alta.operacion_id
    );
    const actualizada = db.prepare("SELECT * FROM altas_bancarias WHERE id = ?").get(alta.id);
    res.json({ alta: actualizada });
  });

  // ============ Fase 15 — Catálogo SPEI, CLABE y altas en portales ============

  // Catálogo de bancos SPEI (la clave son los 3 primeros dígitos de la CLABE).
  // Cualquier usuario autenticado lo consulta para auto-llenar formularios.
  r.get("/bancos", autenticar, (_req, res) => {
    const bancos = db
      .prepare("SELECT clave, nombre_corto, nombre_completo FROM bancos_spei ORDER BY clave")
      .all() as import("./db.js").BancoSpei[];
    res.json({ bancos });
  });

  // Validador/derivador de CLABE (formato "ALTA CUENTA"): normaliza a dígitos,
  // valida los 18, resuelve el banco por prefijo y deriva el número de cuenta
  // con la regla por banco (Santander 014: posiciones 7-17; el resto: 8-17).
  r.post("/clabe/validar", autenticar, (req, res) => {
    const v = validarClabe(typeof req.body?.clabe === "string" ? req.body.clabe : "");
    const clave = v.banco_clave;
    const banco = clave
      ? (db
          .prepare("SELECT clave, nombre_corto, nombre_completo FROM bancos_spei WHERE clave = ?")
          .get(clave) as import("./db.js").BancoSpei | undefined)
      : undefined;
    const cuenta = cuentaDesdeClabe(v.clabe);
    const errores = [...v.errores];
    if (v.ok && !banco) errores.push(`banco no reconocido en el catálogo SPEI (prefijo ${clave || "—"})`);
    res.json({
      ok: errores.length === 0 && !!banco && !!cuenta,
      clabe: v.clabe,
      banco: banco ? { clave: banco.clave, nombre: banco.nombre_corto } : null,
      cuenta,
      errores,
    });
  });

  // Captura por lotes (formato "ALTA CUENTA"): líneas PATERNO/MATERNO/NOMBRE/CLABE
  // y portales (pagadoras) donde se registrarán. Cada línea se normaliza y
  // valida como el formato (nombre sin acentos/Ñ, CLABE 18, banco por prefijo,
  // cuenta derivada); duplicados y errores se reportan línea por línea sin
  // bloquear al resto. Quedan en la cola de altas como 'solicitada'.
  r.post("/altas-bancarias/lote", autenticar, usuarioVivo, requiereRol("altas", "admin_tesoreria", "admin"), (req, res) => {
    const { lineas, portales } = req.body ?? {};
    if (!Array.isArray(lineas) || lineas.length === 0) {
      res.status(400).json({ error: "lineas requerida: lista de { paterno, materno, nombre, clabe }" });
      return;
    }
    if (lineas.length > 5000) {
      res.status(400).json({ error: "máximo 5,000 líneas por lote" });
      return;
    }
    const idsPortales: number[] = Array.isArray(portales)
      ? (portales.map((p: unknown) => Number(p)).filter((p: number) => Number.isInteger(p) && p > 0) as number[])
      : [];
    const portalesInfo = idsPortales
      .map((id) => db.prepare("SELECT id, nombre FROM cuentas WHERE id = ? AND activa = 1").get(id) as
        | { id: number; nombre: string }
        | undefined)
      .filter((p): p is { id: number; nombre: string } => Boolean(p));
    if (portalesInfo.length !== idsPortales.length) {
      res.status(400).json({ error: "algún portal (pagadora) no existe o está fuera de operación" });
      return;
    }
    interface LineaOk {
      alta_id: number;
      linea: number;
      beneficiario: string;
      paterno: string;
      materno: string;
      nombre: string;
      clabe: string;
      banco: string;
      cuenta: string;
    }
    const creadas: LineaOk[] = [];
    const duplicadas: Array<{ linea: number; beneficiario: string; banco: string; cuenta: string; estado: string; alta_id: number }> = [];
    const errores: Array<{ linea: number; errores: string[] }> = [];
    const insertarAlta = db.prepare(
      `INSERT INTO altas_bancarias (beneficiario, banco, moneda, cuenta, clabe, notas, solicitado_por)
       VALUES (?, ?, 'MXN', ?, ?, ?, ?)`
    );
    const insertarPortal = db.prepare(
      "INSERT INTO altas_portales (alta_bancaria_id, portal_cuenta_id, creado_por) VALUES (?, ?, ?)"
    );
    db.transaction(() => {
      (lineas as unknown[]).forEach((cruda, idx) => {
        const ln = (cruda ?? {}) as Record<string, unknown>;
        const texto = (k: string) => (typeof ln[k] === "string" ? (ln[k] as string) : "");
        const clabe = normalizarClabe(texto("clabe"));
        const v = validarClabe(clabe);
        const clave = v.banco_clave;
        const bancoRow = clave
          ? (db.prepare("SELECT clave, nombre_corto FROM bancos_spei WHERE clave = ?").get(clave) as
              | { clave: string; nombre_corto: string }
              | undefined)
          : undefined;
        const cuenta = cuentaDesdeClabe(clabe);
        const paternoN = normalizarNombrePortal(texto("paterno"));
        const maternoN = normalizarNombrePortal(texto("materno"));
        const nombreN = normalizarNombrePortal(texto("nombre"));
        const erroresLinea = [...v.errores];
        if (!paternoN && !maternoN && !nombreN) erroresLinea.push("nombre vacío (paterno/materno/nombre)");
        if (v.ok && !bancoRow) erroresLinea.push(`banco no reconocido (prefijo ${clave || "—"})`);
        if (v.ok && bancoRow && !cuenta) erroresLinea.push(`sin regla de cuenta para el banco ${bancoRow.nombre_corto}`);
        if (erroresLinea.length) {
          errores.push({ linea: idx + 1, errores: erroresLinea });
          return;
        }
        const ben = normalizarNombrePortal(nombreCompleto(paternoN, maternoN, nombreN));
        const previa = altaDeCuenta(db, bancoRow!.nombre_corto, cuenta);
        if (previa && (previa.estado === "registrada" || previa.estado === "solicitada")) {
          duplicadas.push({
            linea: idx + 1,
            beneficiario: ben,
            banco: bancoRow!.nombre_corto,
            cuenta,
            estado: previa.estado,
            alta_id: previa.id,
          });
          return;
        }
        const idAlta = insertarAlta.run(
          ben,
          bancoRow!.nombre_corto,
          cuenta,
          clabe,
          typeof ln.notas === "string" ? ln.notas.trim() : "",
          req.usuario!.id
        ).lastInsertRowid as number;
        for (const p of portalesInfo) insertarPortal.run(idAlta, p.id, req.usuario!.id);
        creadas.push({
          alta_id: idAlta,
          linea: idx + 1,
          beneficiario: ben,
          paterno: paternoN,
          materno: maternoN,
          nombre: nombreN,
          clabe,
          banco: bancoRow!.nombre_corto,
          cuenta,
        });
      });
    })();
    registrarAuditoria(
      db,
      req.usuario!.id,
      "altas_lote",
      `Captura por lotes de altas en portales: ${creadas.length} creada(s), ${duplicadas.length} duplicada(s), ${errores.length} con error, ${portalesInfo.length} portal(es)`
    );
    res.status(201).json({ creadas, duplicadas, errores, portales: portalesInfo });
  });

  // Portales de una alta (matriz alta × portal del formato de alta).
  r.get(
    "/altas-bancarias/:id/portales",
    autenticar,
    requiereRol(
      "operacion",
      "altas",
      "admin_tesoreria",
      "admin",
      "admin_operaciones",
      "fondeador",
      "validador_tesoreria",
      "direccion",
      "auditoria"
    ),
    (req, res) => {
      const alta = db.prepare("SELECT id FROM altas_bancarias WHERE id = ?").get(Number(req.params.id)) as
        | { id: number }
        | undefined;
      if (!alta) {
        res.status(404).json({ error: "Alta bancaria no encontrada" });
        return;
      }
      const filas = db
        .prepare(
          `SELECT ap.*, c.nombre AS portal, u.nombre AS registrador
           FROM altas_portales ap
           JOIN cuentas c ON c.id = ap.portal_cuenta_id
           LEFT JOIN usuarios u ON u.id = ap.registrado_por
           WHERE ap.alta_bancaria_id = ?
           ORDER BY ap.id`
        )
        .all(alta.id) as unknown as import("./db.js").AltaPortal[];
      res.json({ portales: filas });
    }
  );

  // Agregar un portal (pagadora) a una alta.
  r.post("/altas-bancarias/:id/portales", autenticar, usuarioVivo, requiereRol("altas", "admin_tesoreria", "admin"), (req, res) => {
    const alta = db.prepare("SELECT * FROM altas_bancarias WHERE id = ?").get(Number(req.params.id)) as
      | import("./db.js").AltaBancaria
      | undefined;
    if (!alta) {
      res.status(404).json({ error: "Alta bancaria no encontrada" });
      return;
    }
    const portalId = Number(req.body?.portal_cuenta_id);
    if (!Number.isInteger(portalId) || portalId <= 0) {
      res.status(400).json({ error: "portal_cuenta_id requerido" });
      return;
    }
    const portal = db.prepare("SELECT id, nombre FROM cuentas WHERE id = ? AND activa = 1").get(portalId) as
      | { id: number; nombre: string }
      | undefined;
    if (!portal) {
      res.status(404).json({ error: "El portal (pagadora) no existe o está fuera de operación" });
      return;
    }
    const previo = db
      .prepare("SELECT id FROM altas_portales WHERE alta_bancaria_id = ? AND portal_cuenta_id = ?")
      .get(alta.id, portalId);
    if (previo) {
      res.status(409).json({ error: `La alta ya está ligada al portal '${portal.nombre}'` });
      return;
    }
    const id = db
      .prepare("INSERT INTO altas_portales (alta_bancaria_id, portal_cuenta_id, creado_por) VALUES (?, ?, ?)")
      .run(alta.id, portalId, req.usuario!.id).lastInsertRowid as number;
    const fila = db
      .prepare(
        "SELECT ap.*, c.nombre AS portal FROM altas_portales ap JOIN cuentas c ON c.id = ap.portal_cuenta_id WHERE ap.id = ?"
      )
      .get(id) as import("./db.js").AltaPortal;
    // Un portal nuevo nace pendiente: si la alta estaba REGISTRADA, vuelve a la
    // cola (no se dispersa una cuenta con un portal sin alta). El borrado y el
    // cambio de estado recalculan igual (misma regla, un solo lugar).
    const altaFinal = recalcularAltaPorPortales(db, alta.id, req.usuario!.id);
    res.status(201).json({ portal: fila, alta: altaFinal });
  });

  /** Recalcula el estado de la alta según sus portales y lo persiste. */
  const recalcularAltaPorPortales = (
    db: Database,
    altaId: number,
    usuarioId: number
  ): import("./db.js").AltaBancaria | undefined => {
    const alta = db.prepare("SELECT * FROM altas_bancarias WHERE id = ?").get(altaId) as
      | import("./db.js").AltaBancaria
      | undefined;
    if (!alta) return undefined;
    const conteos = db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN estado = 'dada_de_alta' THEN 1 ELSE 0 END), 0) AS dadas
         FROM altas_portales WHERE alta_bancaria_id = ?`
      )
      .get(altaId) as { total: number; dadas: number };
    if (conteos.total > 0) {
      if (conteos.dadas === conteos.total && alta.estado !== "registrada") {
        db.prepare(
          "UPDATE altas_bancarias SET estado = 'registrada', resuelto_por = ?, resuelto_en = datetime('now') WHERE id = ?"
        ).run(usuarioId, altaId);
        registrarAuditoria(
          db,
          usuarioId,
          "alta_registrada_portales",
          `Alta de '${alta.beneficiario}' (${alta.banco}, ${alta.cuenta}) marcada REGISTRADA: todos sus portales (${conteos.total}) quedaron dados de alta`,
          alta.operacion_id
        );
      } else if (conteos.dadas < conteos.total && alta.estado === "registrada") {
        // Un portal rechazó o volvió a pendiente: la cuenta vuelve a la cola
        // (Tesorería no debe dispersar una cuenta con portales sin alta).
        db.prepare(
          "UPDATE altas_bancarias SET estado = 'solicitada', resuelto_por = NULL, resuelto_en = NULL WHERE id = ?"
        ).run(altaId);
        registrarAuditoria(
          db,
          usuarioId,
          "alta_revertida_portales",
          `Alta de '${alta.beneficiario}' (${alta.banco}, ${alta.cuenta}) vuelve a SOLICITADA: hay portales sin alta (${conteos.dadas}/${conteos.total})`,
          alta.operacion_id
        );
      }
    }
    return db.prepare("SELECT * FROM altas_bancarias WHERE id = ?").get(altaId) as
      | import("./db.js").AltaBancaria
      | undefined;
  };

  // Estado de un registro de portal: pendiente | dada_de_alta | rechazada.
  r.post("/altas-portales/:id/estado", autenticar, usuarioVivo, requiereRol("altas", "admin_tesoreria", "admin"), (req, res) => {
    const ap = db.prepare("SELECT * FROM altas_portales WHERE id = ?").get(Number(req.params.id)) as
      | import("./db.js").AltaPortal
      | undefined;
    if (!ap) {
      res.status(404).json({ error: "Registro de portal no encontrado" });
      return;
    }
    const estado = typeof req.body?.estado === "string" ? req.body.estado : "";
    if (!("pendiente" === estado || "dada_de_alta" === estado || "rechazada" === estado)) {
      res.status(400).json({ error: "estado inválido (pendiente | dada_de_alta | rechazada)" });
      return;
    }
    const motivo = typeof req.body?.motivo === "string" ? req.body.motivo.trim() : "";
    if (estado === "rechazada" && !motivo) {
      res.status(400).json({ error: "el rechazo requiere motivo" });
      return;
    }
    db.prepare(
      `UPDATE altas_portales SET estado = ?, motivo_rechazo = ?, registrado_por = ?, registrado_en = datetime('now')
       WHERE id = ?`
    ).run(estado, estado === "rechazada" ? motivo : "", req.usuario!.id, ap.id);
    const alta = recalcularAltaPorPortales(db, ap.alta_bancaria_id, req.usuario!.id);
    const fila = db
      .prepare(
        "SELECT ap.*, c.nombre AS portal, u.nombre AS registrador FROM altas_portales ap JOIN cuentas c ON c.id = ap.portal_cuenta_id LEFT JOIN usuarios u ON u.id = ap.registrado_por WHERE ap.id = ?"
      )
      .get(ap.id) as import("./db.js").AltaPortal;
    res.json({ portal: fila, alta });
  });

  // Quitar el registro de un portal de una alta (corrección de captura).
  r.delete("/altas-portales/:id", autenticar, usuarioVivo, requiereRol("altas", "admin_tesoreria", "admin"), (req, res) => {
    const ap = db.prepare("SELECT * FROM altas_portales WHERE id = ?").get(Number(req.params.id)) as
      | import("./db.js").AltaPortal
      | undefined;
    if (!ap) {
      res.status(404).json({ error: "Registro de portal no encontrado" });
      return;
    }
    db.prepare("DELETE FROM altas_portales WHERE id = ?").run(ap.id);
    const alta = recalcularAltaPorPortales(db, ap.alta_bancaria_id, req.usuario!.id);
    res.json({ ok: true, alta });
  });

  // Filas de UN portal (pagadora): las altas ligadas con su CLABE/cuenta/nombre
  // normalizado, listas para teclear o pegar en el portal bancario.
  r.get("/altas-portales", autenticar, requiereRol("altas", "admin_tesoreria", "admin"), (req, res) => {
    const portalId = Number(req.query.portal_cuenta_id);
    if (!Number.isInteger(portalId) || portalId <= 0) {
      res.status(400).json({ error: "portal_cuenta_id requerido" });
      return;
    }
    const filas = db
      .prepare(
        `SELECT ap.id AS alta_portal_id, ap.estado AS estado_portal, ap.motivo_rechazo,
                ap.registrado_en, ab.id AS alta_id, ab.beneficiario, ab.banco, ab.cuenta,
                ab.clabe, ab.moneda, ab.estado AS estado_alta, u.nombre AS registrador
         FROM altas_portales ap
         JOIN altas_bancarias ab ON ab.id = ap.alta_bancaria_id
         LEFT JOIN usuarios u ON u.id = ap.registrado_por
         WHERE ap.portal_cuenta_id = ?
         ORDER BY CASE ap.estado WHEN 'pendiente' THEN 0 ELSE 1 END, ap.id`
      )
      .all(portalId);
    res.json({ filas });
  });

  // ---- Fase 12: asignación de ejecutivos a validadores (Administrador de
  // Validación). El validador visualiza las operaciones capturadas por los
  // ejecutivos que le asignen; el admin de validación ve todo. Append-only:
  // reasignar cierra la asignación vigente del ejecutivo y abre la nueva.
  r.post("/validacion/asignar-ejecutivo", autenticar, usuarioVivo, requiereRol("admin_validacion"), (req, res) => {
    const { validador_id, ejecutivo_id, motivo } = req.body ?? {};
    if (!Number.isInteger(validador_id) || !Number.isInteger(ejecutivo_id)) {
      res.status(400).json({ error: "validador_id y ejecutivo_id son requeridos" });
      return;
    }
    const validador = db
      .prepare("SELECT id, username, nombre, rol, activo FROM usuarios WHERE id = ?")
      .get(validador_id) as { id: number; username: string; nombre: string; rol: Rol; activo: number } | undefined;
    if (!validador || validador.rol !== "validacion") {
      res.status(400).json({ error: "El validador debe existir y tener rol 'validacion'" });
      return;
    }
    if (validador.activo !== 1) {
      res.status(400).json({ error: "El validador está desactivado" });
      return;
    }
    const ejecutivo = db
      .prepare("SELECT id, username, nombre, rol, activo FROM usuarios WHERE id = ?")
      .get(ejecutivo_id) as { id: number; username: string; nombre: string; rol: Rol; activo: number } | undefined;
    if (!ejecutivo || ejecutivo.rol !== "operacion") {
      res.status(400).json({ error: "El ejecutivo debe existir y tener rol 'operacion'" });
      return;
    }
    if (ejecutivo.activo !== 1) {
      res.status(400).json({ error: "El ejecutivo está desactivado" });
      return;
    }
    const previa = db
      .prepare(
        "SELECT id FROM validacion_ejecutivos WHERE ejecutivo_id = ? AND validador_id = ? AND activo = 1 AND cerrado_en IS NULL"
      )
      .get(ejecutivo_id, validador_id);
    if (previa) {
      res.status(409).json({ error: "Ese ejecutivo ya está asignado a ese validador" });
      return;
    }
    const idAsig = db.transaction(() => {
      db.prepare(
        "UPDATE validacion_ejecutivos SET activo = 0, cerrado_en = datetime('now') WHERE ejecutivo_id = ? AND activo = 1 AND cerrado_en IS NULL"
      ).run(ejecutivo_id);
      return db
        .prepare(
          "INSERT INTO validacion_ejecutivos (validador_id, ejecutivo_id, motivo, asignado_por) VALUES (?, ?, ?, ?)"
        )
        .run(validador_id, ejecutivo_id, typeof motivo === "string" ? motivo.trim() : "", req.usuario!.id)
        .lastInsertRowid;
    })();
    registrarAuditoria(
      db,
      req.usuario!.id,
      "validacion_ejecutivo_asignado",
      `Ejecutivo '${ejecutivo.username}' asignado al validador '${validador.username}'${motivo ? ` (motivo: ${String(motivo).trim()})` : ""}`
    );
    const asignacion = db.prepare("SELECT * FROM validacion_ejecutivos WHERE id = ?").get(idAsig);
    res.status(201).json({ asignacion });
  });

  r.get(
    "/validacion/asignaciones-ejecutivos",
    autenticar,
    requiereRol("admin_validacion", "admin", "auditoria"),
    (_req, res) => {
      const filas = db
        .prepare(
          `SELECT ve.*, uv.nombre AS validador, uv.username AS validador_username,
                  ue.nombre AS ejecutivo, ue.username AS ejecutivo_username,
                  ua.nombre AS asignador
           FROM validacion_ejecutivos ve
           JOIN usuarios uv ON uv.id = ve.validador_id
           JOIN usuarios ue ON ue.id = ve.ejecutivo_id
           JOIN usuarios ua ON ua.id = ve.asignado_por
           ORDER BY ve.activo DESC, ve.id DESC`
        )
        .all();
      res.json({ asignaciones: filas });
    }
  );

  r.post("/validacion/asignaciones-ejecutivos/:id/cerrar", autenticar, usuarioVivo, requiereRol("admin_validacion"), (req, res) => {
    const asig = db
      .prepare("SELECT * FROM validacion_ejecutivos WHERE id = ?")
      .get(Number(req.params.id)) as import("./db.js").ValidacionEjecutivo | undefined;
    if (!asig) {
      res.status(404).json({ error: "Asignación no encontrada" });
      return;
    }
    if (asig.activo !== 1 || asig.cerrado_en) {
      res.status(409).json({ error: "La asignación ya está cerrada" });
      return;
    }
    db.prepare(
      "UPDATE validacion_ejecutivos SET activo = 0, cerrado_en = datetime('now') WHERE id = ?"
    ).run(asig.id);
    registrarAuditoria(
      db,
      req.usuario!.id,
      "validacion_ejecutivo_desasignado",
      `Asignación #${asig.id} de ejecutivo cerrada por el Administrador de Validación`
    );
    const actualizada = db.prepare("SELECT * FROM validacion_ejecutivos WHERE id = ?").get(asig.id);
    res.json({ asignacion: actualizada });
  });

  // ---- Financiamientos (§6.1): Dirección aprueba o rechaza; al aprobarse el
  // monto ingresa al resguardo del cliente como movimiento 'financiamiento'.
  r.get(
    "/financiamientos",
    autenticar,
    requiereRol("direccion", "admin", "auditoria", "admin_operaciones"),
    (req, res) => {
      const estado = typeof req.query.estado === "string" ? req.query.estado : "";
      const permitidos = ["solicitado", "aprobado", "rechazado", "cancelado"];
      if (estado && !permitidos.includes(estado)) {
        res.status(400).json({ error: `estado inválido (${permitidos.join(" | ")})` });
        return;
      }
      const filas = db
        .prepare(
          `SELECT f.*, c.nombre AS cliente, o.folio, o.concepto, o.monto AS monto_operacion, o.estado AS estado_operacion,
                  u.nombre AS solicitador, ru.nombre AS resolutor
           FROM financiamientos f
           JOIN clientes c ON c.id = f.cliente_id
           JOIN operaciones o ON o.id = f.operacion_id
           JOIN usuarios u ON u.id = f.solicitado_por
           LEFT JOIN usuarios ru ON ru.id = f.resuelto_por
           ${estado ? "WHERE f.estado = ?" : ""}
           ORDER BY CASE WHEN f.estado = 'solicitado' THEN 0 ELSE 1 END, f.id DESC`
        )
        .all(...(estado ? [estado] : []));
      res.json({ financiamientos: filas });
    }
  );

  // Aprobación de un financiamiento: ingresa al resguardo del cliente en la
  // misma transacción (§14: saldo calculado) y queda a nombre de Dirección.
  r.post("/financiamientos/:id/aprobar", autenticar, usuarioVivo, requiereRol("direccion", "admin"), (req, res) => {
    const fin = db
      .prepare("SELECT * FROM financiamientos WHERE id = ?")
      .get(Number(req.params.id)) as import("./db.js").Financiamiento | undefined;
    if (!fin) {
      res.status(404).json({ error: "Financiamiento no encontrado" });
      return;
    }
    if (fin.estado !== "solicitado") {
      res.status(409).json({ error: `El financiamiento está en '${fin.estado}'; sólo se aprueban los 'solicitado'` });
      return;
    }
    const cliente = db.prepare("SELECT id, nombre FROM clientes WHERE id = ?").get(fin.cliente_id) as
      | { id: number; nombre: string }
      | undefined;
    if (!cliente) {
      res.status(404).json({ error: "Cliente del financiamiento no encontrado" });
      return;
    }
    const op = db.prepare("SELECT folio FROM operaciones WHERE id = ?").get(fin.operacion_id) as
      | { folio: string }
      | undefined;
    db.transaction(() => {
      const movId = db
        .prepare(
          `INSERT INTO resguardos_movimientos (cliente_id, tipo, importe, operacion_id, comprobante, observaciones, creado_por)
           VALUES (?, 'financiamiento', ?, ?, 'FINANCIAMIENTO', ?, ?)`
        )
        .run(
          fin.cliente_id,
          fin.monto,
          fin.operacion_id,
          `Financiamiento aprobado por Dirección${fin.notas ? ` — ${fin.notas}` : ""}`,
          req.usuario!.id
        ).lastInsertRowid;
      db
        .prepare(
          "UPDATE financiamientos SET estado = 'aprobado', resuelto_por = ?, resuelto_en = datetime('now'), movimiento_id = ? WHERE id = ?"
        )
        .run(req.usuario!.id, movId, fin.id);
    })();
    registrarAuditoria(
      db,
      req.usuario!.id,
      "financiamiento_aprobado",
      `Financiamiento de $${fin.monto.toFixed(2)} aprobado para '${cliente.nombre}' (operación ${op?.folio ?? fin.operacion_id}) — ingresó al resguardo`,
      fin.operacion_id
    );
    res.json({
      financiamiento: db.prepare("SELECT * FROM financiamientos WHERE id = ?").get(fin.id),
      saldo: saldoResguardo(db, fin.cliente_id),
    });
  });

  r.post("/financiamientos/:id/rechazar", autenticar, usuarioVivo, requiereRol("direccion", "admin"), (req, res) => {
    const fin = db
      .prepare("SELECT * FROM financiamientos WHERE id = ?")
      .get(Number(req.params.id)) as import("./db.js").Financiamiento | undefined;
    if (!fin) {
      res.status(404).json({ error: "Financiamiento no encontrado" });
      return;
    }
    if (fin.estado !== "solicitado") {
      res.status(409).json({ error: `El financiamiento está en '${fin.estado}'; sólo se rechazan los 'solicitado'` });
      return;
    }
    const motivo = typeof req.body?.motivo === "string" ? req.body.motivo.trim() : "";
    db
      .prepare(
        "UPDATE financiamientos SET estado = 'rechazado', resuelto_por = ?, resuelto_en = datetime('now') WHERE id = ?"
      )
      .run(req.usuario!.id, fin.id);
    registrarAuditoria(
      db,
      req.usuario!.id,
      "financiamiento_rechazado",
      `Financiamiento de $${fin.monto.toFixed(2)} rechazado (operación ${fin.operacion_id})${motivo ? `: ${motivo}` : ""}`,
      fin.operacion_id
    );
    res.json({ financiamiento: db.prepare("SELECT * FROM financiamientos WHERE id = ?").get(fin.id) });
  });

  r.get("/reportes/direccion", autenticar, requiereRol("direccion"), (_req, res) => {
    const porEstado = db
      .prepare(
        `SELECT estado, COUNT(*) AS operaciones, COALESCE(SUM(monto), 0) AS monto
         FROM operaciones GROUP BY estado ORDER BY estado`
      )
      .all();
    const pendientes = db
      .prepare(
        `SELECT o.*, u.nombre AS capturista FROM operaciones o JOIN usuarios u ON u.id = o.creado_por
         WHERE o.estado = 'pendiente_direccion' ORDER BY o.monto DESC`
      )
      .all();
    const totales = db
      .prepare(
        `SELECT COUNT(*) AS operaciones, COALESCE(SUM(monto), 0) AS monto FROM operaciones
         WHERE estado <> 'cancelada'`
      )
      .get() as { operaciones: number; monto: number };
    const pagosMes = db
      .prepare(
        `SELECT COUNT(*) AS pagos, COALESCE(SUM(p.monto), 0) AS monto
         FROM pagos p
         WHERE p.fecha_pago >= date('now', '-30 days')`
      )
      .get() as { pagos: number; monto: number };
    const pendientesTesoreria = db
      .prepare(
        `SELECT COUNT(*) AS operaciones, COALESCE(SUM(monto), 0) AS monto
         FROM operaciones WHERE estado = 'aprobada'`
      )
      .get() as { operaciones: number; monto: number };
    res.json({
      umbral_direccion: leerUmbralDireccion(db),
      por_estado: porEstado,
      pendientes_direccion: pendientes,
      totales,
      pagos_ultimos_30_dias: pagosMes,
      pendientes_tesoreria: pendientesTesoreria,
    });
  });

  // ---- Tesorería: pago con comprobante (tandas del formato FLUJO) ----
  r.post("/operaciones/:id/pago", autenticar, requiereRol("tesoreria"), (req, res) => {
    const { medio, monto, fecha_pago, comprobante, notas, cuenta_id } = req.body ?? {};
    const errores: string[] = [];
    if (!MEDIOS_PAGO.includes(medio)) errores.push(`medio inválido (${MEDIOS_PAGO.join(" | ")})`);
    if (typeof monto !== "number" || !(monto > 0)) errores.push("monto debe ser mayor a 0");
    if (typeof comprobante !== "string" || !comprobante.trim())
      errores.push("comprobante (folio o referencia) requerido");
    const fecha = fecha_pago ?? new Date().toISOString().slice(0, 10);
    if (typeof fecha !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(fecha))
      errores.push("fecha_pago en formato YYYY-MM-DD");
    if (errores.length) {
      res.status(400).json({ error: "Datos inválidos", detalles: errores });
      return;
    }

    if (typeof cuenta_id !== "undefined" && cuenta_id !== null) {
      const cuenta = db.prepare("SELECT id, activa FROM cuentas WHERE id = ?").get(cuenta_id) as
        | { id: number; activa: number }
        | undefined;
      if (!cuenta || !cuenta.activa) {
        res.status(400).json({ error: "cuenta_id inválida o inactiva" });
        return;
      }
    }

    const op = db.prepare("SELECT * FROM operaciones WHERE id = ?").get(Number(req.params.id)) as
      | Operacion
      | undefined;
    if (!op) {
      res.status(404).json({ error: "Operación no encontrada" });
      return;
    }
    const ctx = contextoPago(db, op);
    if (!["aprobada", "en_pago"].includes(op.estado)) {
      res.status(409).json({ error: `La operación está en '${op.estado}', se requiere 'aprobada'` });
      return;
    }
    // Liberación del Fondeador (Fase 12): el analista de Tesorería sólo paga
    // operaciones ya liberadas por el Tesorero Fondeador.
    if (!op.liberada_en) {
      res.status(409).json({
        error: "La operación requiere la liberación del Tesorero Fondeador antes de dispersar",
      });
      return;
    }
    // Altas bancarias (Fase 12): Tesorería no dispersa a cuentas sin el alta
    // registrada en el banco (las líneas sin banco/cuenta no son verificables).
    const sinAlta = verificarAltasOperacion(db, op.id);
    if (sinAlta.length > 0) {
      const lista = sinAlta
        .map((f) => `${f.beneficiario} (${f.banco}, ${f.cuenta})`)
        .join(", ");
      res.status(409).json({
        error: `Tesorería no puede pagar: hay ${sinAlta.length} cuenta(s) sin alta bancaria registrada — ${lista}. Solicita el alta en 'Altas bancarias'.`,
        altas_pendientes: sinAlta,
      });
      return;
    }
    // Operaciones sin dispersiones (formato anterior): pago único exacto
    // (comportamiento y pruebas originales).
    if (!ctx.tieneDispersiones && Math.abs(monto - op.monto) > 0.005) {
      res.status(400).json({
        error: `El monto del pago (${monto}) debe coincidir con el monto de la operación (${op.monto})`,
        monto_operacion: op.monto,
      });
      return;
    }
    // Con dispersiones: la tanda no excede el restante por dispersar.
    if (ctx.tieneDispersiones && monto > ctx.restante + 0.005) {
      res.status(400).json({
        error: `La tanda (${monto.toFixed(2)}) excede el restante por dispersar (${ctx.restante.toFixed(2)})`,
        total_por_dispersar: ctx.totalPorDispersar,
        restante: ctx.restante,
      });
      return;
    }

    // Resguardo del cliente (§14): cada tanda resta del resguardo. Sin saldo
    // suficiente no se paga — un saldo negativo sólo sería posible con una
    // autorización válida de Dirección (§6.1, módulo de financiamientos).
    if (op.cliente_id !== null) {
      const saldo = saldoResguardo(db, op.cliente_id);
      if (saldo - monto < -0.005) {
        res.status(409).json({
          error: `Resguardo insuficiente del cliente: saldo ${saldo.toFixed(2)}, tanda ${monto.toFixed(2)}`,
          saldo_resguardo: saldo,
        });
        return;
      }
    }

    try {
      const r = registrarTanda(db, op, {
        medio,
        monto,
        comprobante: comprobante.trim(),
        fecha_pago: fecha,
        notas: typeof notas === "string" ? notas.trim() : "",
        cuenta_id: typeof cuenta_id === "number" ? cuenta_id : null,
      }, req.usuario!.id);
      res.status(201).json({
        operacion: r.operacion,
        pago: r.pago,
        completado: r.completado,
        pagado: r.pagado,
      });
    } catch (e) {
      res.status(e instanceof ErrorDominio ? e.status : 500).json({ error: (e as Error).message });
    }
  });

  // Registro de varias tandas en una sola llamada (lote por layout): todas o
  // ninguna — si alguna excede el restante o falla, se revierte el lote.
  r.post("/operaciones/:id/pagos", autenticar, requiereRol("tesoreria"), (req, res) => {
    const lote = req.body?.pagos;
    if (!Array.isArray(lote) || lote.length === 0) {
      res.status(400).json({ error: "'pagos' (arreglo con al menos una tanda) es requerido" });
      return;
    }
    if (lote.length > 100) {
      res.status(400).json({ error: "máximo 100 tandas por lote" });
      return;
    }
    const op = db.prepare("SELECT * FROM operaciones WHERE id = ?").get(Number(req.params.id)) as
      | Operacion
      | undefined;
    if (!op) {
      res.status(404).json({ error: "Operación no encontrada" });
      return;
    }
    if (op.tipo !== "flujo") {
      res.status(409).json({ error: "El registro por lote aplica a operaciones con formato completo (dispersiones)" });
      return;
    }
    // Liberación del Fondeador y altas bancarias (Fase 12): mismos bloqueos que
    // el registro de tanda individual.
    if (!op.liberada_en) {
      res.status(409).json({
        error: "La operación requiere la liberación del Tesorero Fondeador antes de dispersar",
      });
      return;
    }
    const sinAlta = verificarAltasOperacion(db, op.id);
    if (sinAlta.length > 0) {
      const lista = sinAlta.map((f) => `${f.beneficiario} (${f.banco}, ${f.cuenta})`).join(", ");
      res.status(409).json({
        error: `Tesorería no puede pagar: hay ${sinAlta.length} cuenta(s) sin alta bancaria registrada — ${lista}. Solicita el alta en 'Altas bancarias'.`,
        altas_pendientes: sinAlta,
      });
      return;
    }
    const tandas: DatosTanda[] = [];
    for (const [i, fila] of (lote as Array<Record<string, unknown>>).entries()) {
      const f = i + 1;
      const medio = typeof fila?.medio === "string" && (MEDIOS_PAGO as readonly string[]).includes(fila.medio) ? fila.medio : "transferencia";
      const monto = typeof fila?.monto === "number" ? redondear2(fila.monto) : NaN;
      if (!Number.isFinite(monto) || monto <= 0) {
        res.status(400).json({ error: `tanda ${f}: monto debe ser mayor a 0` });
        return;
      }
      const comprobante = typeof fila?.comprobante === "string" ? fila.comprobante.trim() : "";
      if (!comprobante) {
        res.status(400).json({ error: `tanda ${f}: comprobante requerido` });
        return;
      }
      const fecha = typeof fila?.fecha_pago === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fila.fecha_pago)
        ? fila.fecha_pago
        : new Date().toISOString().slice(0, 10);
      const cuentaId = typeof fila?.cuenta_id === "number" ? fila.cuenta_id : null;
      if (cuentaId !== null) {
        const cuenta = db.prepare("SELECT id, activa FROM cuentas WHERE id = ?").get(cuentaId) as
          | { id: number; activa: number }
          | undefined;
        if (!cuenta || !cuenta.activa) {
          res.status(400).json({ error: `tanda ${f}: cuenta_id inválida o inactiva` });
          return;
        }
      }
      tandas.push({
        medio,
        monto,
        comprobante,
        fecha_pago: fecha,
        notas: typeof fila?.notas === "string" ? fila.notas.trim() : "",
        cuenta_id: cuentaId,
      });
    }
    try {
      const resultados = db.transaction(() =>
        tandas.map((datos) => {
          const actual = db.prepare("SELECT * FROM operaciones WHERE id = ?").get(op.id) as Operacion;
          const ctx = contextoPago(db, actual);
          validarTanda(db, actual, datos, ctx);
          return registrarTanda(db, actual, datos, req.usuario!.id);
        })
      )();
      const ultima = resultados[resultados.length - 1];
      res.status(201).json({
        operacion: ultima.operacion,
        pagos: resultados.map((r) => r.pago),
        completado: ultima.completado,
        pagado: ultima.pagado,
      });
    } catch (e) {
      res.status(e instanceof ErrorDominio ? e.status : 500).json({ error: (e as Error).message });
    }
  });

  r.get("/pagos", autenticar, requiereRol("tesoreria", "direccion", "auditoria", "operacion"), (req, res) => {
    // Comprobantes (01-ROLES.md §3.2): el ejecutivo consulta los pagos de sus
    // operaciones (propias o de clientes asignados) para descargarlos.
    let sql = `SELECT p.*, o.folio, u.nombre AS pagador, c.nombre AS cliente
         FROM pagos p
         JOIN operaciones o ON o.id = p.operacion_id
         JOIN usuarios u ON u.id = p.pagado_por
         LEFT JOIN clientes c ON c.id = o.cliente_id`;
    const params: unknown[] = [];
    if (req.usuario!.rol === "operacion") {
      // Comprobantes (01-ROLES.md §3.2): el ejecutivo consulta los pagos de sus
      // operaciones (propias o de clientes asignados/cubiertos) para descargarlos.
      sql += ` WHERE (o.creado_por = ? OR o.cliente_id IN (
        SELECT cliente_id FROM cliente_asignaciones WHERE ejecutivo_id = ? AND activo = 1 AND cerrado_en IS NULL
        UNION
        SELECT cliente_id FROM cliente_coberturas WHERE ejecutivo_temporal_id = ? AND activo = 1 AND (fecha_fin IS NULL OR fecha_fin >= date('now'))
      ))`;
      params.push(req.usuario!.id, req.usuario!.id, req.usuario!.id);
    }
    sql += " ORDER BY p.id DESC";
    const filas = db.prepare(sql).all(...params);
    res.json({ pagos: filas });
  });

  // Catálogo ligero de cuentas activas (nombres, sin saldos): lo usa el
  // Ejecutivo al indicar la cuenta donde el cliente depositó (§5.3) y los
  // selectores de pagadoras. Fase 13: cada fila trae `visible_operador` (1/0) —
  // la UI oculta del listado de pagadoras las que Tesorería marcó como no
  // visibles para operadores; sigue siendo una cuenta válida para depósitos.
  r.get("/cuentas/catalogo", autenticar, (_req, res) => {
    const filas = db
      .prepare(
        "SELECT id, nombre, banco, numero_cuenta, tipo, visible_operador FROM cuentas WHERE activa = 1 ORDER BY nombre"
      )
      .all();
    res.json({ cuentas: filas });
  });

  // Fase 13: Tesorería marca qué cuentas del catálogo son visibles para el
  // listado de PAGADORAS que ven los operadores al capturar. Es un control de
  // visibilidad (no bloquea pagos ni depósitos): todas nacen visibles.
  r.patch("/cuentas/:id/visible", autenticar, usuarioVivo, requiereRol("admin_tesoreria", "admin"), (req, res) => {
    const id = Number(req.params.id);
    const cuenta = db.prepare("SELECT * FROM cuentas WHERE id = ?").get(id) as
      | { id: number; nombre: string; visible_operador: number }
      | undefined;
    if (!cuenta) {
      res.status(404).json({ error: "Cuenta no encontrada" });
      return;
    }
    const { visible_operador, motivo } = req.body ?? {};
    if (typeof visible_operador !== "boolean") {
      res.status(400).json({ error: "visible_operador debe ser true (mostrar) o false (ocultar a operadores)" });
      return;
    }
    if (typeof motivo !== "undefined" && typeof motivo !== "string") {
      res.status(400).json({ error: "motivo debe ser texto" });
      return;
    }
    if (cuenta.visible_operador === (visible_operador ? 1 : 0)) {
      res.status(409).json({
        error: visible_operador
          ? "La cuenta ya es visible para los operadores"
          : "La cuenta ya está oculta para los operadores",
      });
      return;
    }
    db.prepare("UPDATE cuentas SET visible_operador = ? WHERE id = ?").run(visible_operador ? 1 : 0, id);
    registrarAuditoria(
      db,
      req.usuario!.id,
      "cuenta_visibilidad",
      `${visible_operador ? "Mostró" : "Ocultó"} la cuenta '${cuenta.nombre}' en el listado de pagadoras de los operadores${
        motivo && motivo.trim() ? ` — motivo: ${motivo.trim()}` : ""
      }`
    );
    const actualizada = db.prepare("SELECT * FROM cuentas WHERE id = ?").get(id);
    res.json({ cuenta: actualizada });
  });

  r.get(
    "/cuentas",
    autenticar,
    requiereRol("tesoreria", "admin_tesoreria", "validador_tesoreria", "confirmador", "direccion", "auditoria", "admin"),
    (req, res) => {
      // Alcance (01-ROLES.md §5.3, §12): un tesorero con cuentas asignadas (o
      // coberturas vigentes) consulta sólo esas cuentas. Si no tiene ninguna
      // asignación, consulta todas (compatibilidad con el flujo actual).
      // Tarea 12: el administrador puede pedir ?todas=1 para ver también las
      // cuentas fuera de operación (bloqueadas/inactivas) y reactivarlas.
      let where = "c.activa = 1";
      const params: unknown[] = [];
      if (
        (req.usuario!.rol === "admin_tesoreria" || req.usuario!.rol === "admin") &&
        req.query.todas === "1"
      ) {
        where = "1=1";
      }
      if (req.usuario!.rol === "tesoreria" && tesoreroTieneAsignaciones(db, req.usuario!.id)) {
        where = `c.activa = 1 AND c.id IN (
          SELECT cuenta_id FROM cuentas_asignaciones WHERE tesorero_id = ? AND activo = 1 AND cerrado_en IS NULL
          UNION
          SELECT cuenta_id FROM coberturas WHERE tesorero_temporal_id = ? AND activo = 1
            AND (fecha_fin IS NULL OR fecha_fin >= date('now'))
        )`;
        params.push(req.usuario!.id, req.usuario!.id);
      }
      const filas = db
        .prepare(
          `SELECT c.*,
             (c.saldo_inicial
               - COALESCE((SELECT SUM(p.monto) FROM pagos p WHERE p.cuenta_id = c.id), 0)
               + COALESCE((SELECT SUM(CASE WHEN m.tipo = 'deposito' THEN m.monto ELSE -m.monto END)
                           FROM movimientos_cuentas m WHERE m.cuenta_id = c.id), 0)
             ) AS saldo_actual,
             COALESCE((SELECT SUM(p.monto) FROM pagos p WHERE p.cuenta_id = c.id), 0) AS total_pagado,
             (SELECT u2.nombre FROM cuentas_asignaciones ca JOIN usuarios u2 ON u2.id = ca.tesorero_id
              WHERE ca.cuenta_id = c.id AND ca.activo = 1 AND ca.cerrado_en IS NULL
              ORDER BY ca.id DESC LIMIT 1) AS tesorero
           FROM cuentas c WHERE ${where} ORDER BY c.id`
        )
        .all(...params);
      res.json({ cuentas: filas });
    }
  );

  // ============ Fase 15 — Catálogo maestro de cuentas y bóveda ============

  // Listado ligero de portales (pagadoras activas) para las pantallas de altas
  // (el rol 'altas' no consulta el catálogo completo de cuentas).
  r.get("/cuentas/portales", autenticar, requiereRol("altas", "admin_tesoreria", "admin", "operacion", "tesoreria"), (_req, res) => {
    const portales = db
      .prepare("SELECT id, nombre FROM cuentas WHERE activa = 1 ORDER BY nombre")
      .all() as Array<{ id: number; nombre: string }>;
    res.json({ portales });
  });

  /** ¿El usuario puede ver la bóveda de esta cuenta? */
  const puedeVerBoveda = (usuarioId: number, rol: Rol, cuentaId: number): boolean => {
    if (rol === "admin_tesoreria" || rol === "admin") return true;
    if (rol !== "tesoreria") return false;
    const asignada = db
      .prepare(
        "SELECT 1 AS ok FROM cuentas_asignaciones WHERE cuenta_id = ? AND tesorero_id = ? AND activo = 1 AND cerrado_en IS NULL"
      )
      .get(cuentaId, usuarioId);
    if (asignada) return true;
    const cobertura = db
      .prepare(
        `SELECT 1 AS ok FROM coberturas
         WHERE cuenta_id = ? AND tesorero_temporal_id = ? AND activo = 1
           AND (fecha_fin IS NULL OR fecha_fin >= date('now'))`
      )
      .get(cuentaId, usuarioId);
    return Boolean(cobertura);
  };

  /** Proyecta una credencial SIN exponer campos sensibles (sólo banderas). */
  const proyectarCredencial = (f: Record<string, unknown>) => ({
    id: f.id as number,
    cuenta_id: f.cuenta_id as number,
    tipo: f.tipo as string,
    etiqueta: (f.etiqueta as string) ?? "",
    usuario: (f.usuario as string) ?? "",
    tiene_secreto: Boolean(f.secreto),
    tiene_nip: Boolean(f.nip),
    tiene_clave_seguridad: Boolean(f.clave_seguridad),
    token_numero: (f.token_numero as string) ?? "",
    telefono: (f.telefono as string) ?? "",
    correo: (f.correo as string) ?? "",
    vigencia: (f.vigencia as string) ?? "",
    notas: (f.notas as string) ?? "",
    activo: f.activo as number,
    creado_por: f.creado_por as number,
    creado_por_nombre: (f.creado_por_nombre as string) ?? "",
    creado_en: f.creado_en as string,
    actualizado_en: (f.actualizado_en as string | null) ?? null,
  });

  // Bóveda: listado de credenciales de una cuenta. Los secretos JAMÁS salen
  // aquí; se entrega uno por uno vía /credenciales/:id/secreto (con auditoría).
  r.get(
    "/cuentas/:id/credenciales",
    autenticar,
    usuarioVivo,
    requiereRol("tesoreria", "admin_tesoreria", "admin", "auditoria"),
    (req, res) => {
      const cuentaId = Number(req.params.id);
      const cuenta = db.prepare("SELECT id, nombre FROM cuentas WHERE id = ?").get(cuentaId) as
        | { id: number; nombre: string }
        | undefined;
      if (!cuenta) {
        res.status(404).json({ error: "Cuenta no encontrada" });
        return;
      }
      if (!puedeVerBoveda(req.usuario!.id, req.usuario!.rol, cuentaId)) {
        res.status(403).json({ error: "No tienes acceso a la bóveda de esta cuenta" });
        return;
      }
      const filas = db
        .prepare(
          `SELECT cc.*, u.nombre AS creado_por_nombre
           FROM cuentas_credenciales cc JOIN usuarios u ON u.id = cc.creado_por
           WHERE cc.cuenta_id = ? ORDER BY cc.activo DESC, cc.id`
        )
        .all(cuentaId) as unknown as Array<Record<string, unknown>>;
      res.json({ cuenta: cuenta.nombre, credenciales: filas.map(proyectarCredencial) });
    }
  );

  // Bóveda: crear credencial (multi-usuario por cuenta: PORTAL/CORREO/EPLATA/
  // SOFIPO/TOKEN, con etiqueta por persona o rol). Sensibles cifrados al entrar.
  r.post("/cuentas/:id/credenciales", autenticar, usuarioVivo, requiereRol("admin_tesoreria", "admin"), (req, res) => {
    const cuentaId = Number(req.params.id);
    const cuenta = db.prepare("SELECT id FROM cuentas WHERE id = ?").get(cuentaId) as
      | { id: number }
      | undefined;
    if (!cuenta) {
      res.status(404).json({ error: "Cuenta no encontrada" });
      return;
    }
    const b = req.body ?? {};
    const tipo = typeof b.tipo === "string" ? b.tipo : "portal";
    if (!(["portal", "correo", "eplata", "sofipo", "token", "otro"] as string[]).includes(tipo)) {
      res.status(400).json({ error: "tipo inválido (portal | correo | eplata | sofipo | token | otro)" });
      return;
    }
    const texto = (k: string) => (typeof b[k] === "string" ? (b[k] as string).trim() : "");
    const etiqueta = texto("etiqueta");
    const usuario = texto("usuario");
    const secreto = texto("secreto");
    if (!etiqueta && !usuario && !secreto) {
      res.status(400).json({ error: "captura al menos etiqueta, usuario o contraseña" });
      return;
    }
    const id = db
      .prepare(
        `INSERT INTO cuentas_credenciales
         (cuenta_id, tipo, etiqueta, usuario, secreto, nip, clave_seguridad, token_numero, telefono, correo, vigencia, notas, creado_por)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        cuentaId,
        tipo,
        etiqueta,
        usuario,
        cifrarSecreto(secreto),
        cifrarSecreto(texto("nip")),
        cifrarSecreto(texto("clave_seguridad")),
        texto("token_numero"),
        texto("telefono"),
        texto("correo"),
        texto("vigencia"),
        texto("notas"),
        req.usuario!.id
      ).lastInsertRowid as number;
    db.prepare("INSERT INTO credenciales_accesos (credencial_id, usuario_id, accion, campo) VALUES (?, ?, 'crear', '')").run(
      id,
      req.usuario!.id
    );
    registrarAuditoria(db, req.usuario!.id, "credencial_creada", `Credencial (${tipo}${etiqueta ? ` ${etiqueta}` : ""}) creada en la bóveda de la cuenta #${cuentaId}`);
    const fila = db
      .prepare("SELECT cc.*, u.nombre AS creado_por_nombre FROM cuentas_credenciales cc JOIN usuarios u ON u.id = cc.creado_por WHERE cc.id = ?")
      .get(id) as unknown as Record<string, unknown>;
    res.status(201).json({ credencial: proyectarCredencial(fila) });
  });

  // Bóveda: actualizar credencial. Si cambian sensibles se re-cifran; el valor
  // anterior se pierde a propósito (la bóveda guarda el valor vigente; el
  // historial queda en auditoría como evento, nunca como contenido).
  r.patch("/credenciales/:id", autenticar, usuarioVivo, requiereRol("admin_tesoreria", "admin"), (req, res) => {
    const cred = db.prepare("SELECT * FROM cuentas_credenciales WHERE id = ?").get(Number(req.params.id)) as
      | Record<string, unknown>
      | undefined;
    if (!cred) {
      res.status(404).json({ error: "Credencial no encontrada" });
      return;
    }
    const b = req.body ?? {};
    const texto = (k: string) => (typeof b[k] === "string" ? (b[k] as string).trim() : undefined);
    const cambios: string[] = [];
    const set: string[] = [];
    const vals: unknown[] = [];
    for (const campo of ["tipo", "etiqueta", "usuario", "token_numero", "telefono", "correo", "vigencia", "notas"]) {
      const v = texto(campo);
      if (v !== undefined && v !== cred[campo]) {
        if (campo === "tipo" && !(["portal", "correo", "eplata", "sofipo", "token", "otro"] as string[]).includes(v)) {
          res.status(400).json({ error: "tipo inválido (portal | correo | eplata | sofipo | token | otro)" });
          return;
        }
        set.push(`${campo} = ?`);
        vals.push(v);
        cambios.push(campo);
      }
    }
    if (typeof b.activo === "number" && (b.activo === 0 || b.activo === 1) && b.activo !== cred.activo) {
      set.push("activo = ?");
      vals.push(b.activo);
      cambios.push("activo");
    }
    for (const campo of ["secreto", "nip", "clave_seguridad"]) {
      if (typeof b[campo] === "string") {
        set.push(`${campo} = ?`);
        vals.push(cifrarSecreto(b[campo] as string));
        cambios.push(campo);
      }
    }
    if (!cambios.length) {
      res.status(400).json({ error: "nada que actualizar" });
      return;
    }
    set.push("actualizado_en = datetime('now')");
    db.prepare(`UPDATE cuentas_credenciales SET ${set.join(", ")} WHERE id = ?`).run(...vals, cred.id);
    db.prepare("INSERT INTO credenciales_accesos (credencial_id, usuario_id, accion, campo) VALUES (?, ?, 'actualizar', ?)").run(
      cred.id,
      req.usuario!.id,
      cambios.join(",")
    );
    registrarAuditoria(db, req.usuario!.id, "credencial_actualizada", `Credencial #${cred.id} actualizada (campos: ${cambios.join(", ")})`);
    const fila = db
      .prepare("SELECT cc.*, u.nombre AS creado_por_nombre FROM cuentas_credenciales cc JOIN usuarios u ON u.id = cc.creado_por WHERE cc.id = ?")
      .get(cred.id) as unknown as Record<string, unknown>;
    res.json({ credencial: proyectarCredencial(fila) });
  });

  // Bóveda: REVELAR un campo sensible (contraseña/NIP/clave de seguridad).
  // Autorizado: admin de tesorería/admin, y el tesorero con la cuenta asignada
  // (o cobertura vigente). CADA revelación queda auditada (quién, qué, cuándo).
  // El valor nunca se escribe en logs ni en auditoría.
  r.get("/credenciales/:id/secreto", autenticar, usuarioVivo, requiereRol("tesoreria", "admin_tesoreria", "admin"), (req, res) => {
    const campo = typeof req.query.campo === "string" ? req.query.campo : "secreto";
    if (!(["secreto", "nip", "clave_seguridad"] as string[]).includes(campo)) {
      res.status(400).json({ error: "campo inválido (secreto | nip | clave_seguridad)" });
      return;
    }
    const cred = db.prepare("SELECT * FROM cuentas_credenciales WHERE id = ?").get(Number(req.params.id)) as
      | Record<string, unknown>
      | undefined;
    if (!cred) {
      res.status(404).json({ error: "Credencial no encontrada" });
      return;
    }
    if (Number(cred.activo) !== 1) {
      res.status(409).json({ error: "La credencial está desactivada" });
      return;
    }
    if (!puedeVerBoveda(req.usuario!.id, req.usuario!.rol, Number(cred.cuenta_id))) {
      res.status(403).json({ error: "No tienes acceso a la bóveda de esta cuenta" });
      return;
    }
    const plano = descifrarSecreto(cred[campo] as string);
    if (!plano) {
      res.status(404).json({ error: "La credencial no tiene valor en ese campo" });
      return;
    }
    db.prepare("INSERT INTO credenciales_accesos (credencial_id, usuario_id, accion, campo) VALUES (?, ?, 'ver', ?)").run(
      cred.id,
      req.usuario!.id,
      campo
    );
    res.json({ campo, valor: plano });
  });

  // Auditoría de la bóveda de una cuenta: quién consultó/copió qué y cuándo.
  r.get(
    "/cuentas/:id/credenciales/accesos",
    autenticar,
    usuarioVivo,
    requiereRol("admin_tesoreria", "admin", "auditoria"),
    (req, res) => {
      const accesos = db
        .prepare(
          `SELECT ca.*, u.nombre AS usuario, cc.etiqueta, cc.tipo
           FROM credenciales_accesos ca
           JOIN usuarios u ON u.id = ca.usuario_id
           JOIN cuentas_credenciales cc ON cc.id = ca.credencial_id
           WHERE cc.cuenta_id = ?
           ORDER BY ca.id DESC LIMIT 500`
        )
        .all(Number(req.params.id));
      res.json({ accesos });
    }
  );

  // Catálogo maestro de la cuenta (Fase 15): CLABE, moneda, origen, estatus,
  // cliente, formato de reporte y fechas. Con CLABE válida auto-llena banco y
  // número de cuenta (regla por banco); si el banco ya asentado no coincide con
  // el prefijo de la CLABE, se rechaza para no romper el catálogo.
  r.patch("/cuentas/:id/catalogo", autenticar, usuarioVivo, requiereRol("admin_tesoreria", "admin"), (req, res) => {
    const cuentaId = Number(req.params.id);
    const cuenta = db.prepare("SELECT * FROM cuentas WHERE id = ?").get(cuentaId) as
      | (import("./db.js").Cuenta & { clabe?: string })
      | undefined;
    if (!cuenta) {
      res.status(404).json({ error: "Cuenta no encontrada" });
      return;
    }
    const b = req.body ?? {};
    const errores: string[] = [];
    const set: string[] = [];
    const vals: unknown[] = [];
    let bancoNuevo: string | null = null;
    // CLABE: normaliza, valida, resuelve banco y deriva cuenta.
    if (typeof b.clabe === "string") {
      const v = validarClabe(b.clabe);
      if (v.clabe && !v.ok) errores.push(...v.errores);
      if (v.clabe && v.ok) {
        const bancoRow = db.prepare("SELECT clave, nombre_corto FROM bancos_spei WHERE clave = ?").get(v.banco_clave) as
          | { clave: string; nombre_corto: string }
          | undefined;
        if (!bancoRow) errores.push(`banco no reconocido en el catálogo SPEI (prefijo ${v.banco_clave})`);
        else {
          const bancoPrevio = (cuenta.banco ?? "").trim().toUpperCase();
          const bancoDerivado = bancoRow.nombre_corto.toUpperCase();
          if (bancoPrevio && bancoPrevio !== bancoDerivado && typeof b.banco !== "string") {
            errores.push(
              `la CLABE es de ${bancoRow.nombre_corto} pero la cuenta está asentada como ${cuenta.banco}: corrige el banco si es lo correcto`
            );
          } else {
            set.push("clabe = ?", "banco = ?");
            vals.push(v.clabe, bancoRow.nombre_corto);
            bancoNuevo = bancoRow.nombre_corto;
            const derivada = cuentaDesdeClabe(v.clabe);
            if (derivada) {
              set.push("numero_cuenta = ?");
              vals.push(derivada);
            }
          }
        }
      } else if (!v.clabe) {
        set.push("clabe = ''");
      }
    }
    const textoCampo = (campo: string, max = 120): string | null => {
      if (typeof (b as Record<string, unknown>)[campo] !== "string") return null;
      const v = ((b as Record<string, string>)[campo] ?? "").trim();
      if (v.length > max) {
        errores.push(`${campo} excede ${max} caracteres`);
        return null;
      }
      return v;
    };
    const bancoTexto = textoCampo("banco");
    if (bancoTexto !== null && !bancoNuevo) {
      set.push("banco = ?");
      vals.push(bancoTexto);
    }
    for (const campo of ["origen", "cliente", "formato_reporte"] as const) {
      const v = textoCampo(campo);
      if (v !== null) {
        set.push(`${campo} = ?`);
        vals.push(v);
      }
    }
    if (typeof b.moneda === "string") {
      const mon = b.moneda.trim().toUpperCase();
      if (mon && !/^[A-Z]{3}$/.test(mon)) errores.push("moneda con 3 letras (MXN, USD)");
      else {
        set.push("moneda = ?");
        vals.push(mon || "MXN");
      }
    }
    if (typeof b.estatus === "string") {
      const est = b.estatus.trim().toUpperCase();
      if (est && !(["ACTIVA", "CANCELADA", "SUSPENDIDA"] as string[]).includes(est)) {
        errores.push("estatus inválido (ACTIVA | CANCELADA | SUSPENDIDA)");
      } else {
        set.push("estatus = ?");
        vals.push(est);
        if (est === "ACTIVA" && !b.fecha_baja) set.push("fecha_baja = NULL");
        if (est === "CANCELADA" || est === "SUSPENDIDA") {
          const hoyTxt = new Date().toISOString().slice(0, 10);
          set.push("fecha_baja = COALESCE(fecha_baja, ?)");
          vals.push(hoyTxt);
        }
      }
    }
    for (const campo of ["fecha_alta", "fecha_baja"] as const) {
      const v = (b as Record<string, unknown>)[campo];
      if (typeof v === "string") {
        const t = v.trim();
        if (t && !/^\d{4}-\d{2}-\d{2}$/.test(t)) errores.push(`${campo} con formato AAAA-MM-DD`);
        else {
          set.push(`${campo} = ?`);
          vals.push(t || null);
        }
      } else if (v === null) {
        set.push(`${campo} = NULL`);
      }
    }
    if (errores.length) {
      res.status(400).json({ error: "Datos inválidos", detalles: errores });
      return;
    }
    if (!set.length) {
      res.status(400).json({ error: "nada que actualizar" });
      return;
    }
    db.prepare(`UPDATE cuentas SET ${set.join(", ")} WHERE id = ?`).run(...vals, cuentaId);
    registrarAuditoria(db, req.usuario!.id, "catalogo_cuenta_actualizado", `Catálogo maestro de la cuenta '${cuenta.nombre}' (#${cuentaId}) actualizado`);
    const actualizada = db.prepare("SELECT * FROM cuentas WHERE id = ?").get(cuentaId);
    res.json({ cuenta: actualizada });
  });

  // Importador del catálogo (pegar desde el Excel de cuentas): líneas TSV
  // [nombre, banco, numero_cuenta, clabe, moneda, origen, estatus, cliente].
  // Dedupe por CLABE (si viene) o por banco+número; si existe, ACTUALIZA los
  // campos que lleguen llenos (no borra lo asentado) y no duplica.
  r.post("/cuentas/importar-lote", autenticar, usuarioVivo, requiereRol("admin_tesoreria", "admin"), (req, res) => {
    const crudo = req.body?.lineas;
    if (!Array.isArray(crudo) || crudo.length === 0) {
      res.status(400).json({ error: "lineas requerida: filas TSV [nombre, banco, numero_cuenta, clabe, moneda, origen, estatus, cliente]" });
      return;
    }
    const normalizaCelda = (v: unknown): string => (typeof v === "string" ? v.trim() : v === null || v === undefined ? "" : String(v).trim());
    const filas = (crudo as unknown[]).map((f) =>
      Array.isArray(f) ? f.map(normalizaCelda) : String(f ?? "").split("\t").map(normalizaCelda)
    );
    const creadas: string[] = [];
    const actualizadas: string[] = [];
    const errores: Array<{ linea: number; errores: string[] }> = [];
    db.transaction(() => {
      filas.forEach((celdas, idx) => {
        const [nombre, banco, numero, clabeCruda, moneda, origen, estatus, cliente] = celdas;
        const err: string[] = [];
        if (!nombre) err.push("nombre requerido");
        let clabe = "";
        let bancoDeClabe = "";
        if (clabeCruda) {
          const v = validarClabe(clabeCruda);
          if (!v.ok) err.push(...v.errores);
          else {
            const bancoRow = db.prepare("SELECT nombre_corto FROM bancos_spei WHERE clave = ?").get(v.banco_clave) as
              | { nombre_corto: string }
              | undefined;
            if (!bancoRow) err.push(`banco no reconocido (prefijo ${v.banco_clave})`);
            else {
              clabe = v.clabe;
              bancoDeClabe = bancoRow.nombre_corto;
            }
          }
        }
        if (estatus && !(["ACTIVA", "CANCELADA", "SUSPENDIDA"] as string[]).includes(estatus.toUpperCase()))
          err.push("estatus inválido (ACTIVA | CANCELADA | SUSPENDIDA)");
        if (err.length) {
          errores.push({ linea: idx + 1, errores: err });
          return;
        }
        const bancoFinal = banco || bancoDeClabe;
        const numeroFinal = numero || (clabe ? cuentaDesdeClabe(clabe) : "");
        // Dedupe: CLABE primero; banco+número después.
        const existente = (
          clabe
            ? db.prepare("SELECT id, nombre FROM cuentas WHERE clabe = ?").get(clabe)
            : undefined
        ) as { id: number; nombre: string } | undefined;
        const porNumero =
          existente ??
          ((bancoFinal && numeroFinal
            ? db.prepare("SELECT id, nombre FROM cuentas WHERE UPPER(banco) = UPPER(?) AND numero_cuenta = ?").get(bancoFinal, numeroFinal)
            : undefined) as { id: number; nombre: string } | undefined);
        if (porNumero) {
          const set: string[] = [];
          const vals: unknown[] = [];
          if (clabe) {
            set.push("clabe = ?");
            vals.push(clabe);
          }
          if (bancoFinal) {
            set.push("banco = ?");
            vals.push(bancoFinal);
          }
          if (numeroFinal) {
            set.push("numero_cuenta = ?");
            vals.push(numeroFinal);
          }
          if (moneda) {
            set.push("moneda = ?");
            vals.push(moneda.toUpperCase());
          }
          if (origen) {
            set.push("origen = ?");
            vals.push(origen);
          }
          if (estatus) {
            set.push("estatus = ?");
            vals.push(estatus.toUpperCase());
          }
          if (cliente) {
            set.push("cliente = ?");
            vals.push(cliente);
          }
          if (set.length) db.prepare(`UPDATE cuentas SET ${set.join(", ")} WHERE id = ?`).run(...vals, porNumero.id);
          actualizadas.push(porNumero.nombre);
          return;
        }
        db.prepare(
          `INSERT INTO cuentas (nombre, banco, numero_cuenta, tipo, saldo_inicial, activa, visible_operador, clabe, moneda, origen, estatus, cliente)
           VALUES (?, ?, ?, 'flujo', 0, 1, 1, ?, ?, ?, ?, ?)`
        ).run(nombre, bancoFinal, numeroFinal, clabe, (moneda || "MXN").toUpperCase(), origen, estatus ? estatus.toUpperCase() : "ACTIVA", cliente);
        creadas.push(nombre);
      });
    })();
    registrarAuditoria(
      db,
      req.usuario!.id,
      "cuentas_importadas",
      `Importación de catálogo de cuentas: ${creadas.length} creada(s), ${actualizadas.length} actualizada(s), ${errores.length} con error`
    );
    res.status(201).json({ creadas, actualizadas, errores });
  });

  // En Tesorería SÓLO el Administrador crea cuentas (el resto consulta y
  // opera las que le fueron asignadas). El tipo determina la bolsa del dinero:
  // flujo | frente | prestamo | anticipo_rendimiento | sofom | asimilado.
  r.post("/cuentas", autenticar, requiereRol("admin_tesoreria", "admin"), (req, res) => {
    const { nombre, banco, numero_cuenta, saldo_inicial, tipo } = req.body ?? {};
    const errores: string[] = [];
    if (typeof nombre !== "string" || !nombre.trim()) errores.push("nombre requerido");
    if (typeof saldo_inicial !== "undefined" && typeof saldo_inicial !== "number")
      errores.push("saldo_inicial debe ser numérico");
    if (typeof banco !== "undefined" && typeof banco !== "string") errores.push("banco debe ser texto");
    if (typeof numero_cuenta !== "undefined" && typeof numero_cuenta !== "string")
      errores.push("numero_cuenta debe ser texto");
    if (typeof tipo !== "undefined" && !(TIPOS_CUENTA as readonly string[]).includes(tipo))
      errores.push(`tipo inválido (${TIPOS_CUENTA.join(" | ")})`);
    // Fase 15: la cuenta puede nacer con su CLABE — valida y auto-llena banco
    // y número de cuenta con la regla por banco (Santander especial).
    let clabeNueva = "";
    let bancoAuto = "";
    if (typeof req.body?.clabe === "string" && req.body.clabe.trim()) {
      const v = validarClabe(req.body.clabe);
      if (!v.ok) errores.push(...v.errores);
      else {
        const bancoRow = db.prepare("SELECT nombre_corto FROM bancos_spei WHERE clave = ?").get(v.banco_clave) as
          | { nombre_corto: string }
          | undefined;
        if (!bancoRow) errores.push(`banco no reconocido en el catálogo SPEI (prefijo ${v.banco_clave})`);
        else {
          clabeNueva = v.clabe;
          bancoAuto = bancoRow.nombre_corto;
          if (typeof banco === "string" && banco.trim() && banco.trim().toUpperCase() !== bancoAuto.toUpperCase()) {
            errores.push(`la CLABE es de ${bancoAuto} pero indicaste el banco ${banco.trim()}`);
          }
        }
      }
    }
    if (errores.length) {
      res.status(400).json({ error: "Datos inválidos", detalles: errores });
      return;
    }
    const bancoFinal = bancoAuto || (typeof banco === "string" ? banco.trim() : "");
    const numeroFinal =
      typeof numero_cuenta === "string" && numero_cuenta.trim()
        ? numero_cuenta.trim()
        : clabeNueva
          ? cuentaDesdeClabe(clabeNueva)
          : "";
    const raiz = db
      .prepare(
        "INSERT INTO cuentas (nombre, banco, numero_cuenta, saldo_inicial, tipo, clabe) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(
        nombre.trim(),
        bancoFinal,
        numeroFinal,
        typeof saldo_inicial === "number" ? saldo_inicial : 0,
        typeof tipo === "string" ? tipo : "flujo",
        clabeNueva
      );
    registrarAuditoria(
      db,
      req.usuario!.id,
      "cuenta_creada",
      `Alta de cuenta '${nombre.trim()}' (tipo ${typeof tipo === "string" ? tipo : "flujo"})`
    );
    const cuenta = db.prepare("SELECT * FROM cuentas WHERE id = ?").get(raiz.lastInsertRowid);
    res.status(201).json({ cuenta });
  });

  // Tarea 12: sacar de operación (bloqueo o no uso momentáneo) y reactivar
  // cuentas del catálogo. Una cuenta fuera de operación desaparece del
  // catálogo ligero y del layout de captura; no admite pagos ni respaldos.
  r.patch("/cuentas/:id/estado", autenticar, requiereRol("admin_tesoreria", "admin"), (req, res) => {
    const id = Number(req.params.id);
    const cuenta = db.prepare("SELECT * FROM cuentas WHERE id = ?").get(id) as
      | { id: number; nombre: string; activa: number }
      | undefined;
    if (!cuenta) {
      res.status(404).json({ error: "Cuenta no encontrada" });
      return;
    }
    const { activa, motivo } = req.body ?? {};
    if (typeof activa !== "boolean") {
      res.status(400).json({ error: "activa debe ser true (reactivar) o false (sacar de operación)" });
      return;
    }
    if (typeof motivo !== "undefined" && typeof motivo !== "string") {
      res.status(400).json({ error: "motivo debe ser texto" });
      return;
    }
    if (cuenta.activa === (activa ? 1 : 0)) {
      res.status(409).json({
        error: activa ? "La cuenta ya está en operación" : "La cuenta ya está fuera de operación",
      });
      return;
    }
    db.prepare("UPDATE cuentas SET activa = ? WHERE id = ?").run(activa ? 1 : 0, id);
    registrarAuditoria(
      db,
      req.usuario!.id,
      "cuenta_estado",
      `${activa ? "Reactivó" : "Sacó de operación"} la cuenta '${cuenta.nombre}'${motivo && motivo.trim() ? ` — motivo: ${motivo.trim()}` : ""}`
    );
    const actualizada = db.prepare("SELECT * FROM cuentas WHERE id = ?").get(id);
    res.json({ cuenta: actualizada });
  });

  r.get(
    "/cuentas/:id",
    autenticar,
    requiereRol("tesoreria", "admin_tesoreria", "validador_tesoreria", "confirmador", "direccion", "auditoria"),
    (req, res) => {
      const id = Number(req.params.id);
      // Alcance §5.3: igual que el listado — con asignaciones vigentes, el
      // tesorero sólo consulta sus cuentas (o las que cubre temporalmente).
      if (
        req.usuario!.rol === "tesoreria" &&
        tesoreroTieneAsignaciones(db, req.usuario!.id) &&
        !cuentaVisibleParaTesorero(db, id, req.usuario!.id)
      ) {
        res.status(403).json({ error: "Cuenta fuera de tu alcance (no asignada ni en cobertura)" });
        return;
      }
      const cuenta = db.prepare("SELECT * FROM cuentas WHERE id = ?").get(id);
      if (!cuenta) {
        res.status(404).json({ error: "Cuenta no encontrada" });
        return;
      }
      const movimientos = db
        .prepare(
          `SELECT 'pago' AS fuente, p.fecha_pago AS fecha, -p.monto AS monto,
                  ('Pago ' || p.comprobante) AS concepto, p.id AS id
           FROM pagos p WHERE p.cuenta_id = ?
           UNION ALL
           SELECT 'movimiento', m.fecha,
                  CASE m.tipo WHEN 'deposito' THEN m.monto ELSE -m.monto END,
                  m.concepto, m.id
           FROM movimientos_cuentas m WHERE m.cuenta_id = ?
           ORDER BY fecha DESC, id DESC`
        )
        .all(id, id);
      res.json({ cuenta, movimientos });
    }
  );

  // Alta de movimiento en el concentrado. Tesorería carga sus cuentas
  // asignadas; el Validador y el Confirmador de depósitos también alimentan el
  // concentrado (función principal del confirmador). El 'origen' deja
  // constancia de quién lo alimentó (rol).
  r.post(
    "/cuentas/:id/movimientos",
    autenticar,
    requiereRol("tesoreria", "admin_tesoreria", "validador_tesoreria", "confirmador"),
    (req, res) => {
      const { tipo, monto, concepto, fecha, referencia } = req.body ?? {};
      const errores: string[] = [];
      if (!["deposito", "retiro"].includes(tipo)) errores.push("tipo inválido (deposito | retiro)");
      if (typeof monto !== "number" || !(monto > 0)) errores.push("monto debe ser mayor a 0");
      if (typeof concepto !== "string" || !concepto.trim()) errores.push("concepto requerido");
      const f = fecha ?? new Date().toISOString().slice(0, 10);
      if (typeof f !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(f)) errores.push("fecha en formato YYYY-MM-DD");
      if (errores.length) {
        res.status(400).json({ error: "Datos inválidos", detalles: errores });
        return;
      }
      const idCuenta = Number(req.params.id);
      // Alcance §5.3: el tesorero carga movimientos de SUS cuentas asignadas
      // (o en cobertura). Sin asignaciones, mantiene el alcance histórico.
      if (
        req.usuario!.rol === "tesoreria" &&
        tesoreroTieneAsignaciones(db, req.usuario!.id) &&
        !cuentaVisibleParaTesorero(db, idCuenta, req.usuario!.id)
      ) {
        res.status(403).json({ error: "Cuenta fuera de tu alcance (no asignada ni en cobertura)" });
        return;
      }
      const cuenta = db.prepare("SELECT id, activa FROM cuentas WHERE id = ?").get(idCuenta) as
        | { id: number; activa: number }
        | undefined;
      if (!cuenta || !cuenta.activa) {
        res.status(404).json({ error: "Cuenta no encontrada o inactiva" });
        return;
      }
      const raiz = db
        .prepare(
          "INSERT INTO movimientos_cuentas (cuenta_id, tipo, monto, concepto, referencia, fecha, origen, creado_por) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          cuenta.id,
          tipo,
          monto,
          concepto.trim(),
          typeof referencia === "string" ? referencia.trim() : "",
          f,
          req.usuario!.rol,
          req.usuario!.id
        );
      registrarAuditoria(
        db,
        req.usuario!.id,
        "movimiento_cuenta",
        `${tipo} de ${monto} en cuenta ${cuenta.id}: ${concepto.trim()}`
      );
      const mov = db.prepare("SELECT * FROM movimientos_cuentas WHERE id = ?").get(raiz.lastInsertRowid);
      res.status(201).json({ movimiento: mov });
    }
  );

  // ---- Concentrado de movimientos (panel tipo Excel) ----
  // Lote pegado desde el estado de cuenta del banco (una fila por movimiento),
  // todo o nada: si alguna fila es inválida no se inserta ninguna.
  r.post(
    "/cuentas/:id/movimientos/lote",
    autenticar,
    usuarioVivo,
    requiereRol("tesoreria", "admin_tesoreria", "validador_tesoreria", "confirmador"),
    (req, res) => {
      const lote = req.body?.movimientos;
      if (!Array.isArray(lote) || lote.length === 0) {
        res.status(400).json({ error: "'movimientos' (arreglo con al menos una fila) es requerido" });
        return;
      }
      if (lote.length > 500) {
        res.status(400).json({ error: "máximo 500 movimientos por lote" });
        return;
      }
      const idCuenta = Number(req.params.id);
      // Alcance §5.3: el tesorero carga movimientos de SUS cuentas (o cobertura).
      if (
        req.usuario!.rol === "tesoreria" &&
        tesoreroTieneAsignaciones(db, req.usuario!.id) &&
        !cuentaVisibleParaTesorero(db, idCuenta, req.usuario!.id)
      ) {
        res.status(403).json({ error: "Cuenta fuera de tu alcance (no asignada ni en cobertura)" });
        return;
      }
      const cuenta = db.prepare("SELECT id, activa FROM cuentas WHERE id = ?").get(idCuenta) as
        | { id: number; activa: number }
        | undefined;
      if (!cuenta || !cuenta.activa) {
        res.status(404).json({ error: "Cuenta no encontrada o inactiva" });
        return;
      }
      const hoy = new Date().toISOString().slice(0, 10);
      const filas: Array<{ tipo: string; monto: number; concepto: string; referencia: string; fecha: string }> = [];
      for (const [i, fila] of (lote as Array<Record<string, unknown>>).entries()) {
        const f = i + 1;
        const tipo = fila?.tipo;
        if (!["deposito", "retiro"].includes(tipo as string)) {
          res.status(400).json({ error: `fila ${f}: tipo inválido (deposito | retiro)` });
          return;
        }
        const monto = typeof fila?.monto === "number" ? redondear2(fila.monto) : NaN;
        if (!Number.isFinite(monto) || monto <= 0) {
          res.status(400).json({ error: `fila ${f}: monto debe ser mayor a 0` });
          return;
        }
        const concepto = typeof fila?.concepto === "string" ? fila.concepto.trim() : "";
        if (!concepto) {
          res.status(400).json({ error: `fila ${f}: concepto requerido` });
          return;
        }
        const fecha = typeof fila?.fecha === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fila.fecha)
          ? fila.fecha
          : hoy;
        filas.push({
          tipo: tipo as string,
          monto,
          concepto,
          referencia: typeof fila?.referencia === "string" ? fila.referencia.trim() : "",
          fecha,
        });
      }
      const insertar = db.prepare(
        "INSERT INTO movimientos_cuentas (cuenta_id, tipo, monto, concepto, referencia, fecha, origen, creado_por) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      );
      const ids = db.transaction(() =>
        filas.map((fila) =>
          Number(
            insertar.run(cuenta.id, fila.tipo, fila.monto, fila.concepto, fila.referencia, fila.fecha, req.usuario!.rol, req.usuario!.id)
              .lastInsertRowid
          )
        )
      )();
      registrarAuditoria(
        db,
        req.usuario!.id,
        "movimientos_lote",
        `${filas.length} movimiento(s) pegados al concentrado de la cuenta ${cuenta.id} (origen ${req.usuario!.rol})`
      );
      res.status(201).json({ ok: true, insertados: ids.length, ids });
    }
  );

  // Concentrado de todas las cuentas: la copia de trabajo de Tesorería (con
  // marcas) la ven tesorería/admin/validador/confirmador; la versión LIMPIA
  // (sin marcas de trabajo) es la que consultan Dirección y Auditoría.
  r.get(
    "/movimientos",
    autenticar,
    requiereRol("tesoreria", "admin_tesoreria", "validador_tesoreria", "confirmador", "direccion", "auditoria", "admin"),
    (req, res) => {
      const { cuenta_id, desde, hasta, q } = req.query as Record<string, string | undefined>;
      const donde: string[] = [];
      const params: unknown[] = [];
      if (cuenta_id && Number.isInteger(Number(cuenta_id))) {
        donde.push("m.cuenta_id = ?");
        params.push(Number(cuenta_id));
      }
      if (desde && /^\d{4}-\d{2}-\d{2}$/.test(desde)) {
        donde.push("m.fecha >= ?");
        params.push(desde);
      }
      if (hasta && /^\d{4}-\d{2}-\d{2}$/.test(hasta)) {
        donde.push("m.fecha <= ?");
        params.push(hasta);
      }
      if (q) {
        donde.push("(m.concepto LIKE ? OR m.referencia LIKE ?)");
        params.push(`%${q}%`, `%${q}%`);
      }
      // Alcance §5.3: tesorero con asignaciones ve el concentrado de sus cuentas.
      if (req.usuario!.rol === "tesoreria" && tesoreroTieneAsignaciones(db, req.usuario!.id)) {
        donde.push(
          `m.cuenta_id IN (
            SELECT cuenta_id FROM cuentas_asignaciones WHERE tesorero_id = ? AND activo = 1 AND cerrado_en IS NULL
            UNION
            SELECT cuenta_id FROM coberturas WHERE tesorero_temporal_id = ? AND activo = 1
              AND (fecha_fin IS NULL OR fecha_fin >= date('now'))
          )`
        );
        params.push(req.usuario!.id, req.usuario!.id);
      }
      const dondeSql = donde.length ? `WHERE ${donde.join(" AND ")}` : "";
      const filas = db
        .prepare(
          `SELECT m.*, c.nombre AS cuenta,
                  u1.nombre AS creado_por_nombre,
                  u2.nombre AS marcado_por_nombre,
                  d.comprobante AS deposito_comprobante,
                  o.folio AS deposito_folio,
                  o.id AS deposito_operacion_id,
                  cli.nombre AS deposito_cliente
           FROM movimientos_cuentas m
           JOIN cuentas c ON c.id = m.cuenta_id
           JOIN usuarios u1 ON u1.id = m.creado_por
           LEFT JOIN usuarios u2 ON u2.id = m.marcado_por
           LEFT JOIN operaciones_depositos d ON d.id = m.deposito_id
           LEFT JOIN operaciones o ON o.id = d.operacion_id
           LEFT JOIN clientes cli ON cli.id = o.cliente_id
           ${dondeSql}
           ORDER BY m.fecha DESC, m.id DESC
           LIMIT 1000`
        )
        .all(...params) as Array<Record<string, unknown>>;
      const versionLimpia = req.usuario!.rol === "auditoria" || req.usuario!.rol === "direccion";
      const movimientos = filas.map((m) =>
        versionLimpia
          ? { ...m, deposito_id: null, marca: "", marcado_por: null, marcado_en: null, marcado_por_nombre: null }
          : m
      );
      res.json({ movimientos, version_limpia: versionLimpia });
    }
  );

  // Marca de trabajo: liga el movimiento bancario (depósito entrante) con el
  // depósito del cliente que cubre, con comentario. Función principal del
  // Confirmador; también validador y tesorero. Quitarla lo puede hacer quien
  // la puso u otro del mismo rol de control (queda en bitácora).
  r.post(
    "/movimientos/:id/marca",
    autenticar,
    usuarioVivo,
    requiereRol("tesoreria", "admin_tesoreria", "validador_tesoreria", "confirmador", "admin"),
    (req, res) => {
      const { deposito_id, comentario } = req.body ?? {};
      const mov = db
        .prepare(
          `SELECT m.*, c.nombre AS cuenta FROM movimientos_cuentas m JOIN cuentas c ON c.id = m.cuenta_id WHERE m.id = ?`
        )
        .get(Number(req.params.id)) as
        | (import("./db.js").MovimientoCuenta & { cuenta: string })
        | undefined;
      if (!mov) {
        res.status(404).json({ error: "Movimiento no encontrado" });
        return;
      }
      if (
        req.usuario!.rol === "tesoreria" &&
        tesoreroTieneAsignaciones(db, req.usuario!.id) &&
        !cuentaVisibleParaTesorero(db, mov.cuenta_id, req.usuario!.id)
      ) {
        res.status(403).json({ error: "Cuenta fuera de tu alcance (no asignada ni en cobertura)" });
        return;
      }
      let depId: number | null = null;
      if (typeof deposito_id === "number" && Number.isInteger(deposito_id)) {
        if (mov.tipo !== "deposito") {
          res.status(400).json({ error: "Sólo los movimientos de tipo 'deposito' se marcan contra un depósito del cliente" });
          return;
        }
        const dep = db
          .prepare(
            `SELECT d.id, o.folio FROM operaciones_depositos d JOIN operaciones o ON o.id = d.operacion_id WHERE d.id = ?`
          )
          .get(deposito_id) as { id: number; folio: string } | undefined;
        if (!dep) {
          res.status(404).json({ error: "Depósito indicado no encontrado" });
          return;
        }
        depId = dep.id;
      }
      const texto = typeof comentario === "string" ? comentario.trim() : "";
      if (!texto && !depId) {
        res.status(400).json({ error: "La marca requiere al menos un comentario o un depósito" });
        return;
      }
      db.prepare(
        "UPDATE movimientos_cuentas SET deposito_id = ?, marca = ?, marcado_por = ?, marcado_en = datetime('now') WHERE id = ?"
      ).run(depId, texto, req.usuario!.id, mov.id);
      registrarAuditoria(
        db,
        req.usuario!.id,
        "movimiento_marcado",
        `Movimiento ${mov.id} (${mov.cuenta}) marcado${depId ? ` con depósito #${depId}` : ""}${texto ? `: ${texto}` : ""}`
      );
      res.json({
        ok: true,
        movimiento: db
          .prepare(
            `SELECT m.*, u2.nombre AS marcado_por_nombre, d.comprobante AS deposito_comprobante,
                    o.folio AS deposito_folio
             FROM movimientos_cuentas m
             LEFT JOIN usuarios u2 ON u2.id = m.marcado_por
             LEFT JOIN operaciones_depositos d ON d.id = m.deposito_id
             LEFT JOIN operaciones o ON o.id = d.operacion_id
             WHERE m.id = ?`
          )
          .get(mov.id),
      });
    }
  );

  // Quita la marca de trabajo de un movimiento (corrección de Tesorería).
  r.delete(
    "/movimientos/:id/marca",
    autenticar,
    usuarioVivo,
    requiereRol("tesoreria", "admin_tesoreria", "validador_tesoreria", "confirmador", "admin"),
    (req, res) => {
      const mov = db
        .prepare("SELECT id, cuenta_id, marca, deposito_id FROM movimientos_cuentas WHERE id = ?")
        .get(Number(req.params.id)) as
        | { id: number; cuenta_id: number; marca: string; deposito_id: number | null }
        | undefined;
      if (!mov) {
        res.status(404).json({ error: "Movimiento no encontrado" });
        return;
      }
      if (
        req.usuario!.rol === "tesoreria" &&
        tesoreroTieneAsignaciones(db, req.usuario!.id) &&
        !cuentaVisibleParaTesorero(db, mov.cuenta_id, req.usuario!.id)
      ) {
        res.status(403).json({ error: "Cuenta fuera de tu alcance (no asignada ni en cobertura)" });
        return;
      }
      db.prepare(
        "UPDATE movimientos_cuentas SET deposito_id = NULL, marca = '', marcado_por = NULL, marcado_en = NULL WHERE id = ?"
      ).run(mov.id);
      registrarAuditoria(
        db,
        req.usuario!.id,
        "movimiento_desmarcado",
        `Marca quitada del movimiento ${mov.id}${mov.deposito_id ? ` (depósito #${mov.deposito_id})` : ""}`
      );
      res.json({ ok: true });
    }
  );

  // ---- Administración de Tesorería (01-ROLES.md §5.1, §5.2, §5.3) ----
  // Asignación de cuentas a tesoreros (append-only) con reasignación que
  // conserva historial, coberturas temporales por ausencia (00-VISION.md §6)
  // y aplicaciones de recursos con doble control y anti doble uso.
  r.post(
    "/cuentas/:id/asignar",
    autenticar,
    usuarioVivo,
    requiereRol("admin_tesoreria"),
    (req, res) => {
      const { tesorero_id, motivo } = req.body ?? {};
      if (!Number.isInteger(tesorero_id)) {
        res.status(400).json({ error: "tesorero_id requerido" });
        return;
      }
      const cuenta = db.prepare("SELECT id, nombre, activa FROM cuentas WHERE id = ?").get(Number(req.params.id)) as
        | { id: number; nombre: string; activa: number }
        | undefined;
      if (!cuenta) {
        res.status(404).json({ error: "Cuenta no encontrada" });
        return;
      }
      const tesorero = db
        .prepare("SELECT id, username, nombre, rol, activo FROM usuarios WHERE id = ?")
        .get(tesorero_id) as { id: number; username: string; nombre: string; rol: Rol; activo: number } | undefined;
      if (!tesorero || tesorero.rol !== "tesoreria") {
        res.status(400).json({ error: "El usuario debe existir y tener rol 'tesoreria' (Tesorero)" });
        return;
      }
      if (tesorero.activo !== 1) {
        res.status(400).json({ error: "El tesorero está desactivado" });
        return;
      }
      // Reasignación: la asignación original se conserva; se cierra la vigente
      // y se abre la nueva (append-only, igual que cliente_asignaciones).
      const tx = db.transaction(() => {
        db.prepare(
          "UPDATE cuentas_asignaciones SET activo = 0, cerrado_en = datetime('now') WHERE cuenta_id = ? AND activo = 1 AND cerrado_en IS NULL"
        ).run(cuenta.id);
        return db
          .prepare(
            "INSERT INTO cuentas_asignaciones (cuenta_id, tesorero_id, motivo, asignado_por) VALUES (?, ?, ?, ?)"
          )
          .run(cuenta.id, tesorero_id, typeof motivo === "string" ? motivo.trim() : "", req.usuario!.id)
          .lastInsertRowid;
      });
      const asignacionId = tx();
      registrarAuditoria(
        db,
        req.usuario!.id,
        "cuenta_asignada",
        `Cuenta '${cuenta.nombre}' asignada a '${tesorero.username}'${motivo ? ` (motivo: ${String(motivo).trim()})` : ""}`
      );
      const asignacion = db.prepare("SELECT * FROM cuentas_asignaciones WHERE id = ?").get(asignacionId);
      res.status(201).json({ asignacion });
    }
  );

  r.get(
    "/cuentas/:id/asignaciones",
    autenticar,
    requiereRol("admin_tesoreria", "admin", "auditoria"),
    (req, res) => {
      const filas = db
        .prepare(
          `SELECT ca.*, u.nombre AS tesorero, u2.nombre AS asignador
           FROM cuentas_asignaciones ca
           JOIN usuarios u ON u.id = ca.tesorero_id
           JOIN usuarios u2 ON u2.id = ca.asignado_por
           WHERE ca.cuenta_id = ? ORDER BY ca.id DESC`
        )
        .all(Number(req.params.id));
      res.json({ asignaciones: filas });
    }
  );

  // Cobertura temporal (§5.1 "Regla de cobertura", 00-VISION.md §6): cuando
  // un tesorero está ausente, el Administrador de Tesorería reasigna sus
  // cuentas temporalmente conservando el responsable habitual.
  r.post("/coberturas", autenticar, usuarioVivo, requiereRol("admin_tesoreria"), (req, res) => {
    const { cuenta_id, tesorero_habitual_id, tesorero_temporal_id, fecha_inicio, fecha_fin, motivo } =
      req.body ?? {};
    const errores: string[] = [];
    if (!Number.isInteger(cuenta_id)) errores.push("cuenta_id requerido");
    if (!Number.isInteger(tesorero_habitual_id)) errores.push("tesorero_habitual_id requerido");
    if (!Number.isInteger(tesorero_temporal_id)) errores.push("tesorero_temporal_id requerido");
    const inicio = typeof fecha_inicio === "string" ? fecha_inicio : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(inicio)) errores.push("fecha_inicio en formato YYYY-MM-DD");
    if (fecha_fin !== null && fecha_fin !== undefined && !(typeof fecha_fin === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fecha_fin)))
      errores.push("fecha_fin en formato YYYY-MM-DD (o null para cobertura indefinida)");
    if (errores.length) {
      res.status(400).json({ error: "Datos inválidos", detalles: errores });
      return;
    }
    if (fecha_fin && String(fecha_fin) < inicio) {
      res.status(400).json({ error: "fecha_fin no puede ser anterior a fecha_inicio" });
      return;
    }
    if (tesorero_habitual_id === tesorero_temporal_id) {
      res.status(400).json({ error: "El responsable habitual y el temporal deben ser distintos" });
      return;
    }
    const cuenta = db.prepare("SELECT id, nombre, activa FROM cuentas WHERE id = ?").get(cuenta_id) as
      | { id: number; nombre: string; activa: number }
      | undefined;
    if (!cuenta || !cuenta.activa) {
      res.status(400).json({ error: "cuenta_id inválida o inactiva" });
      return;
    }
    const rolesDe = db.prepare("SELECT id, rol, activo FROM usuarios WHERE id = ?");
    const habitual = rolesDe.get(tesorero_habitual_id) as { rol: Rol; activo: number } | undefined;
    const temporal = rolesDe.get(tesorero_temporal_id) as { rol: Rol; activo: number } | undefined;
    if (!habitual || habitual.rol !== "tesoreria" || habitual.activo !== 1) {
      res.status(400).json({ error: "El tesorero habitual debe existir, ser rol 'tesoreria' y estar activo" });
      return;
    }
    if (!temporal || temporal.rol !== "tesoreria" || temporal.activo !== 1) {
      res.status(400).json({ error: "El tesorero temporal debe existir, ser rol 'tesoreria' y estar activo" });
      return;
    }
    const raiz = db
      .prepare(
        `INSERT INTO coberturas (cuenta_id, tesorero_habitual_id, tesorero_temporal_id, fecha_inicio, fecha_fin, motivo, asignado_por)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        cuenta.id,
        tesorero_habitual_id,
        tesorero_temporal_id,
        inicio,
        fecha_fin ?? null,
        typeof motivo === "string" ? motivo.trim() : "",
        req.usuario!.id
      );
    registrarAuditoria(
      db,
      req.usuario!.id,
      "cobertura_creada",
      `Cobertura de la cuenta '${cuenta.nombre}': habitual → temporal desde ${inicio}${fecha_fin ? ` hasta ${String(fecha_fin)}` : " (indefinida)"}${motivo ? ` (motivo: ${String(motivo).trim()})` : ""}`
    );
    const cobertura = db.prepare("SELECT * FROM coberturas WHERE id = ?").get(raiz.lastInsertRowid);
    res.status(201).json({ cobertura });
  });

  r.get("/coberturas", autenticar, requiereRol("admin_tesoreria", "tesoreria", "auditoria", "admin"), (_req, res) => {
    const filas = db
      .prepare(
        `SELECT cb.*, c.nombre AS cuenta,
                uh.nombre AS habitual, ut.nombre AS temporal, ua.nombre AS asignador
         FROM coberturas cb
         JOIN cuentas c ON c.id = cb.cuenta_id
         JOIN usuarios uh ON uh.id = cb.tesorero_habitual_id
         JOIN usuarios ut ON ut.id = cb.tesorero_temporal_id
         JOIN usuarios ua ON ua.id = cb.asignado_por
         ORDER BY (cb.fecha_fin IS NULL OR cb.fecha_fin >= date('now')) DESC, cb.id DESC`
      )
      .all();
    res.json({ coberturas: filas });
  });

  // ---- Resguardo por cliente (modelo financiero, §14) ----
  // El saldo NO se guarda nunca: es la suma de sus movimientos.
  //   deposito (+): lo valida Tesorería al confirmar el recurso del cliente.
  //   cargo (−): se genera solo al ejecutar el pago de la operación.
  r.get(
    "/clientes/:id/resguardo",
    autenticar,
    requiereRol("admin_operaciones", "operacion", "validador_tesoreria", "admin_tesoreria", "tesoreria", "direccion", "auditoria"),
    (req, res) => {
      const id = Number(req.params.id);
      const cliente = db.prepare("SELECT id, nombre, activo FROM clientes WHERE id = ?").get(id) as
        | { id: number; nombre: string; activo: number }
        | undefined;
      if (!cliente) {
        res.status(404).json({ error: "Cliente no encontrado" });
        return;
      }
      // Alcance §12: el ejecutivo sólo consulta resguardos de sus clientes.
      if (req.usuario!.rol === "operacion" && !clienteVisibleParaEjecutivo(db, id, req.usuario!.id)) {
        res.status(403).json({ error: "Cliente fuera de tu alcance (no asignado ni en cobertura)" });
        return;
      }
      const movimientos = db
        .prepare(
          `SELECT rm.*, o.folio, c.nombre AS cuenta, u.nombre AS registrado_por
           FROM resguardos_movimientos rm
           LEFT JOIN operaciones o ON o.id = rm.operacion_id
           LEFT JOIN cuentas c ON c.id = rm.cuenta_id
           JOIN usuarios u ON u.id = rm.creado_por
           WHERE rm.cliente_id = ? ORDER BY rm.id DESC`
        )
        .all(id);
      res.json({ cliente: { id: cliente.id, nombre: cliente.nombre }, saldo: saldoResguardo(db, id), movimientos });
    }
  );

  // Tesorería valida el depósito del cliente: crea el movimiento bancario en la
  // cuenta y suma al resguardo en una sola transacción.
  r.post(
    "/resguardos/depositos",
    autenticar,
    usuarioVivo,
    requiereRol("validador_tesoreria", "admin_tesoreria"),
    (req, res) => {
      const { cliente_id, cuenta_id, monto, comprobante, fecha, operacion_id, observaciones } = req.body ?? {};
      const errores: string[] = [];
      if (!Number.isInteger(cliente_id)) errores.push("cliente_id requerido");
      if (!Number.isInteger(cuenta_id)) errores.push("cuenta_id requerido");
      if (typeof monto !== "number" || !(monto > 0)) errores.push("monto debe ser mayor a 0");
      if (typeof comprobante !== "string" || !comprobante.trim()) errores.push("comprobante requerido");
      const f = fecha ?? new Date().toISOString().slice(0, 10);
      if (typeof f !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(f)) errores.push("fecha en formato YYYY-MM-DD");
      if (errores.length) {
        res.status(400).json({ error: "Datos inválidos", detalles: errores });
        return;
      }
      const cliente = db.prepare("SELECT id, nombre, activo FROM clientes WHERE id = ?").get(cliente_id) as
        | { id: number; nombre: string; activo: number }
        | undefined;
      if (!cliente || !cliente.activo) {
        res.status(404).json({ error: "Cliente no encontrado o inactivo" });
        return;
      }
      const cuenta = db.prepare("SELECT id, nombre, activa FROM cuentas WHERE id = ?").get(cuenta_id) as
        | { id: number; nombre: string; activa: number }
        | undefined;
      if (!cuenta || !cuenta.activa) {
        res.status(404).json({ error: "Cuenta no encontrada o inactiva" });
        return;
      }
      if (operacion_id !== undefined && operacion_id !== null) {
        if (!Number.isInteger(operacion_id)) {
          res.status(400).json({ error: "operacion_id debe ser entero" });
          return;
        }
        const op = db.prepare("SELECT id, folio, cliente_id FROM operaciones WHERE id = ?").get(operacion_id) as
          | { id: number; folio: string; cliente_id: number | null }
          | undefined;
        if (!op) {
          res.status(404).json({ error: "Operación no encontrada" });
          return;
        }
        if (op.cliente_id !== cliente.id) {
          res.status(409).json({ error: "La operación indicada pertenece a otro cliente" });
          return;
        }
      }
      const concepto = `Depósito cliente '${cliente.nombre}' — comprobante ${comprobante.trim()}`;
      const tx = db.transaction(() => {
        db.prepare(
          "INSERT INTO movimientos_cuentas (cuenta_id, tipo, monto, concepto, fecha, creado_por) VALUES (?, 'deposito', ?, ?, ?, ?)"
        ).run(cuenta.id, monto, concepto, f, req.usuario!.id);
        return db
          .prepare(
            `INSERT INTO resguardos_movimientos (cliente_id, tipo, importe, operacion_id, cuenta_id, comprobante, observaciones, creado_por)
             VALUES (?, 'deposito', ?, ?, ?, ?, ?, ?)`
          )
          .run(
            cliente.id,
            monto,
            operacion_id ?? null,
            cuenta.id,
            comprobante.trim(),
            typeof observaciones === "string" ? observaciones.trim() : "",
            req.usuario!.id
          ).lastInsertRowid;
      });
      const resguardoId = tx();
      registrarAuditoria(
        db,
        req.usuario!.id,
        "resguardo_deposito",
        `Depósito validado de ${monto} al resguardo de '${cliente.nombre}' (cuenta ${cuenta.id}, comprobante ${comprobante.trim()})`
      );
      const movimiento = db.prepare("SELECT * FROM resguardos_movimientos WHERE id = ?").get(resguardoId);
      res.status(201).json({ deposito: movimiento, saldo: saldoResguardo(db, cliente.id) });
    }
  );

  // Depósitos indicados por los ejecutivos que Tesorería tiene pendientes de validar.
  // El Confirmador de Depósitos consulta aquí su cola principal de trabajo: con
  // 'comprobantes_count' sabe qué depósitos ya tienen respaldo documental (sin
  // al menos uno, el depósito no puede validarse, §5.3).
  r.get(
    "/resguardos/depositos-pendientes",
    autenticar,
    requiereRol("validador_tesoreria", "admin_tesoreria", "confirmador"),
    (_req, res) => {
      const filas = db
        .prepare(
          `SELECT od.*, o.folio, o.monto AS monto_operacion, o.estado AS estado_operacion,
                  c.nombre AS cliente, cu.nombre AS cuenta, u.nombre AS indicador,
                  (SELECT COUNT(*) FROM depositos_comprobantes dc WHERE dc.deposito_id = od.id) AS comprobantes_count
           FROM operaciones_depositos od
           JOIN operaciones o ON o.id = od.operacion_id
           LEFT JOIN clientes c ON c.id = o.cliente_id
           JOIN cuentas cu ON cu.id = od.cuenta_id
           JOIN usuarios u ON u.id = od.indicado_por
           WHERE od.validado_por IS NULL ORDER BY od.id ASC`
        )
        .all();
      res.json({ depositos: filas });
    }
  );

  // El Ejecutivo indica el depósito del cliente al capturar (saldo 0): cuenta
  // donde se depositó + comprobante. Editable mientras Tesorería no lo valide.
  r.post("/operaciones/:id/deposito", autenticar, usuarioVivo, requiereRol("operacion"), (req, res) => {
    const { cuenta_id, monto, comprobante, fecha_deposito } = req.body ?? {};
    const errores: string[] = [];
    if (!Number.isInteger(cuenta_id)) errores.push("cuenta_id requerido");
    if (typeof monto !== "number" || !(monto > 0)) errores.push("monto debe ser mayor a 0");
    if (typeof comprobante !== "string" || !comprobante.trim()) errores.push("comprobante requerido");
    const f = fecha_deposito ?? new Date().toISOString().slice(0, 10);
    if (typeof f !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(f)) errores.push("fecha_deposito en formato YYYY-MM-DD");
    if (errores.length) {
      res.status(400).json({ error: "Datos inválidos", detalles: errores });
      return;
    }
    const op = db.prepare("SELECT * FROM operaciones WHERE id = ?").get(Number(req.params.id)) as Operacion | undefined;
    if (!op) {
      res.status(404).json({ error: "Operación no encontrada" });
      return;
    }
    // Alcance §12: sólo operaciones propias o de clientes asignados/cubiertos.
    if (!visibleParaEjecutivo(db, op, req.usuario!.id)) {
      res.status(403).json({ error: "Operación fuera de tu alcance" });
      return;
    }
    if (op.cliente_id === null) {
      res.status(400).json({ error: "La operación no tiene cliente: el resguardo es por cliente" });
      return;
    }
    if (!["borrador", "observada"].includes(op.estado)) {
      res.status(409).json({ error: `La operación está en '${op.estado}'; el depósito se indica en borrador u observada` });
      return;
    }
    const cuenta = db.prepare("SELECT id, activa FROM cuentas WHERE id = ?").get(cuenta_id) as
      | { id: number; activa: number }
      | undefined;
    if (!cuenta || !cuenta.activa) {
      res.status(404).json({ error: "Cuenta no encontrada o inactiva" });
      return;
    }
    // Con depósitos múltiples: el endpoint legacy actualiza el primer depósito
    // PENDIENTE de la operación; para agregar más se usa POST /depositos.
    const pendiente = db
      .prepare(
        "SELECT * FROM operaciones_depositos WHERE operacion_id = ? AND validado_por IS NULL ORDER BY id LIMIT 1"
      )
      .get(op.id) as import("./db.js").DepositoOperacion | undefined;
    const totalDepositosOp = (
      db.prepare("SELECT COUNT(*) AS n FROM operaciones_depositos WHERE operacion_id = ?").get(op.id) as { n: number }
    ).n;
    if (!pendiente && totalDepositosOp > 0) {
      res.status(409).json({ error: "Los depósitos indicados ya fueron validados por Tesorería" });
      return;
    }
    if (pendiente) {
      db.prepare(
        "UPDATE operaciones_depositos SET cuenta_id = ?, monto = ?, comprobante = ?, fecha_deposito = ?, indicado_por = ? WHERE id = ?"
      ).run(cuenta.id, monto, comprobante.trim(), f, req.usuario!.id, pendiente.id);
    } else {
      db.prepare(
        `INSERT INTO operaciones_depositos (operacion_id, cuenta_id, monto, comprobante, fecha_deposito, indicado_por)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(op.id, cuenta.id, monto, comprobante.trim(), f, req.usuario!.id);
    }
    registrarAuditoria(
      db,
      req.usuario!.id,
      "deposito_indicado",
      `Depósito indicado de ${monto} en cuenta ${cuenta.id} (comprobante ${comprobante.trim()}) para la operación ${op.folio}`,
      op.id
    );
    const deposito = db.prepare("SELECT * FROM operaciones_depositos WHERE operacion_id = ?").get(op.id);
    res.status(201).json({ deposito });
  });

  // Tesorería valida el depósito indicado: suma al resguardo del cliente y
  // registra el movimiento bancario en la cuenta elegida por el ejecutivo.
  r.post(
    "/operaciones/:id/deposito/validar",
    autenticar,
    usuarioVivo,
    requiereRol("validador_tesoreria", "admin_tesoreria", "confirmador"),
    (req, res) => {
      const op = db.prepare("SELECT * FROM operaciones WHERE id = ?").get(Number(req.params.id)) as Operacion | undefined;
      if (!op) {
        res.status(404).json({ error: "Operación no encontrada" });
        return;
      }
      if (op.cliente_id === null) {
        res.status(409).json({ error: "La operación no tiene cliente: valida el depósito directamente en el resguardo" });
        return;
      }
      // Con depósitos múltiples: revisa existencia y pendientes ANTES de
      // tocar nada. Sin depósitos → 404; todos validados → 409.
      const totalDepositosOp = (
        db.prepare("SELECT COUNT(*) AS n FROM operaciones_depositos WHERE operacion_id = ?").get(op.id) as { n: number }
      ).n;
      if (totalDepositosOp === 0) {
        res.status(404).json({ error: "La operación no tiene depósito indicado" });
        return;
      }
      const cliente = db.prepare("SELECT id, nombre FROM clientes WHERE id = ?").get(op.cliente_id) as
        | { id: number; nombre: string }
        | undefined;
      if (!cliente) {
        res.status(404).json({ error: "Cliente de la operación no encontrado" });
        return;
      }
      // Con depósitos múltiples: valida TODOS los pendientes de la operación
      // en una sola transacción (cada uno crea su movimiento bancario y de
      // resguardo en SU cuenta indicada).
      const pendientes = db
        .prepare(
          "SELECT * FROM operaciones_depositos WHERE operacion_id = ? AND validado_por IS NULL ORDER BY id"
        )
        .all(op.id) as Array<import("./db.js").DepositoOperacion>;
      if (pendientes.length === 0) {
        res.status(409).json({ error: "Los depósitos de la operación ya fueron validados" });
        return;
      }
      const cuentasValidas = new Map<number, number>();
      for (const dep of pendientes) {
        if (cuentasValidas.has(dep.cuenta_id)) continue;
        const cuenta = db.prepare("SELECT id, activa FROM cuentas WHERE id = ?").get(dep.cuenta_id) as
          | { id: number; activa: number }
          | undefined;
        if (!cuenta || !cuenta.activa) {
          res.status(409).json({ error: `La cuenta ${dep.cuenta_id} indicada por un depósito ya no está activa` });
          return;
        }
        cuentasValidas.set(dep.cuenta_id, cuenta.id);
      }
      const totalValidado = redondear2(pendientes.reduce((s, d) => s + d.monto, 0));
      // Regla del negocio: Tesorería valida contra el respaldo del comprobante —
      // cada depósito requiere al menos un comprobante adjunto (1 o varios).
      const sinComprobante = pendientes.filter(
        (dep) =>
          (db.prepare("SELECT COUNT(*) AS n FROM depositos_comprobantes WHERE deposito_id = ?").get(dep.id) as { n: number }).n === 0
      );
      if (sinComprobante.length > 0) {
        res.status(409).json({
          error: `Hay ${sinComprobante.length} depósito(s) sin comprobante adjunto: adjunta 1 o varios comprobantes antes de validar`,
          depositos_sin_comprobante: sinComprobante.map((d) => d.id),
        });
        return;
      }
      db.transaction(() => {
        for (const dep of pendientes) {
          db.prepare(
            "INSERT INTO movimientos_cuentas (cuenta_id, tipo, monto, concepto, fecha, creado_por) VALUES (?, 'deposito', ?, ?, date('now'), ?)"
          ).run(dep.cuenta_id, dep.monto, `Depósito cliente '${cliente.nombre}' — comprobante ${dep.comprobante} (op ${op.folio})`, req.usuario!.id);
          db.prepare(
            `INSERT INTO resguardos_movimientos (cliente_id, tipo, importe, operacion_id, cuenta_id, comprobante, observaciones, creado_por)
             VALUES (?, 'deposito', ?, ?, ?, ?, 'Depósito indicado en la operación', ?)`
          ).run(cliente.id, dep.monto, op.id, dep.cuenta_id, dep.comprobante, req.usuario!.id);
          db.prepare("UPDATE operaciones_depositos SET validado_por = ?, validado_en = datetime('now') WHERE id = ?").run(
            req.usuario!.id,
            dep.id
          );
        }
      })();
      registrarAuditoria(
        db,
        req.usuario!.id,
        "deposito_validado",
        `${pendientes.length} depósito(s) validado(s) al resguardo de '${cliente.nombre}' por $${totalValidado.toFixed(2)} (operación ${op.folio})`,
        op.id
      );
      res.json({
        ok: true,
        depositos: pendientes.length,
        saldo: saldoResguardo(db, cliente.id),
      });
    }
  );

  // Agrega OTRO depósito indicado a la operación (respaldo por partes).
  r.post("/operaciones/:id/depositos", autenticar, usuarioVivo, requiereRol("operacion"), (req, res) => {
    const { cuenta_id, monto, comprobante, fecha_deposito } = req.body ?? {};
    const errores: string[] = [];
    if (!Number.isInteger(cuenta_id)) errores.push("cuenta_id requerido");
    if (typeof monto !== "number" || !(monto > 0)) errores.push("monto debe ser mayor a 0");
    if (typeof comprobante !== "string" || !comprobante.trim()) errores.push("comprobante requerido");
    const f = fecha_deposito ?? new Date().toISOString().slice(0, 10);
    if (typeof f !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(f)) errores.push("fecha_deposito en formato YYYY-MM-DD");
    if (errores.length) {
      res.status(400).json({ error: "Datos inválidos", detalles: errores });
      return;
    }
    const op = db.prepare("SELECT * FROM operaciones WHERE id = ?").get(Number(req.params.id)) as Operacion | undefined;
    if (!op) {
      res.status(404).json({ error: "Operación no encontrada" });
      return;
    }
    if (!visibleParaEjecutivo(db, op, req.usuario!.id)) {
      res.status(403).json({ error: "Operación fuera de tu alcance" });
      return;
    }
    if (op.cliente_id === null) {
      res.status(400).json({ error: "La operación no tiene cliente: el resguardo es por cliente" });
      return;
    }
    if (!["borrador", "en_validacion", "observada"].includes(op.estado)) {
      res.status(409).json({ error: `La operación está en '${op.estado}'; los depósitos se indican antes de aprobarse` });
      return;
    }
    const cuenta = db.prepare("SELECT id, activa FROM cuentas WHERE id = ?").get(cuenta_id) as
      | { id: number; activa: number }
      | undefined;
    if (!cuenta || !cuenta.activa) {
      res.status(404).json({ error: "Cuenta no encontrada o inactiva" });
      return;
    }
    const raiz = db
      .prepare(
        `INSERT INTO operaciones_depositos (operacion_id, cuenta_id, monto, comprobante, fecha_deposito, indicado_por)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(op.id, cuenta.id, monto, comprobante.trim(), f, req.usuario!.id);
    registrarAuditoria(
      db,
      req.usuario!.id,
      "deposito_indicado",
      `Depósito indicado de ${monto} en cuenta ${cuenta.id} (comprobante ${comprobante.trim()}) para la operación ${op.folio}`,
      op.id
    );
    const deposito = db.prepare("SELECT * FROM operaciones_depositos WHERE id = ?").get(raiz.lastInsertRowid);
    res.status(201).json({ deposito });
  });

  // Quita un depósito indicado que aún no ha sido validado por Tesorería.
  r.delete(
    "/operaciones/:id/depositos/:depositoId",
    autenticar,
    usuarioVivo,
    requiereRol("operacion"),
    (req, res) => {
      const op = db.prepare("SELECT * FROM operaciones WHERE id = ?").get(Number(req.params.id)) as Operacion | undefined;
      if (!op) {
        res.status(404).json({ error: "Operación no encontrada" });
        return;
      }
      if (!visibleParaEjecutivo(db, op, req.usuario!.id)) {
        res.status(403).json({ error: "Operación fuera de tu alcance" });
        return;
      }
      const deposito = db
        .prepare("SELECT * FROM operaciones_depositos WHERE id = ? AND operacion_id = ?")
        .get(Number(req.params.depositoId), op.id) as import("./db.js").DepositoOperacion | undefined;
      if (!deposito) {
        res.status(404).json({ error: "Depósito no encontrado para esta operación" });
        return;
      }
      if (deposito.validado_por !== null) {
        res.status(409).json({ error: "El depósito ya fue validado por Tesorería: no se puede quitar" });
        return;
      }
      db.prepare("DELETE FROM operaciones_depositos WHERE id = ?").run(deposito.id);
      registrarAuditoria(
        db,
        req.usuario!.id,
        "deposito_quitado",
        `Depósito indicado de ${deposito.monto} (comprobante ${deposito.comprobante}) quitado de la operación ${op.folio}`,
        op.id
      );
      res.json({ ok: true });
    }
  );

  // ---- Comprobantes del depósito (respaldos para Tesorería, §5.3) ----
  // 1 o varios archivos (PDF/imágenes en base64) por depósito. El Ejecutivo
  // los adjunta desde la captura o el detalle; sin al menos uno, Tesorería
  // no puede validar el depósito.
  const MAX_COMPROBANTES_POR_DEPOSITO = 10;
  const MAX_TAMANO_BASE64 = 8 * 1024 * 1024; // ~6 MB de archivo real

  r.post(
    "/depositos/:id/comprobantes",
    autenticar,
    usuarioVivo,
    requiereRol("operacion", "admin_tesoreria", "admin"),
    (req, res) => {
      const deposito = db
        .prepare("SELECT * FROM operaciones_depositos WHERE id = ?")
        .get(Number(req.params.id)) as import("./db.js").DepositoOperacion | undefined;
      if (!deposito) {
        res.status(404).json({ error: "Depósito no encontrado" });
        return;
      }
      if (deposito.validado_por !== null) {
        res.status(409).json({ error: "El depósito ya fue validado: no admite más comprobantes" });
        return;
      }
      const op = db.prepare("SELECT * FROM operaciones WHERE id = ?").get(deposito.operacion_id) as
        | Operacion
        | undefined;
      if (!op) {
        res.status(404).json({ error: "Operación del depósito no encontrada" });
        return;
      }
      if (req.usuario!.rol === "operacion" && !visibleParaEjecutivo(db, op, req.usuario!.id)) {
        res.status(403).json({ error: "Operación fuera de tu alcance" });
        return;
      }
      const archivos = req.body?.comprobantes;
      if (!Array.isArray(archivos) || archivos.length === 0) {
        res.status(400).json({ error: "'comprobantes' (arreglo con al menos un archivo) es requerido" });
        return;
      }
      const existentes = (
        db.prepare("SELECT COUNT(*) AS n FROM depositos_comprobantes WHERE deposito_id = ?").get(deposito.id) as {
          n: number;
        }
      ).n;
      if (existentes + archivos.length > MAX_COMPROBANTES_POR_DEPOSITO) {
        res
          .status(400)
          .json({ error: `Máximo ${MAX_COMPROBANTES_POR_DEPOSITO} comprobantes por depósito (tiene ${existentes})` });
        return;
      }
      const limpios: Array<{ nombre: string; mime: string; buffer: Buffer }> = [];
      for (const [i, a] of (archivos as Array<Record<string, unknown>>).entries()) {
        const f = i + 1;
        const nombre = typeof a?.nombre === "string" && a.nombre.trim() ? a.nombre.trim() : "";
        const mime = typeof a?.mime === "string" && a.mime.trim() ? a.mime.trim() : "application/octet-stream";
        const contenido = typeof a?.contenido === "string" ? a.contenido : "";
        if (!nombre) {
          res.status(400).json({ error: `comprobante ${f}: nombre requerido` });
          return;
        }
        const base64Limpio = contenido.includes(",") ? contenido.slice(contenido.indexOf(",") + 1) : contenido;
        if (!base64Limpio) {
          res.status(400).json({ error: `comprobante ${f}: contenido base64 requerido` });
          return;
        }
        if (base64Limpio.length > MAX_TAMANO_BASE64) {
          res.status(400).json({ error: `comprobante ${f}: excede el tamaño máximo (~6 MB)` });
          return;
        }
        const buffer = Buffer.from(base64Limpio, "base64");
        if (buffer.length === 0) {
          res.status(400).json({ error: `comprobante ${f}: contenido base64 inválido` });
          return;
        }
        limpios.push({ nombre, mime, buffer });
      }
      const insertar = db.prepare(
        "INSERT INTO depositos_comprobantes (deposito_id, nombre, mime, tamano, contenido, subido_por) VALUES (?, ?, ?, ?, ?, ?)"
      );
      const ids = db.transaction(() =>
        limpios.map((a) =>
          Number(insertar.run(deposito.id, a.nombre, a.mime, a.buffer.length, a.buffer, req.usuario!.id).lastInsertRowid)
        )
      )();
      registrarAuditoria(
        db,
        req.usuario!.id,
        "comprobantes_adjuntados",
        `${limpios.length} comprobante(s) adjuntado(s) al depósito ${deposito.id} (${limpios
          .map((a) => a.nombre)
          .join(", ")}) de la operación ${op.folio}`,
        op.id
      );
      res.status(201).json({
        ok: true,
        ids,
        comprobantes: db
          .prepare("SELECT id, deposito_id, nombre, mime, tamano, subido_por, creado_en FROM depositos_comprobantes WHERE deposito_id = ? ORDER BY id")
          .all(deposito.id),
      });
    }
  );

  // Metadatos de los comprobantes de un depósito.
  r.get("/depositos/:id/comprobantes", autenticar, (req, res) => {
    const deposito = db
      .prepare(
        `SELECT d.*, o.creado_por AS op_creado_por FROM operaciones_depositos d
         JOIN operaciones o ON o.id = d.operacion_id WHERE d.id = ?`
      )
      .get(Number(req.params.id)) as
      | (import("./db.js").DepositoOperacion & { op_creado_por: number })
      | undefined;
    if (!deposito) {
      res.status(404).json({ error: "Depósito no encontrado" });
      return;
    }
    const rolesTesoreria = ["tesoreria", "admin_tesoreria", "validador_tesoreria", "confirmador", "direccion", "auditoria", "admin"];
    const opDep = db
      .prepare("SELECT * FROM operaciones WHERE id = ?")
      .get(deposito.operacion_id) as Operacion | undefined;
    if (
      !rolesTesoreria.includes(req.usuario!.rol) &&
      !(req.usuario!.rol === "operacion" && opDep && visibleParaEjecutivo(db, opDep, req.usuario!.id))
    ) {
      res.status(403).json({ error: "No puedes consultar los comprobantes de este depósito" });
      return;
    }
    const comprobantes = db
      .prepare(
        "SELECT id, deposito_id, nombre, mime, tamano, subido_por, creado_en FROM depositos_comprobantes WHERE deposito_id = ? ORDER BY id"
      )
      .all(deposito.id);
    res.json({ comprobantes });
  });

  // Descarga del contenido de un comprobante (base64) para revisarlo.
  r.get("/comprobantes/:id", autenticar, (req, res) => {
    const comprobante = db
      .prepare(
        `SELECT c.*, d.operacion_id, o.creado_por AS op_creado_por
         FROM depositos_comprobantes c
         JOIN operaciones_depositos d ON d.id = c.deposito_id
         JOIN operaciones o ON o.id = d.operacion_id
         WHERE c.id = ?`
      )
      .get(Number(req.params.id)) as
      | (import("./db.js").ComprobanteDeposito & {
          operacion_id: number;
          op_creado_por: number;
          contenido: Buffer;
        })
      | undefined;
    if (!comprobante) {
      res.status(404).json({ error: "Comprobante no encontrado" });
      return;
    }
    const rolesTesoreria = ["tesoreria", "admin_tesoreria", "validador_tesoreria", "confirmador", "direccion", "auditoria", "admin"];
    const op = db.prepare("SELECT * FROM operaciones WHERE id = ?").get(comprobante.operacion_id) as Operacion;
    if (
      !rolesTesoreria.includes(req.usuario!.rol) &&
      !(req.usuario!.rol === "operacion" && visibleParaEjecutivo(db, op, req.usuario!.id))
    ) {
      res.status(403).json({ error: "No puedes descargar este comprobante" });
      return;
    }
    res.json({
      comprobante: {
        id: comprobante.id,
        deposito_id: comprobante.deposito_id,
        nombre: comprobante.nombre,
        mime: comprobante.mime,
        tamano: comprobante.tamano,
        creado_en: comprobante.creado_en,
        contenido_base64: Buffer.from(comprobante.contenido).toString("base64"),
      },
    });
  });

  // Quita un comprobante mientras el depósito no haya sido validado.
  r.delete(
    "/comprobantes/:id",
    autenticar,
    usuarioVivo,
    requiereRol("operacion", "admin_tesoreria", "admin"),
    (req, res) => {
      const comprobante = db
        .prepare(
          `SELECT c.id, c.nombre, c.deposito_id, d.validado_por, d.operacion_id
           FROM depositos_comprobantes c
           JOIN operaciones_depositos d ON d.id = c.deposito_id
           WHERE c.id = ?`
        )
        .get(Number(req.params.id)) as
        | { id: number; nombre: string; deposito_id: number; validado_por: number | null; operacion_id: number }
        | undefined;
      if (!comprobante) {
        res.status(404).json({ error: "Comprobante no encontrado" });
        return;
      }
      if (req.usuario!.rol === "operacion") {
        const op = db.prepare("SELECT * FROM operaciones WHERE id = ?").get(comprobante.operacion_id) as Operacion;
        if (!visibleParaEjecutivo(db, op, req.usuario!.id)) {
          res.status(403).json({ error: "Operación fuera de tu alcance" });
          return;
        }
      }
      if (comprobante.validado_por !== null) {
        res.status(409).json({ error: "El depósito ya fue validado: los comprobantes quedan como respaldo" });
        return;
      }
      db.prepare("DELETE FROM depositos_comprobantes WHERE id = ?").run(comprobante.id);
      registrarAuditoria(
        db,
        req.usuario!.id,
        "comprobante_quitado",
        `Comprobante '${comprobante.nombre}' quitado del depósito ${comprobante.deposito_id}`,
        comprobante.operacion_id
      );
      res.json({ ok: true });
    }
  );

  // Tesorería valida UN depósito indicado concreto (con varios por operación).
  // El Confirmador de Depósitos tiene aquí su función principal: verifica los
  // comprobantes adjuntos y valida. Sin al menos un comprobante no se valida.
  r.post(
    "/depositos/:id/validar",
    autenticar,
    usuarioVivo,
    requiereRol("validador_tesoreria", "admin_tesoreria", "confirmador"),
    (req, res) => {
      const deposito = db
        .prepare("SELECT * FROM operaciones_depositos WHERE id = ?")
        .get(Number(req.params.id)) as import("./db.js").DepositoOperacion | undefined;
      if (!deposito) {
        res.status(404).json({ error: "Depósito no encontrado" });
        return;
      }
      if (deposito.validado_por !== null) {
        res.status(409).json({ error: "El depósito ya fue validado" });
        return;
      }
      const op = db.prepare("SELECT * FROM operaciones WHERE id = ?").get(deposito.operacion_id) as Operacion | undefined;
      if (!op || op.cliente_id === null) {
        res.status(409).json({ error: "La operación del depósito no tiene cliente" });
        return;
      }
      const cuenta = db.prepare("SELECT id, activa FROM cuentas WHERE id = ?").get(deposito.cuenta_id) as
        | { id: number; activa: number }
        | undefined;
      if (!cuenta || !cuenta.activa) {
        res.status(409).json({ error: "La cuenta indicada ya no está activa" });
        return;
      }
      const cliente = db.prepare("SELECT id, nombre FROM clientes WHERE id = ?").get(op.cliente_id) as
        | { id: number; nombre: string }
        | undefined;
      if (!cliente) {
        res.status(404).json({ error: "Cliente de la operación no encontrado" });
        return;
      }
      const comprobantes = db
        .prepare("SELECT COUNT(*) AS n FROM depositos_comprobantes WHERE deposito_id = ?")
        .get(deposito.id) as { n: number };
      if (comprobantes.n === 0) {
        res.status(409).json({
          error: "El depósito no tiene comprobantes adjuntos: adjunta 1 o varios comprobantes antes de validar",
        });
        return;
      }
      db.transaction(() => {
        db.prepare(
          "INSERT INTO movimientos_cuentas (cuenta_id, tipo, monto, concepto, fecha, creado_por) VALUES (?, 'deposito', ?, ?, date('now'), ?)"
        ).run(cuenta.id, deposito.monto, `Depósito cliente '${cliente.nombre}' — comprobante ${deposito.comprobante} (op ${op.folio})`, req.usuario!.id);
        db.prepare(
          `INSERT INTO resguardos_movimientos (cliente_id, tipo, importe, operacion_id, cuenta_id, comprobante, observaciones, creado_por)
           VALUES (?, 'deposito', ?, ?, ?, ?, 'Depósito indicado en la operación', ?)`
        ).run(cliente.id, deposito.monto, op.id, cuenta.id, deposito.comprobante, req.usuario!.id);
        db.prepare("UPDATE operaciones_depositos SET validado_por = ?, validado_en = datetime('now') WHERE id = ?").run(
          req.usuario!.id,
          deposito.id
        );
      })();
      registrarAuditoria(
        db,
        req.usuario!.id,
        "deposito_validado",
        `Depósito de ${deposito.monto} validado al resguardo de '${cliente.nombre}' (operación ${op.folio})`,
        op.id
      );
      res.json({
        ok: true,
        deposito: db.prepare("SELECT * FROM operaciones_depositos WHERE id = ?").get(deposito.id),
        saldo: saldoResguardo(db, cliente.id),
      });
    }
  );

  // Aplicación de recursos (§5.2): el Validador de Tesorería ocupa parte de un
  // depósito bancario para una operación. Queda registrado movimiento, cliente,
  // operación, importe aplicado, moneda y usuario (§5.2 "Debe quedar registrado").
  r.post("/recursos/aplicar", autenticar, usuarioVivo, requiereRol("validador_tesoreria"), (req, res) => {
    const { movimiento_id, operacion_id, importe, observaciones } = req.body ?? {};
    const errores: string[] = [];
    if (!Number.isInteger(movimiento_id)) errores.push("movimiento_id requerido");
    if (!Number.isInteger(operacion_id)) errores.push("operacion_id requerido");
    if (typeof importe !== "number" || !(importe > 0)) errores.push("importe debe ser mayor a 0");
    if (errores.length) {
      res.status(400).json({ error: "Datos inválidos", detalles: errores });
      return;
    }
    const movimiento = db
      .prepare("SELECT * FROM movimientos_cuentas WHERE id = ?")
      .get(movimiento_id) as
      | { id: number; cuenta_id: number; tipo: string; monto: number }
      | undefined;
    if (!movimiento) {
      res.status(404).json({ error: "Movimiento bancario no encontrado" });
      return;
    }
    if (movimiento.tipo !== "deposito") {
      res.status(409).json({ error: "Sólo los depósitos pueden aplicarse a operaciones" });
      return;
    }
    const op = db.prepare("SELECT * FROM operaciones WHERE id = ?").get(operacion_id) as Operacion | undefined;
    if (!op) {
      res.status(404).json({ error: "Operación no encontrada" });
      return;
    }
    const estadosValidos = ["en_validacion", "pendiente_direccion", "aprobada"];
    if (!estadosValidos.includes(op.estado)) {
      res.status(409).json({
        error: `La operación está en '${op.estado}'; los recursos se aplican a operaciones en validación, pendientes de Dirección o aprobadas`,
      });
      return;
    }
    // Anti doble uso (§5.2): ni el movimiento ni la operación se sobregiran.
    const aplicadoAlMovimiento = (
      db
        .prepare(
          "SELECT COALESCE(SUM(importe), 0) AS total FROM aplicaciones_recursos WHERE movimiento_id = ? AND liberado_por IS NULL"
        )
        .get(movimiento.id) as { total: number }
    ).total;
    if (aplicadoAlMovimiento + importe > movimiento.monto + 0.005) {
      res.status(409).json({
        error: `Doble utilización: el depósito ${movimiento.id} tiene disponible ${movimiento.monto - aplicadoAlMovimiento} y se intentó aplicar ${importe}`,
        disponible: movimiento.monto - aplicadoAlMovimiento,
      });
      return;
    }
    const aplicadoALaOperacion = (
      db
        .prepare(
          "SELECT COALESCE(SUM(importe), 0) AS total FROM aplicaciones_recursos WHERE operacion_id = ? AND liberado_por IS NULL"
        )
        .get(op.id) as { total: number }
    ).total;
    if (aplicadoALaOperacion + importe > op.monto + 0.005) {
      res.status(409).json({
        error: `Doble utilización: la operación ${op.folio} ya tiene aplicado ${aplicadoALaOperacion} de ${op.monto}`,
        aplicado: aplicadoALaOperacion,
      });
      return;
    }
    const raiz = db
      .prepare(
        `INSERT INTO aplicaciones_recursos (movimiento_id, operacion_id, importe, moneda, observaciones, aplicado_por)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        movimiento.id,
        op.id,
        importe,
        op.moneda,
        typeof observaciones === "string" ? observaciones.trim() : "",
        req.usuario!.id
      );
    registrarAuditoria(
      db,
      req.usuario!.id,
      "recurso_aplicado",
      `Aplicación de ${importe} ${op.moneda} del movimiento ${movimiento.id} (cuenta ${movimiento.cuenta_id}) a la operación ${op.folio}`,
      op.id
    );
    const aplicacion = db.prepare("SELECT * FROM aplicaciones_recursos WHERE id = ?").get(raiz.lastInsertRowid);
    res.status(201).json({ aplicacion });
  });

  // Liberación de una aplicación (§5.2 "Liberar aplicaciones autorizadas").
  // Doble control (§10): quien aplicó el recurso no puede liberarlo; debe
  // hacerlo otra persona (el Administrador de Tesorería).
  r.post("/recursos/:id/liberar", autenticar, usuarioVivo, requiereRol("admin_tesoreria"), (req, res) => {
    const { motivo } = req.body ?? {};
    if (typeof motivo !== "string" || !motivo.trim()) {
      res.status(400).json({ error: "motivo requerido para liberar el recurso" });
      return;
    }
    const aplicacion = db
      .prepare("SELECT * FROM aplicaciones_recursos WHERE id = ?")
      .get(Number(req.params.id)) as import("./db.js").AplicacionRecurso | undefined;
    if (!aplicacion) {
      res.status(404).json({ error: "Aplicación no encontrada" });
      return;
    }
    if (aplicacion.liberado_por !== null) {
      res.status(409).json({ error: "La aplicación ya fue liberada" });
      return;
    }
    if (aplicacion.aplicado_por === req.usuario!.id) {
      res.status(409).json({
        error: "Doble control: quien aplicó el recurso no puede liberarlo (requiere otra persona)",
      });
      return;
    }
    db.prepare(
      "UPDATE aplicaciones_recursos SET liberado_por = ?, liberado_en = datetime('now'), liberado_motivo = ? WHERE id = ?"
    ).run(req.usuario!.id, motivo.trim(), aplicacion.id);
    registrarAuditoria(
      db,
      req.usuario!.id,
      "recurso_liberado",
      `Liberación de la aplicación ${aplicacion.id} (${aplicacion.importe} ${aplicacion.moneda}): ${motivo.trim()}`,
      aplicacion.operacion_id
    );
    const actualizada = db.prepare("SELECT * FROM aplicaciones_recursos WHERE id = ?").get(aplicacion.id);
    res.json({ aplicacion: actualizada });
  });

  // Depósitos bancarios con su disponible (§5.2): insumo para decidir qué
  // recurso aplicar a una operación. El disponible resta las aplicaciones
  // vigentes (no liberadas).
  r.get(
    "/recursos/disponibles",
    autenticar,
    requiereRol("validador_tesoreria", "admin_tesoreria"),
    (_req, res) => {
      const filas = db
        .prepare(
          `SELECT m.id AS movimiento_id, m.cuenta_id, c.nombre AS cuenta, m.fecha, m.monto, m.concepto,
                  (m.monto - COALESCE((SELECT SUM(a.importe) FROM aplicaciones_recursos a
                                       WHERE a.movimiento_id = m.id AND a.liberado_por IS NULL), 0)) AS disponible
           FROM movimientos_cuentas m
           JOIN cuentas c ON c.id = m.cuenta_id
           WHERE m.tipo = 'deposito' AND c.activa = 1
           ORDER BY (m.monto - COALESCE((SELECT SUM(a.importe) FROM aplicaciones_recursos a
                                         WHERE a.movimiento_id = m.id AND a.liberado_por IS NULL), 0)) DESC, m.id DESC`
        )
        .all();
      res.json({ depositos: filas });
    }
  );

  // Listado de aplicaciones con disponible por movimiento (§5.2 "consultar
  // movimientos" + control de ocupación). Cada fila trae el estado vigente.
  r.get(
    "/recursos",
    autenticar,
    requiereRol("validador_tesoreria", "admin_tesoreria", "tesoreria", "direccion", "auditoria"),
    (_req, res) => {
      const filas = db
        .prepare(
          `SELECT ar.*, o.folio, o.moneda AS moneda_operacion, o.estado AS estado_operacion,
                  u.nombre AS aplicador, ul.nombre AS liberador,
                  m.tipo AS tipo_movimiento, m.monto AS monto_movimiento, m.concepto AS concepto_movimiento,
                  m.cuenta_id, c.nombre AS cuenta,
                  (m.monto - COALESCE((SELECT SUM(a2.importe) FROM aplicaciones_recursos a2
                                       WHERE a2.movimiento_id = m.id AND a2.liberado_por IS NULL), 0)
                  ) AS disponible_movimiento
           FROM aplicaciones_recursos ar
           JOIN operaciones o ON o.id = ar.operacion_id
           JOIN usuarios u ON u.id = ar.aplicado_por
           LEFT JOIN usuarios ul ON ul.id = ar.liberado_por
           JOIN movimientos_cuentas m ON m.id = ar.movimiento_id
           JOIN cuentas c ON c.id = m.cuenta_id
           ORDER BY ar.id DESC`
        )
        .all();
      res.json({ aplicaciones: filas });
    }
  );

  // ---- Administración del sistema (rol admin, 01-ROLES.md §8) ----
  // Separación de funciones: el admin gestiona usuarios y configuración, pero
  // NO tiene permisos operativos-financieros (no captura, no paga, no valida).
  r.get("/usuarios", autenticar, requiereRol("admin"), (_req, res) => {
    const filas = db
      .prepare("SELECT id, username, nombre, rol, activo FROM usuarios ORDER BY id")
      .all();
    res.json({ usuarios: filas });
  });

  // Ejecutivos de Operaciones (para asignaciones de clientes).
  r.get(
    "/usuarios/ejecutivos",
    autenticar,
    requiereRol("admin", "admin_operaciones", "admin_validacion"),
    (_req, res) => {
      const filas = db
        .prepare(
          "SELECT id, username, nombre, rol, activo FROM usuarios WHERE rol = 'operacion' ORDER BY nombre"
        )
        .all();
      res.json({ ejecutivos: filas });
    }
  );

  r.post("/usuarios", autenticar, usuarioVivo, requiereRol("admin"), (req, res) => {
    const { username, nombre, rol, password } = req.body ?? {};
    const errores: string[] = [];
    if (typeof username !== "string" || !/^[a-zA-Z0-9_.-]{3,30}$/.test(username.trim()))
      errores.push("username requerido (3-30 caracteres: letras, números, . _ -)");
    if (typeof nombre !== "string" || nombre.trim().length < 3)
      errores.push("nombre requerido (mínimo 3 caracteres)");
    if (typeof rol !== "string" || !ROLES.includes(rol as Rol))
      errores.push(`rol inválido (${ROLES.join(" | ")})`);
    if (typeof password !== "string" || password.length < 4)
      errores.push("password requerido (mínimo 4 caracteres)");
    if (errores.length) {
      res.status(400).json({ error: "Datos inválidos", detalles: errores });
      return;
    }
    const existe = db.prepare("SELECT id FROM usuarios WHERE username = ?").get(username.trim());
    if (existe) {
      res.status(409).json({ error: `El usuario '${username.trim()}' ya existe` });
      return;
    }
    const raiz = db
      .prepare("INSERT INTO usuarios (username, password_hash, nombre, rol) VALUES (?, ?, ?, ?)")
      .run(username.trim(), bcrypt.hashSync(password, 10), nombre.trim(), rol);
    registrarAuditoria(
      db,
      req.usuario!.id,
      "usuario_creado",
      `Alta de usuario '${username.trim()}' con rol '${rol}'`
    );
    const u = db
      .prepare("SELECT id, username, nombre, rol, activo FROM usuarios WHERE id = ?")
      .get(raiz.lastInsertRowid);
    res.status(201).json({ usuario: u });
  });

  r.patch("/usuarios/:id/estado", autenticar, usuarioVivo, requiereRol("admin"), (req, res) => {
    const { activo } = req.body ?? {};
    if (typeof activo !== "boolean") {
      res.status(400).json({ error: "activo debe ser true o false" });
      return;
    }
    const id = Number(req.params.id);
    const u = db
      .prepare("SELECT id, username, nombre, rol, activo FROM usuarios WHERE id = ?")
      .get(id) as { id: number; username: string; nombre: string; rol: Rol; activo: number } | undefined;
    if (!u) {
      res.status(404).json({ error: "Usuario no encontrado" });
      return;
    }
    // Doble control (01-ROLES.md §10): el admin no desactiva su propia cuenta.
    if (u.id === req.usuario!.id && !activo) {
      res.status(409).json({ error: "No puedes desactivar tu propio usuario" });
      return;
    }
    if (u.rol === "admin" && !activo) {
      const otros = db
        .prepare("SELECT COUNT(*) AS n FROM usuarios WHERE rol = 'admin' AND activo = 1 AND id <> ?")
        .get(id) as { n: number };
      if (otros.n === 0) {
        res.status(409).json({ error: "Debe existir otro administrador activo antes de desactivar a este" });
        return;
      }
    }
    db.prepare("UPDATE usuarios SET activo = ? WHERE id = ?").run(activo ? 1 : 0, id);
    registrarAuditoria(
      db,
      req.usuario!.id,
      "usuario_estado",
      `Usuario '${u.username}' ${activo ? "activado" : "desactivado"}`
    );
    res.json({ usuario: { ...u, activo: activo ? 1 : 0 } });
  });

  r.patch("/usuarios/:id/rol", autenticar, usuarioVivo, requiereRol("admin"), (req, res) => {
    const { rol } = req.body ?? {};
    if (typeof rol !== "string" || !ROLES.includes(rol as Rol)) {
      res.status(400).json({ error: `rol inválido (${ROLES.join(" | ")})` });
      return;
    }
    const id = Number(req.params.id);
    const u = db
      .prepare("SELECT id, username, nombre, rol, activo FROM usuarios WHERE id = ?")
      .get(id) as { id: number; username: string; nombre: string; rol: Rol; activo: number } | undefined;
    if (!u) {
      res.status(404).json({ error: "Usuario no encontrado" });
      return;
    }
    if (u.id === req.usuario!.id) {
      res.status(409).json({ error: "No puedes cambiar tu propio rol (evita el bloqueo administrativo)" });
      return;
    }
    if (u.rol === "admin" && rol !== "admin") {
      const otros = db
        .prepare("SELECT COUNT(*) AS n FROM usuarios WHERE rol = 'admin' AND activo = 1 AND id <> ?")
        .get(id) as { n: number };
      if (otros.n === 0) {
        res.status(409).json({ error: "Debe existir otro administrador activo antes de cambiar el rol de este" });
        return;
      }
    }
    db.prepare("UPDATE usuarios SET rol = ? WHERE id = ?").run(rol, id);
    registrarAuditoria(
      db,
      req.usuario!.id,
      "usuario_rol",
      `Usuario '${u.username}': rol '${u.rol}' → '${rol}'`
    );
    res.json({ usuario: { ...u, rol } });
  });

  /**
   * Eliminación definitiva de un usuario (Administrador del sistema, §8.1).
   * Doble control (§10): no se elimina a sí mismo ni al último admin activo;
   * los usuarios base no se eliminan (se recrean al arrancar). Sólo se permite
   * eliminar usuarios SIN actividad registrada: cualquier referencia en la
   * bitácora, operaciones, asignaciones, etc. bloquea la baja (trazabilidad
   * append-only) y la vía correcta es desactivarlos (PATCH /usuarios/:id/estado).
   */
  r.delete("/usuarios/:id", autenticar, usuarioVivo, requiereRol("admin"), (req, res) => {
    const id = Number(req.params.id);
    const u = db
      .prepare("SELECT id, username, nombre, rol, activo FROM usuarios WHERE id = ?")
      .get(id) as { id: number; username: string; nombre: string; rol: Rol; activo: number } | undefined;
    if (!u) {
      res.status(404).json({ error: "Usuario no encontrado" });
      return;
    }
    if (u.id === req.usuario!.id) {
      res.status(409).json({ error: "No puedes eliminar tu propio usuario" });
      return;
    }
    if (USUARIOS_BASE.includes(u.username)) {
      res.status(409).json({
        error: `'${u.username}' es un usuario base del sistema y no se puede eliminar. Desactívalo si no se usa.`,
      });
      return;
    }
    if (u.rol === "admin") {
      const otros = db
        .prepare("SELECT COUNT(*) AS n FROM usuarios WHERE rol = 'admin' AND activo = 1 AND id <> ?")
        .get(id) as { n: number };
      if (otros.n === 0) {
        res.status(409).json({ error: "Debe existir otro administrador activo antes de eliminar a este" });
        return;
      }
    }
    const bloqueos: string[] = [];
    for (const [tabla, columnas] of REFERENCIAS_USUARIO) {
      const condiciones = columnas.map((c) => `${c} = ?`).join(" OR ");
      const { n } = db
        .prepare(`SELECT COUNT(*) AS n FROM ${tabla} WHERE ${condiciones}`)
        // Un parámetro por placeholder: cada columna compara contra el mismo id.
        .get(...columnas.map(() => id)) as { n: number };
      if (n > 0) bloqueos.push(`${ETIQUETAS_REFERENCIAS[tabla] ?? tabla} (${n})`);
    }
    if (bloqueos.length > 0) {
      res.status(409).json({
        error:
          `No se puede eliminar a '${u.username}': tiene actividad registrada — ` +
          `${bloqueos.join(", ")}. Desactívalo en lugar de eliminarlo para conservar el historial.`,
      });
      return;
    }
    try {
      const baja = db.transaction(() => {
        db.prepare("DELETE FROM usuarios WHERE id = ?").run(id);
        registrarAuditoria(
          db,
          req.usuario!.id,
          "usuario_eliminado",
          `Usuario '${u.username}' (${u.rol}) eliminado definitivamente`
        );
      });
      baja();
    } catch {
      res.status(409).json({
        error: `No se puede eliminar a '${u.username}': tiene registros asociados. Desactívalo en su lugar.`,
      });
      return;
    }
    res.json({ eliminado: true, username: u.username });
  });

  // ---- Clientes y asignaciones (Administrador de Operaciones, §3.1) ----
  r.get("/clientes", autenticar, (req, res) => {
    const base = `SELECT c.*,
        (SELECT u2.nombre FROM cliente_asignaciones ca JOIN usuarios u2 ON u2.id = ca.ejecutivo_id
         WHERE ca.cliente_id = c.id AND ca.activo = 1 AND ca.cerrado_en IS NULL
         ORDER BY ca.id DESC LIMIT 1) AS ejecutivo,
        (SELECT COALESCE(SUM(CASE WHEN rm.tipo IN ('deposito','financiamiento') THEN rm.importe ELSE -rm.importe END), 0)
         FROM resguardos_movimientos rm WHERE rm.cliente_id = c.id) AS resguardo
      FROM clientes c`;
    // Alcance (§3.2): el ejecutivo consulta sólo sus clientes asignados o en cobertura.
    if (req.usuario!.rol === "operacion") {
      const filas = db
        .prepare(
          `${base} WHERE c.id IN (
            SELECT cliente_id FROM cliente_asignaciones WHERE ejecutivo_id = ? AND activo = 1 AND cerrado_en IS NULL
            UNION
            SELECT cliente_id FROM cliente_coberturas WHERE ejecutivo_temporal_id = ? AND activo = 1 AND (fecha_fin IS NULL OR fecha_fin >= date('now'))
          ) ORDER BY c.nombre`
        )
        .all(req.usuario!.id, req.usuario!.id);
      res.json({ clientes: filas });
      return;
    }
    const filas = db.prepare(`${base} ORDER BY c.nombre`).all();
    res.json({ clientes: filas });
  });

  r.post("/clientes", autenticar, usuarioVivo, requiereRol("admin_operaciones"), (req, res) => {
    const { nombre, rfc, contacto, notas } = req.body ?? {};
    if (typeof nombre !== "string" || nombre.trim().length < 2) {
      res.status(400).json({ error: "nombre de cliente requerido (mínimo 2 caracteres)" });
      return;
    }
    const raiz = db
      .prepare("INSERT INTO clientes (nombre, rfc, contacto, notas, creado_por) VALUES (?, ?, ?, ?, ?)")
      .run(
        nombre.trim(),
        typeof rfc === "string" ? rfc.trim() : "",
        typeof contacto === "string" ? contacto.trim() : "",
        typeof notas === "string" ? notas.trim() : "",
        req.usuario!.id
      );
    registrarAuditoria(db, req.usuario!.id, "cliente_creado", `Alta de cliente '${nombre.trim()}'`);
    const cliente = db.prepare("SELECT * FROM clientes WHERE id = ?").get(raiz.lastInsertRowid);
    res.status(201).json({ cliente });
  });

  r.patch("/clientes/:id", autenticar, usuarioVivo, requiereRol("admin_operaciones"), (req, res) => {
    const id = Number(req.params.id);
    const cliente = db.prepare("SELECT * FROM clientes WHERE id = ?").get(id) as
      | (import("./db.js").Cliente & Record<string, unknown>)
      | undefined;
    if (!cliente) {
      res.status(404).json({ error: "Cliente no encontrado" });
      return;
    }
    const cambios: string[] = [];
    const valores: unknown[] = [];
    for (const campo of ["nombre", "rfc", "contacto", "notas"] as const) {
      const v = (req.body ?? {})[campo];
      if (typeof v === "string") {
        cambios.push(`${campo} = ?`);
        valores.push(v.trim());
      }
    }
    const activo = (req.body ?? {}).activo;
    if (typeof activo === "boolean") {
      cambios.push("activo = ?");
      valores.push(activo ? 1 : 0);
    }
    if (!cambios.length) {
      res.status(400).json({ error: "Nada que actualizar (nombre, rfc, contacto, notas, activo)" });
      return;
    }
    db.prepare(`UPDATE clientes SET ${cambios.join(", ")} WHERE id = ?`).run(...valores, id);
    registrarAuditoria(
      db,
      req.usuario!.id,
      "cliente_actualizado",
      `Cliente '${cliente.nombre}' actualizado (${cambios.map((c) => c.split(" =")[0]).join(", ")})`
    );
    res.json({ cliente: db.prepare("SELECT * FROM clientes WHERE id = ?").get(id) });
  });

  // ---- Fase 14: comisiones preestablecidas del cliente ----
  // admin_operaciones fija por cliente la comisión de BROKER y la que va
  // DIRECTO al resguardo de TRF (null = quitar la preestablecida). Al capturar,
  // si el ejecutivo no indica comisión se usan éstas automáticamente.
  r.patch("/clientes/:id/comisiones", autenticar, usuarioVivo, requiereRol("admin_operaciones", "admin"), (req, res) => {
    const id = Number(req.params.id);
    const cliente = db.prepare("SELECT id, nombre FROM clientes WHERE id = ?").get(id) as
      | { id: number; nombre: string }
      | undefined;
    if (!cliente) {
      res.status(404).json({ error: "Cliente no encontrado" });
      return;
    }
    const { comision_broker_pct, comision_trf_pct } = req.body ?? {};
    const cambios: string[] = [];
    const valores: unknown[] = [];
    const validar = (valor: unknown, etiqueta: string): number | null | "nada" => {
      if (valor === undefined) return "nada";
      if (valor === null) return null;
      if (typeof valor !== "number" || !Number.isFinite(valor) || valor < 0 || valor > 100) {
        res.status(400).json({ error: `${etiqueta} debe ser un número entre 0 y 100 (o null para quitarla)` });
        return "nada";
      }
      return redondear2(valor);
    };
    const broker = validar(comision_broker_pct, "comision_broker_pct");
    if (broker === "nada" && comision_broker_pct !== undefined) return; // respuesta 400 ya enviada
    const trf = validar(comision_trf_pct, "comision_trf_pct");
    if (trf === "nada" && comision_trf_pct !== undefined) return; // respuesta 400 ya enviada
    if (broker !== "nada") {
      cambios.push("comision_broker_pct = ?");
      valores.push(broker);
    }
    if (trf !== "nada") {
      cambios.push("comision_trf_pct = ?");
      valores.push(trf);
    }
    if (!cambios.length) {
      res.status(400).json({ error: "Envía comision_broker_pct y/o comision_trf_pct (número 0-100 o null para quitarla)" });
      return;
    }
    db.prepare(`UPDATE clientes SET ${cambios.join(", ")} WHERE id = ?`).run(...valores, id);
    registrarAuditoria(
      db,
      req.usuario!.id,
      "comisiones_cliente",
      `Comisiones preestablecidas de '${cliente.nombre}': broker ${
        broker === "nada" ? "sin cambio" : broker === null ? "quitada" : `${broker}%`
      }, TRF (directa al resguardo) ${trf === "nada" ? "sin cambio" : trf === null ? "quitada" : `${trf}%`}`
    );
    res.json({ cliente: db.prepare("SELECT * FROM clientes WHERE id = ?").get(id) });
  });

  // Política de financiamiento del cliente (§6.1): la determina Dirección.
  //   sin_aprobacion = el cliente NO requiere aprobación previa (cualquier monto)
  //   monto_maximo   = financiamientos hasta ese monto ya están aprobados
  r.patch("/clientes/:id/financiamiento", autenticar, usuarioVivo, requiereRol("direccion", "admin"), (req, res) => {
    const id = Number(req.params.id);
    const cliente = db.prepare("SELECT id, nombre FROM clientes WHERE id = ?").get(id) as
      | { id: number; nombre: string }
      | undefined;
    if (!cliente) {
      res.status(404).json({ error: "Cliente no encontrado" });
      return;
    }
    const { sin_aprobacion, monto_maximo } = req.body ?? {};
    const cambios: string[] = [];
    const valores: unknown[] = [];
    if (typeof sin_aprobacion === "boolean") {
      cambios.push("financiamiento_sin_aprobacion = ?");
      valores.push(sin_aprobacion ? 1 : 0);
    }
    if (monto_maximo === null) {
      cambios.push("financiamiento_maximo = NULL");
    } else if (typeof monto_maximo === "number") {
      if (!(monto_maximo >= 0)) {
        res.status(400).json({ error: "monto_maximo debe ser un número mayor o igual a 0 (o null para quitarlo)" });
        return;
      }
      cambios.push("financiamiento_maximo = ?");
      valores.push(redondear2(monto_maximo));
    }
    if (!cambios.length) {
      res.status(400).json({ error: "Envía sin_aprobacion (boolean) y/o monto_maximo (número o null)" });
      return;
    }
    db.prepare(`UPDATE clientes SET ${cambios.join(", ")} WHERE id = ?`).run(...valores, id);
    const actualizado = db
      .prepare("SELECT id, nombre, financiamiento_sin_aprobacion, financiamiento_maximo FROM clientes WHERE id = ?")
      .get(id);
    registrarAuditoria(
      db,
      req.usuario!.id,
      "politica_financiamiento",
      `Política de financiamiento de '${cliente.nombre}' actualizada: sin aprobación previa = ${
        typeof sin_aprobacion === "boolean" ? (sin_aprobacion ? "SÍ" : "NO") : "sin cambio"
      }, monto máximo = ${monto_maximo === null ? "quitado" : typeof monto_maximo === "number" ? redondear2(monto_maximo).toFixed(2) : "sin cambio"}`
    );
    res.json({ cliente: actualizado });
  });

  r.post(
    "/clientes/:id/asignaciones",
    autenticar,
    usuarioVivo,
    requiereRol("admin_operaciones"),
    (req, res) => {
      const { ejecutivo_id, motivo } = req.body ?? {};
      if (!Number.isInteger(ejecutivo_id)) {
        res.status(400).json({ error: "ejecutivo_id requerido" });
        return;
      }
      const cliente = db.prepare("SELECT id, nombre, activo FROM clientes WHERE id = ?").get(Number(req.params.id)) as
        | { id: number; nombre: string; activo: number }
        | undefined;
      if (!cliente) {
        res.status(404).json({ error: "Cliente no encontrado" });
        return;
      }
      const ejecutivo = db
        .prepare("SELECT id, username, nombre, rol, activo FROM usuarios WHERE id = ?")
        .get(ejecutivo_id) as { id: number; username: string; nombre: string; rol: Rol; activo: number } | undefined;
      if (!ejecutivo || ejecutivo.rol !== "operacion") {
        res.status(400).json({ error: "El usuario debe existir y tener rol 'operacion' (Ejecutivo de Operaciones)" });
        return;
      }
      if (ejecutivo.activo !== 1) {
        res.status(400).json({ error: "El ejecutivo está desactivado" });
        return;
      }
      // Reasignación (§5.1, principio extendido a clientes): la asignación
      // original se conserva; se cierra la vigente y se abre la nueva.
      const tx = db.transaction(() => {
        db.prepare(
          "UPDATE cliente_asignaciones SET activo = 0, cerrado_en = datetime('now') WHERE cliente_id = ? AND activo = 1 AND cerrado_en IS NULL"
        ).run(cliente.id);
        return db
          .prepare(
            "INSERT INTO cliente_asignaciones (cliente_id, ejecutivo_id, motivo, asignado_por) VALUES (?, ?, ?, ?)"
          )
          .run(cliente.id, ejecutivo_id, typeof motivo === "string" ? motivo.trim() : "", req.usuario!.id)
          .lastInsertRowid;
      });
      const asignacionId = tx();
      registrarAuditoria(
        db,
        req.usuario!.id,
        "cliente_asignado",
        `Cliente '${cliente.nombre}' asignado a '${ejecutivo.username}'${motivo ? ` (motivo: ${String(motivo).trim()})` : ""}`
      );
      const asignacion = db.prepare("SELECT * FROM cliente_asignaciones WHERE id = ?").get(asignacionId);
      res.status(201).json({ asignacion });
    }
  );

  r.get(
    "/clientes/:id/asignaciones",
    autenticar,
    requiereRol("admin_operaciones", "admin", "auditoria"),
    (req, res) => {
      const filas = db
        .prepare(
          `SELECT ca.*, u.nombre AS ejecutivo, u2.nombre AS asignador
           FROM cliente_asignaciones ca
           JOIN usuarios u ON u.id = ca.ejecutivo_id
           JOIN usuarios u2 ON u2.id = ca.asignado_por
           WHERE ca.cliente_id = ? ORDER BY ca.id DESC`
        )
        .all(Number(req.params.id));
      res.json({ asignaciones: filas });
    }
  );

  // ---- Cobertura de clientes (§3.1 + 00-VISION §6): segunda asignación
  // temporal del cliente (vacaciones, permisos especiales). La asignación
  // principal se conserva; el ejecutivo temporal ve el cliente y su historial.
  r.post(
    "/clientes/:id/coberturas",
    autenticar,
    usuarioVivo,
    requiereRol("admin_operaciones"),
    (req, res) => {
      const { ejecutivo_habitual_id, ejecutivo_temporal_id, fecha_inicio, fecha_fin, motivo } = req.body ?? {};
      const errores: string[] = [];
      if (!Number.isInteger(ejecutivo_habitual_id)) errores.push("ejecutivo_habitual_id requerido");
      if (!Number.isInteger(ejecutivo_temporal_id)) errores.push("ejecutivo_temporal_id requerido");
      const inicio = typeof fecha_inicio === "string" ? fecha_inicio : "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(inicio)) errores.push("fecha_inicio en formato YYYY-MM-DD");
      if (fecha_fin !== null && fecha_fin !== undefined && !(typeof fecha_fin === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fecha_fin)))
        errores.push("fecha_fin en formato YYYY-MM-DD (o null para cobertura indefinida)");
      if (errores.length) {
        res.status(400).json({ error: "Datos inválidos", detalles: errores });
        return;
      }
      if (fecha_fin && String(fecha_fin) < inicio) {
        res.status(400).json({ error: "fecha_fin no puede ser anterior a fecha_inicio" });
        return;
      }
      if (ejecutivo_habitual_id === ejecutivo_temporal_id) {
        res.status(400).json({ error: "El ejecutivo habitual y el temporal deben ser distintos" });
        return;
      }
      const cliente = db.prepare("SELECT id, nombre, activo FROM clientes WHERE id = ?").get(Number(req.params.id)) as
        | { id: number; nombre: string; activo: number }
        | undefined;
      if (!cliente || !cliente.activo) {
        res.status(404).json({ error: "Cliente no encontrado o inactivo" });
        return;
      }
      const rolesDe = db.prepare("SELECT id, rol, activo FROM usuarios WHERE id = ?");
      const habitual = rolesDe.get(ejecutivo_habitual_id) as { rol: Rol; activo: number } | undefined;
      const temporal = rolesDe.get(ejecutivo_temporal_id) as { rol: Rol; activo: number } | undefined;
      if (!habitual || habitual.rol !== "operacion" || habitual.activo !== 1) {
        res.status(400).json({ error: "El ejecutivo habitual debe existir, ser rol 'operacion' y estar activo" });
        return;
      }
      if (!temporal || temporal.rol !== "operacion" || temporal.activo !== 1) {
        res.status(400).json({ error: "El ejecutivo temporal debe existir, ser rol 'operacion' y estar activo" });
        return;
      }
      const raiz = db
        .prepare(
          `INSERT INTO cliente_coberturas (cliente_id, ejecutivo_habitual_id, ejecutivo_temporal_id, fecha_inicio, fecha_fin, motivo, asignado_por)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          cliente.id,
          ejecutivo_habitual_id,
          ejecutivo_temporal_id,
          inicio,
          fecha_fin ?? null,
          typeof motivo === "string" ? motivo.trim() : "",
          req.usuario!.id
        );
      registrarAuditoria(
        db,
        req.usuario!.id,
        "cliente_cobertura_creada",
        `Cobertura del cliente '${cliente.nombre}': habitual → temporal desde ${inicio}${fecha_fin ? ` hasta ${String(fecha_fin)}` : " (indefinida)"}${motivo ? ` (motivo: ${String(motivo).trim()})` : ""}`
      );
      const cobertura = db.prepare("SELECT * FROM cliente_coberturas WHERE id = ?").get(raiz.lastInsertRowid);
      res.status(201).json({ cobertura });
    }
  );

  r.get(
    "/clientes/:id/coberturas",
    autenticar,
    requiereRol("admin_operaciones", "admin", "auditoria"),
    (req, res) => {
      const filas = db
        .prepare(
          `SELECT cb.*, uh.nombre AS habitual, ut.nombre AS temporal, ua.nombre AS asignador
           FROM cliente_coberturas cb
           JOIN usuarios uh ON uh.id = cb.ejecutivo_habitual_id
           JOIN usuarios ut ON ut.id = cb.ejecutivo_temporal_id
           JOIN usuarios ua ON ua.id = cb.asignado_por
           WHERE cb.cliente_id = ? ORDER BY cb.id DESC`
        )
        .all(Number(req.params.id));
      res.json({ coberturas: filas });
    }
  );

  // Cierra una cobertura antes de su fecha_fin (terminó la vacación/permiso).
  r.post(
    "/clientes/:id/coberturas/:coberturaId/cerrar",
    autenticar,
    usuarioVivo,
    requiereRol("admin_operaciones"),
    (req, res) => {
      const cobertura = db
        .prepare("SELECT * FROM cliente_coberturas WHERE id = ? AND cliente_id = ?")
        .get(Number(req.params.coberturaId), Number(req.params.id)) as
        | import("./db.js").ClienteCobertura
        | undefined;
      if (!cobertura) {
        res.status(404).json({ error: "Cobertura no encontrada" });
        return;
      }
      if (cobertura.activo !== 1 || cobertura.cerrado_en) {
        res.status(409).json({ error: "La cobertura ya está cerrada" });
        return;
      }
      db.prepare("UPDATE cliente_coberturas SET activo = 0, cerrado_en = datetime('now') WHERE id = ?").run(cobertura.id);
      registrarAuditoria(
        db,
        req.usuario!.id,
        "cliente_cobertura_cerrada",
        `Cobertura ${cobertura.id} del cliente ${cobertura.cliente_id} cerrada anticipadamente`
      );
      res.json({ cobertura: db.prepare("SELECT * FROM cliente_coberturas WHERE id = ?").get(cobertura.id) });
    }
  );

  // ---- Administración de Validación (01-ROLES.md §4.1, §4.2) ----
  // El Administrador de Validación supervisa la cola, distribuye y reasigna
  // cargas. No tiene permisos financieros (no captura, no paga, no autoriza).
  r.get(
    "/usuarios/validadores",
    autenticar,
    requiereRol("admin_validacion", "admin"),
    (_req, res) => {
      const filas = db
        .prepare(
          "SELECT id, username, nombre, rol, activo FROM usuarios WHERE rol = 'validacion' ORDER BY nombre"
        )
        .all();
      res.json({ validadores: filas });
    }
  );

  // Tesoreros (para asignaciones de cuentas y coberturas, §5.1).
  r.get(
    "/usuarios/tesoreros",
    autenticar,
    requiereRol("admin_tesoreria", "admin"),
    (_req, res) => {
      const filas = db
        .prepare(
          "SELECT id, username, nombre, rol, activo FROM usuarios WHERE rol = 'tesoreria' ORDER BY nombre"
        )
        .all();
      res.json({ tesoreros: filas });
    }
  );

  // Cola de validación: operaciones en_validacion con su asignación vigente.
  // El validador sólo ve su carga: asignadas por operación ∪ ejecutivos
  // asignados ∪ ejecutivos sin distribución (flujo simple §4.2). El
  // Administrador de Validación ve toda la cola.
  r.get("/validacion/cola", autenticar, requiereRol("admin_validacion", "validacion"), (req, res) => {
    const filtros: string[] = ["o.estado = 'en_validacion'"];
    const params: unknown[] = [];
    if (req.usuario!.rol === "validacion") {
      filtros.push(
        `(
          EXISTS (SELECT 1 FROM asignaciones_validacion av
                  WHERE av.operacion_id = o.id AND av.validador_id = ? AND av.activo = 1 AND av.cerrado_en IS NULL)
          OR o.creado_por IN (SELECT ejecutivo_id FROM validacion_ejecutivos WHERE validador_id = ? AND activo = 1 AND cerrado_en IS NULL)
          OR o.creado_por NOT IN (SELECT ejecutivo_id FROM validacion_ejecutivos WHERE activo = 1 AND cerrado_en IS NULL)
        )`
      );
      params.push(req.usuario!.id, req.usuario!.id);
    }
    const filas = db
      .prepare(
        `SELECT o.id, o.folio, o.concepto, o.proveedor, o.monto, o.moneda, o.actualizado_en,
                c.nombre AS cliente, u.nombre AS capturista,
                av.validador_id, uv.nombre AS validador_asignado
         FROM operaciones o
         JOIN usuarios u ON u.id = o.creado_por
         LEFT JOIN clientes c ON c.id = o.cliente_id
         LEFT JOIN asignaciones_validacion av
                ON av.operacion_id = o.id AND av.activo = 1 AND av.cerrado_en IS NULL
         LEFT JOIN usuarios uv ON uv.id = av.validador_id
         WHERE ${filtros.join(" AND ")}
         ORDER BY o.actualizado_en ASC, o.id ASC`
      )
      .all(...params);
    res.json({ cola: filas });
  });

  // Cargas por validador: asignaciones vigentes y revisiones totales.
  r.get("/validacion/cargas", autenticar, requiereRol("admin_validacion"), (_req, res) => {
    const filas = db
      .prepare(
        `SELECT u.id, u.username, u.nombre, u.activo,
                (SELECT COUNT(*) FROM asignaciones_validacion av
                 WHERE av.validador_id = u.id AND av.activo = 1 AND av.cerrado_en IS NULL) AS asignadas,
                (SELECT COUNT(*) FROM revisiones rv WHERE rv.revisor_id = u.id) AS revisadas
         FROM usuarios u WHERE u.rol = 'validacion' ORDER BY u.nombre`
      )
      .all();
    res.json({ cargas: filas });
  });

  // Asignar / reasignar una operación en validación a un validador.
  r.post(
    "/operaciones/:id/asignar-validacion",
    autenticar,
    usuarioVivo,
    requiereRol("admin_validacion"),
    (req, res) => {
      const { validador_id, motivo } = req.body ?? {};
      if (!Number.isInteger(validador_id)) {
        res.status(400).json({ error: "validador_id requerido" });
        return;
      }
      const op = db.prepare("SELECT * FROM operaciones WHERE id = ?").get(Number(req.params.id)) as
        | Operacion
        | undefined;
      if (!op) {
        res.status(404).json({ error: "Operación no encontrada" });
        return;
      }
      if (op.estado !== "en_validacion") {
        res.status(409).json({ error: `La operación está en '${op.estado}', se requiere 'en_validacion'` });
        return;
      }
      const validador = db
        .prepare("SELECT id, username, nombre, rol, activo FROM usuarios WHERE id = ?")
        .get(validador_id) as { id: number; username: string; nombre: string; rol: Rol; activo: number } | undefined;
      if (!validador || validador.rol !== "validacion") {
        res.status(400).json({ error: "El usuario debe existir y tener rol 'validacion' (Validador)" });
        return;
      }
      if (validador.activo !== 1) {
        res.status(400).json({ error: "El validador está desactivado" });
        return;
      }
      // Reasignación (§4.1 "Reasignar validaciones"): la asignación original se
      // conserva; se cierra la vigente y se abre la nueva (append-only).
      const tx = db.transaction(() => {
        db.prepare(
          "UPDATE asignaciones_validacion SET activo = 0, cerrado_en = datetime('now') WHERE operacion_id = ? AND activo = 1 AND cerrado_en IS NULL"
        ).run(op.id);
        return db
          .prepare(
            "INSERT INTO asignaciones_validacion (operacion_id, validador_id, motivo, asignado_por) VALUES (?, ?, ?, ?)"
          )
          .run(op.id, validador_id, typeof motivo === "string" ? motivo.trim() : "", req.usuario!.id)
          .lastInsertRowid;
      });
      const asignacionId = tx();
      registrarAuditoria(
        db,
        req.usuario!.id,
        "validacion_asignada",
        `Operación ${op.folio} asignada a '${validador.username}'${motivo ? ` (motivo: ${String(motivo).trim()})` : ""}`,
        op.id
      );
      const asignacion = db.prepare("SELECT * FROM asignaciones_validacion WHERE id = ?").get(asignacionId);
      res.status(201).json({ asignacion });
    }
  );

  r.get(
    "/operaciones/:id/asignaciones-validacion",
    autenticar,
    requiereRol("admin_validacion", "admin", "auditoria"),
    (req, res) => {
      const filas = db
        .prepare(
          `SELECT av.*, u.nombre AS validador, u2.nombre AS asignador
           FROM asignaciones_validacion av
           JOIN usuarios u ON u.id = av.validador_id
           JOIN usuarios u2 ON u2.id = av.asignado_por
           WHERE av.operacion_id = ? ORDER BY av.id DESC`
        )
        .all(Number(req.params.id));
      res.json({ asignaciones: filas });
    }
  );

  // ---- Catálogos administrables y parámetros (admin, §8.1) ----
  r.get("/catalogos/registros", autenticar, (req, res) => {
    const { dominio } = req.query;
    const filas =
      typeof dominio === "string" && dominio.trim()
        ? db.prepare("SELECT * FROM catalogos WHERE dominio = ? ORDER BY dominio, clave").all(dominio.trim())
        : db.prepare("SELECT * FROM catalogos ORDER BY dominio, clave").all();
    res.json({ registros: filas });
  });

  r.post("/catalogos/registros", autenticar, usuarioVivo, requiereRol("admin"), (req, res) => {
    const { dominio, clave, valor } = req.body ?? {};
    if (
      typeof dominio !== "string" ||
      !dominio.trim() ||
      typeof clave !== "string" ||
      !clave.trim() ||
      typeof valor !== "string" ||
      !valor.trim()
    ) {
      res.status(400).json({ error: "dominio, clave y valor son requeridos" });
      return;
    }
    const dup = db
      .prepare("SELECT id FROM catalogos WHERE dominio = ? AND clave = ?")
      .get(dominio.trim(), clave.trim());
    if (dup) {
      res.status(409).json({ error: `Ya existe '${dominio.trim()}/${clave.trim()}' (usa PATCH para modificarlo)` });
      return;
    }
    const raiz = db
      .prepare("INSERT INTO catalogos (dominio, clave, valor, actualizado_por) VALUES (?, ?, ?, ?)")
      .run(dominio.trim(), clave.trim(), valor.trim(), req.usuario!.id);
    registrarAuditoria(
      db,
      req.usuario!.id,
      "catalogo_cambio",
      `Alta en catálogo: ${dominio.trim()}/${clave.trim()} = ${valor.trim()}`
    );
    res.status(201).json({ registro: db.prepare("SELECT * FROM catalogos WHERE id = ?").get(raiz.lastInsertRowid) });
  });

  r.patch("/catalogos/registros/:id", autenticar, usuarioVivo, requiereRol("admin"), (req, res) => {
    const fila = db.prepare("SELECT * FROM catalogos WHERE id = ?").get(Number(req.params.id)) as
      | { id: number; dominio: string; clave: string; valor: string; activo: number }
      | undefined;
    if (!fila) {
      res.status(404).json({ error: "Registro de catálogo no encontrado" });
      return;
    }
    const { valor, activo } = req.body ?? {};
    if (typeof valor !== "string" && typeof activo !== "boolean") {
      res.status(400).json({ error: "Envía 'valor' (texto) o 'activo' (true/false)" });
      return;
    }
    const nuevoValor = typeof valor === "string" ? valor.trim() : fila.valor;
    const nuevoActivo = typeof activo === "boolean" ? (activo ? 1 : 0) : fila.activo;
    db.prepare("UPDATE catalogos SET valor = ?, activo = ?, actualizado_por = ? WHERE id = ?").run(
      nuevoValor,
      nuevoActivo,
      req.usuario!.id,
      fila.id
    );
    registrarAuditoria(
      db,
      req.usuario!.id,
      "catalogo_cambio",
      `Catálogo ${fila.dominio}/${fila.clave}: '${fila.valor}' (${fila.activo ? "activo" : "inactivo"}) → '${nuevoValor}' (${nuevoActivo ? "activo" : "inactivo"})`
    );
    res.json({ registro: db.prepare("SELECT * FROM catalogos WHERE id = ?").get(fila.id) });
  });

  r.get("/parametros", autenticar, requiereRol("admin"), (_req, res) => {
    res.json({ parametros: db.prepare("SELECT * FROM parametros ORDER BY clave").all() });
  });

  r.patch("/parametros/:clave", autenticar, usuarioVivo, requiereRol("admin"), (req, res) => {
    const { valor } = req.body ?? {};
    if (typeof valor !== "string" || !valor.trim()) {
      res.status(400).json({ error: "valor requerido" });
      return;
    }
    const fila = db.prepare("SELECT * FROM parametros WHERE clave = ?").get(req.params.clave) as
      | { clave: string; valor: string }
      | undefined;
    if (!fila) {
      res.status(404).json({ error: "Parámetro no encontrado" });
      return;
    }
    if (fila.clave === "umbral_direccion") {
      const n = Number(valor.trim());
      if (!Number.isFinite(n) || n <= 0) {
        res.status(400).json({ error: "umbral_direccion debe ser un número mayor a 0" });
        return;
      }
    }
    db.prepare(
      "UPDATE parametros SET valor = ?, actualizado_por = ?, actualizado_en = datetime('now') WHERE clave = ?"
    ).run(valor.trim(), req.usuario!.id, fila.clave);
    registrarAuditoria(
      db,
      req.usuario!.id,
      "parametro_cambio",
      `Parámetro '${fila.clave}': '${fila.valor}' → '${valor.trim()}'`
    );
    res.json({ parametro: db.prepare("SELECT * FROM parametros WHERE clave = ?").get(fila.clave) });
  });

  // ---- Sincronización (protocolo uuid + version, ver docs/05) ----
  r.post(
    "/sync/push",
    autenticar,
    requiereRol("operacion", "validacion", "tesoreria", "direccion"),
    (req, res) => {
      const cambios = req.body?.cambios;
      if (!Array.isArray(cambios)) {
        res.status(400).json({ error: "'cambios' (arreglo) es requerido" });
        return;
      }
      const resultados: Array<Record<string, unknown>> = [];
      for (const cambio of cambios.slice(0, 200)) {
        const { tabla, uuid, version, payload } = (cambio ?? {}) as Record<string, unknown>;
        if (!TABLAS_SYNC.includes(tabla as never)) {
          resultados.push({ uuid, estado: "error", detalle: `tabla no soportada: ${String(tabla)}` });
          continue;
        }
        const t = tabla as (typeof TABLAS_SYNC)[number];
        if (typeof uuid !== "string" || !uuid.trim()) {
          resultados.push({ uuid, estado: "error", detalle: "uuid requerido" });
          continue;
        }
        if (!Number.isInteger(version) || (version as number) < 1) {
          resultados.push({ uuid, estado: "error", detalle: "version entera >= 1 requerida" });
          continue;
        }
        if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
          resultados.push({ uuid, estado: "error", detalle: "payload objeto requerido" });
          continue;
        }
        const columnas = (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(
          (c) => c.name
        );
        const ignorados = new Set(["id", "creado_por", "creado_en", "actualizado_en"]);
        const campos = { ...(payload as Record<string, unknown>) };
        for (const k of Object.keys(campos)) if (ignorados.has(k)) delete campos[k];
        const desconocidos = Object.keys(campos).filter((k) => !columnas.includes(k));
        if (desconocidos.length) {
          resultados.push({ uuid, estado: "error", detalle: `campos desconocidos: ${desconocidos.join(", ")}` });
          continue;
        }

        try {
          const mapa = db
            .prepare("SELECT * FROM sync_registros WHERE tabla = ? AND uuid = ?")
            .get(t, uuid) as { registro_id: number; version: number } | undefined;

          if (mapa && (version as number) <= mapa.version) {
            const local = db.prepare(`SELECT * FROM ${t} WHERE id = ?`).get(mapa.registro_id);
            resultados.push({
              uuid,
              estado: "conflicto",
              version_servidor: mapa.version,
              registro_local: local,
              detalle: "gana la versión mayor; resolución humana requerida",
            });
            continue;
          }

          // El usuario del empujón es el responsable registrado en el servidor.
          campos.creado_por = req.usuario!.id;
          let accion = "update";
          let registroId: number;
          if (!mapa) {
            accion = "insert";
            if (typeof campos.folio === "string" && (campos.folio.startsWith("OP-LOCAL") || folioOcupado(db, campos.folio))) {
              campos.folio = siguienteFolio(db);
            }
            const cols = Object.keys(campos);
            const ins = db
              .prepare(`INSERT INTO ${t} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
              .run(...cols.map((c) => campos[c]));
            registroId = Number(ins.lastInsertRowid);
          } else {
            registroId = mapa.registro_id;
            const cols = Object.keys(campos);
            if (cols.length) {
              db.prepare(
                `UPDATE ${t} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`
              ).run(...cols.map((c) => campos[c]), registroId);
            }
          }
          db.prepare(
            `INSERT INTO sync_registros (tabla, uuid, registro_id, version) VALUES (?, ?, ?, ?)
             ON CONFLICT (tabla, uuid) DO UPDATE SET version = excluded.version`
          ).run(t, uuid, registroId, version);
          const fila = db.prepare(`SELECT * FROM ${t} WHERE id = ?`).get(registroId);
          db.prepare(
            `INSERT OR IGNORE INTO sync_aplicados (tabla, uuid, version, accion, payload, usuario_id)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).run(t, uuid, version, accion, JSON.stringify(fila), req.usuario!.id);
          registrarAuditoria(
            db,
            req.usuario!.id,
            "sync_aplicacion",
            `Sync ${accion} de ${t} ${uuid} v${version}`,
            t === "operaciones" ? registroId : null
          );
          resultados.push({ uuid, estado: "aplicado", accion, id: registroId });
        } catch (e) {
          resultados.push({ uuid, estado: "error", detalle: (e as Error).message });
        }
      }
      res.json({ resultados });
    }
  );

  r.get("/sync/pull", autenticar, (req, res) => {
    const desde = Number(req.query.desde ?? 0);
    const cursor = Number.isFinite(desde) && desde >= 0 ? desde : 0;
    const filas = db
      .prepare(
        `SELECT id, tabla, uuid, version, accion, payload, fecha
         FROM sync_aplicados WHERE id > ? ORDER BY id LIMIT 200`
      )
      .all(cursor) as Array<{ payload: string; id: number }>;
    res.json({
      cambios: filas.map((f) => ({ ...f, payload: JSON.parse(f.payload) })),
      cursor: filas.length ? filas[filas.length - 1].id : cursor,
    });
  });

  // ---- Auditoría ----
  // Bitácora global: Auditoría y Dirección (03-roles-y-permisos) + admin
  // (01-ROLES.md §8.1 "consultar bitácoras técnicas"; decisión documentada en
  // plan-maestro-roles.md: el admin la consulta, no interviene financieramente).
  r.get("/auditoria", autenticar, requiereRol("auditoria", "direccion", "admin"), (_req, res) => {
    const filas = db
      .prepare(
        `SELECT a.*, u.nombre AS usuario, o.folio
         FROM auditoria a
         JOIN usuarios u ON u.id = a.usuario_id
         LEFT JOIN operaciones o ON o.id = a.operacion_id
         ORDER BY a.id DESC LIMIT 500`
      )
      .all();
    res.json({ eventos: filas });
  });

  // Concentrado descargable (01-ROLES.md §7.1 "Descargar concentrados",
  // §13 "Descargar concentración": tesorería, dirección, auditoría).
  r.get(
    "/reportes/concentrado",
    autenticar,
    requiereRol("tesoreria", "direccion", "auditoria"),
    (_req, res) => {
      const esc = (v: unknown): string => {
        const s = v === null || v === undefined ? "" : String(v);
        return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const lineas: string[] = [];
      lineas.push("# CONCENTRADO DE OPERACIONES FINANCIERAS");
      lineas.push(`# Generado: ${new Date().toISOString()}`);
      lineas.push("");
      lineas.push("PAGOS");
      lineas.push("id,folio,fecha_pago,medio,monto,moneda,comprobante,pagador,cuenta,fecha_registro");
      const pagos = db
        .prepare(
          `SELECT p.*, o.folio, u.nombre AS pagador, c.nombre AS cuenta
           FROM pagos p
           JOIN operaciones o ON o.id = p.operacion_id
           JOIN usuarios u ON u.id = p.pagado_por
           LEFT JOIN cuentas c ON c.id = p.cuenta_id
           ORDER BY p.id`
        )
        .all() as Array<Record<string, unknown>>;
      for (const p of pagos) {
        lineas.push(
          [p.id, p.folio, p.fecha_pago, p.medio, p.monto, p.moneda, p.comprobante, p.pagador, p.cuenta ?? "", p.fecha_registro]
            .map(esc)
            .join(",")
        );
      }
      lineas.push("");
      lineas.push("MOVIMIENTOS_DE_CUENTAS");
      lineas.push("id,cuenta,tipo,monto,concepto,fecha,registrado_por");
      const movimientos = db
        .prepare(
          `SELECT m.*, c.nombre AS cuenta, u.nombre AS registrado_por
           FROM movimientos_cuentas m
           JOIN cuentas c ON c.id = m.cuenta_id
           JOIN usuarios u ON u.id = m.creado_por
           ORDER BY m.id`
        )
        .all() as Array<Record<string, unknown>>;
      for (const m of movimientos) {
        lineas.push(
          [m.id, m.cuenta, m.tipo, m.monto, m.concepto, m.fecha, m.registrado_por].map(esc).join(",")
        );
      }
      lineas.push("");
      lineas.push("APLICACIONES_DE_RECURSOS");
      lineas.push("id,operacion_folio,movimiento_id,importe,moneda,aplicado_por,aplicado_en,liberado,liberador");
      const aplicaciones = db
        .prepare(
          `SELECT ar.*, o.folio, u.nombre AS aplicador, ul.nombre AS liberador
           FROM aplicaciones_recursos ar
           JOIN operaciones o ON o.id = ar.operacion_id
           JOIN usuarios u ON u.id = ar.aplicado_por
           LEFT JOIN usuarios ul ON ul.id = ar.liberado_por
           ORDER BY ar.id`
        )
        .all() as Array<Record<string, unknown>>;
      for (const a of aplicaciones) {
        lineas.push(
          [a.id, a.folio, a.movimiento_id, a.importe, a.moneda, a.aplicador, a.aplicado_en, a.liberado_por ? "si" : "no", a.liberador ?? ""]
            .map(esc)
            .join(",")
        );
      }
      const fecha = new Date().toISOString().slice(0, 10);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="concentrado-${fecha}.csv"`);
      res.send("\uFEFF" + lineas.join("\n"));
    }
  );

  // Fase 12 — Auditoría ES SÓLO LECTURA: el auditor ve todas las operaciones
  // (proceso y estatus), la bitácora y el concentrado, pero no registra
  // observaciones ni modifica nada.

  return r;
}

function folioOcupado(db: Database, folio: unknown): boolean {
  return typeof folio === "string" && !!db.prepare("SELECT 1 FROM operaciones WHERE folio = ?").get(folio);
}

function siguienteFolio(db: Database): string {
  const n = (db.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS n FROM operaciones").get() as { n: number }).n;
  return `OP-${new Date().getFullYear()}-${String(n).padStart(5, "0")}`;
}

/**
 * Umbral de Dirección vigente: si el admin configuró el parámetro
 * 'umbral_direccion', prevalece; si no, se usa la variable de entorno.
 */
function leerUmbralDireccion(db: Database): number {
  const fila = db
    .prepare("SELECT valor FROM parametros WHERE clave = 'umbral_direccion'")
    .get() as { valor: string } | undefined;
  const n = fila ? Number(fila.valor) : NaN;
  return Number.isFinite(n) && n > 0 ? n : UMBRAL_DIRECCION;
}

/**
 * Visibilidad de una operación por rol (Fase 12) — misma regla que el listado
 * GET /operaciones. Se aplica en el detalle y en los flujos de escritura para
 * que nadie actúe sobre operaciones fuera de su alcance.
 */
function puedeVerOperacion(
  db: Database,
  op: Operacion,
  usuario: { id: number; rol: Rol }
): boolean {
  switch (usuario.rol) {
    case "admin":
    case "admin_operaciones":
    case "admin_validacion":
    case "admin_tesoreria":
    case "validador_tesoreria":
    case "direccion":
    case "auditoria":
      return true;
    case "operacion":
      return visibleParaEjecutivo(db, op, usuario.id);
    case "validacion": {
      const asignada = db
        .prepare(
          "SELECT 1 AS ok FROM asignaciones_validacion WHERE operacion_id = ? AND validador_id = ? AND activo = 1 AND cerrado_en IS NULL"
        )
        .get(op.id, usuario.id);
      if (asignada) return true;
      const mios = db
        .prepare(
          "SELECT 1 AS ok FROM validacion_ejecutivos WHERE validador_id = ? AND ejecutivo_id = ? AND activo = 1 AND cerrado_en IS NULL"
        )
        .get(usuario.id, op.creado_por);
      if (mios) return true;
      // Flujo simple (§4.2): si el ejecutivo no está distribuido, la ven todos.
      const distribuido = db
        .prepare(
          "SELECT 1 AS ok FROM validacion_ejecutivos WHERE ejecutivo_id = ? AND activo = 1 AND cerrado_en IS NULL LIMIT 1"
        )
        .get(op.creado_por);
      return !distribuido;
    }
    case "fondeador":
      return ["en_validacion", "observada", "pendiente_direccion", "aprobada", "en_pago", "pagada"].includes(
        op.estado
      );
    case "tesoreria":
      return op.liberada_en !== null;
    case "confirmador":
      return !!db
        .prepare(
          "SELECT 1 AS ok FROM operaciones_depositos WHERE operacion_id = ? AND validado_por IS NULL LIMIT 1"
        )
        .get(op.id);
    case "altas":
      // Tesorería de Altas sólo abre operaciones con solicitudes de alta
      // ligadas (contexto para registrar la cuenta en el portal bancario).
      return !!db
        .prepare("SELECT 1 AS ok FROM altas_bancarias WHERE operacion_id = ? LIMIT 1")
        .get(op.id);
    default:
      return false;
  }
}

/** Normaliza banco para comparación (mayúsculas, sin espacios ni guiones). */
function normalizaBanco(valor: string): string {
  return valor.trim().replace(/[\s-]/g, "").toUpperCase();
}

/** Normaliza cuenta/CLABE para comparación (mayúsculas, sin espacios ni guiones). */
function normalizaCuenta(valor: string): string {
  return valor.trim().replace(/[\s-]/g, "").toUpperCase();
}

/** Última solicitud/alta conocida de una cuenta en un banco (cualquier estado). */
function altaDeCuenta(db: Database, banco: string, cuenta: string): import("./db.js").AltaBancaria | undefined {
  return db
    .prepare(
      `SELECT * FROM altas_bancarias
       WHERE REPLACE(REPLACE(UPPER(banco), ' ', ''), '-', '') = ?
         AND REPLACE(REPLACE(UPPER(cuenta), ' ', ''), '-', '') = ?
       ORDER BY id DESC LIMIT 1`
    )
    .get(normalizaBanco(banco), normalizaCuenta(cuenta)) as import("./db.js").AltaBancaria | undefined;
}

/**
 * Cuentas de las dispersiones de la operación SIN alta bancaria registrada
 * (Fase 12). Las líneas sin banco o sin cuenta/CLABE no son verificables y no
 * bloquean (el medio de pago puede no ser transferencia a esas cuentas).
 */
function verificarAltasOperacion(
  db: Database,
  operacionId: number
): Array<{ dispersion_id: number; beneficiario: string; banco: string; cuenta: string; importe: number }> {
  const dispersiones = db
    .prepare("SELECT * FROM dispersiones WHERE operacion_id = ? ORDER BY orden, id")
    .all(operacionId) as Array<import("./db.js").Dispersion>;
  const faltantes: Array<{
    dispersion_id: number;
    beneficiario: string;
    banco: string;
    cuenta: string;
    importe: number;
  }> = [];
  for (const d of dispersiones) {
    const ident = d.cuenta.trim() || d.clabe.trim();
    if (!d.banco.trim() || !ident) continue;
    const alta = altaDeCuenta(db, d.banco, ident);
    if (!alta || alta.estado !== "registrada") {
      faltantes.push({
        dispersion_id: d.id,
        beneficiario: d.beneficiario,
        banco: d.banco,
        cuenta: ident,
        importe: d.importe,
      });
    }
  }
  return faltantes;
}

/** Alcance del Ejecutivo (01-ROLES.md §12): operación propia o de cliente asignado/cubierto. */
function visibleParaEjecutivo(db: Database, op: Operacion, usuarioId: number): boolean {
  if (op.creado_por === usuarioId) return true;
  if (op.cliente_id === null) return false;
  return clienteVisibleParaEjecutivo(db, op.cliente_id, usuarioId);
}

/** ¿El cliente está en el alcance del ejecutivo? (§3.1, §12): asignación vigente o cobertura vigente. */
function clienteVisibleParaEjecutivo(db: Database, clienteId: number, usuarioId: number): boolean {
  const asignado = db
    .prepare(
      "SELECT 1 AS ok FROM cliente_asignaciones WHERE cliente_id = ? AND ejecutivo_id = ? AND activo = 1 AND cerrado_en IS NULL"
    )
    .get(clienteId, usuarioId);
  if (asignado) return true;
  const cobertura = db
    .prepare(
      "SELECT 1 AS ok FROM cliente_coberturas WHERE cliente_id = ? AND ejecutivo_temporal_id = ? AND activo = 1 AND (fecha_fin IS NULL OR fecha_fin >= date('now'))"
    )
    .get(clienteId, usuarioId);
  return !!cobertura;
}

/** Saldo del resguardo del cliente: suma de sus movimientos (§14, nunca se guarda).
 * 'deposito' y 'financiamiento' suman; 'cargo' resta. */
function saldoResguardo(db: Database, clienteId: number): number {
  const fila = db
    .prepare(
      "SELECT COALESCE(SUM(CASE WHEN tipo IN ('deposito','financiamiento') THEN importe ELSE -importe END), 0) AS saldo FROM resguardos_movimientos WHERE cliente_id = ?"
    )
    .get(clienteId) as { saldo: number };
  return fila.saldo;
}

/** Política de financiamiento del cliente (§6.1): ¿el monto pedido requiere
 * aprobación de Dirección o entra por una exención (sin aprobación previa o
 * dentro del monto máximo ya aprobado)? */
function politicaFinanciamiento(
  cliente: { financiamiento_sin_aprobacion?: number; financiamiento_maximo?: number | null },
  monto: number
): { requiereAprobacion: boolean; exentoMotivo: string } {
  if (cliente.financiamiento_sin_aprobacion === 1) {
    return { requiereAprobacion: false, exentoMotivo: "sin_aprobacion_previa" };
  }
  if (typeof cliente.financiamiento_maximo === "number" && monto <= cliente.financiamiento_maximo + 0.005) {
    return { requiereAprobacion: false, exentoMotivo: "monto_maximo" };
  }
  return { requiereAprobacion: true, exentoMotivo: "" };
}

/** Respaldo disponible para UNA operación (§6.1): saldo real de resguardo del
 * cliente + depósitos indicados de ESA operación pendientes de validar +
 * financiamientos de ESA operación por aprobar (los aprobados ya entraron al
 * saldo como movimiento 'financiamiento'). Es por operación para que dos
 * capturas en curso no reclamen el mismo dinero pendiente. */
function respaldoDeOperacion(
  db: Database,
  op: Pick<Operacion, "id" | "cliente_id">
): {
  saldo_resguardo: number;
  depositos_pendientes: number;
  financiamiento_solicitado: number;
  disponible: number;
} | null {
  if (op.cliente_id === null) return null;
  const saldo = saldoResguardo(db, op.cliente_id);
  const depositosPendientes = redondear2(
    (
      db
        .prepare(
          "SELECT COALESCE(SUM(monto), 0) AS t FROM operaciones_depositos WHERE operacion_id = ? AND validado_por IS NULL"
        )
        .get(op.id) as { t: number }
    ).t
  );
  const financiamientoSolicitado = redondear2(
    (
      db
        .prepare("SELECT COALESCE(SUM(monto), 0) AS t FROM financiamientos WHERE operacion_id = ? AND estado = 'solicitado'")
        .get(op.id) as { t: number }
    ).t
  );
  return {
    saldo_resguardo: redondear2(saldo),
    depositos_pendientes: depositosPendientes,
    financiamiento_solicitado: financiamientoSolicitado,
    disponible: redondear2(saldo + depositosPendientes + financiamientoSolicitado),
  };
}

/** ¿El tesorero tiene cuentas asignadas vigentes o coberturas vigentes? (§5.3, §12) */
function tesoreroTieneAsignaciones(db: Database, usuarioId: number): boolean {
  const asignada = db
    .prepare(
      "SELECT 1 AS ok FROM cuentas_asignaciones WHERE tesorero_id = ? AND activo = 1 AND cerrado_en IS NULL LIMIT 1"
    )
    .get(usuarioId);
  if (asignada) return true;
  const cubierta = db
    .prepare(
      "SELECT 1 AS ok FROM coberturas WHERE tesorero_temporal_id = ? AND activo = 1 AND (fecha_fin IS NULL OR fecha_fin >= date('now')) LIMIT 1"
    )
    .get(usuarioId);
  return !!cubierta;
}

/** La cuenta está dentro del alcance del tesorero: asignación vigente o cobertura vigente. */
function cuentaVisibleParaTesorero(db: Database, cuentaId: number, usuarioId: number): boolean {
  const asignada = db
    .prepare(
      "SELECT 1 AS ok FROM cuentas_asignaciones WHERE cuenta_id = ? AND tesorero_id = ? AND activo = 1 AND cerrado_en IS NULL"
    )
    .get(cuentaId, usuarioId);
  if (asignada) return true;
  const cubierta = db
    .prepare(
      "SELECT 1 AS ok FROM coberturas WHERE cuenta_id = ? AND tesorero_temporal_id = ? AND activo = 1 AND (fecha_fin IS NULL OR fecha_fin >= date('now'))"
    )
    .get(cuentaId, usuarioId);
  return !!cubierta;
}

/** Contexto de dispersión de una operación para el registro de tandas (§14: todo calculado). */
function contextoPago(
  db: Database,
  op: Operacion
): {
  tieneDispersiones: boolean;
  totalPorDispersar: number;
  totalDispersado: number;
  restante: number;
} {
  const dispersiones = db
    .prepare("SELECT importe FROM dispersiones WHERE operacion_id = ?")
    .all(op.id) as Array<{ importe: number }>;
  const totalPorDispersar = dispersiones.length
    ? redondear2(dispersiones.reduce((s, d) => s + d.importe, 0))
    : op.monto;
  const totalDispersado = redondear2(
    (db.prepare("SELECT COALESCE(SUM(monto), 0) AS t FROM pagos WHERE operacion_id = ?").get(op.id) as { t: number })
      .t
  );
  return {
    tieneDispersiones: dispersiones.length > 0,
    totalPorDispersar,
    totalDispersado,
    restante: redondear2(totalPorDispersar - totalDispersado),
  };
}

/**
 * Saldo del resguardo de TRF por moneda + equivalente en pesos (usando el tipo
 * de cambio registrado en cada movimiento). Lo usan el ledger completo
 * (GET /trf/resguardo) y el resumen de saldos para la captura de pagos
 * especiales (GET /trf/resguardo/saldo).
 */
function saldoPorMonedaTrf(
  db: Database
): Array<{ moneda: string; saldo: number; ingresos: number; retiros: number; equivalente_mxn: number }> {
  const movimientos = db
    .prepare("SELECT tipo, importe, moneda, tipo_cambio FROM trf_resguardos_movimientos")
    .all() as Array<{ tipo: "ingreso" | "retiro"; importe: number; moneda: string; tipo_cambio: number | null }>;
  const equivalente = (m: { importe: number; moneda: string; tipo_cambio: number | null }): number =>
    m.moneda === "MXN" ? m.importe : redondear2(m.importe * (m.tipo_cambio ?? 0));
  const porMoneda = new Map<string, { ingresos: number; retiros: number; equivalente: number }>();
  for (const m of movimientos) {
    const b = porMoneda.get(m.moneda) ?? { ingresos: 0, retiros: 0, equivalente: 0 };
    if (m.tipo === "ingreso") b.ingresos = redondear2(b.ingresos + m.importe);
    else b.retiros = redondear2(b.retiros + m.importe);
    b.equivalente = redondear2(b.equivalente + (m.tipo === "ingreso" ? equivalente(m) : -equivalente(m)));
    porMoneda.set(m.moneda, b);
  }
  return Array.from(porMoneda.entries())
    .map(([moneda, b]) => ({
      moneda,
      saldo: redondear2(b.ingresos - b.retiros),
      ingresos: b.ingresos,
      retiros: b.retiros,
      // Para MXN el equivalente es el propio saldo; para otras monedas es el
      // saldo convertido con los tipos de cambio registrados.
      equivalente_mxn: moneda === "MXN" ? redondear2(b.ingresos - b.retiros) : b.equivalente,
    }))
    .sort((a, b) => (a.moneda === "MXN" ? -1 : b.moneda === "MXN" ? 1 : a.moneda.localeCompare(b.moneda)));
}

/**
 * Ajuste del negocio — TRF AL AUTORIZARSE: al quedar APROBADA la operación se
 * aplican sus movimientos al resguardo de TRF (antes se aplicaban al pagarse):
 *   · Pago especial originado de TRF → retiro del importe (el efectivo queda
 *     apartado para la operación desde su autorización).
 *   · Flujo con comisión TRF en MXN → ingreso de la comisión al resguardo.
 * Idempotente por operación+tipo. Si el retiro no tiene fondo lanza 409 para
 * que la AUTORIZACIÓN no proceda (la captura sólo valida; aquí se aparta el
 * efectivo). Llamar DENTRO de una transacción junto a cambiarEstado.
 */
function aplicarTrfAlAutorizar(db: Database, op: Operacion, usuarioId: number): void {
  if (op.tipo === "pago_especial") {
    const pe = db
      .prepare("SELECT resguardo_origen, broker_origen_id, broker_origen FROM pagos_especiales WHERE operacion_id = ?")
      .get(op.id) as
      | { resguardo_origen: "trf" | "broker"; broker_origen_id: number | null; broker_origen: string }
      | undefined;
    if (!pe || pe.resguardo_origen !== "trf") return;
    const ya = db
      .prepare("SELECT 1 FROM trf_resguardos_movimientos WHERE operacion_id = ? AND tipo = 'retiro'")
      .get(op.id);
    if (ya) return;
    const importe = redondear2(op.monto);
    const saldo = (
      db
        .prepare(
          "SELECT COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN importe ELSE -importe END), 0) AS s FROM trf_resguardos_movimientos WHERE moneda = 'MXN'"
        )
        .get() as { s: number }
    ).s;
    if (importe > redondear2(saldo) + 0.005) {
      throw new ErrorDominio(
        409,
        `No se puede autorizar: el resguardo de TRF no tiene depósito suficiente (saldo ${redondear2(saldo).toFixed(2)} MXN frente a ${importe.toFixed(2)} MXN del pago especial). Aliméntalo o cancela la operación.`
      );
    }
    db
      .prepare(
        "INSERT INTO trf_resguardos_movimientos (tipo, importe, moneda, operacion_id, notas, creado_por) VALUES ('retiro', ?, 'MXN', ?, ?, ?)"
      )
      .run(importe, op.id, `Pago especial (${op.folio}): ${op.concepto} — aplicado al autorizarse`, usuarioId);
    registrarAuditoria(
      db,
      usuarioId,
      "trf_resguardo_aplicado",
      `Retiro de ${importe.toFixed(2)} MXN aplicado al resguardo de TRF al AUTORIZARSE el pago especial ${op.folio}`,
      op.id
    );
    return;
  }
  if (op.tipo === "flujo" && (op.comision_trf_pct ?? 0) > 0 && op.moneda === "MXN") {
    const yaIngreso = db
      .prepare("SELECT 1 FROM trf_resguardos_movimientos WHERE operacion_id = ? AND tipo = 'ingreso'")
      .get(op.id);
    if (yaIngreso) return;
    const importeTrf = redondear2((op.monto * (op.comision_trf_pct as number)) / 100);
    if (importeTrf <= 0) return;
    db
      .prepare(
        "INSERT INTO trf_resguardos_movimientos (tipo, importe, moneda, operacion_id, notas, creado_por) VALUES ('ingreso', ?, 'MXN', ?, ?, ?)"
      )
      .run(
        importeTrf,
        op.id,
        `Comisión TRF ${op.comision_trf_pct}% de la operación ${op.folio} — aplicada al autorizarse`,
        usuarioId
      );
    registrarAuditoria(
      db,
      usuarioId,
      "trf_resguardo_aplicado",
      `Ingreso de ${importeTrf.toFixed(2)} MXN (comisión TRF) aplicado al resguardo de TRF al AUTORIZARSE la operación ${op.folio}`,
      op.id
    );
  }
}

/**
 * Ajuste del negocio — reversa al CANCELAR: si una operación ya autorizada se
 * cancela, se reversan los movimientos de TRF que se aplicaron al autorizarla
 * (ledger append-only: se registra el movimiento CONTRARIO ligado a la
 * operación). Sin efecto si no había movimientos o ya se reversó.
 */
function reversarTrfAlCancelar(db: Database, op: Operacion, usuarioId: number): void {
  const yaReversa = db
    .prepare("SELECT 1 FROM trf_resguardos_movimientos WHERE operacion_id = ? AND notas LIKE 'Reversa%'")
    .get(op.id);
  if (yaReversa) return;
  const previos = db
    .prepare(
      "SELECT tipo, importe, moneda FROM trf_resguardos_movimientos WHERE operacion_id = ? AND notas NOT LIKE 'Reversa%'"
    )
    .all(op.id) as Array<{ tipo: "ingreso" | "retiro"; importe: number; moneda: string }>;
  for (const m of previos) {
    const contrario = m.tipo === "retiro" ? "ingreso" : "retiro";
    db
      .prepare(
        "INSERT INTO trf_resguardos_movimientos (tipo, importe, moneda, operacion_id, notas, creado_por) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(contrario, m.importe, m.moneda, op.id, `Reversa por cancelación de la operación ${op.folio}`, usuarioId);
    registrarAuditoria(
      db,
      usuarioId,
      "trf_resguardo_reversa",
      `Reversa (${contrario} de ${m.importe.toFixed(2)} ${m.moneda}) en el resguardo de TRF por la cancelación de la operación ${op.folio}`,
      op.id
    );
  }
}

/** Valida una tanda contra el contexto (estado, montos y resguardo). Lanza ErrorDominio. */
function validarTanda(
  db: Database,
  op: Operacion,
  datos: DatosTanda,
  ctx: ReturnType<typeof contextoPago>
): void {
  if (!["aprobada", "en_pago"].includes(op.estado)) {
    throw new ErrorDominio(
      409,
      `La operación está en '${op.estado}', se requiere 'aprobada' (o 'en_pago' para tandas siguientes)`
    );
  }
  if (ctx.tieneDispersiones) {
    if (datos.monto > ctx.restante + 0.005) {
      throw new ErrorDominio(
        400,
        `La tanda (${datos.monto.toFixed(2)}) excede el restante por dispersar (${ctx.restante.toFixed(2)})`
      );
    }
  } else if (Math.abs(datos.monto - op.monto) > 0.005) {
    throw new ErrorDominio(
      400,
      `El monto del pago (${datos.monto}) debe coincidir con el monto de la operación (${op.monto})`
    );
  }
  if (op.cliente_id !== null) {
    const saldo = saldoResguardo(db, op.cliente_id);
    if (saldo - datos.monto < -0.005) {
      throw new ErrorDominio(
        409,
        `Resguardo insuficiente del cliente: saldo ${saldo.toFixed(2)}, tanda ${datos.monto.toFixed(2)}`
      );
    }
  }
  // Pago especial (Fase 14): el resguardo de origen debe SEGUIR teniendo
  // depósito suficiente al momento de pagar (puede haber bajado desde la
  // captura); si no cubre, Tesorería no dispersa.
  if (op.tipo === "pago_especial") {
    const pe = db.prepare("SELECT resguardo_origen, broker_origen_id, broker_origen FROM pagos_especiales WHERE operacion_id = ?").get(
      op.id
    ) as { resguardo_origen: "trf" | "broker"; broker_origen_id: number | null; broker_origen: string } | undefined;
    if (!pe) throw new ErrorDominio(409, "La operación es un pago especial pero no tiene datos de origen del resguardo");
    if (pe.resguardo_origen === "trf") {
      // El retiro se aplicó AL AUTORIZARSE la operación: el efectivo ya quedó
      // apartado para ella y no se re-valida contra el saldo del resguardo.
      const yaRetirado = db
        .prepare("SELECT 1 FROM trf_resguardos_movimientos WHERE operacion_id = ? AND tipo = 'retiro'")
        .get(op.id);
      if (!yaRetirado) {
        const saldoTrf = (
          db
            .prepare("SELECT COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN importe ELSE -importe END), 0) AS s FROM trf_resguardos_movimientos WHERE moneda = 'MXN'")
            .get() as { s: number }
        ).s;
        if (datos.monto > redondear2(saldoTrf) + 0.005) {
          throw new ErrorDominio(
            409,
            `El resguardo de TRF ya no tiene depósito suficiente: saldo ${redondear2(saldoTrf).toFixed(2)} MXN frente a la tanda de ${datos.monto.toFixed(2)} MXN`
          );
        }
      }
    } else if (pe.broker_origen_id !== null) {
      const comisiones = (
        db.prepare("SELECT COALESCE(SUM(importe), 0) AS t FROM brokers_resguardos WHERE broker_id = ? AND tipo = 'comision'").get(
          pe.broker_origen_id
        ) as { t: number }
      ).t;
      const retiros = (
        db.prepare("SELECT COALESCE(SUM(importe), 0) AS t FROM brokers_resguardos WHERE broker_id = ? AND tipo = 'retiro'").get(
          pe.broker_origen_id
        ) as { t: number }
      ).t;
      const saldoBroker = redondear2(comisiones - retiros);
      if (datos.monto > saldoBroker + 0.005) {
        throw new ErrorDominio(
          409,
          `El resguardo del broker ${pe.broker_origen} ya no tiene depósito suficiente: saldo ${saldoBroker.toFixed(2)} MXN frente a la tanda de ${datos.monto.toFixed(2)} MXN`
        );
      }
    }
  }
}

/**
 * Registra una tanda de pago dentro de una transacción: pago + cargo al
 * resguardo del cliente + cambio de estado ('en_pago' parcial o 'pagada' al
 * cubrir el flujo total; en ese momento la diferencia a favor del formato
 * FLUJO queda ingresada al resguardo del cliente).
 */
function registrarTanda(
  db: Database,
  opOperacion: Operacion,
  datos: DatosTanda,
  usuarioId: number
): {
  operacion: Operacion;
  pago: import("./db.js").Pago;
  completado: boolean;
  pagado: { total_por_dispersar: number; total_dispersado: number; restante: number };
} {
  const ctx = contextoPago(db, opOperacion);
  const tx = db.transaction(() => {
    const insercion = db
      .prepare(
        `INSERT INTO pagos (operacion_id, medio, monto, moneda, fecha_pago, comprobante, notas, pagado_por, cuenta_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        opOperacion.id,
        datos.medio,
        datos.monto,
        opOperacion.moneda,
        datos.fecha_pago,
        datos.comprobante,
        datos.notas,
        usuarioId,
        datos.cuenta_id
      );
    const pagoId = Number(insercion.lastInsertRowid);
    registrarAuditoria(
      db,
      usuarioId,
      "pago",
      `Pago (tanda) por ${datos.medio}, comprobante ${datos.comprobante}`,
      opOperacion.id
    );
    if (opOperacion.cliente_id !== null) {
      db.prepare(
        `INSERT INTO resguardos_movimientos (cliente_id, tipo, importe, operacion_id, cuenta_id, comprobante, observaciones, creado_por)
         VALUES (?, 'cargo', ?, ?, ?, ?, 'Cargo por pago (tanda) de la operación', ?)`
      ).run(opOperacion.cliente_id, datos.monto, opOperacion.id, datos.cuenta_id, datos.comprobante, usuarioId);
      registrarAuditoria(
        db,
        usuarioId,
        "resguardo_cargo",
        `Cargo de ${datos.monto} al resguardo del cliente (pago de la operación ${opOperacion.folio})`,
        opOperacion.id
      );
    }
    const totalDispersado = redondear2(ctx.totalDispersado + datos.monto);
    const completado = Math.abs(totalDispersado - ctx.totalPorDispersar) <= 0.005;
    let operacion = opOperacion;
    if (completado) {
      operacion = cambiarEstado(db, opOperacion, "pagada", usuarioId);
      // Resguardo de comisiones por broker: al quedar PAGADA la operación, la
      // comisión cobrada de cada broker participante entra a su resguardo
      // (append-only; anti doble alta por operación+broker).
      const participantes = db
        .prepare("SELECT broker_id, nombre, monto FROM operaciones_brokers WHERE operacion_id = ? AND monto > 0")
        .all(opOperacion.id) as Array<{ broker_id: number; nombre: string; monto: number }>;
      for (const b of participantes) {
        const ya = db
          .prepare("SELECT 1 FROM brokers_resguardos WHERE broker_id = ? AND operacion_id = ? AND tipo = 'comision'")
          .get(b.broker_id, opOperacion.id);
        if (!ya) {
          db.prepare(
            "INSERT INTO brokers_resguardos (broker_id, tipo, importe, operacion_id, notas, creado_por) VALUES (?, 'comision', ?, ?, ?, ?)"
          ).run(b.broker_id, redondear2(b.monto), opOperacion.id, `Comisión de la operación ${opOperacion.folio}`, usuarioId);
        }
      }
      if (participantes.length > 0) {
        registrarAuditoria(
          db,
          usuarioId,
          "broker_comision_resguardo",
          `Comisiones de ${participantes.map((b) => b.nombre).join(", ")} ingresadas al resguardo de cada broker (operación ${opOperacion.folio})`,
          opOperacion.id
        );
      }
      // ---- Fase 14: pago especial — al quedar PAGADA, el efectivo sale del
      // resguardo de origen. Para TRF el retiro se aplica AL AUTORIZARSE
      // (aplicarTrfAlAutorizar); este bloque queda como red de seguridad
      // idempotente para operaciones autorizadas antes del ajuste. El broker
      // sigue descontándose al pagarse.
      if (opOperacion.tipo === "pago_especial") {
        const pe = db
          .prepare("SELECT resguardo_origen, broker_origen_id, broker_origen FROM pagos_especiales WHERE operacion_id = ?")
          .get(opOperacion.id) as
          | { resguardo_origen: "trf" | "broker"; broker_origen_id: number | null; broker_origen: string }
          | undefined;
        if (pe) {
          if (pe.resguardo_origen === "trf") {
            const ya = db
              .prepare("SELECT 1 FROM trf_resguardos_movimientos WHERE operacion_id = ? AND tipo = 'retiro'")
              .get(opOperacion.id);
            if (!ya) {
              db.prepare(
                "INSERT INTO trf_resguardos_movimientos (tipo, importe, moneda, operacion_id, notas, creado_por) VALUES ('retiro', ?, 'MXN', ?, ?, ?)"
              ).run(
                redondear2(opOperacion.monto),
                opOperacion.id,
                `Pago especial (${opOperacion.folio}): ${opOperacion.concepto}`,
                usuarioId
              );
            }
          } else if (pe.broker_origen_id !== null) {
            const yaB = db
              .prepare("SELECT 1 FROM brokers_resguardos WHERE broker_id = ? AND operacion_id = ? AND tipo = 'retiro'")
              .get(pe.broker_origen_id, opOperacion.id);
            if (!yaB) {
              db.prepare(
                "INSERT INTO brokers_resguardos (broker_id, tipo, importe, operacion_id, notas, creado_por) VALUES (?, 'retiro', ?, ?, ?, ?)"
              ).run(
                pe.broker_origen_id,
                redondear2(opOperacion.monto),
                opOperacion.id,
                `Pago especial (${opOperacion.folio}): ${opOperacion.concepto}`,
                usuarioId
              );
            }
          }
          registrarAuditoria(
            db,
            usuarioId,
            "pago_especial_resguardo",
            `Retiro de ${redondear2(opOperacion.monto).toFixed(2)} MXN del resguardo de ${
              pe.resguardo_origen === "trf" ? "TRF (la empresa)" : `broker ${pe.broker_origen}`
            } por el pago especial ${opOperacion.folio}`,
            opOperacion.id
          );
        }
      }
      // ---- Fase 14: comisión TRF preestablecida — si la operación cobra
      // comisión para TRF (directa al resguardo de la empresa) y está en MXN,
      // ingresa AL AUTORIZARSE (aplicarTrfAlAutorizar); este bloque queda como
      // red de seguridad idempotente para operaciones autorizadas antes del
      // ajuste (si ya hay ingreso ligado a la operación no se duplica).
      else if (
        opOperacion.tipo === "flujo" &&
        (opOperacion.comision_trf_pct ?? 0) > 0 &&
        opOperacion.moneda === "MXN"
      ) {
        const yaIngreso = db
          .prepare("SELECT 1 FROM trf_resguardos_movimientos WHERE operacion_id = ? AND tipo = 'ingreso'")
          .get(opOperacion.id);
        if (!yaIngreso) {
          const importeTrf = redondear2((opOperacion.monto * (opOperacion.comision_trf_pct as number)) / 100);
          if (importeTrf > 0) {
            db.prepare(
              "INSERT INTO trf_resguardos_movimientos (tipo, importe, moneda, operacion_id, notas, creado_por) VALUES ('ingreso', ?, 'MXN', ?, ?, ?)"
            ).run(
              importeTrf,
              opOperacion.id,
              `Comisión TRF (${opOperacion.comision_trf_pct}%) de la operación ${opOperacion.folio}`,
              usuarioId
            );
            registrarAuditoria(
              db,
              usuarioId,
              "trf_resguardo",
              `Ingreso automático de ${importeTrf.toFixed(2)} MXN al resguardo de TRF (comisión ${opOperacion.comision_trf_pct}% de la operación ${opOperacion.folio})`,
              opOperacion.id
            );
          }
        }
      }
      const diferencia = redondear2(opOperacion.monto - ctx.totalPorDispersar);
      if (diferencia > 0.005 && opOperacion.cliente_id !== null) {
        // Diferencia a favor del formato FLUJO: se ingresa al resguardo del
        // cliente (queda como saldo remanente de las cargas por tanda).
        registrarAuditoria(
          db,
          usuarioId,
          "diferencia_resguardo",
          `Diferencia a favor de ${diferencia.toFixed(2)} de la operación ${opOperacion.folio} ingresada al resguardo del cliente`,
          opOperacion.id
        );
      }
    } else if (opOperacion.estado === "aprobada") {
      operacion = cambiarEstado(db, opOperacion, "en_pago", usuarioId);
    }
    const pago = db.prepare("SELECT * FROM pagos WHERE id = ?").get(pagoId) as import("./db.js").Pago;
    return {
      operacion,
      pago,
      completado,
      pagado: {
        total_por_dispersar: ctx.totalPorDispersar,
        total_dispersado: totalDispersado,
        restante: redondear2(ctx.totalPorDispersar - totalDispersado),
      },
    };
  });
  return tx();
}

/**
 * Valida los brokers participantes de una operación: existen, están activos,
 * no se repiten y la suma de sus porcentajes no excede 100% (el resto de la
 * comisión lo retiene la casa).
 */
function validarBrokers(
  db: Database,
  entrada: unknown
): { ok: true; datos: Array<{ broker_id: number; nombre: string; porcentaje: number }> } | { ok: false; errores: string[] } {
  if (entrada === undefined || entrada === null) return { ok: true, datos: [] };
  if (!Array.isArray(entrada)) return { ok: false, errores: ["brokers debe ser un arreglo"] };
  const errores: string[] = [];
  const datos: Array<{ broker_id: number; nombre: string; porcentaje: number }> = [];
  const vistos = new Set<number>();
  (entrada as Array<Record<string, unknown>>).forEach((fila, i) => {
    const f = i + 1;
    const id = fila?.broker_id;
    if (!Number.isInteger(id)) {
      errores.push(`broker ${f}: broker_id requerido`);
      return;
    }
    if (vistos.has(id as number)) {
      errores.push(`broker ${f}: broker_id duplicado`);
      return;
    }
    vistos.add(id as number);
    const pct = typeof fila?.porcentaje === "number" ? fila.porcentaje : NaN;
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      errores.push(`broker ${f}: porcentaje debe estar entre 0 y 100`);
      return;
    }
    const b = db.prepare("SELECT id, nombre, activo FROM brokers WHERE id = ?").get(id) as
      | { id: number; nombre: string; activo: number }
      | undefined;
    if (!b) {
      errores.push(`broker ${f}: no existe (id ${String(id)})`);
      return;
    }
    if (b.activo !== 1) {
      errores.push(`broker ${f}: '${b.nombre}' está inactivo`);
      return;
    }
    datos.push({ broker_id: b.id, nombre: b.nombre, porcentaje: pct });
  });
  if (errores.length) return { ok: false, errores };
  const suma = datos.reduce((s, b) => s + b.porcentaje, 0);
  if (suma > 100 + 1e-9) {
    return {
      ok: false,
      errores: [`la suma de porcentajes de brokers (${suma.toFixed(2)}%) excede 100%`],
    };
  }
  return { ok: true, datos };
}