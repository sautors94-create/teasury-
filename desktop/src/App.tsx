import { useCallback, useEffect, useState } from "react";
import { api, getToken, setToken } from "./api";import {
  ETIQUETAS_ESTADO,
  MEDIOS_PAGO,
  type Estado,
  type Evento,
  type MedioPago,
  type Operacion,
  type Pago,
  type Revision,
  type Usuario,
} from "./tipos";
import type { Cuenta } from "./tipos";

const ESTADOS: Array<Estado | ""> = [
  "",
  "borrador",
  "en_validacion",
  "observada",
  "pendiente_direccion",
  "aprobada",
  "pagada",
  "cancelada",
];

type Vista = "operaciones" | "captura" | "pagos" | "cuentas" | "direccion" | "auditoria";

export default function App() {
  const [usuario, setUsuario] = useState<Usuario | null>(null);
  const [vista, setVista] = useState<Vista>("operaciones");
  const [error, setError] = useState<string>("");

  useEffect(() => {
    if (!getToken()) return;
    api
      .me()
      .then(({ usuario }) => setUsuario(usuario))
      .catch(() => setToken(null));
  }, []);

  if (!usuario) {
    return (
      <Login
        onLogin={(u) => {
          setUsuario(u);
          setVista("operaciones");
        }}
      />
    );
  }

  const cerrarSesion = () => {
    setToken(null);
    setUsuario(null);
  };

  return (
    <div className="contenedor">
      <aside className="sidebar">
        <div className="marca">
          Tesorería
          <small>Sistema Integral</small>
        </div>
        <button className={vista === "operaciones" ? "activo" : ""} onClick={() => setVista("operaciones")}>
          Operaciones
        </button>
        {usuario.rol === "operacion" && (
          <button className={vista === "captura" ? "activo" : ""} onClick={() => setVista("captura")}>
            Nueva operación
          </button>
        )}
        {(usuario.rol === "tesoreria" || usuario.rol === "direccion" || usuario.rol === "auditoria") && (
          <button className={vista === "pagos" ? "activo" : ""} onClick={() => setVista("pagos")}>
            Pagos
          </button>
        )}
        {(usuario.rol === "tesoreria" || usuario.rol === "direccion" || usuario.rol === "auditoria") && (
          <button className={vista === "cuentas" ? "activo" : ""} onClick={() => setVista("cuentas")}>
            Cuentas
          </button>
        )}
        {usuario.rol === "direccion" && (
          <button className={vista === "direccion" ? "activo" : ""} onClick={() => setVista("direccion")}>
            Dirección
          </button>
        )}
        {(usuario.rol === "auditoria" || usuario.rol === "direccion") && (
          <button className={vista === "auditoria" ? "activo" : ""} onClick={() => setVista("auditoria")}>
            Auditoría
          </button>
        )}
        <div className="usuario">
          <strong>{usuario.nombre}</strong>
          Rol: {usuario.rol}
          <button onClick={cerrarSesion}>Cerrar sesión</button>
        </div>
      </aside>

      <main className="contenido">
        {error && <div className="error">{error}</div>}
        {vista === "operaciones" && (
          <VistaOperaciones usuario={usuario} onError={setError} onLimpiaError={() => setError("")} />
        )}
        {vista === "captura" && (
          <VistaCaptura
            onCreada={() => {
              setVista("operaciones");
              setError("");
            }}
            onError={setError}
          />
        )}
        {vista === "pagos" && <VistaPagos />}
        {vista === "cuentas" && <VistaCuentas />}
        {vista === "direccion" && <VistaDireccion />}
        {vista === "auditoria" && <VistaAuditoria />}
      </main>
    </div>
  );
}

function Login({ onLogin }: { onLogin: (u: Usuario) => void }) {
  const [username, setUsuario] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [cargando, setEntrando] = useState(false);

  const enviar = async (e: React.FormEvent) => {
    e.preventDefault();
    setEntrando(true);
    setError("");
    try {
      const { token, usuario } = await api.login(username, password);
      setToken(token);
      onLogin(usuario);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setEntrando(false);
    }
  };

  return (
    <div className="login">
      <form className="tarjeta" onSubmit={enviar}>
        <h1>Sistema Integral de Tesorería</h1>
        <p>Inicia sesión para continuar</p>
        {error && <div className="error">{error}</div>}
        <label>Usuario</label>
        <input value={username} onChange={(e) => setUsuario(e.target.value)} autoFocus autoComplete="username" />
        <label>Contraseña</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
        <button className="btn" style={{ width: "100%" }} disabled={cargando}>
          {cargando ? "Entrando…" : "Entrar"}
        </button>
      </form>
    </div>
  );
}

function VistaOperaciones({
  usuario,
  onError,
  onLimpiaError,
}: {
  usuario: Usuario;
  onError: (m: string) => void;
  onLimpiaError: () => void;
}) {
  const [operaciones, setOperaciones] = useState<Operacion[]>([]);
  const [estado, setEstado] = useState("");
  const [q, setQ] = useState("");
  const [seleccion, setSeleccion] = useState<number | null>(null);
  const [detalle, setDetalle] = useState<{
    operacion: Operacion;
    revisiones: Revision[];
    historial: Evento[];
    pago: Pago | null;
  } | null>(null);
  const [comentario, setComentario] = useState("");
  const [dirComentario, setDirComentario] = useState("");
  const [pagoForm, setPagoForm] = useState({
    medio: "transferencia" as MedioPago,
    monto: "",
    comprobante: "",
    fecha: new Date().toISOString().slice(0, 10),
    notas: "",
    cuenta_id: "",
  });
  const [cuentasPago, setCuentasPago] = useState<Cuenta[]>([]);

  useEffect(() => {
    if (usuario.rol !== "tesoreria") return;
    api
      .cuentas()
      .then(({ cuentas }) => setCuentasPago(cuentas))
      .catch(() => setCuentasPago([]));
  }, [usuario.rol]);
  const [mensaje, setMensaje] = useState("");

  const cargar = useCallback(async () => {
    try {
      const { operaciones } = await api.lista({ estado, q });
      setOperaciones(operaciones);
    } catch (err) {
      onError((err as Error).message);
    }
  }, [estado, q, onError]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const abrir = async (id: number) => {
    onLimpiaError();
    setMensaje("");
    setSeleccion(id);
    try {
      const d = await api.detalle(id);
      setDetalle(d);
      setPagoForm((f) => ({
        ...f,
        medio: "transferencia",
        monto: String(d.operacion.monto),
        comprobante: "",
        notas: "",
        cuenta_id: "",
      }));
      setDirComentario("");
    } catch (err) {
      onError((err as Error).message);
    }
  };

  const accion = async (fn: Promise<unknown>, texto: string) => {
    onLimpiaError();
    try {
      await fn;
      setMensaje(texto);
      if (seleccion) await abrir(seleccion);
      await cargar();
    } catch (err) {
      onError((err as Error).message);
    }
  };

  const op = detalle?.operacion;

  return (
    <>
      <h2>Operaciones</h2>
      <div className="barra">
        <select value={estado} onChange={(e) => setEstado(e.target.value)} style={{ maxWidth: 200, marginBottom: 0 }}>
          {ESTADOS.map((e) => (
            <option key={e} value={e}>
              {e ? ETIQUETAS_ESTADO[e] : "Todos los estados"}
            </option>
          ))}
        </select>
        <input
          placeholder="Buscar por folio, concepto o proveedor…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ maxWidth: 340, marginBottom: 0 }}
        />
      </div>

      {mensaje && <div className="exito-msg">{mensaje}</div>}

      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Folio</th>
              <th>Tipo</th>
              <th>Concepto</th>
              <th>Proveedor</th>
              <th style={{ textAlign: "right" }}>Monto</th>
              <th>Estado</th>
              <th>Capturista</th>
            </tr>
          </thead>
          <tbody>
            {operaciones.map((o) => (
              <tr
                key={o.id}
                className={seleccion === o.id ? "seleccionada" : ""}
                onClick={() => void abrir(o.id)}
              >
                <td>{o.folio}</td>
                <td style={{ textTransform: "capitalize" }}>{o.tipo}</td>
                <td>{o.concepto}</td>
                <td>{o.proveedor}</td>
                <td style={{ textAlign: "right" }}>
                  {o.monto.toLocaleString("es-MX", { minimumFractionDigits: 2 })} {o.moneda}
                </td>
                <td>
                  <span className={`badge ${o.estado}`}>{ETIQUETAS_ESTADO[o.estado]}</span>
                </td>
                <td>{o.capturista ?? "—"}</td>
              </tr>
            ))}
            {operaciones.length === 0 && (
              <tr>
                <td colSpan={7} className="vacio">
                  No hay operaciones que coincidan.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {op && (
        <>
          <h3>
            {op.folio} <span className={`badge ${op.estado}`}>{ETIQUETAS_ESTADO[op.estado]}</span>
          </h3>
          <div className="panel">
            <p>
              <strong>Concepto:</strong> {op.concepto}
              <br />
              <strong>Proveedor:</strong> {op.proveedor}
              <br />
              <strong>Monto:</strong>{" "}
              {op.monto.toLocaleString("es-MX", { minimumFractionDigits: 2 })} {op.moneda}
              <br />
              <strong>Fecha de operación:</strong> {op.fecha_operacion}
            </p>

            <div className="barra">
              {usuario.rol === "operacion" && (op.estado === "borrador" || op.estado === "observada") && (
                <button
                  className="btn"
                  onClick={() => void accion(api.enviarValidacion(op.id), "Enviada a validación.")}
                >
                  Enviar a validación
                </button>
              )}
              {usuario.rol === "operacion" &&
                op.estado !== "cancelada" &&
                op.estado !== "pagada" &&
                op.estado !== "pendiente_direccion" && (
                <button
                  className="btn peligro"
                  onClick={() => void accion(api.cancelar(op.id), "Operación cancelada.")}
                >
                  Cancelar
                </button>
              )}
              {op.estado === "pendiente_direccion" && usuario.rol === "operacion" && (
                <span style={{ color: "var(--tenue)", fontSize: "0.85rem" }}>
                  En revisión de Dirección (monto sobre el umbral). Sin acción de Operaciones por ahora.
                </span>
              )}
              {(op.estado === "borrador" || op.estado === "observada" || op.estado === "cancelada") &&
                usuario.rol === "operacion" && (
                  <span style={{ color: "var(--tenue)", fontSize: "0.85rem" }}>
                    Aún no requiere pago: continúa en el flujo de Operaciones / Validación.
                  </span>
                )}
            </div>

            {usuario.rol === "validacion" && op.estado === "en_validacion" && (
              <>
                <h3>Revisión de Validación</h3>
                <label>Comentario (obligatorio)</label>
                <textarea rows={3} value={comentario} onChange={(e) => setComentario(e.target.value)} />
                <div className="barra">
                  <button
                    className="btn exito"
                    onClick={() =>
                      void accion(api.revisar(op.id, "aprobada", comentario), "Operación aprobada.")
                    }
                  >
                    Aprobar
                  </button>
                  <button
                    className="btn"
                    style={{ background: "var(--ambar)" }}
                    onClick={() =>
                      void accion(api.revisar(op.id, "observada", comentario), "Operación observada.")
                    }
                  >
                    Observar
                  </button>
                </div>
              </>
            )}

            {usuario.rol === "direccion" && op.estado === "pendiente_direccion" && (
              <>
                <h3>Dirección — Aprobación por monto</h3>
                <p style={{ color: "var(--tenue)", fontSize: "0.87rem", margin: "0 0 0.6rem" }}>
                  Monto ${op.monto.toLocaleString("es-MX", { minimumFractionDigits: 2 })} igual o mayor al
                  umbral configurado: requiere su aprobación explícita.
                </p>
                <label>Comentario (obligatorio)</label>
                <textarea rows={2} value={dirComentario} onChange={(e) => setDirComentario(e.target.value)} />
                <div className="barra">
                  <button
                    className="btn exito"
                    onClick={() =>
                      void accion(api.aprobarDireccion(op.id, true, dirComentario), "Aprobada por Dirección.")
                    }
                  >
                    Aprobar
                  </button>
                  <button
                    className="btn peligro"
                    onClick={() =>
                      void accion(api.aprobarDireccion(op.id, false, dirComentario), "Rechazada por Dirección.")
                    }
                  >
                    Rechazar
                  </button>
                </div>
              </>
            )}

            {(op.estado === "aprobada" || op.estado === "pagada") && (
              <>
                <h3>Tesorería</h3>
                {usuario.rol === "tesoreria" && !detalle.pago && (
                  <>
                    <div className="rejilla">
                      <div>
                        <label>Medio de pago</label>
                        <select
                          value={pagoForm.medio}
                          onChange={(e) => setPagoForm({ ...pagoForm, medio: e.target.value as MedioPago })}
                        >
                          {MEDIOS_PAGO.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label>Monto (debe coincidir con la operación)</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0.01"
                          value={pagoForm.monto}
                          onChange={(e) => setPagoForm({ ...pagoForm, monto: e.target.value })}
                        />
                      </div>
                      <div>
                        <label>Fecha de pago</label>
                        <input
                          type="date"
                          value={pagoForm.fecha}
                          onChange={(e) => setPagoForm({ ...pagoForm, fecha: e.target.value })}
                        />
                      </div>
                      <div>
                        <label>Comprobante (folio / referencia)</label>
                        <input
                          value={pagoForm.comprobante}
                          onChange={(e) => setPagoForm({ ...pagoForm, comprobante: e.target.value })}
                          placeholder="TRF-123456"
                        />
                      </div>
                      <div>
                        <label>Cuenta de salida (opcional)</label>
                        <select
                          value={pagoForm.cuenta_id}
                          onChange={(e) => setPagoForm({ ...pagoForm, cuenta_id: e.target.value })}
                        >
                          <option value="">— Sin cuenta —</option>
                          {cuentasPago.map((c) => (
                            <option key={c.id} value={String(c.id)}>
                              {c.nombre} (saldo {c.saldo_actual?.toLocaleString("es-MX", { minimumFractionDigits: 2 })})
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <label>Notas</label>
                    <textarea
                      rows={2}
                      value={pagoForm.notas}
                      onChange={(e) => setPagoForm({ ...pagoForm, notas: e.target.value })}
                    />
                    <div className="barra">
                      <button
                        className="btn exito"
                        onClick={() =>
                          void accion(
                            api.pagar(op.id, {
                              medio: pagoForm.medio,
                              monto: Number(pagoForm.monto),
                              comprobante: pagoForm.comprobante,
                              fecha_pago: pagoForm.fecha,
                              notas: pagoForm.notas,
                              ...(pagoForm.cuenta_id ? { cuenta_id: Number(pagoForm.cuenta_id) } : {}),
                            }),
                            "Pago registrado."
                          )
                        }
                      >
                        Registrar pago
                      </button>
                    </div>
                  </>
                )}
                {detalle.pago && (
                  <p>
                    <strong>Estado del pago:</strong> liquidado
                    <br />
                    <strong>Medio:</strong> {detalle.pago.medio}
                    <br />
                    <strong>Monto:</strong>{" "}
                    {detalle.pago.monto.toLocaleString("es-MX", { minimumFractionDigits: 2 })}{" "}
                    {detalle.pago.moneda}
                    <br />
                    <strong>Fecha de pago:</strong> {detalle.pago.fecha_pago}
                    <br />
                    <strong>Comprobante:</strong> {detalle.pago.comprobante}
                    {detalle.pago.notas && (
                      <>
                        <br />
                        <strong>Notas:</strong> {detalle.pago.notas}
                      </>
                    )}
                  </p>
                )}
              </>
            )}

            {detalle.revisiones.length > 0 && (
              <>
                <h3>Revisiones</h3>
                <ul className="historial">
                  {detalle.revisiones.map((r) => (
                    <li key={r.id}>
                      <strong>{r.revisor}</strong> · {r.resultado === "aprobada" ? "Aprobó" : "Observó"} —{" "}
                      {r.comentario}
                      <span>{r.fecha}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <h3>Historial (auditoría)</h3>
            <ul className="historial">
              {detalle.historial.map((h) => (
                <li key={h.id}>
                  <strong>{h.usuario}</strong> · {h.detalle}
                  <span>
                    {h.accion} — {h.fecha}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </>
  );
}

function VistaCaptura({ onCreada, onError }: { onCreada: () => void; onError: (m: string) => void }) {
  const [tipo, setTipo] = useState<"pago" | "cobro" | "financiamiento">("pago");
  const [concepto, setConcepto] = useState("");
  const [proveedor, setProveedor] = useState("");
  const [monto, setMonto] = useState("");
  const [moneda, setMoneda] = useState("MXN");
  const [fecha, setFecha] = useState(new Date().toISOString().slice(0, 10));
  const [guardando, setGuardando] = useState(false);

  const enviar = async (e: React.FormEvent) => {
    e.preventDefault();
    setGuardando(true);
    try {
      await api.crear({
        tipo,
        concepto,
        proveedor,
        monto: Number(monto),
        moneda,
        fecha_operacion: fecha,
      });
      onCreada();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setGuardando(false);
    }
  };

  return (
    <>
      <h2>Nueva operación</h2>
      <form className="panel" onSubmit={enviar} style={{ maxWidth: 720 }}>
        <div className="rejilla">
          <div>
            <label>Tipo</label>
            <select value={tipo} onChange={(e) => setTipo(e.target.value as typeof tipo)}>
              <option value="pago">Pago</option>
              <option value="cobro">Cobro</option>
              <option value="financiamiento">Financiamiento</option>
            </select>
          </div>
          <div>
            <label>Fecha de operación</label>
            <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} required />
          </div>
          <div>
            <label>Monto</label>
            <input
              type="number"
              step="0.01"
              min="0.01"
              value={monto}
              onChange={(e) => setMonto(e.target.value)}
              required
            />
          </div>
          <div>
            <label>Moneda</label>
            <select value={moneda} onChange={(e) => setMoneda(e.target.value)}>
              <option>MXN</option>
              <option>USD</option>
              <option>EUR</option>
            </select>
          </div>
        </div>
        <label>Concepto</label>
        <input value={concepto} onChange={(e) => setConcepto(e.target.value)} required />
        <label>Proveedor / Beneficiario</label>
        <input value={proveedor} onChange={(e) => setProveedor(e.target.value)} required />
        <button className="btn" disabled={guardando}>
          {guardando ? "Guardando…" : "Guardar en borrador"}
        </button>
      </form>
    </>
  );
}

function VistaDireccion() {
  const [reporte, setReporte] = useState<import("./tipos").ReporteDireccion | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .reportesDireccion()
      .then(setReporte)
      .catch((err: Error) => setError(err.message));
  }, []);

  if (!reporte) {
    return (
      <>
        <h2>Dirección</h2>
        {error && <div className="error">{error}</div>}
        {!error && <div className="vacio">Cargando reporte…</div>}
      </>
    );
  }

  const formato = (n: number) => n.toLocaleString("es-MX", { minimumFractionDigits: 2 });

  return (
    <>
      <h2>Dirección — Reporte de control</h2>
      <div className="rejilla" style={{ marginBottom: "1rem" }}>
        <div className="panel">
          <label>Operaciones vigentes</label>
          <p style={{ fontSize: "1.4rem", fontWeight: 700, margin: 0 }}>
            {reporte.totales.operaciones} 
            <span style={{ fontSize: "0.85rem", fontWeight: 400, color: "var(--tenue)" }}>
              · {formato(reporte.totales.monto)}
            </span>
          </p>
        </div>
        <div className="panel">
          <label>Pagos (30 días)</label>
          <p style={{ fontSize: "1.4rem", fontWeight: 700, margin: 0 }}>
            {reporte.pagos_ultimos_30_dias.pagos}
            <span style={{ fontSize: "0.85rem", fontWeight: 400, color: "var(--tenue)" }}>
              · {formato(reporte.pagos_ultimos_30_dias.monto)}
            </span>
          </p>
        </div>
        <div className="panel">
          <label>Espera de Tesorería</label>
          <p style={{ fontSize: "1.4rem", fontWeight: 700, margin: 0 }}>
            {reporte.pendientes_tesoreria.operaciones}
            <span style={{ fontSize: "0.85rem", fontWeight: 400, color: "var(--tenue)" }}>
              · {formato(reporte.pendientes_tesoreria.monto)}
            </span>
          </p>
        </div>
        <div className="panel">
          <label>Umbral Dirección</label>
          <p style={{ fontSize: "1.4rem", fontWeight: 700, margin: 0 }}>{formato(reporte.umbral_direccion)}</p>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: "1rem" }}>
        <h3 style={{ marginTop: 0 }}>Pendientes de aprobación ({reporte.pendientes_direccion.length})</h3>
        <table>
          <thead>
            <tr>
              <th>Folio</th>
              <th>Concepto</th>
              <th>Proveedor</th>
              <th style={{ textAlign: "right" }}>Monto</th>
              <th>Capturista</th>
            </tr>
          </thead>
          <tbody>
            {reporte.pendientes_direccion.map((o) => (
              <tr key={o.id}>
                <td>{o.folio}</td>
                <td>{o.concepto}</td>
                <td>{o.proveedor}</td>
                <td style={{ textAlign: "right" }}>
                  {formato(o.monto)} {o.moneda}
                </td>
                <td>{o.capturista ?? "—"}</td>
              </tr>
            ))}
            {reporte.pendientes_direccion.length === 0 && (
              <tr>
                <td colSpan={5} className="vacio">
                  Sin operaciones pendientes de aprobación.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <p style={{ color: "var(--tenue)", fontSize: "0.82rem", marginBottom: 0 }}>
          Para aprobar o rechazar, abre la operación desde la vista Operaciones.
        </p>
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Resumen por estado</h3>
        <table>
          <thead>
            <tr>
              <th>Estado</th>
              <th style={{ textAlign: "right" }}>Operaciones</th>
              <th style={{ textAlign: "right" }}>Monto</th>
            </tr>
          </thead>
          <tbody>
            {reporte.por_estado.map((f) => (
              <tr key={f.estado}>
                <td>
                  <span className={`badge ${f.estado}`}>{
                    {
                      borrador: "Borrador",
                      en_validacion: "En validación",
                      observada: "Observada",
                      pendiente_direccion: "Pend. Dirección",
                      aprobada: "Aprobada",
                      pagada: "Pagada",
                      cancelada: "Cancelada",
                    }[f.estado]
                  }{" "}
                  </span>
                </td>
                <td style={{ textAlign: "right" }}>{f.operaciones}</td>
                <td style={{ textAlign: "right" }}>{formato(f.monto)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function VistaCuentas() {
  const [cuentas, setCuentas] = useState<import("./tipos").Cuenta[]>([]);
  const [error, setError] = useState("");
  const [mensaje, setMensaje] = useState("");
  const [esTesoreria, setEsTesoreria] = useState(false);
  const [alta, setAlta] = useState({ nombre: "", banco: "", numero_cuenta: "", saldo_inicial: "0" });
  const [mov, setMov] = useState({
    cuenta: "",
    tipo: "deposito" as "deposito" | "retiro",
    monto: "",
    concepto: "",
  });
  const [errorAlt, setErrorAlt] = useState("");

  useEffect(() => {
    api
      .cuentas()
      .then(({ cuentas }) => setCuentas(cuentas))
      .catch((err: Error) => setError(err.message));
    api
      .me()
      .then(({ usuario }) => setEsTesoreria(usuario.rol === "tesoreria"))
      .catch(() => setEsTesoreria(false));
  }, []);

  const refrescar = () =>
    api
      .cuentas()
      .then(({ cuentas }) => setCuentas(cuentas))
      .catch((err: Error) => setError(err.message));

  const formato = (n: number) => n.toLocaleString("es-MX", { minimumFractionDigits: 2 });

  if (!esTesoreria && !error) {
    return (
      <>
        <h2>Cuentas de Tesorería</h2>
        <CuentasSoloLectura cuentas={cuentas} />
      </>
    );
  }

  return (
    <>
      <h2>Cuentas de Tesorería</h2>
      {error && <div className="error">{error}</div>}
      {mensaje && <div className="exito-msg">{mensaje}</div>}
      <CuentasSoloLectura cuentas={cuentas} />

      <div className="rejilla">
        <form
          className="panel"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api.crearCuenta({
                nombre: alta.nombre,
                banco: alta.banco,
                numero_cuenta: alta.numero_cuenta,
                saldo_inicial: Number(alta.saldo_inicial),
              });
              setMensaje(`Cuenta '${alta.nombre}' creada.`);
              setErrorAlt("");
              setAlta({ nombre: "", banco: "", numero_cuenta: "", saldo_inicial: "0" });
              await refrescar();
            } catch (err) {
              setErrorAlt((err as Error).message);
            }
          }}
        >
          <h3 style={{ marginTop: 0 }}>Nueva cuenta</h3>
          {errorAlt && <div className="error">{errorAlt}</div>}
          <label>Nombre</label>
          <input value={alta.nombre} onChange={(e) => setAlta({ ...alta, nombre: e.target.value })} required />
          <label>Banco</label>
          <input value={alta.banco} onChange={(e) => setAlta({ ...alta, banco: e.target.value })} />
          <label>Número de cuenta</label>
          <input
            value={alta.numero_cuenta}
            onChange={(e) => setAlta({ ...alta, numero_cuenta: e.target.value })}
          />
          <label>Saldo inicial</label>
          <input
            type="number"
            step="0.01"
            value={alta.saldo_inicial}
            onChange={(e) => setAlta({ ...alta, saldo_inicial: e.target.value })}
          />
          <button className="btn">Crear cuenta</button>
        </form>

        <form
          className="panel"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api.crearMovimiento(Number(mov.cuenta), {
                tipo: mov.tipo,
                monto: Number(mov.monto),
                concepto: mov.concepto,
              });
              setMensaje("Movimiento registrado.");
              setErrorAlt("");
              setMov({ ...mov, monto: "", concepto: "" });
              await refrescar();
            } catch (err) {
              setErrorAlt((err as Error).message);
            }
          }}
        >
          <h3 style={{ marginTop: 0 }}>Depósito / Retiro</h3>
          {errorAlt && <div className="error">{errorAlt}</div>}
          <label>Cuenta</label>
          <select value={mov.cuenta} onChange={(e) => setMov({ ...mov, cuenta: e.target.value })} required>
            <option value="">— Selecciona —</option>
            {cuentas.map((c) => (
              <option key={c.id} value={String(c.id)}>
                {c.nombre}
              </option>
            ))}
          </select>
          <label>Tipo</label>
          <select
            value={mov.tipo}
            onChange={(e) => setMov({ ...mov, tipo: e.target.value as "deposito" | "retiro" })}
          >
            <option value="deposito">Depósito</option>
            <option value="retiro">Retiro</option>
          </select>
          <label>Monto</label>
          <input
            type="number"
            step="0.01"
            min="0.01"
            value={mov.monto}
            onChange={(e) => setMov({ ...mov, monto: e.target.value })}
            required
          />
          <label>Concepto</label>
          <input value={mov.concepto} onChange={(e) => setMov({ ...mov, concepto: e.target.value })} required />
          <button className="btn">Registrar movimiento</button>
        </form>
      </div>
      <p style={{ color: "var(--tenue)", fontSize: "0.82rem" }}>
        El saldo descontado por cada pago se aplica automáticamente si el pago se liga a una cuenta.
      </p>
    </>
  );
}

function CuentasSoloLectura({ cuentas }: { cuentas: import("./tipos").Cuenta[] }) {
  const formato = (n: number) => n.toLocaleString("es-MX", { minimumFractionDigits: 2 });
  return (
    <div className="panel" style={{ marginBottom: "1rem" }}>
      <table>
        <thead>
          <tr>
            <th>Cuenta</th>
            <th>Banco</th>
            <th>Número</th>
            <th style={{ textAlign: "right" }}>Saldo inicial</th>
            <th style={{ textAlign: "right" }}>Pagado</th>
            <th style={{ textAlign: "right" }}>Saldo actual</th>
          </tr>
        </thead>
        <tbody>
          {cuentas.map((c) => (
            <tr key={c.id}>
              <td>{c.nombre}</td>
              <td>{c.banco || "—"}</td>
              <td>{c.numero_cuenta || "—"}</td>
              <td style={{ textAlign: "right" }}>{formato(c.saldo_inicial)}</td>
              <td style={{ textAlign: "right" }}>{formato(c.total_pagado ?? 0)}</td>
              <td style={{ textAlign: "right", fontWeight: 700 }}>{formato(c.saldo_actual ?? 0)}</td>
            </tr>
          ))}
          {cuentas.length === 0 && (
            <tr>
              <td colSpan={6} className="vacio">
                Sin cuentas de tesorería registradas.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function VistaPagos() {
  const [pagos, setPagos] = useState<Pago[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .pagos()
      .then(({ pagos }) => setPagos(pagos))
      .catch((err: Error) => setError(err.message));
  }, []);

  const total = pagos.reduce((s, p) => s + p.monto, 0);

  return (
    <>
      <h2>Pagos ejecutados</h2>
      {error && <div className="error">{error}</div>}
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Folio</th>
              <th>Fecha</th>
              <th>Medio</th>
              <th style={{ textAlign: "right" }}>Monto</th>
              <th>Comprobante</th>
              <th>Pagado por</th>
              <th>Notas</th>
            </tr>
          </thead>
          <tbody>
            {pagos.map((p) => (
              <tr key={p.id}>
                <td>{p.folio}</td>
                <td>{p.fecha_pago}</td>
                <td style={{ textTransform: "capitalize" }}>{p.medio}</td>
                <td style={{ textAlign: "right" }}>
                  {p.monto.toLocaleString("es-MX", { minimumFractionDigits: 2 })} {p.moneda}
                </td>
                <td>{p.comprobante}</td>
                <td>{p.pagador ?? "—"}</td>
                <td>{p.notas || "—"}</td>
              </tr>
            ))}
            {pagos.length === 0 && (
              <tr>
                <td colSpan={7} className="vacio">
                  Sin pagos registrados.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {pagos.length > 0 && (
          <p style={{ textAlign: "right", fontWeight: 600, marginBottom: 0 }}>
            Total pagado ({pagos.length}): {total.toLocaleString("es-MX", { minimumFractionDigits: 2 })}
          </p>
        )}
      </div>
    </>
  );
}

function VistaAuditoria() {
  const [eventos, setEventos] = useState<Evento[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .auditoria()
      .then(({ eventos }) => setEventos(eventos))
      .catch((err: Error) => setError(err.message));
  }, []);

  return (
    <>
      <h2>Auditoría</h2>
      {error && <div className="error">{error}</div>}
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Usuario</th>
              <th>Folio</th>
              <th>Acción</th>
              <th>Detalle</th>
            </tr>
          </thead>
          <tbody>
            {eventos.map((e) => (
              <tr key={e.id}>
                <td>{e.fecha}</td>
                <td>{e.usuario}</td>
                <td>{e.folio ?? "—"}</td>
                <td>{e.accion}</td>
                <td>{e.detalle}</td>
              </tr>
            ))}
            {eventos.length === 0 && (
              <tr>
                <td colSpan={5} className="vacio">
                  Sin eventos registrados.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}