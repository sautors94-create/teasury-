import { Router } from "express";
import bcrypt from "bcryptjs";
import type { Database } from "better-sqlite3";
import { autenticar, firmarToken, requiereRol } from "./auth.js";
import { UMBRAL_DIRECCION } from "./config.js";
import { cambiarEstado, ErrorDominio, registrarAuditoria } from "./dominio.js";
import {
  emitir,
  MEDIOS_PAGO,
  TABLAS_SYNC,
  TRANSICIONES,
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
      umbral_direccion: UMBRAL_DIRECCION,
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
    emitir(db, "operaciones", Number(resultado.lastInsertRowid), req.usuario!.id);
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
    // Sobre el umbral, aprobar deja la operación pendiente de Dirección.
    const destino: EstadoOperacion =
      resultado === "aprobada"
        ? op.monto >= UMBRAL_DIRECCION
          ? "pendiente_direccion"
          : "aprobada"
        : "observada";
    try {
      const actualizada = cambiarEstado(db, op, destino, req.usuario!.id);
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
      const actualizada = cambiarEstado(db, op, aprobado ? "aprobada" : "observada", req.usuario!.id);
      res.json({ operacion: actualizada });
    } catch (e) {
      res.status(e instanceof ErrorDominio ? e.status : 500).json({ error: (e as Error).message });
    }
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
      umbral_direccion: UMBRAL_DIRECCION,
      por_estado: porEstado,
      pendientes_direccion: pendientes,
      totales,
      pagos_ultimos_30_dias: pagosMes,
      pendientes_tesoreria: pendientesTesoreria,
    });
  });

  // ---- Tesorería: pago con comprobante ----
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
        `INSERT INTO pagos (operacion_id, medio, monto, moneda, fecha_pago, comprobante, notas, pagado_por, cuenta_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        op.id,
        medio,
        monto,
        op.moneda,
        fecha,
        comprobante.trim(),
        typeof notas === "string" ? notas.trim() : "",
        req.usuario!.id,
        typeof cuenta_id === "number" ? cuenta_id : null
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

  r.get(
    "/cuentas",
    autenticar,
    requiereRol("tesoreria", "direccion", "auditoria"),
    (_req, res) => {
      const filas = db
        .prepare(
          `SELECT c.*,
             (c.saldo_inicial
               - COALESCE((SELECT SUM(p.monto) FROM pagos p WHERE p.cuenta_id = c.id), 0)
               + COALESCE((SELECT SUM(CASE WHEN m.tipo = 'deposito' THEN m.monto ELSE -m.monto END)
                           FROM movimientos_cuentas m WHERE m.cuenta_id = c.id), 0)
             ) AS saldo_actual,
             COALESCE((SELECT SUM(p.monto) FROM pagos p WHERE p.cuenta_id = c.id), 0) AS total_pagado
           FROM cuentas c WHERE c.activa = 1 ORDER BY c.id`
        )
        .all();
      res.json({ cuentas: filas });
    }
  );

  r.post("/cuentas", autenticar, requiereRol("tesoreria"), (req, res) => {
    const { nombre, banco, numero_cuenta, saldo_inicial } = req.body ?? {};
    const errores: string[] = [];
    if (typeof nombre !== "string" || !nombre.trim()) errores.push("nombre requerido");
    if (typeof saldo_inicial !== "undefined" && typeof saldo_inicial !== "number")
      errores.push("saldo_inicial debe ser numérico");
    if (typeof banco !== "undefined" && typeof banco !== "string") errores.push("banco debe ser texto");
    if (typeof numero_cuenta !== "undefined" && typeof numero_cuenta !== "string")
      errores.push("numero_cuenta debe ser texto");
    if (errores.length) {
      res.status(400).json({ error: "Datos inválidos", detalles: errores });
      return;
    }
    const raiz = db
      .prepare("INSERT INTO cuentas (nombre, banco, numero_cuenta, saldo_inicial) VALUES (?, ?, ?, ?)")
      .run(
        nombre.trim(),
        typeof banco === "string" ? banco.trim() : "",
        typeof numero_cuenta === "string" ? numero_cuenta.trim() : "",
        typeof saldo_inicial === "number" ? saldo_inicial : 0
      );
    registrarAuditoria(db, req.usuario!.id, "cuenta_creada", `Alta de cuenta '${nombre.trim()}'`);
    const cuenta = db.prepare("SELECT * FROM cuentas WHERE id = ?").get(raiz.lastInsertRowid);
    res.status(201).json({ cuenta });
  });

  r.get(
    "/cuentas/:id",
    autenticar,
    requiereRol("tesoreria", "direccion", "auditoria"),
    (req, res) => {
      const id = Number(req.params.id);
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

  r.post("/cuentas/:id/movimientos", autenticar, requiereRol("tesoreria"), (req, res) => {
    const { tipo, monto, concepto, fecha } = req.body ?? {};
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
    const cuenta = db.prepare("SELECT id, activa FROM cuentas WHERE id = ?").get(Number(req.params.id)) as
      | { id: number; activa: number }
      | undefined;
    if (!cuenta || !cuenta.activa) {
      res.status(404).json({ error: "Cuenta no encontrada o inactiva" });
      return;
    }
    const raiz = db
      .prepare(
        "INSERT INTO movimientos_cuentas (cuenta_id, tipo, monto, concepto, fecha, creado_por) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(cuenta.id, tipo, monto, concepto.trim(), f, req.usuario!.id);
    registrarAuditoria(
      db,
      req.usuario!.id,
      "movimiento_cuenta",
      `${tipo} de ${monto} en cuenta ${cuenta.id}: ${concepto.trim()}`
    );
    const mov = db.prepare("SELECT * FROM movimientos_cuentas WHERE id = ?").get(raiz.lastInsertRowid);
    res.status(201).json({ movimiento: mov });
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
              detalle: "gana la versión menor; resolución humana requerida",
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

function folioOcupado(db: Database, folio: unknown): boolean {
  return typeof folio === "string" && !!db.prepare("SELECT 1 FROM operaciones WHERE folio = ?").get(folio);
}

function siguienteFolio(db: Database): string {
  const n = (db.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS n FROM operaciones").get() as { n: number }).n;
  return `OP-${new Date().getFullYear()}-${String(n).padStart(5, "0")}`;
}
