import { useCallback, useEffect, useState } from "react";
import { api, getToken, setToken } from "./api";
import {
  ETIQUETAS_ESTADO,
  type Estado,
  type Evento,
  type Operacion,
  type Revision,
  type Usuario,
} from "./tipos";

const ESTADOS: Array<Estado | ""> = [
  "",
  "borrador",
  "en_validacion",
  "observada",
  "aprobada",
  "pagada",
  "cancelada",
];

type Vista = "operaciones" | "captura" | "auditoria";

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
  } | null>(null);
  const [comentario, setComentario] = useState("");
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
      setDetalle(await api.detalle(id));
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
              {usuario.rol === "operacion" && op.estado !== "cancelada" && op.estado !== "pagada" && (
                <button
                  className="btn peligro"
                  onClick={() => void accion(api.cancelar(op.id), "Operación cancelada.")}
                >
                  Cancelar
                </button>
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