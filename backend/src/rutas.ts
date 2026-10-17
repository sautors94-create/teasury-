import { Router } from "express";
import bcrypt from "bcryptjs";
import type { Database } from "better-sqlite3";
import { autenticar, firmarToken, requiereRol } from "./auth.js";
import { cambiarEstado, ErrorDominio, registrarAuditoria } from "./dominio.js";
import { MEDIOS_PAGO, TRANSICIONES, type Operacion, type Revision, type Rol } from "./db.js";

interface FilaUsuario {
  id: number;
  username: string;
  password_hash: string;
  nombre: string;
  rol: Rol;
  activo: number;
}

export function crearRouter(db: Database): Router {
  const r = Router();

  r.get("/salud", (_req, res) => {
    res.json({ ok: true, servicio: "teasury-backend", version: "0.1.0" });
  });

  // ---- Catálogos ----
  r.get("/catalogos", autenticar, (_req, res) => {
    res.json({
      estados: Object.entries(TRANSICIONES).map(([estado, permitidas]) => ({ estado, permitidas })),
      tipos: ["pago", "cobro", "financiamiento"],
      roles: ["operacion", "validacion", "tesoreria", "direccion", "auditoria"],
    });
  });

  // ---- Autenticación ----
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
  r.get("/operaciones", autenticar, (req, res) => {
    const { estado, q } = req.query;
    const filtros: string[] = [];
    const params: unknown[] = [];
    if (typeof estado === "string" && estado) {
      filtros.push("estado = ?");
      params.push(estado);
    }
    if (typeof q === "string" && q.trim()) {
      filtros.push("(folio LIKE ? OR concepto LIKE ? OR proveedor LIKE ?)");
      const like = `%${q.trim()}%`;
      params.push(like, like, like);
    }
    const where = filtros.length ? `WHERE ${filtros.join(" AND ")}` : "";
    const filas = db
      .prepare(
        `SELECT o.*, u.nombre AS capturista
         FROM operaciones o JOIN usuarios u ON u.id = o.creado_por
         ${where} ORDER BY o.actualizado_en DESC, o.id DESC`
      )
      .all(...params);
    res.json({ operaciones: filas });
  });

  r.post("/operaciones", autenticar, requiereRol("operacion"), (req, res) => {
    const { tipo, concepto, proveedor, monto, moneda, fecha_operacion } = req.body ?? {};
    const errores: string[] = [];
    if (!["pago", "cobro", "financiamiento"].includes(tipo)) errores.push("tipo inválido (pago|cobro|financiamiento)");
    if (typeof concepto !== "string" || !concepto.trim()) errores.push("concepto requerido");
    if (typeof proveedor !== "string" || !proveedor.trim()) errores.push("proveedor requerido");
    if (typeof monto !== "number" || !(monto > 0)) errores.push("monto debe ser mayor a 0");
    if (typeof fecha_operacion !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(fecha_operacion))
      errores.push("fecha_operacion en formato YYYY-MM-DD");
    if (errores.length) {
      res.status(400).json({ error: "Datos inválidos", detalles: errores });
      return;
    }
    const correlativo = (db.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS n FROM operaciones").get() as { n: number }).n;
    const folio = `OP-${new Date().getFullYear()}-${String(correlativo).padStart(5, "0")}`;
    const resultado = db
      .prepare(
        `INSERT INTO operaciones (folio, tipo, concepto, proveedor, monto, moneda, fecha_operacion, creado_por)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(folio, tipo, concepto.trim(), proveedor.trim(), monto, moneda ?? "MXN", fecha_operacion, req.usuario!.id);
    registrarAuditoria(db, req.usuario!.id, "captura", `Captura de la operación ${folio}`, Number(resultado.lastInsertRowid));
    const op = db.prepare("SELECT * FROM operaciones WHERE id = ?").get(resultado.lastInsertRowid);
    res.status(201).json({ operacion: op });
  });

  r.get("/operaciones/:id", autenticar, (req, res) => {
    const id = Number(req.params.id);
    const op = db.prepare("SELECT * FROM operaciones WHERE id = ?").get(id) as Operacion | undefined;
    if (!op) {
      res.status(404).json({ error: "Operación no encontrada" });
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
    const pago =
      (db.prepare("SELECT * FROM pagos WHERE operacion_id = ?").get(id) as import("./db.js").Pago | undefined) ??
      null;
    res.json({ operacion: op, revisiones, historial, pago });
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
    db.prepare(
      "INSERT INTO revisiones (operacion_id, revisor_id, resultado, comentario) VALUES (?, ?, ?, ?)"
    ).run(op.id, req.usuario!.id, resultado, comentario.trim());
    try {
      const actualizada = cambiarEstado(db, op, resultado, req.usuario!.id);
      res.json({ operacion: actualizada });
    } catch (e) {
      res.status(e instanceof ErrorDominio ? e.status : 500).json({ error: (e as Error).message });
    }
  });

  r.post("/operaciones/:id/cancelar", autenticar, requiereRol("operacion", "direccion"), (req, res) => {
    const op = db.prepare("SELECT * FROM operaciones WHERE id = ?").get(Number(req.params.id)) as
      | Operacion
      | undefined;
    if (!op) {
      res.status(404).json({ error: "Operación no encontrada" });
      return;
    }
    try {
      const actualizada = cambiarEstado(db, op, "cancelada", req.usuario!.id);
      res.json({ operacion: actualizada });
    } catch (e) {
      res.status(e instanceof ErrorDominio ? e.status : 500).json({ error: (e as Error).message });
    }
  });

  // ---- Tesorería: pago con comprobante ----
  r.post("/operaciones/:id/pago", autenticar, requiereRol("tesoreria"), (req, res) => {
    const { medio, monto, fecha_pago, comprobante, notas } = req.body ?? {};
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

    const op = db.prepare("SELECT * FROM operaciones WHERE id = ?").get(Number(req.params.id)) as
      | Operacion
      | undefined;
    if (!op) {
      res.status(404).json({ error: "Operación no encontrada" });
      return;
    }
    if (op.estado !== "aprobada") {
      res.status(409).json({ error: `La operación está en '${op.estado}', se requiere 'aprobada'` });
      return;
    }
    if (Math.abs(monto - op.monto) > 0.005) {
      res.status(400).json({
        error: `El monto del pago (${monto}) debe coincidir con el monto de la operación (${op.monto})`,
        monto_operacion: op.monto,
      });
      return;
    }

    const insercion = db
      .prepare(
        `INSERT INTO pagos (operacion_id, medio, monto, moneda, fecha_pago, comprobante, notas, pagado_por)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        op.id,
        medio,
        monto,
        op.moneda,
        fecha,
        comprobante.trim(),
        typeof notas === "string" ? notas.trim() : "",
        req.usuario!.id
      );
    registrarAuditoria(
      db,
      req.usuario!.id,
      "pago",
      `Pago por ${medio}, comprobante ${comprobante.trim()}`,
      op.id
    );
    try {
      const actualizada = cambiarEstado(db, op, "pagada", req.usuario!.id);
      const pago = db.prepare("SELECT * FROM pagos WHERE id = ?").get(insercion.lastInsertRowid);
      res.status(201).json({ operacion: actualizada, pago });
    } catch (e) {
      db.prepare("DELETE FROM pagos WHERE id = ?").run(insercion.lastInsertRowid);
      res.status(e instanceof ErrorDominio ? e.status : 500).json({ error: (e as Error).message });
    }
  });

  r.get("/pagos", autenticar, requiereRol("tesoreria", "direccion", "auditoria"), (_req, res) => {
    const filas = db
      .prepare(
        `SELECT p.*, o.folio, u.nombre AS pagador
         FROM pagos p
         JOIN operaciones o ON o.id = p.operacion_id
         JOIN usuarios u ON u.id = p.pagado_por
         ORDER BY p.id DESC`
      )
      .all();
    res.json({ pagos: filas });
  });

  // ---- Auditoría ----
  r.get("/auditoria", autenticar, requiereRol("auditoria", "direccion"), (_req, res) => {
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

  return r;
}