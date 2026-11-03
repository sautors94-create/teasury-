import { useCallback, useEffect, useState } from "react";
import { api, descargarConcentrado, getToken, setToken } from "./api";import {
  descargarPlantillaDispersiones,
  descargarPlantillaTandas,
  leerFilas,
  mapearDispersiones,
  mapearTandas,
  type LineaLayout,
  type TandaLayout,
} from "./layout";import {
  ETIQUETAS_ESTADO,
  ETIQUETAS_ROL,
  ETIQUETAS_TIPO_CUENTA,
  MEDIOS_PAGO,
  MONEDAS_COMUNES,
  TIPOS_CUENTA,
  type Broker,
  type CalculosFlujo,
  type DetalleOperacion,
  type Dispersion,
  type Estado,
  type Evento,
  type MedioPago,
  type Operacion,
  type Pago,
  type Revision,
  type Rol,
  type TipoCuenta,
  type Usuario,
} from "./tipos";
import type {
  AplicacionRecurso,
  Asignacion,
  AsignacionEjecutivo,
  AltaBancaria,
  CargoValidacion,
  CatalogoRegistro,
  Cliente,
  Cobertura,
  CoberturaCliente,
  ComprobanteDeposito,
  TrfResguardoDetalle,
  CuentaCatalogo,
  DepositoOperacion,
  DepositoPendiente,
  Financiamiento,
  FilaColaValidacion,
  FilaRespaldoOperacion,
  MovimientoConcentrado,
  Parametro,
  ResguardoBroker,
  ResguardoDetalle,
  ResumenFondeador,
  UsuarioAdmin,
} from "./tipos";
import type { Cuenta } from "./tipos";

const ESTADOS: Array<Estado | ""> = [
  "",
  "borrador",
  "en_validacion",
  "observada",
  "pendiente_direccion",
  "aprobada",
  "en_pago",
  "pagada",
  "cancelada",
];

const VACIA = (): LineaLayout => ({
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
  importe: NaN,
  pagadora: "",
  pagadora_cuenta_id: null,
});

/**
 * Tarea 12: destino seleccionado del catálogo de Tesorería. cuenta_id null =
 * "CUALQUIER FLUJO" (Tesorería determina la cuenta concreta).
 */
interface DestinoSel {
  cuenta_id: number | null;
  tipo: string;
  nombre: string;
  manejo_manual: boolean;
}

const claveDestino = (d: DestinoSel) => (d.cuenta_id !== null ? `c${d.cuenta_id}` : `t${d.tipo}`);

/**
 * Fase 13: selector de pagadoras/frentes desde el catálogo de Tesorería. El
 * listado de cuentas puede superar las 300, así que es DESPLEGABLE: se elige
 * la cuenta y se agrega; las seleccionadas se muestran como etiquetas (chips)
 * que se pueden quitar. Ya no muestra el banco ni el manejo manual: con
 * CUALQUIER FLUJO Tesorería determina la cuenta concreta. Sólo aparecen las
 * cuentas activas y visibles para operadores (las que Tesorería oculta no se
 * listan aquí).
 */
function SelectorDestinos({
  catalogo,
  seleccion,
  setSeleccion,
}: {
  catalogo: CuentaCatalogo[];
  seleccion: Record<string, DestinoSel>;
  setSeleccion: React.Dispatch<React.SetStateAction<Record<string, DestinoSel>>>;
}) {
  const [elegida, setElegida] = useState("");
  const grupos = TIPOS_CUENTA.map((t) => ({
    tipo: t,
    cuentas: catalogo.filter((c) => c.tipo === t),
  })).filter((g) => g.cuentas.length > 0);
  const elegir = () => {
    if (!elegida) return;
    if (elegida === "tflujo") {
      const d: DestinoSel = { cuenta_id: null, tipo: "flujo", nombre: "CUALQUIER FLUJO", manejo_manual: false };
      setSeleccion((prev) => ({ ...prev, [claveDestino(d)]: d }));
    } else {
      const cuenta = catalogo.find((c) => `c${c.id}` === elegida);
      if (cuenta) {
        const d: DestinoSel = { cuenta_id: cuenta.id, tipo: cuenta.tipo ?? "flujo", nombre: cuenta.nombre, manejo_manual: false };
        setSeleccion((prev) => ({ ...prev, [claveDestino(d)]: d }));
      }
    }
    setElegida("");
  };
  const quitar = (clave: string) =>
    setSeleccion((prev) => {
      const sig = { ...prev };
      delete sig[clave];
      return sig;
    });
  const seleccionadas = Object.values(seleccion);
  return (
    <div>
      {catalogo.length === 0 ? (
        <p style={{ color: "var(--ambar, #b26a00)", fontSize: "0.88rem", margin: "0 0 0.4rem" }}>
          El catálogo de Tesorería no tiene cuentas visibles: pide al Administrador de Tesorería que
          registre, reactive o haga visibles cuentas antes de capturar.
        </p>
      ) : (
        <div className="barra" style={{ alignItems: "center", flexWrap: "wrap" }}>
          <select
            value={elegida}
            onChange={(e) => setElegida(e.target.value)}
            style={{ maxWidth: 460, marginBottom: 0 }}
            aria-label="Pagadora (catálogo de Tesorería)"
          >
            <option value="">— Selecciona la pagadora ({catalogo.length} disponibles) —</option>
            <option value="tflujo">CUALQUIER FLUJO — Tesorería determina la cuenta</option>
            {grupos.map((g) => (
              <optgroup key={g.tipo} label={ETIQUETAS_TIPO_CUENTA[g.tipo] ?? g.tipo}>
                {g.cuentas.map((c) => (
                  <option key={c.id} value={`c${c.id}`}>
                    {c.nombre}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <button type="button" className="btn" style={{ marginBottom: 0 }} onClick={elegir} disabled={!elegida}>
            + Agregar pagadora
          </button>
          <small style={{ color: "var(--tenue)" }}>
            Con <strong>CUALQUIER FLUJO</strong> Tesorería determina la cuenta concreta.
          </small>
        </div>
      )}
      {seleccionadas.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginTop: "0.5rem" }}>
          {seleccionadas.map((d) => {
            const clave = claveDestino(d);
            return (
              <span
                key={clave}
                className="etiqueta-tipo"
                style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", fontSize: "0.85rem" }}
                title={d.cuenta_id === null ? "Tesorería determina la cuenta" : d.tipo}
              >
                {d.nombre}
                {d.cuenta_id === null && <small style={{ color: "var(--tenue)" }}>(cualquiera)</small>}
                <button
                  type="button"
                  onClick={() => quitar(clave)}
                  style={{
                    border: "none",
                    background: "transparent",
                    cursor: "pointer",
                    fontWeight: 700,
                    lineHeight: 1,
                    padding: 0,
                    color: "inherit",
                  }}
                  aria-label={`Quitar ${d.nombre}`}
                  title="Quitar pagadora"
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Tarea 12: convierte la selección del catálogo al payload `destinos` de la API. */
const destinosAPayload = (seleccion: Record<string, DestinoSel>) =>
  Object.values(seleccion).map((d) => ({
    ...(d.cuenta_id !== null ? { cuenta_id: d.cuenta_id } : {}),
    tipo: d.tipo,
    manejo_manual: d.manejo_manual,
  }));

/** Tarea 12: clave de la pagadora de una línea para el select. */
const clavePagadora = (l: { pagadora?: string; pagadora_cuenta_id?: number | null }): string => {
  if (l.pagadora_cuenta_id !== null && l.pagadora_cuenta_id !== undefined) return `c${l.pagadora_cuenta_id}`;
  const m = /^CUALQUIER\s+(.+)$/i.exec((l.pagadora ?? "").trim());
  if (m) return `t${m[1].trim().toLowerCase().replace(/\s+/g, "_")}`;
  return "";
};

/**
 * Tarea 12: select de PAGADORA para una línea de dispersión: cuenta del
 * catálogo (agrupada por tipo) o "CUALQUIER FLUJO" para que Tesorería
 * determine la cuenta. Fase 13: sólo muestra las cuentas visibles para
 * operadores (las que Tesorería oculta no aparecen en el listado).
 */
function SelectPagadora({
  catalogo,
  clave,
  onChange,
  conVacia = true,
}: {
  catalogo: CuentaCatalogo[];
  clave: string;
  onChange: (pagadora: string, cuentaId: number | null) => void;
  conVacia?: boolean;
}) {
  const visibles = catalogo.filter((c) => c.visible_operador !== 0);
  const grupos = TIPOS_CUENTA.map((t) => ({
    tipo: t,
    cuentas: visibles.filter((c) => c.tipo === t),
  })).filter((g) => g.cuentas.length > 0);
  return (
    <select
      value={clave}
      onChange={(e) => {
        const v = e.target.value;
        if (!v) return onChange("", null);
        if (v.startsWith("t")) {
          const tipo = v.slice(1);
          return onChange(`CUALQUIER ${tipo.toUpperCase().replace(/_/g, " ")}`, null);
        }
        const cuenta = visibles.find((c) => `c${c.id}` === v);
        return cuenta ? onChange(cuenta.nombre, cuenta.id) : onChange("", null);
      }}
    >
      {conVacia && <option value="">— sin pagadora —</option>}
      <option value="tflujo">CUALQUIER FLUJO (Tesorería determina)</option>
      {grupos.map((g) => (
        <optgroup key={g.tipo} label={ETIQUETAS_TIPO_CUENTA[g.tipo] ?? g.tipo}>
          {g.cuentas.map((c) => (
            <option key={c.id} value={`c${c.id}`}>
              {c.nombre}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/**
 * Fase 13: etiqueta (chip) de la PAGADORA de una línea, editable: al picarla
 * se abre el desplegable del catálogo para corregirla antes del envío. Se usa
 * en la vista previa de la operación.
 */
function EtiquetaPagadora({
  catalogo,
  linea,
  onChange,
}: {
  catalogo: CuentaCatalogo[];
  linea: { pagadora?: string; pagadora_cuenta_id?: number | null };
  onChange: (pagadora: string, cuentaId: number | null) => void;
}) {
  const [editando, setEditando] = useState(false);
  const clave = clavePagadora(linea);
  if (!editando) {
    return (
      <button
        type="button"
        className="etiqueta-tipo"
        style={{
          cursor: "pointer",
          fontSize: "0.8rem",
          display: "inline-flex",
          alignItems: "center",
          gap: "0.3rem",
        }}
        title="Picar para corregir la pagadora de este pago"
        onClick={() => setEditando(true)}
      >
        {linea.pagadora || "— sin pagadora —"} <small>✎</small>
      </button>
    );
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
      <SelectPagadora
        catalogo={catalogo}
        clave={clave}
        conVacia={false}
        onChange={(pagadora, id) => {
          onChange(pagadora, id);
          setEditando(false);
        }}
      />
      <button type="button" className="btn" style={{ marginBottom: 0 }} onClick={() => setEditando(false)}>
        ×
      </button>
    </span>
  );
}

/** Redondeo a centavos en la UI (mismas fórmulas que el backend/Excel). */
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

const fmt = (n: number) => n.toLocaleString("es-MX", { minimumFractionDigits: 2 });

/** Fila de la balanza de comprobación (concepto + desglose + importe). */
interface FilaBalanza {
  concepto: string;
  detalle?: string;
  importe: number;
}

/**
 * Balanza de comprobación de la operación: al lado izquierdo lo que SUMA
 * (recursos: monto pagado, depósitos, financiamiento) y al derecho lo que
 * RESTA (aplicación: dispersiones a beneficiarios), con desglose de a qué
 * corresponde cada importe. Al pie, el sobrante (que queda en el resguardo
 * del cliente) o el faltante (si el flujo excede lo que entra).
 */
function BalanzaFlujo({ sumas, restas, nota }: { sumas: FilaBalanza[]; restas: FilaBalanza[]; nota?: React.ReactNode }) {
  const totalSumas = r2(sumas.reduce((s, f) => s + f.importe, 0));
  const totalRestas = r2(restas.reduce((s, f) => s + f.importe, 0));
  const diferencia = r2(totalSumas - totalRestas);
  const filas = Math.max(sumas.length, restas.length);
  return (
    <table style={{ maxWidth: 820 }}>
      <thead>
        <tr>
          <th style={{ textAlign: "left" }}>Suman (recursos)</th>
          <th style={{ textAlign: "right" }}>Importe</th>
          <th style={{ textAlign: "left" }}>Restan (aplicación)</th>
          <th style={{ textAlign: "right" }}>Importe</th>
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: filas }).map((_, i) => {
          const s = sumas[i];
          const d = restas[i];
          return (
            <tr key={i}>
              <td>
                {s ? (
                  <>
                    {s.concepto}
                    {s.detalle ? (
                      <small style={{ display: "block", color: "var(--tenue)" }}>{s.detalle}</small>
                    ) : null}
                  </>
                ) : (
                  ""
                )}
              </td>
              <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{s ? `$${fmt(s.importe)}` : ""}</td>
              <td>
                {d ? (
                  <>
                    {d.concepto}
                    {d.detalle ? (
                      <small style={{ display: "block", color: "var(--tenue)" }}>{d.detalle}</small>
                    ) : null}
                  </>
                ) : (
                  ""
                )}
              </td>
              <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{d ? `$${fmt(d.importe)}` : ""}</td>
            </tr>
          );
        })}
        <tr style={{ fontWeight: 700, borderTop: "2px solid currentColor" }}>
          <td>Total que suma</td>
          <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>${fmt(totalSumas)}</td>
          <td>Total que resta</td>
          <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>${fmt(totalRestas)}</td>
        </tr>
        <tr>
          <td colSpan={4} style={{ textAlign: "right", fontWeight: 700 }}>
            {diferencia >= -0.005 ? (
              <span style={{ color: "var(--exito, #2e7d32)" }}>
                Sobrante: ${fmt(diferencia)} — queda en el resguardo del cliente
              </span>
            ) : (
              <span style={{ color: "var(--peligro, #c62828)" }}>
                Faltante: ${fmt(Math.abs(diferencia))} — el flujo excede lo que suma
              </span>
            )}
          </td>
        </tr>
        {nota && (
          <tr>
            <td colSpan={4} style={{ color: "var(--tenue)", fontSize: "0.85rem" }}>
              {nota}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

const ROLES_UI = Object.keys(ETIQUETAS_ROL) as Rol[];

type Vista =
  | "operaciones"
  | "captura"
  | "clientes"
  | "usuarios"
  | "config"
  | "pagos"
  | "cuentas"
  | "direccion"
  | "auditoria"
  | "validacion"
  | "confirmacion"
  | "tesoreria"
  | "fondeo"
  | "altas"
  | "trf";

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
        {/* El menú es la única zona que hace scroll: la marca y el bloque de
            usuario (cerrar sesión) quedan SIEMPRE fijos en la barra lateral. */}
        <nav className="menu">
        <button className={vista === "operaciones" ? "activo" : ""} onClick={() => setVista("operaciones")}>
          Operaciones
        </button>
        {usuario.rol === "operacion" && (
          <button className={vista === "captura" ? "activo" : ""} onClick={() => setVista("captura")}>
            Nueva operación
          </button>
        )}
        {(usuario.rol === "admin_operaciones" || usuario.rol === "operacion") && (
          <button className={vista === "clientes" ? "activo" : ""} onClick={() => setVista("clientes")}>
            {usuario.rol === "operacion" ? "Mis clientes" : "Clientes"}
          </button>
        )}
        {(usuario.rol === "validacion" || usuario.rol === "admin_validacion") && (
          <button className={vista === "validacion" ? "activo" : ""} onClick={() => setVista("validacion")}>
            Validación
          </button>
        )}
        {usuario.rol === "fondeador" && (
          <button className={vista === "fondeo" ? "activo" : ""} onClick={() => setVista("fondeo")}>
            Fondeo
          </button>
        )}
        {["admin_operaciones", "admin_tesoreria", "validador_tesoreria", "tesoreria", "fondeador", "admin", "direccion", "auditoria"].includes(
          usuario.rol
        ) && (
          <button className={vista === "trf" ? "activo" : ""} onClick={() => setVista("trf")}>
            Resguardo TRF
          </button>
        )}
        {["operacion", "altas", "admin_tesoreria", "admin", "admin_operaciones", "fondeador", "validador_tesoreria", "direccion", "auditoria"].includes(
          usuario.rol
        ) && (
          <button className={vista === "altas" ? "activo" : ""} onClick={() => setVista("altas")}>
            Altas bancarias
          </button>
        )}
        {usuario.rol === "confirmador" && (
          <button className={vista === "confirmacion" ? "activo" : ""} onClick={() => setVista("confirmacion")}>
            Confirmación de depósitos
          </button>
        )}
        {(usuario.rol === "admin_tesoreria" || usuario.rol === "validador_tesoreria") && (
          <button className={vista === "tesoreria" ? "activo" : ""} onClick={() => setVista("tesoreria")}>
            Tesorería
          </button>
        )}
        {usuario.rol === "admin" && (
          <button className={vista === "usuarios" ? "activo" : ""} onClick={() => setVista("usuarios")}>
            Usuarios
          </button>
        )}
        {usuario.rol === "admin" && (
          <button className={vista === "config" ? "activo" : ""} onClick={() => setVista("config")}>
            Configuración
          </button>
        )}
        {(usuario.rol === "tesoreria" || usuario.rol === "direccion" || usuario.rol === "auditoria") && (
          <button className={vista === "pagos" ? "activo" : ""} onClick={() => setVista("pagos")}>
            Pagos
          </button>
        )}
        {(
          usuario.rol === "tesoreria" ||
          usuario.rol === "admin_tesoreria" ||
          usuario.rol === "validador_tesoreria" ||
          usuario.rol === "direccion" ||
          usuario.rol === "auditoria"
        ) && (
          <button className={vista === "cuentas" ? "activo" : ""} onClick={() => setVista("cuentas")}>
            Cuentas
          </button>
        )}
        {usuario.rol === "direccion" && (
          <button className={vista === "direccion" ? "activo" : ""} onClick={() => setVista("direccion")}>
            Dirección
          </button>
        )}
        {(usuario.rol === "auditoria" || usuario.rol === "direccion" || usuario.rol === "admin") && (
          <button className={vista === "auditoria" ? "activo" : ""} onClick={() => setVista("auditoria")}>
            Auditoría
          </button>
        )}
        </nav>
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
        {vista === "clientes" && <VistaClientes usuario={usuario} />}
        {vista === "usuarios" && <VistaUsuarios actual={usuario} />}
        {vista === "config" && <VistaConfig />}
        {vista === "pagos" && <VistaPagos />}
        {vista === "cuentas" && <VistaCuentas />}
        {vista === "direccion" && <VistaDireccion />}
        {vista === "auditoria" && <VistaAuditoria />}
        {vista === "validacion" && <VistaValidacion usuario={usuario} />}
        {vista === "confirmacion" && <VistaConfirmacion usuario={usuario} />}
        {vista === "tesoreria" && <VistaTesoreria usuario={usuario} />}
        {vista === "fondeo" && <VistaFondeo />}
        {vista === "altas" && <VistaAltas usuario={usuario} />}
        {vista === "trf" && <VistaTrfResguardo usuario={usuario} />}
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
  // Fase 13 (filtros del listado): tipo, moneda y rango de monto, aplicados en
  // vivo sobre lo cargado (se combinan con el alcance del rol del backend).
  const [fTipo, setFTipo] = useState("");
  const [fMoneda, setFMoneda] = useState("");
  const [fMin, setFMin] = useState("");
  const [fMax, setFMax] = useState("");
  const [seleccion, setSeleccion] = useState<number | null>(null);
  const [detalle, setDetalle] = useState<DetalleOperacion | null>(null);
  const [resguardo, setResguardo] = useState<ResguardoDetalle | null>(null);
  const [catalogo, setCatalogo] = useState<CuentaCatalogo[]>([]);
  const [depForm, setDepForm] = useState({
    cuenta_id: "",
    monto: "",
    comprobante: "",
    fecha: new Date().toISOString().slice(0, 10),
  });
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
  const [tandasImport, setTandasImport] = useState<TandaLayout[]>([]);
  const [erroresLayout, setErroresLayout] = useState<string[]>([]);
  const [editarDisp, setEditarDisp] = useState(false);
  const [dispEdit, setDispEdit] = useState<LineaLayout[]>([]);
  const [filaNueva, setFilaNueva] = useState<LineaLayout>(VACIA());
  const [editarDatos, setEditarDatos] = useState(false);
  // Tarea 12: pagadoras del catálogo en edición (multi-selección).
  const [destinosEdit, setDestinosEdit] = useState<Record<string, DestinoSel>>({});
  const [datosForm, setDatosForm] = useState({
    timbrar: false,
    comision_pct: "",
    observaciones: "",
  });
  const [cuentasPago, setCuentasPago] = useState<Cuenta[]>([]);
  // Historial por día del Ejecutivo (Fase 12): la consulta es por un día y
  // puede mirar hasta 1 mes atrás (el backend lo valida).
  const esOperador = usuario.rol === "operacion";
  const hoyStr = new Date().toISOString().slice(0, 10);
  const minDia = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const [dia, setDia] = useState(hoyStr);
  const moverDia = (delta: number) => {
    const d = new Date(`${dia}T12:00:00`);
    d.setDate(d.getDate() + delta);
    const nueva = d.toISOString().slice(0, 10);
    if (nueva < minDia || nueva > hoyStr) return;
    setDia(nueva);
  };

  useEffect(() => {
    if (usuario.rol !== "tesoreria") return;
    api
      .cuentas()
      .then(({ cuentas }) => setCuentasPago(cuentas))
      .catch(() => setCuentasPago([]));
  }, [usuario.rol]);
  // Catálogo ligero de cuentas (§5.3 + Tarea 12): depósitos del ejecutivo y
  // pagadoras/frentes en captura y edición.
  useEffect(() => {
    if (usuario.rol !== "operacion") return;
    api
      .cuentasCatalogo()
      .then(({ cuentas }) => setCatalogo(cuentas))
      .catch(() => setCatalogo([]));
  }, [usuario.rol]);
  const [mensaje, setMensaje] = useState("");

  const cargar = useCallback(async () => {
    try {
      const filtros: { estado?: string; q?: string; desde?: string; hasta?: string } = { estado, q };
      if (esOperador) {
        filtros.desde = dia;
        filtros.hasta = dia;
      }
      const { operaciones } = await api.lista(filtros);
      setOperaciones(operaciones);
    } catch (err) {
      onError((err as Error).message);
    }
  }, [estado, q, dia, esOperador, onError]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const abrir = async (id: number) => {
    onLimpiaError();
    setMensaje("");
    setSeleccion(id);
    setResguardo(null);
    setEditarDisp(false);
    setEditarDatos(false);
    setTandasImport([]);
    setErroresLayout([]);
    try {
      const d = await api.detalle(id);
      setDetalle(d);
      setPagoForm((f) => ({
        ...f,
        medio: "transferencia",
        monto: String(d.totales_pago.restante > 0.005 ? d.totales_pago.restante : d.operacion.monto),
        comprobante: "",
        notas: "",
        cuenta_id: "",
      }));
      setDatosForm({
        timbrar: d.operacion.timbrar === 1,
        comision_pct: String(d.operacion.comision_pct ?? 0),
        observaciones: d.operacion.observaciones ?? "",
      });
      // Tarea 12: pagadoras actuales de la operación para el editor.
      setDestinosEdit(
        Object.fromEntries(
          (d.destinos ?? []).map((x) => [
            x.cuenta_id !== null ? `c${x.cuenta_id}` : `t${x.tipo}`,
            { cuenta_id: x.cuenta_id, tipo: x.tipo, nombre: x.nombre, manejo_manual: x.manejo_manual === 1 },
          ])
        )
      );
      setDepForm({
        cuenta_id: "",
        monto: d.deposito && d.deposito.validado_por === null ? String(d.deposito.monto) : String(d.operacion.monto),
        comprobante: d.deposito && d.deposito.validado_por === null ? d.deposito.comprobante : "",
        fecha: d.deposito && d.deposito.validado_por === null ? d.deposito.fecha_deposito : new Date().toISOString().slice(0, 10),
      });
      setDirComentario("");
      // Resguardo del cliente (§14): saldo visible para quien atiende la
      // operación (el backend aplica el alcance del ejecutivo).
      const rolesResguardo = [
        "operacion",
        "admin_operaciones",
        "validador_tesoreria",
        "admin_tesoreria",
        "tesoreria",
        "direccion",
        "auditoria",
      ];
      if (d.operacion.cliente_id && rolesResguardo.includes(usuario.rol)) {
        api
          .resguardo(d.operacion.cliente_id)
          .then(setResguardo)
          .catch(() => setResguardo(null));
      }
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

  // Fase 13: filas tras aplicar los filtros del listado en vivo.
  const opsFiltradas = operaciones.filter((o) => {
    if (fTipo && o.tipo !== fTipo) return false;
    if (fMoneda && (o.moneda ?? "MXN") !== fMoneda) return false;
    if (fMin.trim() && !(o.monto >= Number(fMin))) return false;
    if (fMax.trim() && !(o.monto <= Number(fMax))) return false;
    return true;
  });
  const monedasLista = Array.from(new Set(operaciones.map((o) => o.moneda ?? "MXN"))).sort();

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
        <select value={fTipo} onChange={(e) => setFTipo(e.target.value)} style={{ maxWidth: 150, marginBottom: 0 }} title="Filtrar por tipo">
          <option value="">Todos los tipos</option>
          <option value="flujo">Flujo</option>
          <option value="pago">Pago</option>
          <option value="cobro">Cobro</option>
          <option value="financiamiento">Financiamiento</option>
          <option value="pago_especial">Pago especial</option>
        </select>
        <select value={fMoneda} onChange={(e) => setFMoneda(e.target.value)} style={{ maxWidth: 120, marginBottom: 0 }} title="Filtrar por moneda">
          <option value="">Toda moneda</option>
          {monedasLista.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <input
          type="number"
          placeholder="Monto mín"
          value={fMin}
          onChange={(e) => setFMin(e.target.value)}
          style={{ maxWidth: 110, marginBottom: 0 }}
          title="Monto mínimo"
        />
        <input
          type="number"
          placeholder="Monto máx"
          value={fMax}
          onChange={(e) => setFMax(e.target.value)}
          style={{ maxWidth: 110, marginBottom: 0 }}
          title="Monto máximo"
        />
        {(fTipo || fMoneda || fMin || fMax) && (
          <button
            className="btn"
            style={{ marginBottom: 0 }}
            onClick={() => {
              setFTipo("");
              setFMoneda("");
              setFMin("");
              setFMax("");
            }}
          >
            Limpiar filtros
          </button>
        )}
        {esOperador && (
          <>
            <label style={{ marginBottom: 0 }}>Historial del día:</label>
            <button className="btn" style={{ marginBottom: 0 }} onClick={() => moverDia(-1)}>
              ‹
            </button>
            <input
              type="date"
              value={dia}
              min={minDia}
              max={hoyStr}
              onChange={(e) => setDia(e.target.value)}
              style={{ marginBottom: 0 }}
            />
            <button
              className="btn"
              style={{ marginBottom: 0 }}
              onClick={() => moverDia(1)}
              disabled={dia >= hoyStr}
            >
              ›
            </button>
            <span style={{ color: "var(--tenue)", fontSize: "0.82rem" }}>
              Puedes revisar tu historial por día hasta 1 mes atrás.
            </span>
          </>
        )}
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
              <th>Cliente</th>
              <th style={{ textAlign: "right" }}>Monto</th>
              <th>Estado</th>
              <th>Capturista</th>
            </tr>
          </thead>
          <tbody>
            {opsFiltradas.map((o) => (
              <tr
                key={o.id}
                className={seleccion === o.id ? "seleccionada" : ""}
                onClick={() => void abrir(o.id)}
              >
                <td>{o.folio}</td>
                <td style={{ textTransform: "capitalize" }}>{o.tipo}</td>
                <td>{o.concepto}</td>
                <td>{o.proveedor}</td>
                <td>{o.cliente ?? "—"}</td>
                <td style={{ textAlign: "right" }}>
                  {o.monto.toLocaleString("es-MX", { minimumFractionDigits: 2 })} {o.moneda}
                </td>
                <td>
                  <span className={`badge ${o.estado}`}>{ETIQUETAS_ESTADO[o.estado]}</span>
                </td>
                <td>{o.capturista ?? "—"}</td>
              </tr>
            ))}
            {opsFiltradas.length === 0 && (
              <tr>
                <td colSpan={8} className="vacio">
                  No hay operaciones que coincidan con los filtros.
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
              <strong>Cliente:</strong> {op.cliente ?? "— (sin cliente)"}
              <br />
              <strong>Monto:</strong>{" "}
              {fmt(op.monto)} {op.moneda}
              <br />
              <strong>Fecha de operación:</strong> {op.fecha_operacion}
            </p>

            {op.tipo === "flujo" && detalle.calculos && (
              <PanelFlujo
                detalle={detalle}
                rol={usuario.rol}
                puedeEditar={
                  usuario.rol === "operacion" &&
                  ["borrador", "en_validacion", "observada"].includes(op.estado) &&
                  detalle.pagos.length === 0
                }
                editarDisp={editarDisp}
                setEditarDisp={(v) => {
                  setEditarDisp(v);
                  setDispEdit(
                    v
                      ? detalle.dispersiones.map((d) => ({
                          ...d,
                          pagadora: d.pagadora ?? "",
                          pagadora_cuenta_id: d.pagadora_cuenta_id ?? null,
                          // Fase 14: los campos nuevos son opcionales en la BD
                          // pero obligatorios en el editor (string).
                          nombre: d.nombre ?? "",
                          apellido_paterno: d.apellido_paterno ?? "",
                          apellido_materno: d.apellido_materno ?? "",
                          concepto: d.concepto ?? "",
                          referencia_pago: d.referencia_pago ?? "",
                        }))
                      : []
                  );
                  setFilaNueva(VACIA());
                }}
                dispEdit={dispEdit}
                setDispEdit={setDispEdit}
                filaNueva={filaNueva}
                setFilaNueva={setFilaNueva}
                erroresLayout={erroresLayout}
                setErroresLayout={setErroresLayout}
                onImportarDisp={(lineas, errores) => {
                  setErroresLayout(errores);
                  if (lineas.length) setDispEdit((prev) => [...prev, ...lineas]);
                }}
                onGuardarDisp={async () => {
                  await accion(
                    api.guardarDispersiones(op.id, dispEdit),
                    "Dispersiones actualizadas."
                  );
                  setEditarDisp(false);
                }}
                editarDatos={editarDatos}
                setEditarDatos={setEditarDatos}
                datosForm={datosForm}
                setDatosForm={setDatosForm}
                catalogo={catalogo}
                destinosEdit={destinosEdit}
                setDestinosEdit={setDestinosEdit}
                onGuardarDatos={async () => {
                  await accion(
                    api.guardarDatosFlujo(op.id, {
                      timbrar: datosForm.timbrar,
                      comision_pct: Number(datosForm.comision_pct),
                      observaciones: datosForm.observaciones,
                      // Tarea 12: pagadoras del catálogo (el backend rellena
                      // pagador/tipo_operacion desde aquí).
                      destinos: destinosAPayload(destinosEdit),
                    }),
                    "Datos del flujo actualizados."
                  );
                  setEditarDatos(false);
                }}
              />
            )}

            {op.tipo === "pago_especial" && (
              <PanelPagoEspecial detalle={detalle} />
            )}

            <div className="barra">
              {usuario.rol === "operacion" && (op.estado === "borrador" || op.estado === "observada") && (
                <button
                  className="btn"
                  onClick={() => void accion(api.enviarValidacion(op.id), "Enviada a validación.")}
                >
                  Enviar a validación
                </button>
              )}
              {usuario.rol === "fondeador" && op.estado === "aprobada" && !op.liberada_en && (
                <button
                  className="btn exito"
                  onClick={() => void accion(api.liberar(op.id), "Operación liberada a Tesorería.")}
                >
                  Liberar a Tesorería
                </button>
              )}
              {((usuario.rol === "operacion" && ["borrador", "observada"].includes(op.estado)) ||
                ((usuario.rol === "tesoreria" || usuario.rol === "admin_tesoreria" || usuario.rol === "fondeador") &&
                  !["pagada", "cancelada"].includes(op.estado) &&
                  !(op.estado === "en_pago" && detalle.totales_pago.total_dispersado > 0.005))) && (
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

            {op.liberada_en && (
              <p style={{ color: "var(--exito, #2e7d32)", fontSize: "0.87rem" }}>
                <strong>Liberada por el Tesorero Fondeador</strong>
                {detalle.liberada_por_nombre ? ` — ${detalle.liberada_por_nombre}` : ""} el {op.liberada_en}:
                Tesorería ya puede dispersarla.
              </p>
 )}
            {!op.liberada_en &&
              ["en_validacion", "observada", "pendiente_direccion"].includes(op.estado) && (
                <p style={{ color: "var(--tenue)", fontSize: "0.85rem" }}>
                  Al aprobarse, el Tesorero Fondeador la libera y sólo entonces Tesorería la verá y podrá pagarla.
                </p>
 )}

            {detalle.altas_dispersiones && detalle.altas_dispersiones.length > 0 && (
              <>
                <h3>Altas bancarias de la dispersión</h3>
                <p style={{ color: "var(--tenue)", fontSize: "0.85rem" }}>
                  Sin el alta registrada en el banco, Tesorería no puede dispersar esa línea (solicítala aquí;
                  Tesorería de Altas la registra en el portal bancario).
                </p>
                <table>
                  <thead>
                    <tr>
                      <th>Beneficiario</th>
                      <th>Banco</th>
                      <th>Cuenta / CLABE</th>
                      <th style={{ textAlign: "right" }}>Importe</th>
                      <th>Alta bancaria</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detalle.altas_dispersiones.map((a) => (
                      <tr key={a.dispersion_id}>
                        <td>{a.beneficiario}</td>
                        <td>{a.banco || "—"}</td>
                        <td>{a.cuenta || "—"}</td>
                        <td style={{ textAlign: "right" }}>${fmt(a.importe)}</td>
                        <td>
                          {!a.verificable && <span style={{ color: "var(--tenue)" }}>Línea sin datos bancarios</span>}
                          {a.verificable && a.registrada && (
                            <span style={{ color: "var(--exito, #2e7d32)", fontWeight: 600 }}>Registrada</span>
                          )}
                          {a.verificable && !a.registrada && a.estado_alta === "solicitada" && (
                            <span style={{ color: "var(--ambar, #b26a00)" }}>Solicitud en proceso</span>
                          )}
                          {a.verificable && !a.registrada && a.estado_alta === "rechazada" && (
                            <span style={{ color: "var(--peligro, #c62828)" }}>Solicitud rechazada — vuelve a solicitarla</span>
                          )}
                          {a.verificable && !a.registrada && !a.estado_alta && (
                            <span style={{ color: "var(--peligro, #c62828)" }}>Sin alta — Tesorería no podrá pagar</span>
                          )}
                          {usuario.rol === "operacion" && a.verificable && !a.registrada &&
                            a.estado_alta !== "solicitada" && (
                              <button
                                className="btn"
                                style={{ marginLeft: "0.5rem" }}
                                onClick={() =>
                                  void accion(
                                    api.solicitarAlta({ dispersion_id: a.dispersion_id }),
                                    `Alta solicitada: ${a.beneficiario} (${a.banco}).`
                                  )
                                }
                              >
                                Solicitar alta
                              </button>
                            )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}

            {op.cliente_id && resguardo && (
              <p style={{ color: "var(--tenue)", fontSize: "0.87rem" }}>
                <strong>Resguardo del cliente:</strong>{" "}
                <span
                  style={{
                    color:
                      resguardo.saldo >= detalle.totales_pago.total_por_dispersar
                        ? "var(--exito, #2e7d32)"
                        : "var(--ambar, #b26a00)",
                  }}
                >
                  ${fmt(resguardo.saldo)}
                </span>{" "}
                — por dispersar: ${fmt(detalle.totales_pago.total_por_dispersar)}; sin resguardo suficiente
                Tesorería no puede pagar (§14).
              </p>
            )}

            {usuario.rol === "operacion" && op.cliente_id && (op.estado === "borrador" || op.estado === "observada") && (
              <>
                <h3>Depósito del cliente (comprobante de recursos)</h3>
                {detalle.deposito && detalle.deposito.validado_por !== null ? (
                  <p style={{ color: "var(--exito, #2e7d32)", fontSize: "0.87rem" }}>
                    Depósito validado por Tesorería el {detalle.deposito.validado_en}: $
                    {detalle.deposito.monto.toLocaleString("es-MX", { minimumFractionDigits: 2 })} — comprobante{" "}
                    {detalle.deposito.comprobante}.
                  </p>
                ) : (
                  <>
                    {detalle.deposito && (
                      <p style={{ color: "var(--ambar, #b26a00)", fontSize: "0.85rem" }}>
                        Depósito indicado pendiente de validación por Tesorería. Puedes corregirlo antes de que lo validen.
                      </p>
                    )}
                    <div className="rejilla">
                      <div>
                        <label>Cuenta donde depositó el cliente</label>
                        <select
                          value={depForm.cuenta_id}
                          onChange={(e) => setDepForm({ ...depForm, cuenta_id: e.target.value })}
                          required
                        >
                          <option value="">— Selecciona cuenta —</option>
                          {catalogo.map((c) => (
                            <option key={c.id} value={String(c.id)}>
                              {c.nombre}
                              {c.banco ? ` — ${c.banco}` : ""}
                              {c.numero_cuenta ? ` (${c.numero_cuenta})` : ""}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label>Monto depositado</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0.01"
                          value={depForm.monto}
                          onChange={(e) => setDepForm({ ...depForm, monto: e.target.value })}
                        />
                      </div>
                      <div>
                        <label>Fecha del depósito</label>
                        <input
                          type="date"
                          value={depForm.fecha}
                          onChange={(e) => setDepForm({ ...depForm, fecha: e.target.value })}
                        />
                      </div>
                    </div>
                    <label>Comprobante de la entrada de recursos (folio / referencia)</label>
                    <input
                      value={depForm.comprobante}
                      onChange={(e) => setDepForm({ ...depForm, comprobante: e.target.value })}
                      placeholder="Ej. SPEI-8842 o ficha de depósito"
                    />
                    <div className="barra">
                      <button
                        className="btn"
                        onClick={() =>
                          void accion(
                            api.indicarDeposito(op.id, {
                              cuenta_id: Number(depForm.cuenta_id),
                              monto: Number(depForm.monto),
                              comprobante: depForm.comprobante,
                              fecha_deposito: depForm.fecha,
                            }),
                            "Depósito indicado: Tesorería lo validará y sumará al resguardo del cliente."
                          )
                        }
                      >
                        {detalle.deposito ? "Actualizar depósito indicado" : "Indicar depósito"}
                      </button>
                    </div>
                  </>
                )}
              </>
            )}

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

            {(op.estado === "aprobada" || op.estado === "en_pago" || op.estado === "pagada") && (
              <>
                <h3>Tesorería — pagos (tandas)</h3>
                <p style={{ color: "var(--tenue)", fontSize: "0.87rem", margin: "0 0 0.6rem" }}>
                  Dispersado <strong>${fmt(detalle.totales_pago.total_dispersado)}</strong> de{" "}
                  <strong>${fmt(detalle.totales_pago.total_por_dispersar)}</strong>
                  {detalle.totales_pago.restante > 0.005 && (
                    <> · restante por dispersar: <strong>${fmt(detalle.totales_pago.restante)}</strong></>
                  )}
                  {detalle.calculos.diferencia > 0.005 && (
                    <> · diferencia a favor: <strong>${fmt(detalle.calculos.diferencia)}</strong> (se ingresa a resguardo)</>
                  )}
                </p>

                {usuario.rol === "tesoreria" && (op.estado === "aprobada" || op.estado === "en_pago") && (
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
                        <label>Monto de la tanda (restante: ${fmt(detalle.totales_pago.restante)})</label>
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
                    {detalle.destinos && detalle.destinos.length > 0 && (
                      <p style={{ color: "var(--tenue)", fontSize: "0.83rem", margin: "0.3rem 0" }}>
                        Pagadoras solicitadas por el ejecutivo:{" "}
                        {detalle.destinos
                          .map((d) => `${d.nombre}${d.manejo_manual === 1 ? " (manual)" : ""}`)
                          .join(" · ")}
                        . En <strong>CUALQUIER FLUJO</strong> Tesorería determina la cuenta de salida.
                      </p>
                    )}
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
                            "Tanda registrada."
                          )
                        }
                      >
                        Registrar tanda
                      </button>
                      <label className="btn" style={{ marginBottom: 0 }}>
                        Importar layout de tandas
                        <input
                          type="file"
                          accept=".xlsx,.xls,.csv,.txt"
                          style={{ display: "none" }}
                          onChange={async (e) => {
                            const archivo = e.target.files?.[0];
                            e.target.value = "";
                            if (!archivo) return;
                            try {
                              const filas = await leerFilas(archivo);
                              const r = mapearTandas(filas);
                              setErroresLayout(r.errores);
                              setTandasImport(r.filas);
                            } catch (err) {
                              setErroresLayout([(err as Error).message]);
                              setTandasImport([]);
                            }
                          }}
                        />
                      </label>
                      <button className="btn" onClick={() => descargarPlantillaTandas()}>
                        Descargar plantilla
                      </button>
                    </div>
                    {tandasImport.length > 0 && (
                      <div className="panel" style={{ background: "var(--fondo-suave, #f7f7f7)" }}>
                        <strong>Vista previa del lote ({tandasImport.length} tandas)</strong>
                        <table>
                          <thead>
                            <tr>
                              <th>#</th>
                              <th>Medio</th>
                              <th style={{ textAlign: "right" }}>Monto</th>
                              <th>Fecha</th>
                              <th>Comprobante</th>
                              <th>Notas</th>
                            </tr>
                          </thead>
                          <tbody>
                            {tandasImport.map((t, i) => (
                              <tr key={i}>
                                <td>{i + 1}</td>
                                <td>{t.medio}</td>
                                <td style={{ textAlign: "right" }}>{fmt(t.monto)}</td>
                                <td>{t.fecha_pago || "hoy"}</td>
                                <td>{t.comprobante || "—"}</td>
                                <td>{t.notas || "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <div className="barra">
                          <button
                            className="btn exito"
                            onClick={() =>
                              void accion(
                                api.pagarLote(
                                  op.id,
                                  tandasImport.map((t, i) => ({
                                    medio: t.medio as MedioPago,
                                    monto: t.monto,
                                    comprobante: t.comprobante || `LOTE-${i + 1}`,
                                    fecha_pago: t.fecha_pago || undefined,
                                    notas: t.notas,
                                  }))
                                ),
                                "Lote de tandas registrado."
                              ).then(() => setTandasImport([]))
                            }
                          >
                            Registrar lote completo
                          </button>
                          <button className="btn" onClick={() => setTandasImport([])}>
                            Descartar
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}

                {detalle.pagos.length > 0 && (
                  <table>
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Fecha de pago</th>
                        <th>Medio</th>
                        <th style={{ textAlign: "right" }}>Monto</th>
                        <th>Comprobante</th>
                        <th>Pagó</th>
                        <th>Notas</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detalle.pagos.map((p, i) => (
                        <tr key={p.id}>
                          <td>{i + 1}</td>
                          <td>{p.fecha_pago}</td>
                          <td>{p.medio}</td>
                          <td style={{ textAlign: "right" }}>{fmt(p.monto)} {p.moneda}</td>
                          <td>{p.comprobante}</td>
                          <td>{p.pagador ?? "—"}</td>
                          <td>{p.notas || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {detalle.pagos.length === 0 && detalle.totales_pago.total_dispersado === 0 && (
                  <p style={{ color: "var(--tenue)", fontSize: "0.85rem" }}>
                    Aún no hay tandas registradas: Tesorería dispersa en una o varias tandas hasta cubrir el
                    flujo total.
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
  const [guardando, setGuardando] = useState(false);
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [clienteId, setClienteId] = useState("");
  // Tarea 12: pagadoras/frentes seleccionados del catálogo de Tesorería
  // (desplegable + etiquetas desde Fase 13).
  const [destinosSel, setDestinosSel] = useState<Record<string, DestinoSel>>({});
  const [brokers, setBrokers] = useState<Broker[]>([]);
  const [brokersSel, setBrokersSel] = useState<Record<number, string>>({});
  const [timbrar, setTimbrar] = useState(false);
  const [concepto, setConcepto] = useState("");
  const [observaciones, setObservaciones] = useState("");
  const [monto, setMonto] = useState("");
  const [comisionPct, setComisionPct] = useState("2.50");
  // Fase 13 (otras monedas): MXN y USD directos; "OTRA" abre el listado de
  // monedas más usadas (Libra, Yen, Euro, …) o un código personalizado.
  const [moneda, setMoneda] = useState("MXN");
  const [monedaOtra, setMonedaOtra] = useState(false);
  const [monedaLista, setMonedaLista] = useState("");
  const [monedaLibre, setMonedaLibre] = useState("");
  const monedaFinal = monedaOtra
    ? (monedaLibre.trim().toUpperCase() || monedaLista)
    : moneda;
  // Fase 13 (vista previa): antes de enviar, el ejecutivo revisa el listado de
  // pagos sobre la balanza y corrige pagadoras como etiquetas.
  const [previa, setPrevia] = useState(false);
  const [fecha, setFecha] = useState(new Date().toISOString().slice(0, 10));
  const [dispersiones, setDispersiones] = useState<LineaLayout[]>([]);
  const [filaNueva, setFilaNueva] = useState<LineaLayout>(VACIA());
  const [erroresLayout, setErroresLayout] = useState<string[]>([]);
  // Respaldo de la operación (§6.1): depósitos indicados + financiamiento.
  // Cada depósito puede llevar 1 o varios comprobantes (archivos adjuntos) que
  // se suben al crear la operación: sin ellos Tesorería no podrá validarlo.
  const [cuentasCat, setCuentasCat] = useState<CuentaCatalogo[]>([]);
  const [saldoCliente, setSaldoCliente] = useState(0);
  const [depsResp, setDepsResp] = useState<
    Array<{ cuenta_id: string; monto: string; comprobante: string; fecha: string; archivos: File[] }>
  >([]);
  const [depNueva, setDepNueva] = useState({
    cuenta_id: "",
    monto: "",
    comprobante: "",
    fecha: new Date().toISOString().slice(0, 10),
    archivos: [] as File[],
  });
  const [usarFin, setUsarFin] = useState(false);
  const [finMonto, setFinMonto] = useState("");
  const [finNotas, setFinNotas] = useState("");
  // Fase 14: la captura tiene dos modos — operación completa (flujo) o PAGO
  // ESPECIAL (formato adjunto, importe, pagadora y descripción; el efectivo
  // sale de un resguardo). El pago especial vive en su propio componente.
  const [modoCaptura, setModoCaptura] = useState<"flujo" | "especial">("flujo");

  useEffect(() => {
    // El backend devuelve sólo los clientes asignados al ejecutivo (01-ROLES.md §3.2).
    api
      .clientes()
      .then(({ clientes }) => setClientes(clientes))
      .catch(() => setClientes([]));
    api
      .brokers()
      .then(({ brokers }) => setBrokers(brokers))
      .catch(() => setBrokers([]));
  }, []);

  // Catálogo de cuentas: depósitos del respaldo Y pagadoras/frentes (Tarea 12).
  useEffect(() => {
    api
      .cuentasCatalogo()
      .then(({ cuentas }) => setCuentasCat(cuentas))
      .catch(() => setCuentasCat([]));
  }, []);

  // Al elegir cliente: saldo de resguardo y su política de financiamiento.
  useEffect(() => {
    if (!clienteId) {
      setSaldoCliente(0);
      return;
    }
    api
      .resguardo(Number(clienteId))
      .then((r) => setSaldoCliente(r.saldo))
      .catch(() => setSaldoCliente(0));
  }, [clienteId]);

  // ---- Cálculos en vivo (mismas fórmulas del formato/Excel) ----
  const montoNum = Number(monto) || 0;
  const pctNum = Number(comisionPct) || 0;
  const iva = r2((montoNum * 16) / 116);
  const neto = r2((montoNum * 100) / 116);
  const comisionTotal = r2((montoNum * pctNum) / 100);
  const brokersPct = Object.values(brokersSel).map(Number);
  const sumaBrokers = r2(brokersPct.reduce((s, p) => s + p, 0));
  const flujoTotal = r2(dispersiones.reduce((s, d) => s + (Number.isFinite(d.importe) ? d.importe : 0), 0));
  const devolucion = r2(flujoTotal - comisionTotal);
  const diferencia = r2(montoNum - flujoTotal);
  const comprobacionOk = diferencia >= -0.005;
  const faltantes = brokers.filter((b) => brokersSel[b.id] !== undefined && !(Number(brokersSel[b.id]) > 0));
  // Tarea 12: nombres de las pagadoras seleccionadas (para la balanza).
  const pagadorasTexto = Object.values(destinosSel)
    .map((d) => d.nombre)
    .join(", ");
  // Fase 13: brokers participantes (para la nota de la balanza en la vista previa).
  const brokersParticipan = brokers.filter((b) => brokersSel[b.id] !== undefined);

  // ---- Respaldo en vivo (§6.1): saldo + depósitos + financiamiento vs flujo ----
  const clienteSel = clientes.find((c) => String(c.id) === clienteId) ?? null;
  // Fase 14: comisiones preestablecidas del cliente — la de broker se rellena
  // sola al elegir el cliente (el ejecutivo puede ajustarla); la de TRF va
  // directo al resguardo de la empresa al pagarse la operación.
  useEffect(() => {
    if (clienteSel?.comision_broker_pct != null) setComisionPct(String(clienteSel.comision_broker_pct));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clienteSel?.comision_broker_pct]);
  const comisionTrfCliente = clienteSel?.comision_trf_pct ?? null;
  const totalDepsResp = r2(depsResp.reduce((s, d) => s + (Number(d.monto) || 0), 0));
  const finMontoNum = usarFin ? Number(finMonto) || 0 : 0;
  const disponibleResp = r2(saldoCliente + totalDepsResp + finMontoNum);
  const faltanteRespaldo = r2(flujoTotal - disponibleResp);
  const respaldoOk = !clienteId || faltanteRespaldo <= 0.005;
  const finExento =
    !!clienteSel &&
    (clienteSel.financiamiento_sin_aprobacion === 1 ||
      (typeof clienteSel.financiamiento_maximo === "number" &&
        finMontoNum > 0 &&
        finMontoNum <= (clienteSel.financiamiento_maximo as number) + 0.005));

  const agregarDepositoResp = () => {
    if (!depNueva.cuenta_id || !(Number(depNueva.monto) > 0) || !depNueva.comprobante.trim()) return;
    setDepsResp((prev) => [...prev, { ...depNueva, monto: String(r2(Number(depNueva.monto))) }]);
    setDepNueva({ cuenta_id: "", monto: "", comprobante: "", fecha: new Date().toISOString().slice(0, 10), archivos: [] });
  };

  /** Lee un archivo como base64 (para adjuntar comprobantes al depósito). */
  const leerArchivo = (archivo: File): Promise<string> =>
    new Promise((resolver, rechazar) => {
      const lector = new FileReader();
      lector.onload = () => resolver(String(lector.result));
      lector.onerror = () => rechazar(new Error(`No se pudo leer ${archivo.name}`));
      lector.readAsDataURL(archivo);
    });

  const agregarFila = () => {
    if (!filaNueva.beneficiario.trim() || !(Number(filaNueva.importe) > 0)) return;
    setDispersiones((prev) => [...prev, { ...filaNueva, importe: r2(Number(filaNueva.importe)) }]);
    setFilaNueva(VACIA());
  };

  /** Catálogo de pagadoras que ve el operador: activas y visibles (Fase 13). */
  const catalogoPagadoras = cuentasCat.filter((c) => c.visible_operador !== 0);

  const importarLayout = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const archivo = e.target.files?.[0];
    e.target.value = "";
    if (!archivo) return;
    try {
      const filas = await leerFilas(archivo);
      // Tarea 12: la PAGADORA se valida contra el catálogo vigente; Fase 13:
      // contra las cuentas VISIBLES para operadores (las ocultas se rechazan
      // igual que las sacadas de operación).
      const r = mapearDispersiones(filas, catalogoPagadoras);
      setErroresLayout(r.errores);
      if (r.filas.length) setDispersiones((prev) => [...prev, ...r.filas]);
    } catch (err) {
      setErroresLayout([(err as Error).message]);
    }
  };

  /** Validaciones locales compartidas por la vista previa y el envío real. */
  const validarLocal = (): string[] => {
    const locales: string[] = [];
    if (Object.keys(destinosSel).length === 0)
      locales.push("selecciona al menos una pagadora del catálogo de Tesorería (o CUALQUIER FLUJO)");
    if (dispersiones.length === 0) locales.push("agrega al menos una dispersión (manual o por layout)");
    if (!comprobacionOk) locales.push("la comprobación está EN CONTRA: el flujo total excede el monto pagado");
    if (sumaBrokers > 100.0001) locales.push("la suma de porcentajes de brokers excede 100%");
    if (faltantes.length) locales.push("define el % de los brokers seleccionados");
    if (monedaOtra && !/^[A-Z]{3}$/.test(monedaFinal))
      locales.push("especifica la otra moneda (elige de la lista o escribe el código de 3 letras)");
    if (clienteId && !respaldoOk)
      locales.push(
        `respaldo insuficiente: disponible $${fmt(disponibleResp)} para un flujo de $${fmt(flujoTotal)} — agrega depósitos o un financiamiento por al menos $${fmt(faltanteRespaldo)}`
      );
    if (usarFin && finMontoNum > 0 && !clienteId) locales.push("el financiamiento requiere cliente");
    if (depsResp.length > 0 && !clienteId) locales.push("los depósitos del respaldo requieren cliente");
    return locales;
  };

  /** Fase 13: el formulario no envía: muestra la VISTA PREVIA para revisar. */
  const enviarFormulario = (e: React.FormEvent) => {
    e.preventDefault();
    const locales = validarLocal();
    if (locales.length) {
      onError(`Captura incompleta: ${locales.join(" · ")}`);
      return;
    }
    setPrevia(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const enviarReal = async () => {
    const locales = validarLocal();
    if (locales.length) {
      onError(`Captura incompleta: ${locales.join(" · ")}`);
      setPrevia(false);
      return;
    }
    setGuardando(true);
    try {
      const creada = await api.crear({
        tipo: "flujo",
        concepto,
        monto: montoNum,
        moneda: monedaFinal || "MXN",
        fecha_operacion: fecha,
        ...(clienteId ? { cliente_id: Number(clienteId) } : {}),
        // Tarea 12: las pagadoras del catálogo determinan el pagador y el
        // tipo de operación (el backend los rellena desde los destinos).
        destinos: destinosAPayload(destinosSel),
        timbrar,
        comision_pct: pctNum,
        // Fase 14: la comisión TRF preestablecida del cliente viaja con la
        // operación y al pagarse ingresa directo al resguardo de la empresa.
        ...(clienteSel?.comision_trf_pct != null ? { comision_trf_pct: clienteSel.comision_trf_pct } : {}),
        observaciones,
        dispersiones,
        brokers: Object.entries(brokersSel).map(([id, pct]) => ({
          broker_id: Number(id),
          porcentaje: Number(pct),
        })),
        ...(clienteId && (depsResp.length > 0 || (usarFin && finMontoNum > 0))
          ? {
              respaldo: {
                ...(depsResp.length > 0
                  ? {
                      depositos: depsResp.map((d) => ({
                        cuenta_id: Number(d.cuenta_id),
                        monto: Number(d.monto),
                        comprobante: d.comprobante.trim(),
                        fecha_deposito: d.fecha,
                      })),
                    }
                  : {}),
                ...(usarFin && finMontoNum > 0 ? { financiamiento: { monto: finMontoNum, notas: finNotas } } : {}),
              },
            }
          : {}),
      });
      // Comprobantes documentales del respaldo (1 o varios por depósito): se
      // suben en cuanto la operación existe, para que Tesorería pueda validar.
      const conArchivos = depsResp.map((d, i) => ({ d, i, archivos: d.archivos })).filter((x) => x.archivos.length > 0);
      if (conArchivos.length > 0 && creada.operacion?.id) {
        try {
          const det = await api.detalle(creada.operacion.id);
          for (const { d, i, archivos } of conArchivos) {
            const creado =
              det.depositos.find(
                (dep) =>
                  dep.cuenta_id === Number(d.cuenta_id) &&
                  Math.abs(dep.monto - Number(d.monto)) < 0.005 &&
                  dep.comprobante === d.comprobante.trim()
              ) ?? det.depositos[i];
            if (!creado) continue;
            const contenido = await Promise.all(
              archivos.map(async (a) => ({ nombre: a.name, mime: a.type || "application/octet-stream", contenido: await leerArchivo(a) }))
            );
            await api.subirComprobantes(creado.id, contenido);
          }
        } catch (errComp) {
          onError(`La operación se creó, pero hubo un problema al subir comprobantes: ${(errComp as Error).message}`);
        }
      }
      onCreada();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setGuardando(false);
    }
  };

  const CAMPOS_FILA: Array<[keyof LineaLayout, string, string]> = [
    ["beneficiario", "Beneficiario (nombre)", "COMERCIAL BRAIN FENIX"],
    // Fase 14: datos adicionales de la persona y del pago — todos OPCIONALES.
    ["nombre", "Nombre (de pila)", "JUAN"],
    ["apellido_paterno", "Apellido paterno", "PEREZ"],
    ["apellido_materno", "Apellido materno", "GARCIA"],
    ["razon_social", "Razón social", "COMERCIAL BRAIN FENIX S DE RL DE CV"],
    ["concepto", "Concepto del pago", "PAGO DE PROVEEDORES"],
    ["referencia", "Referencia", "1010"],
    ["referencia_pago", "Referencia para pago", "REF-88"],
    ["ine", "INE", ""],
    ["numero", "#", ""],
    ["tarjeta", "Tarjeta", ""],
    ["cuenta", "Cuenta / CLABE", "6461803528523520323"],
    ["clabe", "CLABE", ""],
    ["banco", "Banco", "STP"],
    ["etiqueta", "Etiqueta", "PROVEEDOR"],
  ];

  if (modoCaptura === "especial") {
    return <VistaCapturaEspecial onCreada={onCreada} onError={onError} onVolver={() => setModoCaptura("flujo")} />;
  }

  return (
    <>
      <div className="barra" style={{ maxWidth: 1080 }}>
        <button className="btn activo" style={{ marginBottom: 0 }} title="Captura con dispersiones, balanza y respaldo">
          Operación completa (flujo)
        </button>
        <button className="btn" style={{ marginBottom: 0 }} onClick={() => setModoCaptura("especial")} title="Retiro respaldado por un resguardo (TRF o broker) con formato adjunto">
          Pago especial (formato adjunto)
        </button>
      </div>
      <h2>Nueva operación (formato completo)</h2>
      {previa ? (
        <div className="panel" style={{ maxWidth: 1080 }}>
          <h3 style={{ marginTop: 0 }}>Vista previa de la operación</h3>
          <p style={{ color: "var(--tenue)", fontSize: "0.88rem" }}>
            Revisa el listado de pagos sobre la balanza. Las <strong>pagadoras</strong> se muestran
            como etiquetas: pica la etiqueta para corregir cualquier pagadora que haya quedado mal
            antes de enviar.
          </p>
          <div className="rejilla" style={{ marginBottom: "0.6rem" }}>
            <div>
              <label>Cliente (resguardo)</label>
              <div>{clienteSel ? clienteSel.nombre : "— Sin cliente —"}</div>
            </div>
            <div>
              <label>Fecha de operación</label>
              <div>{fecha}</div>
            </div>
            <div>
              <label>Moneda</label>
              <div style={{ fontWeight: 700 }}>{monedaFinal || "MXN"}</div>
            </div>
            <div>
              <label>Timbrar</label>
              <div>{timbrar ? "SÍ" : "NO"}</div>
            </div>
          </div>
          <p style={{ margin: "0.2rem 0" }}>
            <strong>Concepto:</strong> {concepto}
            {observaciones ? (
              <span style={{ color: "var(--tenue)" }}> — {observaciones}</span>
            ) : null}
          </p>

          <h4 style={{ marginBottom: "0.3rem" }}>Pagos de la operación ({dispersiones.length})</h4>
          <table style={{ maxWidth: 1020 }}>
            <thead>
              <tr>
                <th>#</th>
                <th>Beneficiario</th>
                <th>Cuenta / Banco</th>
                <th style={{ textAlign: "right" }}>Importe</th>
                <th>Pagadora (etiqueta editable)</th>
              </tr>
            </thead>
            <tbody>
              {dispersiones.map((d, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>
                    {d.beneficiario}
                    {d.razon_social ? (
                      <small style={{ display: "block", color: "var(--tenue)" }}>{d.razon_social}</small>
                    ) : null}
                  </td>
                  <td>
                    {d.cuenta || d.clabe || "—"}
                    {d.banco ? <small style={{ display: "block", color: "var(--tenue)" }}>{d.banco}</small> : null}
                  </td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>${fmt(d.importe)}</td>
                  <td>
                    <EtiquetaPagadora
                      catalogo={catalogoPagadoras}
                      linea={d}
                      onChange={(pagadora, id) =>
                        setDispersiones((prev) =>
                          prev.map((l, j) => (j === i ? { ...l, pagadora, pagadora_cuenta_id: id } : l))
                        )
                      }
                    />
                  </td>
                </tr>
              ))}
              <tr style={{ fontWeight: 700, borderTop: "2px solid currentColor" }}>
                <td colSpan={3}>Flujo Total</td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>${fmt(flujoTotal)}</td>
                <td style={{ color: comprobacionOk ? "var(--exito, #2e7d32)" : "var(--peligro, #c62828)" }}>
                  Comprobación: {comprobacionOk ? "VERDADERO" : "EN CONTRA"}
                </td>
              </tr>
            </tbody>
          </table>

          <h4 style={{ marginBottom: "0.3rem" }}>Pagadoras de la operación (etiquetas modificables)</h4>
          <SelectorDestinos catalogo={catalogoPagadoras} seleccion={destinosSel} setSeleccion={setDestinosSel} />

          {montoNum > 0 && (
            <>
              <h4 style={{ marginBottom: "0.3rem" }}>Balanza de la operación</h4>
              <BalanzaFlujo
                sumas={[
                  {
                    concepto: "Monto pagado por el cliente",
                    detalle: pagadorasTexto ? `Pagadoras: ${pagadorasTexto}` : undefined,
                    importe: montoNum,
                  },
                ]}
                restas={dispersiones.map((d) => ({
                  concepto: d.etiqueta || "Dispersión",
                  detalle: `${d.beneficiario}${d.banco ? ` · ${d.banco}` : ""}${
                    d.cuenta || d.clabe ? ` · ${d.cuenta || d.clabe}` : ""
                  }`,
                  importe: d.importe,
                }))}
                nota={
                  <>
                    IVA (desglosado) ${fmt(iva)} · Neto ${fmt(neto)} · Comisión total ({pctNum.toFixed(2)}%) $
                    {fmt(comisionTotal)} · Devolución ${fmt(devolucion)}
                    {(clienteSel?.comision_trf_pct ?? 0) > 0 && (
                      <>
                        {' '}· Comisión TRF: {clienteSel?.comision_trf_pct}% = ${
                          fmt(r2((montoNum * (clienteSel?.comision_trf_pct ?? 0)) / 100))
                        } directo al resguardo de TRF
                      </>
                    )}
                    {brokersParticipan.length > 0
                      ? ` · Brokers: ${brokersParticipan
                          .map((b) => `${b.nombre} ${brokersSel[b.id]}% ($${fmt(r2((comisionTotal * Number(brokersSel[b.id])) / 100))})`)
                          .join(", ")}`
                      : ""}
                  </>
                }
              />
            </>
          )}

          {clienteId && (
            <p style={{ margin: "0.5rem 0", fontSize: "0.92rem" }}>
              Respaldo disponible: <strong>${fmt(disponibleResp)}</strong> (saldo ${fmt(saldoCliente)} + depósitos $
              {fmt(totalDepsResp)} + financiamiento ${fmt(finMontoNum)}) frente a un flujo de <strong>${fmt(flujoTotal)}</strong>
              {depsResp.length > 0 ? ` · ${depsResp.length} depósito(s) indicado(s)` : ""}
              {usarFin && finMontoNum > 0 ? " · con financiamiento" : ""}
            </p>
          )}

          <div className="barra" style={{ marginTop: "0.8rem" }}>
            <button type="button" className="btn" onClick={() => setPrevia(false)} disabled={guardando}>
              ‹ Volver a editar
            </button>
            <button type="button" className="btn" onClick={() => void enviarReal()} disabled={guardando}>
              {guardando ? "Enviando…" : "Confirmar y enviar"}
            </button>
          </div>
        </div>
      ) : (
      <form className="panel" onSubmit={enviarFormulario} style={{ maxWidth: 1080 }}>
        <h3 style={{ marginTop: 0 }}>Datos de la operación</h3>
        <div className="rejilla">
          <div>
            <label>Cliente (resguardo)</label>
            <select value={clienteId} onChange={(e) => setClienteId(e.target.value)}>
              <option value="">— Sin cliente —</option>
              {clientes.map((c) => (
                <option key={c.id} value={String(c.id)}>
                  {c.nombre}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>Fecha de operación</label>
            <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} required />
          </div>
          <div>
            <label>Moneda</label>
            <select
              value={monedaOtra ? "otra" : moneda}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "otra") {
                  setMonedaOtra(true);
                  setMonedaLista("");
                  setMonedaLibre("");
                } else {
                  setMonedaOtra(false);
                  setMoneda(v);
                }
              }}
            >
              <option value="MXN">MXN — Peso mexicano</option>
              <option value="USD">USD — Dólar americano</option>
              <option value="otra">Otra moneda… (especificar)</option>
            </select>
            {monedaOtra && (
              <div style={{ marginTop: "0.4rem", display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
                <select value={monedaLista} onChange={(e) => setMonedaLista(e.target.value)} style={{ marginBottom: 0, maxWidth: 260 }}>
                  <option value="">— Monedas más usadas —</option>
                  {MONEDAS_COMUNES.map((m) => (
                    <option key={m.codigo} value={m.codigo}>
                      {m.codigo} — {m.nombre}
                    </option>
                  ))}
                </select>
                <input
                  value={monedaLibre}
                  onChange={(e) => setMonedaLibre(e.target.value.toUpperCase())}
                  placeholder="u otro código (3 letras)"
                  maxLength={3}
                  style={{ marginBottom: 0, maxWidth: 170, textTransform: "uppercase" }}
                  title="Código de 3 letras de la moneda (ej. SEK, NZD)"
                />
                <small style={{ color: "var(--tenue)" }}>
                  Moneda de la operación: <strong>{monedaFinal || "—"}</strong>
                </small>
              </div>
            )}
          </div>
          <div>
            <label>Timbrar</label>
            <select value={timbrar ? "si" : "no"} onChange={(e) => setTimbrar(e.target.value === "si")}>
              <option value="no">NO</option>
              <option value="si">SÍ</option>
            </select>
          </div>
        </div>
        <label>Concepto</label>
        <input value={concepto} onChange={(e) => setConcepto(e.target.value)} required />
        <label>Observaciones o instrucciones especiales (opcional)</label>
        <input value={observaciones} onChange={(e) => setObservaciones(e.target.value)} />

        <h3>Pagadoras / tipo de operación (catálogo de Tesorería)</h3>
        <p style={{ color: "var(--tenue)", fontSize: "0.85rem", margin: "0 0 0.4rem" }}>
          Elige las cuentas del desplegable y agrégalas: la operación puede combinar asimilados,
          flujos, rendimientos, frentes, etc. Con <strong>CUALQUIER FLUJO</strong> Tesorería determina
          la cuenta concreta. Sólo aparecen las cuentas que Tesorería tiene visibles para operadores.
        </p>
        <SelectorDestinos catalogo={catalogoPagadoras} seleccion={destinosSel} setSeleccion={setDestinosSel} />

        <h3>Montos y comisión (cálculo automático)</h3>
        <div className="rejilla">
          <div>
            <label>Monto pagado</label>
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
            <label>Comisión % (se cobra la comisión)</label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={comisionPct}
              onChange={(e) => setComisionPct(e.target.value)}
              required
            />
            {clienteSel && comisionTrfCliente != null && comisionTrfCliente > 0 && (
              <small style={{ display: "block", color: "var(--tenue)", fontSize: "0.8rem" }}>
                Comisión preestablecida del cliente: {comisionTrfCliente}% para TRF (va directo al resguardo de la empresa)
              </small>
            )}
          </div>
        </div>
        {montoNum > 0 && (
          <p style={{ color: "var(--tenue)", fontSize: "0.87rem", margin: "0.4rem 0" }}>
            IVA (desglosado): <strong>${fmt(iva)}</strong> · Neto (subtotal): <strong>${fmt(neto)}</strong> ·
            Comisión total: <strong>${fmt(comisionTotal)}</strong>
          </p>
        )}

        <h3>Brokers participantes (opcional)</h3>
        {brokers.length === 0 ? (
          <p style={{ color: "var(--tenue)", fontSize: "0.85rem", margin: "0 0 0.4rem" }}>
            Sin brokers en el catálogo: la comisión completa la retiene la casa. El Administrador de Operaciones
            puede dar de alta brokers con su % de la comisión.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Participa</th>
                <th>Broker</th>
                <th style={{ textAlign: "right" }}>% de la comisión</th>
                <th style={{ textAlign: "right" }}>Monto estimado</th>
              </tr>
            </thead>
            <tbody>
              {brokers.map((b) => (
                <tr key={b.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={brokersSel[b.id] !== undefined}
                      onChange={(e) =>
                        setBrokersSel((prev) => {
                          const siguiente = { ...prev };
                          if (e.target.checked) siguiente[b.id] = String(b.porcentaje);
                          else delete siguiente[b.id];
                          return siguiente;
                        })
                      }
                    />
                  </td>
                  <td>{b.nombre}</td>
                  <td style={{ textAlign: "right" }}>
                    {brokersSel[b.id] !== undefined ? (
                      <input
                        type="number"
                        step="0.01"
                        min="0.01"
                        max="100"
                        value={brokersSel[b.id]}
                        onChange={(e) => setBrokersSel({ ...brokersSel, [b.id]: e.target.value })}
                        style={{ maxWidth: 100, marginBottom: 0 }}
                      />
                    ) : (
                      `${b.porcentaje.toFixed(2)}%`
                    )}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {brokersSel[b.id] !== undefined && Number(brokersSel[b.id]) > 0
                      ? `$${fmt(r2((comisionTotal * Number(brokersSel[b.id])) / 100))}`
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {sumaBrokers > 0 && (
          <p style={{ color: sumaBrokers > 100.0001 ? "var(--peligro, #c62828)" : "var(--tenue)", fontSize: "0.85rem" }}>
            Suma de brokers: {sumaBrokers.toFixed(2)}% {sumaBrokers <= 100.0001 ? `(casa retiene ${r2(100 - sumaBrokers).toFixed(2)}% de la comisión)` : "— EXCEDE 100%"}
          </p>
        )}

        <h3>Dispersiones (pagos a beneficiarios)</h3>
        <p style={{ color: "var(--tenue)", fontSize: "0.85rem", margin: "0 0 0.4rem" }}>
          Agrega líneas manualmente o importa un layout en Excel/CSV. La plantilla descargable trae
          el <strong>catálogo de pagadoras vigente</strong> (hoja CATALOGO PAGADORAS) y cada línea
          debe indicar la <strong>PAGADORA</strong> — cuenta del catálogo o <strong>CUALQUIER
          FLUJO</strong> para que Tesorería la determine. El Flujo Total es la suma de los importes
          y no puede exceder el monto pagado.
        </p>
        <div className="barra">
          <label className="btn" style={{ marginBottom: 0 }}>
            Importar layout (Excel/CSV)
            <input type="file" accept=".xlsx,.xls,.csv,.txt" style={{ display: "none" }} onChange={importarLayout} />
          </label>
          <button type="button" className="btn" onClick={() => void descargarPlantillaDispersiones(catalogoPagadoras)}>
            Descargar layout (con catálogo vigente)
          </button>
          {dispersiones.length > 0 && (
            <button type="button" className="btn peligro" onClick={() => setDispersiones([])}>
              Vaciar ({dispersiones.length})
            </button>
          )}
        </div>
        {erroresLayout.length > 0 && (
          <div className="error">
            {erroresLayout.slice(0, 5).map((e, i) => (
              <div key={i}>· {e}</div>
            ))}
          </div>
        )}
        {dispersiones.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Beneficiario</th>
                <th>Razón social</th>
                <th>Referencia</th>
                <th>Cuenta / CLABE</th>
                <th>Banco</th>
                <th>Pagadora</th>
                <th style={{ textAlign: "right" }}>Importe</th>
                <th>Etiqueta</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {dispersiones.map((d, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>{d.beneficiario}</td>
                  <td>{d.razon_social || "—"}</td>
                  <td>{d.referencia || "—"}</td>
                  <td>{d.cuenta || d.clabe || "—"}</td>
                  <td>{d.banco || "—"}</td>
                  <td>
                    {d.pagadora ? (
                      d.pagadora_cuenta_id === null ? (
                        <em style={{ color: "var(--tenue)" }}>{d.pagadora}</em>
                      ) : (
                        <EtiquetaPagadora
                          catalogo={catalogoPagadoras}
                          linea={d}
                          onChange={(pagadora, id) =>
                            setDispersiones((prev) =>
                              prev.map((l, j) => (j === i ? { ...l, pagadora, pagadora_cuenta_id: id } : l))
                            )
                          }
                        />
                      )
                    ) : (
                      "—"
                    )}
                  </td>
                  <td style={{ textAlign: "right" }}>${fmt(d.importe)}</td>
                  <td>{d.etiqueta || "—"}</td>
                  <td>
                    <button
                      type="button"
                      className="btn peligro"
                      onClick={() => setDispersiones((prev) => prev.filter((_, j) => j !== i))}
                    >
                      Quitar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p style={{ margin: "0.4rem 0", fontSize: "0.9rem" }}>
          Flujo Total (suma de dispersiones): <strong>${fmt(flujoTotal)}</strong> ·{" "}
          <span style={{ color: comprobacionOk ? "var(--exito, #2e7d32)" : "var(--peligro, #c62828)" }}>
            Comprobación: {comprobacionOk ? "VERDADERO" : "EN CONTRA"}
          </span>
        </p>
        {montoNum > 0 && (
          <>
            <h4 style={{ marginBottom: "0.3rem" }}>Balanza de la operación</h4>
            <BalanzaFlujo
              sumas={[
                {
                  concepto: "Monto pagado por el cliente",
                  detalle: pagadorasTexto ? `Pagadoras: ${pagadorasTexto}` : undefined,
                  importe: montoNum,
                },
              ]}
              restas={dispersiones.map((d) => ({
                concepto: d.etiqueta || "Dispersión",
                detalle: `${d.beneficiario}${d.banco ? ` · ${d.banco}` : ""}${
                  d.cuenta || d.clabe ? ` · ${d.cuenta || d.clabe}` : ""
                }`,
                importe: d.importe,
              }))}
              nota={
                <>
                  IVA (desglosado) ${fmt(iva)} · Neto ${fmt(neto)} · Comisión total ({pctNum.toFixed(2)}%) $
                  {fmt(comisionTotal)} · Devolución ${fmt(devolucion)}
                </>
              }
            />
          </>
        )}

        <h4 style={{ marginBottom: "0.3rem" }}>Agregar línea manual</h4>
        <div className="rejilla">
          {CAMPOS_FILA.slice(0, 4).map(([campo, etiqueta, ejemplo]) => (
            <div key={campo}>
              <label>{etiqueta}</label>
              <input
                value={filaNueva[campo] === undefined || Number.isNaN(filaNueva[campo] as unknown as number) ? "" : String(filaNueva[campo])}
                onChange={(e) => setFilaNueva({ ...filaNueva, [campo]: e.target.value })}
                placeholder={ejemplo}
              />
            </div>
          ))}
          {CAMPOS_FILA.slice(4, 9).map(([campo, etiqueta, ejemplo]) => (
            <div key={campo}>
              <label>{etiqueta}</label>
              <input
                value={String(filaNueva[campo] ?? "")}
                onChange={(e) => setFilaNueva({ ...filaNueva, [campo]: e.target.value })}
                placeholder={ejemplo}
              />
            </div>
          ))}
          <div>
            <label>Pagadora (catálogo de Tesorería)</label>
            <SelectPagadora
              catalogo={catalogoPagadoras}
              clave={clavePagadora(filaNueva)}
              onChange={(pagadora, id) => setFilaNueva({ ...filaNueva, pagadora, pagadora_cuenta_id: id })}
            />
          </div>
          <div>
            <label>Importe</label>
            <input
              type="number"
              step="0.01"
              min="0.01"
              value={Number.isFinite(filaNueva.importe) && filaNueva.importe !== 0 ? String(filaNueva.importe) : ""}
              onChange={(e) => setFilaNueva({ ...filaNueva, importe: Number(e.target.value) })}
            />
          </div>
        </div>
        <button type="button" className="btn" onClick={agregarFila}>
          + Agregar dispersión
        </button>

        {clientes.length === 0 && (
          <p style={{ color: "var(--tenue)", fontSize: "0.85rem", margin: "0.4rem 0" }}>
            Aún no tienes clientes asignados: la operación puede capturarse sin cliente (la diferencia a resguardo
            requiere cliente).
          </p>
        )}

        <h3 style={{ marginBottom: "0.2rem" }}>Respaldo de la operación (depósitos y/o financiamiento)</h3>
        <p style={{ color: "var(--tenue)", fontSize: "0.85rem", margin: "0 0 0.4rem" }}>
          Si el cliente no tiene recurso en resguardo, la operación debe incluir uno o varios depósitos que la
          respalden, o un financiamiento. Los depósitos quedan pendientes de validar por Tesorería; cualquier
          financiamiento requiere aprobación de Dirección, salvo que el cliente esté exento o esté dentro de su
          monto máximo ya aprobado.
        </p>
        {clienteId && (
          <p style={{ margin: "0.2rem 0", fontSize: "0.9rem" }}>
            Saldo de resguardo de <strong>{clienteSel?.nombre}</strong>:{" "}
            <strong style={{ color: saldoCliente > 0 ? "var(--exito, #2e7d32)" : "var(--ambar, #b26a00)" }}>
              ${fmt(saldoCliente)}
            </strong>
          </p>
        )}
        {clienteId && (
          <>
            {depsResp.length > 0 && (
              <table style={{ maxWidth: 860 }}>
                <thead>
                  <tr>
                    <th>Cuenta</th>
                    <th style={{ textAlign: "right" }}>Monto</th>
                    <th>Comprobante</th>
                    <th>Fecha</th>
                    <th>Adjuntos</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {depsResp.map((d, i) => (
                    <tr key={i}>
                      <td>{cuentasCat.find((c) => String(c.id) === d.cuenta_id)?.nombre ?? d.cuenta_id}</td>
                      <td style={{ textAlign: "right" }}>${fmt(Number(d.monto))}</td>
                      <td>{d.comprobante}</td>
                      <td>{d.fecha}</td>
                      <td>
                        {d.archivos.length > 0 ? (
                          <small>{d.archivos.length} archivo(s) por subir</small>
                        ) : (
                          <small style={{ color: "var(--ambar, #b26a00)" }}>sin comprobantes adjuntos</small>
                        )}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn peligro"
                          onClick={() => setDepsResp((prev) => prev.filter((_, j) => j !== i))}
                        >
                          Quitar
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="rejilla">
              <div>
                <label>Cuenta donde depositó el cliente</label>
                <select value={depNueva.cuenta_id} onChange={(e) => setDepNueva({ ...depNueva, cuenta_id: e.target.value })}>
                  <option value="">— Selecciona cuenta —</option>
                  {cuentasCat.map((c) => (
                    <option key={c.id} value={String(c.id)}>
                      {c.nombre}
                      {c.banco ? ` — ${c.banco}` : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label>Monto del depósito</label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={depNueva.monto}
                  onChange={(e) => setDepNueva({ ...depNueva, monto: e.target.value })}
                />
              </div>
              <div>
                <label>Comprobante (folio / referencia)</label>
                <input
                  value={depNueva.comprobante}
                  onChange={(e) => setDepNueva({ ...depNueva, comprobante: e.target.value })}
                  placeholder="SPEI-1234"
                />
              </div>
              <div>
                <label>Fecha del depósito</label>
                <input type="date" value={depNueva.fecha} onChange={(e) => setDepNueva({ ...depNueva, fecha: e.target.value })} />
              </div>
            </div>
            <label>Comprobantes del depósito (1 o varios archivos: ficha SPEI, PDF, imagen)</label>
            <input
              type="file"
              multiple
              accept="image/*,application/pdf"
              onChange={(e) => setDepNueva({ ...depNueva, archivos: Array.from(e.target.files ?? []) })}
            />
            <p style={{ color: "var(--tenue)", fontSize: "0.82rem", margin: "0.2rem 0 0.4rem" }}>
              Sin al menos un comprobante, Tesorería no podrá validar el depósito (el folio/referencia es obligatorio
              de todas formas; los archivos son el respaldo documental).
            </p>
            <button type="button" className="btn" onClick={agregarDepositoResp}>
              + Agregar depósito al respaldo
            </button>
          </>
        )}
        {clienteId && (
          <div style={{ marginTop: "0.6rem" }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
              <input type="checkbox" checked={usarFin} onChange={(e) => setUsarFin(e.target.checked)} />
              Incluir financiamiento en el respaldo
            </label>
            {usarFin && (
              <div className="rejilla" style={{ marginTop: "0.4rem" }}>
                <div>
                  <label>Monto del financiamiento</label>
                  <input type="number" step="0.01" min="0.01" value={finMonto} onChange={(e) => setFinMonto(e.target.value)} />
                </div>
                <div>
                  <label>Notas del financiamiento (opcional)</label>
                  <input value={finNotas} onChange={(e) => setFinNotas(e.target.value)} placeholder="línea de crédito, proveedor, etc." />
                </div>
              </div>
            )}
            {usarFin && finMontoNum > 0 && (
              <p style={{ fontSize: "0.87rem", margin: "0.3rem 0", color: finExento ? "var(--exito, #2e7d32)" : "var(--ambar, #b26a00)" }}>
                {clienteSel?.financiamiento_sin_aprobacion === 1
                  ? "Cliente exento por Dirección: el financiamiento entra aprobado sin trámite."
                  : finExento
                    ? `Dentro del monto máximo aprobado ($${fmt(clienteSel?.financiamiento_maximo ?? 0)}): entra aprobado sin trámite.`
                    : "Requerirá aprobación de Dirección antes de entrar al resguardo (la operación puede capturarse ya)."}
              </p>
            )}
          </div>
        )}
        {clienteId && flujoTotal > 0 && (
          <p style={{ margin: "0.5rem 0", fontSize: "0.95rem" }}>
            Respaldo disponible: <strong>${fmt(disponibleResp)}</strong> (saldo ${fmt(saldoCliente)} + depósitos $
            {fmt(totalDepsResp)} + financiamiento ${fmt(finMontoNum)}) frente a un flujo de <strong>${fmt(flujoTotal)}</strong>{" "}
            —{" "}
            <strong style={{ color: respaldoOk ? "var(--exito, #2e7d32)" : "var(--peligro, #c62828)" }}>
              {respaldoOk
                ? `respaldo OK (sobrante $${fmt(r2(disponibleResp - flujoTotal))})`
                : `FALTANTE $${fmt(faltanteRespaldo)}: no se podrá guardar`}
            </strong>
          </p>
        )}

        <button className="btn" disabled={guardando}>
          {guardando ? "Guardando…" : "Revisar y enviar (vista previa)"}
        </button>
      </form>
      )}
    </>
  );
}

/**
 * Panel del formato FLUJO en el detalle de la operación: datos de captura,
 * cálculos (IVA/neto/comisión/devolución/flujo total/diferencia), brokers,
 * dispersiones y edición por parte del Ejecutivo mientras no haya tandas.
 */
/**
 * Fase 14: captura de PAGOS ESPECIALES. El ejecutivo adjunta el FORMATO
 * (p.ej. SAT), captura el importe, la pagadora (cuenta del catálogo de
 * Tesorería) y una descripción breve; el efectivo sale de un RESGUARDO
 * (TRF o broker) que debe tener depósito suficiente. Sigue el mismo flujo que
 * cualquier operación: validación → aprobación → liberación → pago; al quedar
 * PAGADA, el resguardo de origen se descuenta automáticamente.
 */
function VistaCapturaEspecial({
  onCreada,
  onError,
  onVolver,
}: {
  onCreada: () => void;
  onError: (m: string) => void;
  onVolver: () => void;
}) {
  const [catalogo, setCatalogo] = useState<CuentaCatalogo[]>([]);
  const [resguardos, setResguardos] = useState<ResguardoBroker[]>([]);
  const [saldoTrf, setSaldoTrf] = useState(0);
  const [form, setForm] = useState({ descripcion: "", monto: "", pagadora: "", origen: "trf", broker_id: "", notas: "" });
  const [archivo, setArchivo] = useState<File | null>(null);
  const [previa, setPrevia] = useState(false);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    // Pagadoras visibles para operadores (Fase 13) y saldos de los resguardos.
    api
      .cuentasCatalogo()
      .then(({ cuentas }) => setCatalogo(cuentas.filter((c) => c.visible_operador !== 0)))
      .catch(() => setCatalogo([]));
    api
      .resguardosBrokers()
      .then(({ resguardos }) => setResguardos(resguardos))
      .catch(() => setResguardos([]));
    // Ajuste del negocio: el ejecutivo consulta sólo el SALDO del resguardo de
    // TRF (el ledger ya no le es visible); el descuento se aplica al autorizarse.
    api
      .trfResguardoSaldo()
      .then((r) => setSaldoTrf(r.saldos.find((s) => s.moneda === "MXN")?.saldo ?? 0))
      .catch(() => setSaldoTrf(0));
  }, []);

  const montoNum = Number(form.monto) || 0;
  const pagadoraSel = catalogo.find((c) => String(c.id) === form.pagadora) ?? null;
  const brokerSel =
    form.origen === "broker" ? (resguardos.find((r) => String(r.broker_id) === form.broker_id) ?? null) : null;
  const nombreOrigen = form.origen === "trf" ? "TRF (la empresa)" : (brokerSel?.nombre ?? "");
  const saldoOrigen = form.origen === "trf" ? saldoTrf : (brokerSel?.saldo ?? 0);
  const saldoOk = montoNum > 0 && montoNum <= saldoOrigen + 0.005;

  const validar = (): string[] => {
    const errores: string[] = [];
    if (!form.descripcion.trim()) errores.push("escribe la descripción breve del pago");
    if (!(montoNum > 0)) errores.push("el importe debe ser mayor a 0");
    if (!pagadoraSel) errores.push("elige la pagadora (cuenta de Tesorería que paga)");
    if (form.origen === "broker" && !brokerSel) errores.push("elige el broker de cuyo resguardo sale el efectivo");
    if (montoNum > 0 && !saldoOk)
      errores.push(`el resguardo de ${nombreOrigen} no tiene depósito suficiente (saldo $${fmt(saldoOrigen)})`);
    if (!archivo) errores.push("adjunta el formato del pago (p.ej. el formato del SAT)");
    return errores;
  };

  const enviarReal = async () => {
    const errores = validar();
    if (errores.length) {
      onError(`Pago especial incompleto: ${errores.join(" · ")}`);
      setPrevia(false);
      return;
    }
    setGuardando(true);
    try {
      const contenido = await new Promise<string>((resolver, rechazar) => {
        const lector = new FileReader();
        lector.onload = () => resolver(String(lector.result));
        lector.onerror = () => rechazar(new Error(`No se pudo leer ${archivo!.name}`));
        lector.readAsDataURL(archivo!);
      });
      await api.crear({
        tipo: "pago_especial",
        concepto: form.descripcion.trim(),
        monto: montoNum,
        moneda: "MXN",
        fecha_operacion: new Date().toISOString().slice(0, 10),
        ...(form.notas.trim() ? { observaciones: form.notas.trim() } : {}),
        pagadora_cuenta_id: Number(form.pagadora),
        origen: form.origen === "broker" ? { tipo: "broker", broker_id: Number(form.broker_id) } : { tipo: "trf" },
        formato: { nombre: archivo!.name, mime: archivo!.type || "application/octet-stream", contenido },
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
      <div className="barra" style={{ maxWidth: 860 }}>
        <button className="btn" style={{ marginBottom: 0 }} onClick={onVolver}>
          ‹ Operación completa (flujo)
        </button>
        <button className="btn activo" style={{ marginBottom: 0 }}>
          Pago especial
        </button>
      </div>
      <h2>Nuevo pago especial</h2>
      <p style={{ color: "var(--tenue)", fontSize: "0.88rem", maxWidth: 900 }}>
        Retiro respaldado por un resguardo: adjunta el FORMATO del pago (p. ej. el del SAT), captura el
        importe, la pagadora que dispersa y una descripción breve. El resguardo de origen —TRF o de un
        broker— debe tener depósito suficiente; al AUTORIZARSE la operación el importe queda apartado
        del resguardo para que todo cuadre.
      </p>
      {previa ? (
        <div className="panel" style={{ maxWidth: 860 }}>
          <h3 style={{ marginTop: 0 }}>Vista previa del pago especial</h3>
          <div className="rejilla" style={{ maxWidth: 800 }}>
            <div style={{ gridColumn: "1 / -1" }}>
              <label>Descripción</label>
              <div>{form.descripcion}</div>
            </div>
            <div>
              <label>Importe</label>
              <div style={{ fontWeight: 700 }}>${fmt(montoNum)} MXN</div>
            </div>
            <div>
              <label>Pagadora</label>
              <div>{pagadoraSel?.nombre ?? "—"}</div>
            </div>
            <div>
              <label>Efectivo del resguardo de</label>
              <div>
                {nombreOrigen} — saldo ${fmt(saldoOrigen)}
              </div>
            </div>
            <div>
              <label>Formato adjunto</label>
              <div>{archivo?.name ?? "—"}</div>
            </div>
            {form.notas.trim() ? (
              <div style={{ gridColumn: "1 / -1" }}>
                <label>Notas</label>
                <div>{form.notas}</div>
              </div>
            ) : null}
          </div>
          {!saldoOk && (
            <div className="error" style={{ marginTop: "0.6rem" }}>
              El resguardo de {nombreOrigen} ya no tiene depósito suficiente (saldo ${fmt(saldoOrigen)} frente a $
              {fmt(montoNum)} solicitados). Vuelve a editar y ajusta el importe u origen.
            </div>
          )}
          <div className="barra" style={{ marginTop: "0.8rem" }}>
            <button className="btn" onClick={() => setPrevia(false)}>
              ‹ Volver a editar
            </button>
            <button className="btn" disabled={guardando || !saldoOk} onClick={enviarReal}>
              {guardando ? "Guardando…" : "Confirmar y enviar"}
            </button>
          </div>
        </div>
      ) : (
        <form
          className="panel"
          style={{ maxWidth: 860 }}
          onSubmit={(e) => {
            e.preventDefault();
            const errores = validar();
            if (errores.length) {
              onError(`Pago especial incompleto: ${errores.join(" · ")}`);
              return;
            }
            setPrevia(true);
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
        >
          <div className="rejilla" style={{ maxWidth: 800 }}>
            <div style={{ gridColumn: "1 / -1" }}>
              <label>Descripción breve *</label>
              <input
                value={form.descripcion}
                onChange={(e) => setForm({ ...form, descripcion: e.target.value })}
                placeholder="p. ej. Pago de impuestos SAT — línea de captura 12345"
                required
              />
            </div>
            <div>
              <label>Importe (MXN) *</label>
              <input
                type="number"
                step="0.01"
                min="0.01"
                value={form.monto}
                onChange={(e) => setForm({ ...form, monto: e.target.value })}
                required
              />
            </div>
            <div>
              <label>Pagadora (cuenta que paga) *</label>
              <select value={form.pagadora} onChange={(e) => setForm({ ...form, pagadora: e.target.value })} required>
                <option value="">— Selecciona pagadora —</option>
                {catalogo.map((c) => (
                  <option key={c.id} value={String(c.id)}>
                    {c.nombre}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label>Efectivo del resguardo de *</label>
              <select
                value={form.origen === "trf" ? "trf" : `b${form.broker_id}`}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "trf") setForm({ ...form, origen: "trf", broker_id: "" });
                  else setForm({ ...form, origen: "broker", broker_id: v.slice(1) });
                }}
                required
              >
                <option value="trf">TRF (la empresa) — saldo ${fmt(saldoTrf)}</option>
                {resguardos
                  .filter((r) => r.activo === 1)
                  .map((r) => (
                    <option key={r.broker_id} value={`b${r.broker_id}`}>
                      {r.nombre} — saldo ${fmt(r.saldo)}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label>Formato del pago (PDF / imagen) *</label>
              <input
                type="file"
                accept=".pdf,image/*"
                onChange={(e) => setArchivo(e.target.files?.[0] ?? null)}
                required
              />
            </div>
            <div>
              <label>Notas (opcional)</label>
              <input value={form.notas} onChange={(e) => setForm({ ...form, notas: e.target.value })} />
            </div>
          </div>
          {montoNum > 0 && (
            <p
              style={{
                margin: "0.5rem 0 0",
                fontSize: "0.88rem",
                color: saldoOk ? "var(--exito, #2e7d32)" : "var(--peligro, #c62828)",
              }}
            >
              Resguardo de {nombreOrigen}: saldo ${fmt(saldoOrigen)} − ${fmt(montoNum)} = $
              {fmt(r2(saldoOrigen - montoNum))} {saldoOk ? "después del pago" : "— INSUFICIENTE"}
            </p>
          )}
          <button className="btn">Revisar y enviar (vista previa)</button>
        </form>
      )}
    </>
  );
}

/**
 * Fase 14: panel del PAGO ESPECIAL en el detalle de la operación: descripción,
 * importe, pagadora, resguardo de origen y el formato adjunto descargable.
 */
function PanelPagoEspecial({ detalle }: { detalle: DetalleOperacion }) {
  const pe = detalle.pago_especial;
  const op = detalle.operacion;
  const [descargando, setDescargando] = useState(false);
  if (!pe) return null;

  const descargarFormato = async () => {
    setDescargando(true);
    try {
      const f = await api.formatoPagoEspecial(op.id);
      // El contenido llega como data URL (data:<mime>;base64,…) o base64 puro.
      const href = f.contenido.startsWith("data:") ? f.contenido : `data:${f.mime};base64,${f.contenido}`;
      const enlace = document.createElement("a");
      enlace.href = href;
      enlace.download = f.nombre || `formato-pago-especial-${op.folio}`;
      document.body.appendChild(enlace);
      enlace.click();
      document.body.removeChild(enlace);
    } finally {
      setDescargando(false);
    }
  };

  return (
    <div className="panel" style={{ maxWidth: 780 }}>
      <h4 style={{ marginTop: 0, marginBottom: "0.3rem" }}>Pago especial</h4>
      <p style={{ fontSize: "0.9rem", margin: "0 0 0.4rem" }}>
        {pe.descripcion || op.concepto} · <strong>Importe:</strong> ${fmt(op.monto)} MXN ·{" "}
        <strong>Pagadora:</strong> {pe.pagadora || "—"} ·{" "}
        <strong>Efectivo del resguardo de:</strong>{" "}
        {pe.resguardo_origen === "trf" ? "TRF (la empresa)" : `broker ${pe.broker_origen}`}
        {pe.creado_por_nombre ? ` · Solicitó: ${pe.creado_por_nombre}` : ""}
      </p>
      <p style={{ fontSize: "0.85rem", color: "var(--tenue)", margin: "0 0 0.5rem" }}>
        Al quedar PAGADA, el importe sale del resguardo de origen (movimiento append-only) para que los
        resguardos cuadren.
      </p>
      <button className="btn" onClick={() => void descargarFormato()} disabled={descargando}>
        {descargando ? "Descargando…" : `Descargar formato (${pe.formato_nombre || "adjunto"})`}
      </button>
    </div>
  );
}

function PanelFlujo({
  detalle,
  rol,
  puedeEditar,
  editarDisp,
  setEditarDisp,
  dispEdit,
  setDispEdit,
  filaNueva,
  setFilaNueva,
  erroresLayout,
  setErroresLayout,
  onImportarDisp,
  onGuardarDisp,
  editarDatos,
  setEditarDatos,
  datosForm,
  setDatosForm,
  catalogo,
  destinosEdit,
  setDestinosEdit,
  onGuardarDatos,
}: {
  detalle: DetalleOperacion;
  rol: Rol;
  puedeEditar: boolean;
  editarDisp: boolean;
  setEditarDisp: (v: boolean) => void;
  dispEdit: LineaLayout[];
  setDispEdit: React.Dispatch<React.SetStateAction<LineaLayout[]>>;
  filaNueva: LineaLayout;
  setFilaNueva: React.Dispatch<React.SetStateAction<LineaLayout>>;
  erroresLayout: string[];
  setErroresLayout: React.Dispatch<React.SetStateAction<string[]>>;
  onImportarDisp: (lineas: LineaLayout[], errores: string[]) => void;
  onGuardarDisp: () => Promise<void>;
  editarDatos: boolean;
  setEditarDatos: (v: boolean) => void;
  datosForm: { timbrar: boolean; comision_pct: string; observaciones: string };
  setDatosForm: React.Dispatch<
    React.SetStateAction<{ timbrar: boolean; comision_pct: string; observaciones: string }>
  >;
  /** Tarea 12: catálogo de Tesorería (cuentas activas) y pagadoras en edición. */
  catalogo: CuentaCatalogo[];
  destinosEdit: Record<string, DestinoSel>;
  setDestinosEdit: React.Dispatch<React.SetStateAction<Record<string, DestinoSel>>>;
  onGuardarDatos: () => Promise<void>;
}) {
  const c = detalle.calculos;
  const op = detalle.operacion;
  const flujoTotalEdit = r2(dispEdit.reduce((s, d) => s + (Number.isFinite(d.importe) ? d.importe : 0), 0));
  const comprobacionEdit = r2(op.monto - flujoTotalEdit) >= -0.005;

  return (
    <>
      <h3 style={{ marginBottom: "0.3rem" }}>Formato completo (FLUJO)</h3>
      {detalle.destinos && detalle.destinos.length > 0 ? (
        <p style={{ color: "var(--tenue)", fontSize: "0.87rem", margin: "0 0 0.4rem" }}>
          <strong>Pagadoras:</strong>{" "}
          {detalle.destinos.map((d) => (
            <span key={d.id} style={{ marginRight: "0.7rem", whiteSpace: "nowrap" }}>
              {d.nombre}
              {d.manejo_manual === 1 && (
                <span className="etiqueta-tipo" style={{ fontSize: "0.72rem", marginLeft: "0.25rem" }}>
                  MANUAL
                </span>
              )}
              {d.cuenta_id !== null && d.cuenta_activa === 0 && (
                <span style={{ color: "var(--ambar, #b26a00)", fontSize: "0.75rem", marginLeft: "0.25rem" }}>
                  (fuera de operación)
                </span>
              )}
            </span>
          ))}
          · <strong>Timbrar:</strong> {op.timbrar === 1 ? "SÍ" : "NO"} · <strong>Comisión:</strong>{" "}
          {(op.comision_pct ?? 0).toFixed(2)}%
          {op.observaciones ? (
            <>
              {" "}
              · <strong>Observaciones:</strong> {op.observaciones}
            </>
          ) : null}
        </p>
      ) : (
        <p style={{ color: "var(--tenue)", fontSize: "0.87rem", margin: "0 0 0.4rem" }}>
          <strong>Pagador:</strong> {op.pagador || "—"} · <strong>Tipo:</strong> {op.tipo_operacion || "—"} ·{" "}
          <strong>Timbrar:</strong> {op.timbrar === 1 ? "SÍ" : "NO"} · <strong>Comisión:</strong>{" "}
          {(op.comision_pct ?? 0).toFixed(2)}%
          {op.observaciones ? (
            <>
              {" "}
              · <strong>Observaciones:</strong> {op.observaciones}
            </>
          ) : null}
        </p>
      )}
      <p style={{ fontSize: "0.9rem", margin: "0 0 0.4rem" }}>
        Monto pagado: <strong>${fmt(op.monto)}</strong> · Flujo Total: <strong>${fmt(c.flujo_total)}</strong> ·{" "}
        <span style={{ color: c.comprobacion === "VERDADERO" ? "var(--exito, #2e7d32)" : "var(--peligro, #c62828)" }}>
          Comprobación: {c.comprobacion}
        </span>
      </p>

      <h4 style={{ marginBottom: "0.3rem" }}>Balanza de la operación</h4>
      <BalanzaFlujo
        sumas={[
          {
            concepto: "Monto pagado por el cliente",
            detalle: op.pagador ? `Pagador: ${op.pagador}` : undefined,
            importe: op.monto,
          },
        ]}
        restas={detalle.dispersiones.map((d) => ({
          concepto: d.etiqueta || "Dispersión",
          detalle: `${d.beneficiario}${d.banco ? ` · ${d.banco}` : ""}${d.cuenta || d.clabe ? ` · ${d.cuenta || d.clabe}` : ""}`,
          importe: d.importe,
        }))}
        nota={
          <>
            IVA (desglosado) ${fmt(c.iva)} · Neto ${fmt(c.neto)} · Comisión total ({(op.comision_pct ?? 0).toFixed(2)}%) $
            {fmt(c.comision_total)} · Devolución ${fmt(c.devolucion)}
          </>
        }
      />

      {detalle.respaldo && (
        <div className="panel" style={{ maxWidth: 820, background: "var(--fondo-suave, #f7f7f7)", marginTop: "0.6rem" }}>
          <h4 style={{ marginTop: 0, marginBottom: "0.3rem" }}>Respaldo del cliente</h4>
          <p style={{ margin: "0 0 0.4rem", fontSize: "0.9rem" }}>
            Disponible: <strong>${fmt(detalle.respaldo.disponible)}</strong> (saldo de resguardo $
            {fmt(detalle.respaldo.saldo_resguardo)} + depósitos pendientes $ {fmt(detalle.respaldo.depositos_pendientes)} +
            financiamiento por aprobar ${fmt(detalle.respaldo.financiamiento_solicitado)}) para un flujo de{" "}
            <strong>${fmt(detalle.respaldo.requerido)}</strong>{" "}
            {detalle.respaldo.faltante > 0.005 ? (
              <strong style={{ color: "var(--peligro, #c62828)" }}>— FALTANTE ${fmt(detalle.respaldo.faltante)}</strong>
            ) : (
              <strong style={{ color: "var(--exito, #2e7d32)" }}>— respaldo OK</strong>
            )}
            . Sin respaldo real (depósitos validados / financiamiento aprobado) Tesorería no puede pagar (§14).
          </p>
          {detalle.depositos.length > 0 && (
            <table style={{ maxWidth: 860 }}>
              <thead>
                <tr>
                  <th>Depósito indicado</th>
                  <th style={{ textAlign: "right" }}>Monto</th>
                  <th>Fecha</th>
                  <th>Estado</th>
                  <th>Comprobantes</th>
                </tr>
              </thead>
              <tbody>
                {detalle.depositos.map((d) => (
                  <tr key={d.id}>
                    <td>
                      {d.comprobante}
                      {d.cuenta ? <small style={{ color: "var(--tenue)" }}> · {d.cuenta}</small> : null}
                    </td>
                    <td style={{ textAlign: "right" }}>${fmt(d.monto)}</td>
                    <td>{d.fecha_deposito}</td>
                    <td>
                      {d.validado_por !== null ? (
                        <span style={{ color: "var(--exito, #2e7d32)" }}>Validado por Tesorería</span>
                      ) : (
                        <span style={{ color: "var(--ambar, #b26a00)" }}>Pendiente de validar</span>
                      )}
                    </td>
                    <td>
                      <CeldaComprobantes
                        deposito={d}
                        puedeAdjuntar={
                          d.validado_por === null &&
                          (rol === "operacion" || rol === "admin_tesoreria" || rol === "admin")
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {detalle.financiamientos.length > 0 && (
            <table style={{ maxWidth: 760, marginTop: "0.4rem" }}>
              <thead>
                <tr>
                  <th>Financiamiento</th>
                  <th style={{ textAlign: "right" }}>Monto</th>
                  <th>Estado</th>
                  <th>Notas</th>
                </tr>
              </thead>
              <tbody>
                {detalle.financiamientos.map((f) => (
                  <tr key={f.id}>
                    <td>Solicitó: {f.solicitador ?? "—"}</td>
                    <td style={{ textAlign: "right" }}>${fmt(f.monto)}</td>
                    <td>
                      {
                        {
                          solicitado: <span style={{ color: "var(--ambar, #b26a00)" }}>Por aprobar (Dirección)</span>,
                          aprobado: <span style={{ color: "var(--exito, #2e7d32)" }}>Aprobado — en resguardo</span>,
                          rechazado: <span style={{ color: "var(--peligro, #c62828)" }}>Rechazado</span>,
                          cancelado: <span style={{ color: "var(--tenue)" }}>Cancelado</span>,
                        }[f.estado]
                      }
                      {f.exento_motivo === "sin_aprobacion_previa" ? (
                        <small style={{ display: "block", color: "var(--tenue)" }}>exento: sin aprobación previa</small>
                      ) : f.exento_motivo === "monto_maximo" ? (
                        <small style={{ display: "block", color: "var(--tenue)" }}>dentro del monto máximo aprobado</small>
                      ) : null}
                    </td>
                    <td>{f.notas || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {detalle.brokers.length > 0 && (
        <p style={{ color: "var(--tenue)", fontSize: "0.85rem", margin: "0 0 0.4rem" }}>
          <strong>Brokers:</strong>{" "}
          {detalle.brokers
            .map((b) => `${b.nombre} ${b.porcentaje.toFixed(2)}% ($${fmt(b.monto)})`)
            .join(" · ")}
        </p>
      )}

      {puedeEditar && (
        <div className="barra" style={{ marginBottom: "0.4rem" }}>
          <button className="btn" onClick={() => setEditarDisp(!editarDisp)}>
            {editarDisp ? "Cancelar edición de dispersiones" : "Editar dispersiones"}
          </button>
          <button className="btn" onClick={() => setEditarDatos(!editarDatos)}>
            {editarDatos ? "Cancelar edición de datos" : "Editar datos del flujo"}
          </button>
        </div>
      )}

      {editarDatos && puedeEditar && (
        <div className="panel" style={{ maxWidth: 780, background: "var(--fondo-suave, #f7f7f7)" }}>
          <h4 style={{ marginTop: 0, marginBottom: "0.3rem" }}>Pagadoras / tipo de operación (catálogo)</h4>
          <SelectorDestinos catalogo={catalogo} seleccion={destinosEdit} setSeleccion={setDestinosEdit} />
          <div className="rejilla" style={{ marginTop: "0.5rem" }}>
            <div>
              <label>Timbrar</label>
              <select
                value={datosForm.timbrar ? "si" : "no"}
                onChange={(e) => setDatosForm({ ...datosForm, timbrar: e.target.value === "si" })}
              >
                <option value="no">NO</option>
                <option value="si">SÍ</option>
              </select>
            </div>
            <div>
              <label>Comisión %</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={datosForm.comision_pct}
                onChange={(e) => setDatosForm({ ...datosForm, comision_pct: e.target.value })}
              />
            </div>
          </div>
          <label>Observaciones o instrucciones especiales</label>
          <input
            value={datosForm.observaciones}
            onChange={(e) => setDatosForm({ ...datosForm, observaciones: e.target.value })}
          />
          <div className="barra">
            <button className="btn exito" onClick={() => void onGuardarDatos()}>
              Guardar datos del flujo
            </button>
          </div>
        </div>
      )}

      {editarDisp && puedeEditar ? (
        <div>
          <div className="barra">
            <label className="btn" style={{ marginBottom: 0 }}>
              Importar layout (Excel/CSV)
              <input
                type="file"
                accept=".xlsx,.xls,.csv,.txt"
                style={{ display: "none" }}
                onChange={async (e) => {
                  const archivo = e.target.files?.[0];
                  e.target.value = "";
                  if (!archivo) return;
                  try {
                    const filas = await leerFilas(archivo);
                    // Tarea 12: la PAGADORA se valida contra el catálogo vigente.
                    const r = mapearDispersiones(filas, catalogo);
                    setErroresLayout(r.errores);
                    onImportarDisp(r.filas, r.errores);
                  } catch (err) {
                    setErroresLayout([(err as Error).message]);
                  }
                }}
              />
            </label>
            <button className="btn" onClick={() => void descargarPlantillaDispersiones(catalogo)}>
              Descargar layout (con catálogo vigente)
            </button>
          </div>
          {erroresLayout.length > 0 && (
            <div className="error">
              {erroresLayout.slice(0, 5).map((e, i) => (
                <div key={i}>· {e}</div>
              ))}
            </div>
          )}
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Beneficiario</th>
                <th>Razón social</th>
                <th>Referencia</th>
                <th>Cuenta / CLABE</th>
                <th>Banco</th>
                <th>Pagadora</th>
                <th style={{ textAlign: "right" }}>Importe</th>
                <th>Etiqueta</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {dispEdit.map((d, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>{d.beneficiario}</td>
                  <td>{d.razon_social || "—"}</td>
                  <td>{d.referencia || "—"}</td>
                  <td>{d.cuenta || d.clabe || "—"}</td>
                  <td>{d.banco || "—"}</td>
                  <td>
                    <SelectPagadora
                      catalogo={catalogo}
                      clave={clavePagadora(d)}
                      onChange={(pagadora, id) =>
                        setDispEdit((prev) =>
                          prev.map((fila, j) => (j === i ? { ...fila, pagadora, pagadora_cuenta_id: id } : fila))
                        )
                      }
                    />
                  </td>
                  <td style={{ textAlign: "right" }}>${fmt(d.importe)}</td>
                  <td>{d.etiqueta || "—"}</td>
                  <td>
                    <button
                      className="btn peligro"
                      onClick={() => setDispEdit((prev) => prev.filter((_, j) => j !== i))}
                    >
                      Quitar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ margin: "0.4rem 0", fontSize: "0.9rem" }}>
            Flujo Total nuevo: <strong>${fmt(flujoTotalEdit)}</strong> ·{" "}
            <span style={{ color: comprobacionEdit ? "var(--exito, #2e7d32)" : "var(--peligro, #c62828)" }}>
              Comprobación: {comprobacionEdit ? "VERDADERO" : "EN CONTRA"}
            </span>
          </p>
          <div className="barra">
            <button
              className="btn exito"
              disabled={dispEdit.length === 0 || !comprobacionEdit}
              onClick={() => void onGuardarDisp()}
            >
              Guardar dispersiones
            </button>
            <button className="btn" onClick={() => setEditarDisp(false)}>
              Cancelar
            </button>
          </div>
        </div>
      ) : (
        <>
          {detalle.dispersiones.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Beneficiario</th>
                  <th>Razón social</th>
                  <th>Referencia</th>
                  <th>Cuenta / CLABE</th>
                  <th>Banco</th>
                  <th>Pagadora</th>
                  <th style={{ textAlign: "right" }}>Importe</th>
                  <th>Etiqueta</th>
                </tr>
              </thead>
              <tbody>
                {detalle.dispersiones.map((d, i) => (
                  <tr key={d.id ?? i}>
                    <td>{i + 1}</td>
                    <td>{d.beneficiario}</td>
                    <td>{d.razon_social || "—"}</td>
                    <td>{d.referencia || "—"}</td>
                    <td>{d.cuenta || d.clabe || "—"}</td>
                    <td>{d.banco || "—"}</td>
                    <td>
                      {d.pagadora ? (
                        d.pagadora_cuenta_id === null ? (
                          <em style={{ color: "var(--tenue)" }}>{d.pagadora}</em>
                        ) : (
                          d.pagadora
                        )
                      ) : (
                        "—"
                      )}
                    </td>
                    <td style={{ textAlign: "right" }}>${fmt(d.importe)}</td>
                    <td>{d.etiqueta || "—"}</td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={7} style={{ textAlign: "right" }}>
                    <strong>Flujo Total</strong>
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <strong>${fmt(c.flujo_total)}</strong>
                  </td>
                  <td></td>
                </tr>
              </tbody>
            </table>
          )}
          {detalle.dispersiones.length === 0 && (
            <p style={{ color: "var(--tenue)", fontSize: "0.85rem" }}>
              Sin líneas de dispersión registradas.
            </p>
          )}
        </>
      )}
    </>
  );
}

function VistaDireccion() {
  const [reporte, setReporte] = useState<import("./tipos").ReporteDireccion | null>(null);
  const [error, setError] = useState("");
  const [mensaje, setMensaje] = useState("");
  const [fins, setFins] = useState<Financiamiento[]>([]);
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [politicaForm, setPoliticaForm] = useState<{ cliente_id: string; sin_aprobacion: boolean; monto_maximo: string }>({
    cliente_id: "",
    sin_aprobacion: false,
    monto_maximo: "",
  });
  const cargarFinanciamientos = useCallback(() => {
    api
      .financiamientos()
      .then(({ financiamientos }) => setFins(financiamientos))
      .catch((err: Error) => setError(err.message));
  }, []);
  useEffect(() => {
    api
      .reportesDireccion()
      .then(setReporte)
      .catch((err: Error) => setError(err.message));
    cargarFinanciamientos();
    api
      .clientes()
      .then(({ clientes }) => setClientes(clientes))
      .catch(() => undefined);
  }, [cargarFinanciamientos]);

  const resolverFin = async (id: number, accion: "aprobar" | "rechazar") => {
    try {
      if (accion === "aprobar") {
        const r = await api.aprobarFinanciamiento(id);
        setMensaje(
          `Financiamiento aprobado: el resguardo del cliente quedó en ${r.saldo.toLocaleString("es-MX", { minimumFractionDigits: 2 })}.`
        );
      } else {
        const motivo = window.prompt("Motivo del rechazo (opcional):") ?? "";
        await api.rechazarFinanciamiento(id, motivo);
        setMensaje("Financiamiento rechazado.");
      }
      setError("");
      cargarFinanciamientos();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const guardarPolitica = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!politicaForm.cliente_id) return;
    try {
      await api.actualizarPoliticaFinanciamiento(Number(politicaForm.cliente_id), {
        sin_aprobacion: politicaForm.sin_aprobacion,
        monto_maximo: politicaForm.monto_maximo.trim() === "" ? null : Number(politicaForm.monto_maximo),
      });
      setMensaje("Política de financiamiento actualizada.");
      setError("");
      const { clientes: lista } = await api.clientes();
      setClientes(lista);
    } catch (err) {
      setError((err as Error).message);
    }
  };

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
  const porResolver = fins.filter((f) => f.estado === "solicitado");

  return (
    <>
      <h2>Dirección — Reporte de control</h2>
      {error && <div className="error">{error}</div>}
      {mensaje && <div className="ok">{mensaje}</div>}
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

      <div className="panel" style={{ marginBottom: "1rem" }}>
        <h3 style={{ marginTop: 0 }}>Financiamientos por aprobar ({porResolver.length})</h3>
        <p style={{ color: "var(--tenue)", fontSize: "0.85rem", margin: "0 0 0.4rem" }}>
          Al aprobar, el monto ingresa al resguardo del cliente como un movimiento de tipo financiamiento (§14) y
          Tesorería puede pagar las tandas respaldadas. Los clientes exentos o dentro de su monto máximo no aparecen
          aquí (entran aprobados automáticamente).
        </p>
        <table>
          <thead>
            <tr>
              <th>Folio</th>
              <th>Cliente</th>
              <th>Concepto</th>
              <th style={{ textAlign: "right" }}>Financiamiento</th>
              <th style={{ textAlign: "right" }}>Operación</th>
              <th>Solicitó</th>
              <th>Notas</th>
              <th>Acción</th>
            </tr>
          </thead>
          <tbody>
            {porResolver.map((f) => (
              <tr key={f.id}>
                <td>{f.folio}</td>
                <td>{f.cliente}</td>
                <td>{f.concepto}</td>
                <td style={{ textAlign: "right" }}>{formato(f.monto)}</td>
                <td style={{ textAlign: "right" }}>{formato(f.monto_operacion ?? 0)}</td>
                <td>{f.solicitador}</td>
                <td>{f.notas || "—"}</td>
                <td>
                  <div className="barra" style={{ gap: "0.3rem" }}>
                    <button className="btn exito" onClick={() => resolverFin(f.id, "aprobar")}>
                      Aprobar
                    </button>
                    <button className="btn peligro" onClick={() => resolverFin(f.id, "rechazar")}>
                      Rechazar
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {porResolver.length === 0 && (
              <tr>
                <td colSpan={8} className="vacio">
                  Sin financiamientos pendientes de aprobación.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="panel" style={{ marginBottom: "1rem" }}>
        <h3 style={{ marginTop: 0 }}>Política de financiamiento por cliente</h3>
        <p style={{ color: "var(--tenue)", fontSize: "0.85rem", margin: "0 0 0.4rem" }}>
          Determina qué clientes NO requieren aprobación previa para un financiamiento y/o cuál es su monto máximo
          ya aprobado (los financiamientos dentro del máximo entran sin trámite).
        </p>
        <form onSubmit={guardarPolitica} className="rejilla" style={{ alignItems: "end", marginBottom: "0.6rem" }}>
          <div>
            <label>Cliente</label>
            <select
              value={politicaForm.cliente_id}
              onChange={(e) => {
                const c = clientes.find((x) => String(x.id) === e.target.value);
                setPoliticaForm({
                  cliente_id: e.target.value,
                  sin_aprobacion: c?.financiamiento_sin_aprobacion === 1,
                  monto_maximo: typeof c?.financiamiento_maximo === "number" ? String(c.financiamiento_maximo) : "",
                });
              }}
              required
            >
              <option value="">— Selecciona cliente —</option>
              {clientes.map((c) => (
                <option key={c.id} value={String(c.id)}>
                  {c.nombre}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", marginTop: "1.4rem" }}>
              <input
                type="checkbox"
                checked={politicaForm.sin_aprobacion}
                onChange={(e) => setPoliticaForm({ ...politicaForm, sin_aprobacion: e.target.checked })}
              />
              No requiere aprobación previa
            </label>
          </div>
          <div>
            <label>Monto máximo ya aprobado (vacío = sin límite aprobado)</label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={politicaForm.monto_maximo}
              onChange={(e) => setPoliticaForm({ ...politicaForm, monto_maximo: e.target.value })}
              disabled={politicaForm.sin_aprobacion}
            />
          </div>
          <div>
            <button className="btn" disabled={!politicaForm.cliente_id} style={{ marginTop: "1.4rem" }}>
              Guardar política
            </button>
          </div>
        </form>
        <table style={{ maxWidth: 720 }}>
          <thead>
            <tr>
              <th>Cliente</th>
              <th>Sin aprobación previa</th>
              <th style={{ textAlign: "right" }}>Monto máximo aprobado</th>
            </tr>
          </thead>
          <tbody>
            {clientes.map((c) => (
              <tr key={c.id}>
                <td>{c.nombre}</td>
                <td>{c.financiamiento_sin_aprobacion === 1 ? "SÍ" : "No"}</td>
                <td style={{ textAlign: "right" }}>
                  {typeof c.financiamiento_maximo === "number" ? formato(c.financiamiento_maximo) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
                      en_pago: "En pago (tandas)",
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
  // Tarea 12: el administrador puede ver también las cuentas fuera de
  // operación y reactivarlas.
  const [esAdmin, setEsAdmin] = useState(false);
  const [verTodas, setVerTodas] = useState(false);
  const [alta, setAlta] = useState({
    nombre: "",
    banco: "",
    numero_cuenta: "",
    saldo_inicial: "0",
    tipo: "flujo" as import("./tipos").TipoCuenta,
    clabe: "",
  });
  const [mov, setMov] = useState({
    cuenta: "",
    tipo: "deposito" as "deposito" | "retiro",
    monto: "",
    concepto: "",
    referencia: "",
  });
  const [errorAlt, setErrorAlt] = useState("");
  // Fase 15: bóveda de credenciales, catálogo maestro e importador.
  const [bovedaDe, setBovedaDe] = useState<import("./tipos").Cuenta | null>(null);
  const [catalogoDe, setCatalogoDe] = useState<import("./tipos").Cuenta | null>(null);
  const [verImportar, setVerImportar] = useState(false);
  const [clabeInfo, setClabeInfo] = useState("");

  useEffect(() => {
    api
      .cuentas(verTodas)
      .then(({ cuentas }) => setCuentas(cuentas))
      .catch((err: Error) => setError(err.message));
    api
      .me()
      .then(({ usuario }) => {
        setEsTesoreria(usuario.rol === "tesoreria" || usuario.rol === "admin_tesoreria");
        setEsAdmin(usuario.rol === "admin_tesoreria" || usuario.rol === "admin");
      })
      .catch(() => {
        setEsTesoreria(false);
        setEsAdmin(false);
      });
  }, [verTodas]);

  const refrescar = () =>
    api
      .cuentas(verTodas)
      .then(({ cuentas }) => setCuentas(cuentas))
      .catch((err: Error) => setError(err.message));

  /** Tarea 12: sacar de operación / reactivar una cuenta del catálogo. */
  const cambiarEstado = async (c: import("./tipos").Cuenta, activar: boolean) => {
    setError("");
    try {
      let motivo = "";
      if (!activar) {
        const entrada = window.prompt(
          `Motivo para sacar '${c.nombre}' de operación (bloqueo o no uso momentáneo):`
        );
        if (entrada === null) return;
        motivo = entrada;
      }
      await api.estadoCuenta(c.id, activar, motivo);
      setMensaje(
        activar
          ? `Cuenta '${c.nombre}' reactivada: vuelve a aparecer en el catálogo y en el layout.`
          : `Cuenta '${c.nombre}' sacada de operación: desaparece del catálogo y del layout de captura.`
      );
      await refrescar();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  /**
   * Fase 13: ocultar/mostrar la cuenta en el listado de PAGADORAS que ven los
   * operadores al capturar. No la saca de operación: sólo afecta el catálogo
   * que el ejecutivo ve al elegir pagadoras.
   */
  const cambiarVisibilidad = async (c: import("./tipos").Cuenta, visible: boolean) => {
    setError("");
    try {
      let motivo = "";
      if (!visible) {
        const entrada = window.prompt(
          `Motivo para ocultar '${c.nombre}' del listado de pagadoras de los operadores (opcional):`
        );
        if (entrada === null) return;
        motivo = entrada;
      }
      await api.visibilidadCuenta(c.id, visible, motivo);
      setMensaje(
        visible
          ? `Cuenta '${c.nombre}' visible de nuevo para los operadores en el listado de pagadoras.`
          : `Cuenta '${c.nombre}' ocultada: ya no aparece en el listado de pagadoras de los operadores (sigue activa para depósitos y pagos).`
      );
      await refrescar();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const formato = (n: number) => n.toLocaleString("es-MX", { minimumFractionDigits: 2 });

  if (!esTesoreria && !error) {
    return (
      <>
        <h2>Cuentas de Tesorería</h2>
        <BarraConcentrado onError={setError} onOk={setMensaje} />
        <CuentasSoloLectura
          cuentas={cuentas}
          esAdmin={esAdmin}
          onEstado={cambiarEstado}
          onVisibilidad={esAdmin ? cambiarVisibilidad : undefined}
          verTodas={verTodas}
          setVerTodas={setVerTodas}
        />
      </>
    );
  }

  const cerrarBoveda = () => {
    setBovedaDe(null);
    refrescar();
  };

  return (
    <>
      <h2>Cuentas de Tesorería</h2>
      {error && <div className="error">{error}</div>}
      {mensaje && <div className="exito-msg">{mensaje}</div>}
      <BarraConcentrado onError={setError} onOk={setMensaje} />
      {bovedaDe && (
        <PanelBoveda
          cuenta={bovedaDe}
          esAdmin={esAdmin}
          onError={setError}
          onOk={setMensaje}
          onCerrar={cerrarBoveda}
        />
      )}
      {catalogoDe && (
        <PanelCatalogoCuenta
          cuenta={catalogoDe}
          onError={setError}
          onOk={(m) => {
            setMensaje(m);
            setCatalogoDe(null);
            refrescar();
          }}
          onCerrar={() => setCatalogoDe(null)}
        />
      )}
      {verImportar && esAdmin && (
        <PanelImportarCuentas
          onError={setError}
          onOk={(m) => {
            setMensaje(m);
            refrescar();
          }}
          onCerrar={() => setVerImportar(false)}
        />
      )}
      {esAdmin && (
        <div className="barra">
          <button className="btn" onClick={() => setVerImportar((v) => !v)}>
            {verImportar ? "Cerrar importador" : "Importar cuentas (pegar desde Excel)"}
          </button>
        </div>
      )}
      <CuentasSoloLectura
        cuentas={cuentas}
        esAdmin={esAdmin}
        onEstado={cambiarEstado}
        onVisibilidad={esAdmin ? cambiarVisibilidad : undefined}
        verTodas={verTodas}
        setVerTodas={setVerTodas}
        onCredenciales={(c) => {
          setCatalogoDe(null);
          setBovedaDe(c);
        }}
        onCatalogo={
          esAdmin
            ? (c) => {
                setBovedaDe(null);
                setCatalogoDe(c);
              }
            : undefined
        }
      />

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
                tipo: alta.tipo,
                clabe: alta.clabe,
              });
              setMensaje(`Cuenta '${alta.nombre}' creada (tipo ${ETIQUETAS_TIPO_CUENTA[alta.tipo]}).`);
              setErrorAlt("");
              setAlta({ nombre: "", banco: "", numero_cuenta: "", saldo_inicial: "0", tipo: "flujo", clabe: "" });
              setClabeInfo("");
              await refrescar();
            } catch (err) {
              setErrorAlt((err as Error).message);
            }
          }}
        >
          <h3 style={{ marginTop: 0 }}>Nueva cuenta</h3>
          {errorAlt && <div className="error">{errorAlt}</div>}
          <p style={{ color: "var(--tenue)", fontSize: "0.82rem", margin: "0 0 0.4rem" }}>
            Sólo el Administrador crea cuentas de Tesorería. El tipo determina a qué bolsa pertenece el dinero:
            flujos, frentes, préstamos, anticipo a rendimientos, SOFOM o asimilados.
          </p>
          <label>Nombre</label>
          <input value={alta.nombre} onChange={(e) => setAlta({ ...alta, nombre: e.target.value })} required />
          <label>Tipo de cuenta</label>
          <select
            value={alta.tipo}
            onChange={(e) => setAlta({ ...alta, tipo: e.target.value as import("./tipos").TipoCuenta })}
          >
            {TIPOS_CUENTA.map((t) => (
              <option key={t} value={t}>
                {ETIQUETAS_TIPO_CUENTA[t]}
              </option>
            ))}
          </select>
          <label>Banco</label>
          <input value={alta.banco} onChange={(e) => setAlta({ ...alta, banco: e.target.value })} />
          <label>Número de cuenta</label>
          <input
            value={alta.numero_cuenta}
            onChange={(e) => setAlta({ ...alta, numero_cuenta: e.target.value })}
          />
          <label>CLABE (opcional — auto-llena banco y número)</label>
          <input
            value={alta.clabe}
            onChange={(e) => setAlta({ ...alta, clabe: e.target.value })}
            onBlur={async () => {
              if (!alta.clabe.trim()) {
                setClabeInfo("");
                return;
              }
              try {
                const v = await api.validarClabe(alta.clabe);
                setClabeInfo(
                  v.ok
                    ? `Banco: ${v.banco?.nombre} · Cuenta derivada: ${v.cuenta}`
                    : `CLABE inválida: ${v.errores.join("; ")}`
                );
              } catch {
                setClabeInfo("");
              }
            }}
          />
          {clabeInfo && (
            <p style={{ color: clabeInfo.startsWith("CLABE") ? "var(--peligro, #c62828)" : "var(--exito, #2e7d32)", fontSize: "0.82rem", margin: "0.2rem 0 0" }}>
              {clabeInfo}
            </p>
          )}
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
                referencia: mov.referencia,
              });
              setMensaje("Movimiento registrado en el concentrado.");
              setErrorAlt("");
              setMov({ ...mov, monto: "", concepto: "", referencia: "" });
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
          <label>Referencia (folio bancario, opcional)</label>
          <input value={mov.referencia} onChange={(e) => setMov({ ...mov, referencia: e.target.value })} />
          <button className="btn">Registrar movimiento</button>
        </form>
      </div>
      <p style={{ color: "var(--tenue)", fontSize: "0.82rem" }}>
        El saldo descontado por cada pago se aplica automáticamente si el pago se liga a una cuenta.
      </p>
    </>
  );
}

/**
 * Fase 15 — Bóveda de credenciales de una cuenta: usuarios/contraseñas de
 * portales, correos, ePlata, SOFIPO y tokens (multi-usuario nativo). Los
 * secretos se guardan cifrados; revelarlos requiere permiso y CADA acceso
 * queda auditado. Sólo el Administrador de Tesorería crea/edita.
 */
function PanelBoveda({
  cuenta,
  esAdmin,
  onError,
  onOk,
  onCerrar,
}: {
  cuenta: import("./tipos").Cuenta;
  esAdmin: boolean;
  onError: (m: string) => void;
  onOk: (m: string) => void;
  onCerrar: () => void;
}) {
  const [credenciales, setCredenciales] = useState<import("./tipos").CredencialBoveda[]>([]);
  const [verAccesos, setVerAccesos] = useState(false);
  const [accesos, setAccesos] = useState<import("./tipos").AccesoCredencial[]>([]);
  const [form, setForm] = useState({
    tipo: "portal",
    etiqueta: "",
    usuario: "",
    secreto: "",
    nip: "",
    clave_seguridad: "",
    token_numero: "",
    telefono: "",
    correo: "",
    vigencia: "",
    notas: "",
  });

  const cargar = useCallback(() => {
    api
      .credenciales(cuenta.id)
      .then(({ credenciales }) => setCredenciales(credenciales))
      .catch((err: Error) => onError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cuenta.id]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  const revelar = async (c: import("./tipos").CredencialBoveda, campo: "secreto" | "nip" | "clave_seguridad") => {
    try {
      const { valor } = await api.secretoCredencial(c.id, campo);
      const etiquetaCampo = campo === "secreto" ? "Contraseña" : campo === "nip" ? "NIP" : "Clave de seguridad";
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(valor);
        onOk(`${etiquetaCampo} de '${c.etiqueta || c.usuario || c.tipo}' copiada al portapapeles (acceso auditado).`);
      } else {
        window.prompt(`${etiquetaCampo} de '${c.etiqueta || c.usuario || c.tipo}' (acceso auditado):`, valor);
      }
    } catch (err) {
      onError((err as Error).message);
    }
  };

  const cambiarContrasena = async (c: import("./tipos").CredencialBoveda) => {
    const nueva = window.prompt(`Nueva contraseña para '${c.etiqueta || c.usuario || c.tipo}':`);
    if (nueva === null) return;
    try {
      await api.actualizarCredencial(c.id, { secreto: nueva });
      onOk("Contraseña actualizada y guardada cifrada.");
      cargar();
    } catch (err) {
      onError((err as Error).message);
    }
  };

  const alternarActivo = async (c: import("./tipos").CredencialBoveda) => {
    try {
      await api.actualizarCredencial(c.id, { activo: c.activo === 1 ? 0 : 1 });
      onOk(c.activo === 1 ? "Credencial desactivada." : "Credencial reactivada.");
      cargar();
    } catch (err) {
      onError((err as Error).message);
    }
  };

  const cargarAccesos = async () => {
    try {
      const { accesos } = await api.accesosBoveda(cuenta.id);
      setAccesos(accesos);
      setVerAccesos(true);
    } catch (err) {
      onError((err as Error).message);
    }
  };

  const crear = async () => {
    try {
      await api.crearCredencial(cuenta.id, { ...form, tipo: form.tipo });
      onOk("Credencial creada y guardada cifrada.");
      setForm({ ...form, etiqueta: "", usuario: "", secreto: "", nip: "", clave_seguridad: "", token_numero: "", telefono: "", correo: "", vigencia: "", notas: "" });
      cargar();
    } catch (err) {
      onError((err as Error).message);
    }
  };

  const TIPOS = [
    ["portal", "Portal bancario"],
    ["correo", "Correo"],
    ["eplata", "ePlata / STP"],
    ["sofipo", "SOFIPO"],
    ["token", "Token"],
    ["otro", "Otro"],
  ] as const;

  return (
    <div className="panel" style={{ marginBottom: "1rem", border: "2px solid var(--ambar, #b26a00)" }}>
      <h3 style={{ marginTop: 0 }}>Bóveda de credenciales — {cuenta.nombre}</h3>
      <p style={{ color: "var(--tenue)", fontSize: "0.85rem" }}>
        Contraseñas y NIP guardados CIFRADOS (AES-256-GCM). Cada vez que alguien consulta o copia un secreto queda
        registrado (quién, qué y cuándo). Multi-usuario: agrega todas las credenciales que tenga la cuenta.
        {!esAdmin && " Sólo el Administrador de Tesorería crea o edita credenciales."}
      </p>
      {credenciales.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Tipo</th>
              <th>Etiqueta</th>
              <th>Usuario</th>
              <th>Secretos</th>
              <th>Teléfono</th>
              <th>Correo</th>
              <th>Vigencia</th>
              <th>Notas</th>
              <th>Estado</th>
              {esAdmin && <th>Acciones</th>}
            </tr>
          </thead>
          <tbody>
            {credenciales.map((c) => (
              <tr key={c.id} style={c.activo === 0 ? { opacity: 0.55 } : undefined}>
                <td>{TIPOS.find((t) => t[0] === c.tipo)?.[1] ?? c.tipo}</td>
                <td>{c.etiqueta || "—"}</td>
                <td>{c.usuario || "—"}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  {c.tiene_secreto && (
                    <button
                      className="btn"
                      style={{ fontSize: "0.75rem", padding: "0.1rem 0.4rem" }}
                      onClick={() => void revelar(c, "secreto")}
                      title="Revela/copiar la contraseña (queda auditado)"
                    >
                      Contraseña
                    </button>
                  )}
                  {c.tiene_nip && (
                    <button
                      className="btn"
                      style={{ fontSize: "0.75rem", padding: "0.1rem 0.4rem", marginLeft: "0.2rem" }}
                      onClick={() => void revelar(c, "nip")}
                    >
                      NIP
                    </button>
                  )}
                  {c.tiene_clave_seguridad && (
                    <button
                      className="btn"
                      style={{ fontSize: "0.75rem", padding: "0.1rem 0.4rem", marginLeft: "0.2rem" }}
                      onClick={() => void revelar(c, "clave_seguridad")}
                    >
                      Clave seg.
                    </button>
                  )}
                  {c.token_numero && (
                    <small style={{ display: "block", color: "var(--tenue)" }}>Token #{c.token_numero}</small>
                  )}
                </td>
                <td>{c.telefono || "—"}</td>
                <td>{c.correo || "—"}</td>
                <td>{c.vigencia || "—"}</td>
                <td>{c.notas || "—"}</td>
                <td>{c.activo === 1 ? "Activa" : "Desactivada"}</td>
                {esAdmin && (
                  <td style={{ whiteSpace: "nowrap" }}>
                    {c.tiene_secreto && (
                      <button
                        className="btn"
                        style={{ fontSize: "0.75rem", padding: "0.1rem 0.4rem" }}
                        onClick={() => void cambiarContrasena(c)}
                      >
                        Cambiar contraseña
                      </button>
                    )}
                    <button
                      className={`btn ${c.activo === 1 ? "peligro" : "exito"}`}
                      style={{ fontSize: "0.75rem", padding: "0.1rem 0.4rem", marginLeft: "0.2rem" }}
                      onClick={() => void alternarActivo(c)}
                    >
                      {c.activo === 1 ? "Desactivar" : "Reactivar"}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {credenciales.length === 0 && <p style={{ color: "var(--tenue)" }}>Sin credenciales registradas aún.</p>}
      {esAdmin && (
        <div style={{ borderTop: "1px solid var(--borde, #ddd)", marginTop: "0.6rem", paddingTop: "0.6rem" }}>
          <strong style={{ fontSize: "0.9rem" }}>Nueva credencial</strong>
          <div className="rejilla" style={{ marginTop: "0.4rem" }}>
            <div>
              <label>Tipo</label>
              <select value={form.tipo} onChange={(e) => setForm({ ...form, tipo: e.target.value })}>
                {TIPOS.map(([v, t]) => (
                  <option key={v} value={v}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label>Etiqueta (ADMIN1, USUARIO1…)</label>
              <input value={form.etiqueta} onChange={(e) => setForm({ ...form, etiqueta: e.target.value })} />
            </div>
            <div>
              <label>Usuario</label>
              <input value={form.usuario} onChange={(e) => setForm({ ...form, usuario: e.target.value })} />
            </div>
            <div>
              <label>Contraseña</label>
              <input
                type="password"
                value={form.secreto}
                onChange={(e) => setForm({ ...form, secreto: e.target.value })}
                autoComplete="new-password"
              />
            </div>
            <div>
              <label>NIP</label>
              <input
                type="password"
                value={form.nip}
                onChange={(e) => setForm({ ...form, nip: e.target.value })}
                autoComplete="new-password"
              />
            </div>
            <div>
              <label>Clave de seguridad</label>
              <input
                type="password"
                value={form.clave_seguridad}
                onChange={(e) => setForm({ ...form, clave_seguridad: e.target.value })}
                autoComplete="new-password"
              />
            </div>
            <div>
              <label>N° de token</label>
              <input value={form.token_numero} onChange={(e) => setForm({ ...form, token_numero: e.target.value })} />
            </div>
            <div>
              <label>Teléfono</label>
              <input value={form.telefono} onChange={(e) => setForm({ ...form, telefono: e.target.value })} />
            </div>
            <div>
              <label>Correo</label>
              <input value={form.correo} onChange={(e) => setForm({ ...form, correo: e.target.value })} />
            </div>
            <div>
              <label>Vigencia / último cambio</label>
              <input value={form.vigencia} onChange={(e) => setForm({ ...form, vigencia: e.target.value })} />
            </div>
            <div>
              <label>Notas</label>
              <input value={form.notas} onChange={(e) => setForm({ ...form, notas: e.target.value })} />
            </div>
          </div>
          <button className="btn" style={{ marginTop: "0.4rem" }} onClick={() => void crear()}>
            Agregar credencial
          </button>
        </div>
      )}
      <div className="barra" style={{ marginTop: "0.6rem" }}>
        {esAdmin && (
          <button className="btn" onClick={() => void cargarAccesos()}>
            {verAccesos ? "Ocultar accesos" : "Ver accesos (auditoría)"}
          </button>
        )}
        <button className="btn" onClick={onCerrar}>
          Cerrar bóveda
        </button>
      </div>
      {verAccesos && (
        <table style={{ marginTop: "0.4rem" }}>
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Usuario</th>
              <th>Acción</th>
              <th>Campo</th>
              <th>Credencial</th>
            </tr>
          </thead>
          <tbody>
            {accesos.map((a) => (
              <tr key={a.id}>
                <td>{a.fecha}</td>
                <td>{a.usuario}</td>
                <td>{a.accion}</td>
                <td>{a.campo || "—"}</td>
                <td>
                  {a.tipo}
                  {a.etiqueta ? ` · ${a.etiqueta}` : ""}
                </td>
              </tr>
            ))}
            {accesos.length === 0 && (
              <tr>
                <td colSpan={5} className="vacio">
                  Sin accesos registrados.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * Fase 15 — catálogo maestro de la cuenta: CLABE (auto-llena banco y número de
 * cuenta con la regla por banco), moneda, origen (JS/MTY…), estatus, cliente,
 * formato de reporte bancario y fechas de alta/baja.
 */
function PanelCatalogoCuenta({
  cuenta,
  onError,
  onOk,
  onCerrar,
}: {
  cuenta: import("./tipos").Cuenta;
  onError: (m: string) => void;
  onOk: (m: string) => void;
  onCerrar: () => void;
}) {
  const [campos, setCampos] = useState({
    clabe: cuenta.clabe ?? "",
    moneda: cuenta.moneda ?? "MXN",
    origen: cuenta.origen ?? "",
    estatus: (cuenta.estatus || "ACTIVA").toUpperCase(),
    cliente: cuenta.cliente ?? "",
    formato_reporte: cuenta.formato_reporte ?? "",
    fecha_alta: cuenta.fecha_alta ?? "",
    fecha_baja: cuenta.fecha_baja ?? "",
  });
  const [clabeInfo, setClabeInfo] = useState("");

  const guardar = async () => {
    try {
      await api.catálogoCuenta(cuenta.id, { ...campos, fecha_alta: campos.fecha_alta || null, fecha_baja: campos.fecha_baja || null });
      onOk(`Catálogo de '${cuenta.nombre}' actualizado.`);
    } catch (err) {
      onError((err as Error).message);
    }
  };

  return (
    <div className="panel" style={{ marginBottom: "1rem" }}>
      <h3 style={{ marginTop: 0 }}>Catálogo maestro — {cuenta.nombre}</h3>
      <p style={{ color: "var(--tenue)", fontSize: "0.85rem" }}>
        Con una CLABE válida el sistema resuelve el banco (prefijo SPEI) y deriva el número de cuenta
        (Santander 11 dígitos desde la posición 7; el resto 10 desde la 8). Si el banco asentado no coincide con el
        prefijo, la captura se rechaza para proteger el catálogo.
      </p>
      <div className="rejilla">
        <div>
          <label>CLABE (18 dígitos)</label>
          <input
            value={campos.clabe}
            onChange={(e) => setCampos({ ...campos, clabe: e.target.value })}
            onBlur={async () => {
              if (!campos.clabe.trim()) {
                setClabeInfo("");
                return;
              }
              try {
                const v = await api.validarClabe(campos.clabe);
                setClabeInfo(v.ok ? `Banco: ${v.banco?.nombre} · Cuenta: ${v.cuenta}` : `Inválida: ${v.errores.join("; ")}`);
              } catch {
                setClabeInfo("");
              }
            }}
          />
          {clabeInfo && <p style={{ fontSize: "0.8rem", margin: "0.2rem 0 0", color: "var(--tenue)" }}>{clabeInfo}</p>}
        </div>
        <div>
          <label>Moneda</label>
          <input
            value={campos.moneda}
            maxLength={3}
            onChange={(e) => setCampos({ ...campos, moneda: e.target.value.toUpperCase() })}
          />
        </div>
        <div>
          <label>Origen (JS, JS MTY…)</label>
          <input value={campos.origen} onChange={(e) => setCampos({ ...campos, origen: e.target.value })} />
        </div>
        <div>
          <label>Estatus</label>
          <select value={campos.estatus} onChange={(e) => setCampos({ ...campos, estatus: e.target.value })}>
            <option value="ACTIVA">ACTIVA</option>
            <option value="CANCELADA">CANCELADA</option>
            <option value="SUSPENDIDA">SUSPENDIDA</option>
          </select>
        </div>
        <div>
          <label>Cliente / empresa</label>
          <input value={campos.cliente} onChange={(e) => setCampos({ ...campos, cliente: e.target.value })} />
        </div>
        <div>
          <label>Formato de reporte (A–E)</label>
          <input value={campos.formato_reporte} onChange={(e) => setCampos({ ...campos, formato_reporte: e.target.value })} />
        </div>
        <div>
          <label>Fecha de alta</label>
          <input
            type="date"
            value={campos.fecha_alta}
            onChange={(e) => setCampos({ ...campos, fecha_alta: e.target.value })}
          />
        </div>
        <div>
          <label>Fecha de baja</label>
          <input
            type="date"
            value={campos.fecha_baja}
            onChange={(e) => setCampos({ ...campos, fecha_baja: e.target.value })}
          />
        </div>
      </div>
      <div className="barra" style={{ marginTop: "0.5rem" }}>
        <button className="btn exito" onClick={() => void guardar()}>
          Guardar catálogo
        </button>
        <button className="btn" onClick={onCerrar}>
          Cerrar
        </button>
      </div>
    </div>
  );
}

/**
 * Fase 15 — importador del catálogo de cuentas: pega las filas del Excel
 * (TSV: nombre ▸ banco ▸ numero_cuenta ▸ clabe ▸ moneda ▸ origen ▸ estatus ▸
 * cliente). Dedupe por CLABE o banco+número: lo existente se ACTUALIZA, no se
 * duplica. Las credenciales se capturan a mano en la bóveda (nunca por lote).
 */
function PanelImportarCuentas({
  onError,
  onOk,
  onCerrar,
}: {
  onError: (m: string) => void;
  onOk: (m: string) => void;
  onCerrar: () => void;
}) {
  const [texto, setTexto] = useState("");
  const [resumen, setResumen] = useState<{
    creadas: string[];
    actualizadas: string[];
    errores: Array<{ linea: number; errores: string[] }>;
  } | null>(null);

  const importar = async () => {
    const lineas = texto.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lineas.length) {
      onError("Pega al menos una fila del Excel.");
      return;
    }
    try {
      const r = await api.importarCuentas(lineas);
      setResumen(r);
      onOk(`Importación: ${r.creadas.length} creada(s), ${r.actualizadas.length} actualizada(s), ${r.errores.length} con error.`);
    } catch (err) {
      onError((err as Error).message);
    }
  };

  return (
    <div className="panel" style={{ marginBottom: "1rem" }}>
      <h3 style={{ marginTop: 0 }}>Importar cuentas (pegar desde Excel)</h3>
      <p style={{ color: "var(--tenue)", fontSize: "0.85rem" }}>
        Pega las filas con 8 columnas separadas por tabulador:{" "}
        <strong>nombre ▸ banco ▸ numero_cuenta ▸ clabe ▸ moneda ▸ origen ▸ estatus ▸ cliente</strong>. Si la cuenta ya
        existe (misma CLABE o mismo banco+número) se actualiza con los datos que traigan valor; no se duplica. Las
        credenciales se capturan después a mano en la bóveda de cada cuenta.
      </p>
      <textarea
        rows={6}
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        placeholder={"ORION JS\tSTP\t1407\t646180401200001407\tMXN\tJS\tACTIVA\tORION"}
        style={{ width: "100%", fontFamily: "monospace", fontSize: "0.85rem" }}
      />
      <button className="btn" style={{ marginTop: "0.4rem" }} onClick={() => void importar()}>
        Importar
      </button>
      {resumen && (
        <div style={{ marginTop: "0.6rem" }}>
          <p style={{ fontWeight: 600, margin: "0.2rem 0" }}>
            Creadas: {resumen.creadas.length} · Actualizadas: {resumen.actualizadas.length} · Con error:{" "}
            {resumen.errores.length}
          </p>
          {resumen.errores.length > 0 && (
            <div className="error">
              {resumen.errores.map((e) => (
                <div key={e.linea}>
                  Línea {e.linea}: {e.errores.join("; ")}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <button className="btn" style={{ marginTop: "0.5rem" }} onClick={onCerrar}>
        Cerrar importador
      </button>
    </div>
  );
}

function CuentasSoloLectura({
  cuentas,
  esAdmin = false,
  onEstado,
  onVisibilidad,
  verTodas = false,
  setVerTodas,
  onCredenciales,
  onCatalogo,
}: {
  cuentas: import("./tipos").Cuenta[];
  /** Tarea 12: el administrador puede sacar de operación / reactivar. */
  esAdmin?: boolean;
  onEstado?: (c: import("./tipos").Cuenta, activar: boolean) => Promise<void> | void;
  /** Fase 13: Tesorería oculta/muestra la cuenta en el listado de pagadoras de operadores. */
  onVisibilidad?: (c: import("./tipos").Cuenta, visible: boolean) => Promise<void> | void;
  verTodas?: boolean;
  setVerTodas?: (v: boolean) => void;
  /** Fase 15: abrir la bóveda de credenciales de la cuenta (Tesorería/admin). */
  onCredenciales?: (c: import("./tipos").Cuenta) => void;
  /** Fase 15: editar el catálogo maestro de la cuenta (sólo administrador). */
  onCatalogo?: (c: import("./tipos").Cuenta) => void;
}) {
  const formato = (n: number) => n.toLocaleString("es-MX", { minimumFractionDigits: 2 });
  const [filtroTipo, setFiltroTipo] = useState<import("./tipos").TipoCuenta | "">("");
  // Fase 13: búsqueda por texto (nombre, banco o número) para listados largos.
  const [filtroTexto, setFiltroTexto] = useState("");
  const texto = filtroTexto.trim().toLowerCase();
  const visibles = cuentas.filter(
    (c) =>
      (!filtroTipo || c.tipo === filtroTipo) &&
      (!texto ||
        c.nombre.toLowerCase().includes(texto) ||
        (c.banco ?? "").toLowerCase().includes(texto) ||
        (c.numero_cuenta ?? "").toLowerCase().includes(texto))
  );
  return (
    <div className="panel" style={{ marginBottom: "1rem" }}>
      <div className="barra" style={{ alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ margin: 0 }}>Filtrar por tipo: </label>
        <select
          value={filtroTipo}
          onChange={(e) => setFiltroTipo(e.target.value as import("./tipos").TipoCuenta | "")}
          style={{ maxWidth: 260, marginBottom: 0 }}
        >
          <option value="">Todos los tipos</option>
          {TIPOS_CUENTA.map((t) => (
            <option key={t} value={t}>
              {ETIQUETAS_TIPO_CUENTA[t]}
            </option>
          ))}
        </select>
        <input
          placeholder="Buscar por nombre, banco o número…"
          value={filtroTexto}
          onChange={(e) => setFiltroTexto(e.target.value)}
          style={{ maxWidth: 280, marginBottom: 0 }}
        />
        {esAdmin && setVerTodas && (
          <label style={{ margin: 0, fontSize: "0.85rem" }}>
            <input
              type="checkbox"
              checked={verTodas}
              onChange={(e) => setVerTodas(e.target.checked)}
              style={{ marginRight: "0.3rem" }}
            />
            Mostrar cuentas fuera de operación
          </label>
        )}
      </div>
      <table>
        <thead>
          <tr>
            <th>Cuenta</th>
            <th>Tipo</th>
            <th>Banco</th>
            <th>Número</th>
            <th style={{ textAlign: "right" }}>Saldo inicial</th>
            <th style={{ textAlign: "right" }}>Pagado</th>
            <th style={{ textAlign: "right" }}>Saldo actual</th>
            <th>Tesorero asignado</th>
            <th>Estado</th>
            <th>Operadores</th>
            {esAdmin && (onEstado || onVisibilidad) && <th></th>}
            {onCredenciales && <th>Bóveda</th>}
          </tr>
        </thead>
        <tbody>
          {visibles.map((c) => (
            <tr key={c.id} style={c.activa === 0 ? { opacity: 0.55 } : undefined}>
              <td>{c.nombre}</td>
              <td>
                <span className="etiqueta-tipo" style={{ fontSize: "0.8rem" }}>
                  {ETIQUETAS_TIPO_CUENTA[c.tipo] ?? c.tipo}
                </span>
              </td>
              <td>{c.banco || "—"}</td>
              <td>{c.numero_cuenta || "—"}</td>
              <td style={{ textAlign: "right" }}>{formato(c.saldo_inicial)}</td>
              <td style={{ textAlign: "right" }}>{formato(c.total_pagado ?? 0)}</td>
              <td style={{ textAlign: "right", fontWeight: 700 }}>{formato(c.saldo_actual ?? 0)}</td>
              <td>{c.tesorero ?? "—"}</td>
              <td>
                {c.activa === 0 ? (
                  <span style={{ color: "var(--peligro, #c62828)", fontSize: "0.8rem" }}>FUERA DE OPERACIÓN</span>
                ) : (
                  <span style={{ color: "var(--exito, #2e7d32)", fontSize: "0.8rem" }}>En operación</span>
                )}
              </td>
              <td>
                {c.visible_operador === 0 ? (
                  <span
                    style={{ color: "var(--ambar, #b26a00)", fontSize: "0.8rem" }}
                    title="No aparece en el listado de pagadoras de los operadores"
                  >
                    OCULTA
                  </span>
                ) : (
                  <span
                    style={{ color: "var(--exito, #2e7d32)", fontSize: "0.8rem" }}
                    title="Aparece en el listado de pagadoras de los operadores"
                  >
                    Visible
                  </span>
                )}
              </td>
              {esAdmin && (onEstado || onVisibilidad) && (
                <td style={{ whiteSpace: "nowrap" }}>
                  {onEstado && (
                    <button
                      className={`btn ${c.activa === 0 ? "exito" : "peligro"}`}
                      style={{ fontSize: "0.78rem", padding: "0.15rem 0.5rem" }}
                      onClick={() => void onEstado(c, c.activa === 0)}
                    >
                      {c.activa === 0 ? "Reactivar" : "Sacar de operación"}
                    </button>
                  )}
                  {onVisibilidad && (
                    <button
                      className="btn"
                      style={{ fontSize: "0.78rem", padding: "0.15rem 0.5rem", marginLeft: "0.3rem" }}
                      title={
                        c.visible_operador === 0
                          ? "Volver a mostrarla en el listado de pagadoras de los operadores"
                          : "Ocultarla del listado de pagadoras de los operadores"
                      }
                      onClick={() => void onVisibilidad(c, c.visible_operador === 0)}
                    >
                      {c.visible_operador === 0 ? "Mostrar a operadores" : "Ocultar a operadores"}
                    </button>
                  )}
                </td>
              )}
              {onCredenciales && (
                <td style={{ whiteSpace: "nowrap" }}>
                  <button
                    className="btn"
                    style={{ fontSize: "0.78rem", padding: "0.15rem 0.5rem" }}
                    title="Bóveda de credenciales: usuarios, contraseñas (cifradas), tokens y accesos"
                    onClick={() => void onCredenciales(c)}
                  >
                    Credenciales
                  </button>
                  {onCatalogo && (
                    <button
                      className="btn"
                      style={{ fontSize: "0.78rem", padding: "0.15rem 0.5rem", marginLeft: "0.3rem" }}
                      title="Catálogo maestro: CLABE, moneda, origen, estatus, cliente, formato de reporte"
                      onClick={() => void onCatalogo(c)}
                    >
                      Catálogo
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
          {visibles.length === 0 && (
            <tr>
              <td colSpan={(esAdmin && (onEstado || onVisibilidad) ? 11 : 10) + (onCredenciales ? 1 : 0)} className="vacio">
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
  // Fase 13: filtro del listado (folio, comprobante, pagador, notas, moneda).
  const [filtro, setFiltro] = useState("");

  useEffect(() => {
    api
      .pagos()
      .then(({ pagos }) => setPagos(pagos))
      .catch((err: Error) => setError(err.message));
  }, []);

  const texto = filtro.trim().toLowerCase();
  const filtrados = pagos.filter(
    (p) =>
      !texto ||
      (p.folio ?? "").toLowerCase().includes(texto) ||
      (p.comprobante ?? "").toLowerCase().includes(texto) ||
      (p.pagador ?? "").toLowerCase().includes(texto) ||
      (p.notas ?? "").toLowerCase().includes(texto) ||
      (p.moneda ?? "").toLowerCase().includes(texto)
  );
  const total = filtrados.reduce((s, p) => s + p.monto, 0);

  return (
    <>
      <h2>Pagos ejecutados</h2>
      {error && <div className="error">{error}</div>}
      <div className="barra">
        <input
          placeholder="Filtrar por folio, comprobante, pagador, notas o moneda…"
          value={filtro}
          onChange={(e) => setFiltro(e.target.value)}
          style={{ maxWidth: 380, marginBottom: 0 }}
        />
      </div>
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
            {filtrados.map((p) => (
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
            {filtrados.length === 0 && (
              <tr>
                <td colSpan={7} className="vacio">
                  Sin pagos que coincidan con el filtro.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {filtrados.length > 0 && (
          <p style={{ textAlign: "right", fontWeight: 600, marginBottom: 0 }}>
            Total pagado ({filtrados.length} de {pagos.length}): {total.toLocaleString("es-MX", { minimumFractionDigits: 2 })}
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

      {/* Versión LIMPIA del concentrado bancario (sin marcas de trabajo de
          Tesorería) y cuadre de respaldos por operación, sólo lectura. */}
      <PanelConcentrado modo="lectura" onOk={() => undefined} onError={setError} />
      <PanelRespaldosOperaciones onError={setError} />
    </>
  );
}

// ---- Fase roles (01-ROLES.md §3 y §8) ----

/**
 * Fase 14: comisiones preestablecidas del cliente (las fija
 * admin_operaciones). La de BROKER se usa como comisión por defecto al
 * capturar operaciones del cliente; la de TRF va DIRECTO al resguardo de la
 * empresa al pagarse (los ejecutivos lo gestionan; puede quedar en 0).
 */
function ComisionesCliente({
  clienteId,
  cliente,
  onGuardado,
  onError,
}: {
  clienteId: number | null;
  cliente: Cliente | null;
  onGuardado: () => void;
  onError: (m: string) => void;
}) {
  const [brokerPct, setBrokerPct] = useState("");
  const [trfPct, setTrfPct] = useState("");
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    setBrokerPct(cliente?.comision_broker_pct != null ? String(cliente.comision_broker_pct) : "");
    setTrfPct(cliente?.comision_trf_pct != null ? String(cliente.comision_trf_pct) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clienteId]);

  if (!clienteId || !cliente) return null;

  const guardar = async () => {
    setGuardando(true);
    try {
      await api.comisionesCliente(clienteId, {
        comision_broker_pct: brokerPct.trim() === "" ? null : Number(brokerPct),
        comision_trf_pct: trfPct.trim() === "" ? null : Number(trfPct),
      });
      onGuardado();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div className="panel" style={{ maxWidth: 640 }}>
      <div className="rejilla">
        <div>
          <label>Comisión de broker (%)</label>
          <input
            type="number"
            step="0.01"
            min="0"
            max="100"
            value={brokerPct}
            onChange={(e) => setBrokerPct(e.target.value)}
            placeholder="vacío = sin preestablecer"
          />
        </div>
        <div>
          <label>Comisión TRF (%) — directo al resguardo</label>
          <input
            type="number"
            step="0.01"
            min="0"
            max="100"
            value={trfPct}
            onChange={(e) => setTrfPct(e.target.value)}
            placeholder="vacío = sin preestablecer"
          />
        </div>
      </div>
      <p style={{ color: "var(--tenue)", fontSize: "0.83rem", margin: "0.4rem 0" }}>
        La de broker rellena sola la comisión al capturar operaciones de este cliente. La de TRF ingresa
        directo al resguardo de la empresa al pagarse (en MXN; en otras monedas la registra el ejecutivo
        con el tipo de cambio del banco). Deja el campo vacío para quitar la preestablecida.
      </p>
      <button className="btn" onClick={() => void guardar()} disabled={guardando}>
        {guardando ? "Guardando…" : "Guardar comisiones"}
      </button>
    </div>
  );
}

function VistaClientes({ usuario }: { usuario: Usuario }) {
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [ejecutivos, setEjecutivos] = useState<UsuarioAdmin[]>([]);
  const [asignaciones, setAsignaciones] = useState<Asignacion[]>([]);
  const [seleccion, setSeleccion] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [mensaje, setMensaje] = useState("");
  const [alta, setAlta] = useState({ nombre: "", rfc: "", contacto: "", notas: "" });
  const [asig, setAsig] = useState({ ejecutivo: "", motivo: "" });
  const [coberturas, setCoberturas] = useState<CoberturaCliente[]>([]);
  const [resguardoCli, setResguardoCli] = useState<ResguardoDetalle | null>(null);
  const [cobForm, setCobForm] = useState({ habitual: "", temporal: "", inicio: "", fin: "", motivo: "" });
  const esAdminOps = usuario.rol === "admin_operaciones";

  const cargar = useCallback(() => {
    api
      .clientes()
      .then(({ clientes }) => setClientes(clientes))
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    cargar();
    if (esAdminOps) {
      api
        .ejecutivos()
        .then(({ ejecutivos }) => setEjecutivos(ejecutivos))
        .catch(() => setEjecutivos([]));
    }
  }, [cargar, esAdminOps]);

  const abrirResguardo = (id: number) => {
    setSeleccion(id);
    setMensaje("");
    api
      .resguardo(id)
      .then(setResguardoCli)
      .catch((err: Error) => setError(err.message));
  };

  const abrirAsignaciones = (id: number) => {
    setSeleccion(id);
    setMensaje("");
    setAsig({ ejecutivo: "", motivo: "" });
    setCobForm({ habitual: "", temporal: "", inicio: "", fin: "", motivo: "" });
    api
      .asignacionesCliente(id)
      .then(({ asignaciones }) => setAsignaciones(asignaciones))
      .catch(() => setAsignaciones([]));
    // Coberturas temporales del cliente (§3.1 + 00-VISION §6).
    api
      .coberturasCliente(id)
      .then(({ coberturas }) => setCoberturas(coberturas))
      .catch(() => setCoberturas([]));
    // Resguardo del cliente (§14): saldo y movimientos.
    api
      .resguardo(id)
      .then(setResguardoCli)
      .catch(() => setResguardoCli(null));
  };

  return (
    <>
      <h2>{usuario.rol === "operacion" ? "Mis clientes" : "Clientes"}</h2>
      {error && <div className="error">{error}</div>}
      {mensaje && <div className="exito-msg">{mensaje}</div>}

      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Nombre</th>
              <th>RFC</th>
              <th>Contacto</th>
              <th>Ejecutivo asignado</th>
              <th>Comisiones (Broker / TRF)</th>
              <th>Estado</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {clientes.map((c) => (
              <tr key={c.id} className={seleccion === c.id ? "seleccionada" : ""}>
                <td>{c.nombre}</td>
                <td>{c.rfc || "—"}</td>
                <td>{c.contacto || "—"}</td>
                <td>{c.ejecutivo ?? "— sin asignar —"}</td>
                <td>
                  {c.comision_broker_pct != null || c.comision_trf_pct != null
                    ? `${c.comision_broker_pct != null ? `${c.comision_broker_pct}%` : "—"} / ${
                        c.comision_trf_pct != null ? `${c.comision_trf_pct}%` : "—"
                      }`
                    : "—"}
                </td>
                <td>{c.activo === 1 ? "Activo" : "Inactivo"}</td>
                {esAdminOps && (
                  <td>
                    <button className="btn" onClick={() => abrirAsignaciones(c.id)}>
                      Asignar / cobertura / resguardo
                    </button>
                  </td>
                )}
                {!esAdminOps && (
                  <td>
                    <button className="btn" onClick={() => abrirResguardo(c.id)}>
                      Ver resguardo
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {clientes.length === 0 && (
              <tr>
                <td colSpan={7} className="vacio">
                  {esAdminOps
                    ? "Sin clientes: crea el primero con el formulario de abajo."
                    : "Sin clientes asignados todavía."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {esAdminOps && seleccion && (
        <>
          <h3>Asignación del cliente seleccionado</h3>
          <form
            className="panel"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api.asignarCliente(seleccion, Number(asig.ejecutivo), asig.motivo);
                setMensaje("Asignación registrada (la asignación anterior se conserva en el historial).");
                abrirAsignaciones(seleccion);
                cargar();
              } catch (err) {
                setError((err as Error).message);
              }
            }}
            style={{ maxWidth: 640 }}
          >
            <label>Ejecutivo de Operaciones</label>
            <select value={asig.ejecutivo} onChange={(e) => setAsig({ ...asig, ejecutivo: e.target.value })} required>
              <option value="">— Selecciona ejecutivo —</option>
              {ejecutivos.map((u) => (
                <option key={u.id} value={String(u.id)}>
                  {u.nombre} ({u.username}){u.activo !== 1 ? " [desactivado]" : ""}
                </option>
              ))}
            </select>
            <label>Motivo (opcional)</label>
            <input value={asig.motivo} onChange={(e) => setAsig({ ...asig, motivo: e.target.value })} />
            <button className="btn">Asignar / reasignar</button>
          </form>

          <h3>Comisiones preestablecidas del cliente</h3>
          <ComisionesCliente
            clienteId={seleccion}
            cliente={clientes.find((c) => c.id === seleccion) ?? null}
            onGuardado={() => {
              setMensaje("Comisiones preestablecidas actualizadas.");
              cargar();
            }}
            onError={setError}
          />

          {asignaciones.length > 0 && (
            <div className="panel" style={{ marginBottom: "1rem" }}>
              <h3 style={{ marginTop: 0 }}>Historial de asignaciones (append-only)</h3>
              <table>
                <thead>
                  <tr>
                    <th>Ejecutivo</th>
                    <th>Asignado por</th>
                    <th>Motivo</th>
                    <th>Desde</th>
                    <th>Hasta</th>
                    <th>Vigencia</th>
                  </tr>
                </thead>
                <tbody>
                  {asignaciones.map((a) => (
                    <tr key={a.id}>
                      <td>{a.ejecutivo}</td>
                      <td>{a.asignador}</td>
                      <td>{a.motivo || "—"}</td>
                      <td>{a.creado_en}</td>
                      <td>{a.cerrado_en ?? "—"}</td>
                      <td>{a.activo === 1 ? "Vigente" : "Cerrada"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <form
            className="panel"
            style={{ maxWidth: 720 }}
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api.crearCoberturaCliente(seleccion, {
                  ejecutivo_habitual_id: Number(cobForm.habitual),
                  ejecutivo_temporal_id: Number(cobForm.temporal),
                  fecha_inicio: cobForm.inicio,
                  fecha_fin: cobForm.fin ? cobForm.fin : null,
                  motivo: cobForm.motivo,
                });
                setMensaje(
                  "Cobertura registrada: el ejecutivo temporal ve al cliente y su historial sin alterar la asignación principal."
                );
                setError("");
                setCobForm({ habitual: "", temporal: "", inicio: "", fin: "", motivo: "" });
                abrirAsignaciones(seleccion);
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          >
            <h3 style={{ marginTop: 0 }}>Cobertura temporal del cliente (vacaciones / permisos)</h3>
            <div className="rejilla">
              <div>
                <label>Ejecutivo habitual</label>
                <select value={cobForm.habitual} onChange={(e) => setCobForm({ ...cobForm, habitual: e.target.value })} required>
                  <option value="">— Selecciona ejecutivo —</option>
                  {ejecutivos.map((u) => (
                    <option key={u.id} value={String(u.id)}>
                      {u.nombre} ({u.username}){u.activo !== 1 ? " [desactivado]" : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label>Ejecutivo temporal (cubre)</label>
                <select value={cobForm.temporal} onChange={(e) => setCobForm({ ...cobForm, temporal: e.target.value })} required>
                  <option value="">— Selecciona ejecutivo —</option>
                  {ejecutivos.map((u) => (
                    <option key={u.id} value={String(u.id)}>
                      {u.nombre} ({u.username}){u.activo !== 1 ? " [desactivado]" : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label>Desde</label>
                <input type="date" value={cobForm.inicio} onChange={(e) => setCobForm({ ...cobForm, inicio: e.target.value })} required />
              </div>
              <div>
                <label>Hasta (opcional)</label>
                <input type="date" value={cobForm.fin} onChange={(e) => setCobForm({ ...cobForm, fin: e.target.value })} />
              </div>
            </div>
            <label>Motivo (vacaciones, permiso especial, incapacidad…)</label>
            <input value={cobForm.motivo} onChange={(e) => setCobForm({ ...cobForm, motivo: e.target.value })} />
            <button className="btn">Crear cobertura</button>
          </form>

          {coberturas.length > 0 && (
            <div className="panel" style={{ marginBottom: "1rem" }}>
              <h3 style={{ marginTop: 0 }}>Coberturas del cliente</h3>
              <table>
                <thead>
                  <tr>
                    <th>Habitual</th>
                    <th>Temporal</th>
                    <th>Desde</th>
                    <th>Hasta</th>
                    <th>Motivo</th>
                    <th>Vigencia</th>
                    <th>Acción</th>
                  </tr>
                </thead>
                <tbody>
                  {coberturas.map((cb) => (
                    <tr key={cb.id}>
                      <td>{cb.habitual}</td>
                      <td>{cb.temporal}</td>
                      <td>{cb.fecha_inicio}</td>
                      <td>{cb.fecha_fin ?? "—"}</td>
                      <td>{cb.motivo || "—"}</td>
                      <td>{cb.activo === 1 ? "Vigente" : "Cerrada"}</td>
                      <td>
                        {cb.activo === 1 && (
                          <button
                            className="btn peligro"
                            onClick={async () => {
                              try {
                                await api.cerrarCoberturaCliente(seleccion, cb.id);
                                setMensaje("Cobertura cerrada: el ejecutivo temporal pierde el acceso al cliente.");
                                setError("");
                                abrirAsignaciones(seleccion);
                              } catch (err) {
                                setError((err as Error).message);
                              }
                            }}
                          >
                            Cerrar
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {seleccion && resguardoCli && (
        <div className="panel" style={{ marginBottom: "1rem" }}>
          <h3 style={{ marginTop: 0 }}>
            Resguardo de {resguardoCli.cliente.nombre} — saldo:{" "}
            <span style={{ color: resguardoCli.saldo > 0 ? "var(--exito, #2e7d32)" : "var(--tenue)" }}>
              ${resguardoCli.saldo.toLocaleString("es-MX", { minimumFractionDigits: 2 })}
            </span>
          </h3>
          <p style={{ color: "var(--tenue)", fontSize: "0.85rem", margin: "0 0 0.6rem" }}>
            El saldo no se guarda: es la suma de sus movimientos (§14). Los depósitos los valida Tesorería; los cargos
            se generan al pagar las operaciones.
          </p>
          {resguardoCli.movimientos.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Tipo</th>
                  <th style={{ textAlign: "right" }}>Importe</th>
                  <th>Operación</th>
                  <th>Cuenta</th>
                  <th>Comprobante</th>
                  <th>Observaciones</th>
                  <th>Registró</th>
                </tr>
              </thead>
              <tbody>
                {resguardoCli.movimientos.map((m) => (
                  <tr key={m.id}>
                    <td>{m.creado_en}</td>
                    <td>{m.tipo === "deposito" ? "Depósito (+)" : "Cargo (−)"}</td>
                    <td style={{ textAlign: "right" }}>
                      {m.importe.toLocaleString("es-MX", { minimumFractionDigits: 2 })}
                    </td>
                    <td>{m.folio ?? "—"}</td>
                    <td>{m.cuenta ?? "—"}</td>
                    <td>{m.comprobante || "—"}</td>
                    <td>{m.observaciones || "—"}</td>
                    <td>{m.registrado_por}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p style={{ color: "var(--tenue)", margin: 0 }}>Sin movimientos todavía.</p>
          )}
        </div>
      )}

      {esAdminOps && (
        <form
          className="panel"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api.crearCliente(alta);
              setMensaje(`Cliente '${alta.nombre}' creado.`);
              setAlta({ nombre: "", rfc: "", contacto: "", notas: "" });
              cargar();
            } catch (err) {
              setError((err as Error).message);
            }
          }}
          style={{ maxWidth: 720 }}
        >
          <h3 style={{ marginTop: 0 }}>Nuevo cliente</h3>
          <div className="rejilla">
            <div>
              <label>Nombre</label>
              <input value={alta.nombre} onChange={(e) => setAlta({ ...alta, nombre: e.target.value })} required />
            </div>
            <div>
              <label>RFC</label>
              <input value={alta.rfc} onChange={(e) => setAlta({ ...alta, rfc: e.target.value })} />
            </div>
            <div>
              <label>Contacto</label>
              <input value={alta.contacto} onChange={(e) => setAlta({ ...alta, contacto: e.target.value })} />
            </div>
          </div>
          <label>Notas</label>
          <input value={alta.notas} onChange={(e) => setAlta({ ...alta, notas: e.target.value })} />
          <button className="btn">Crear cliente</button>
        </form>
      )}
    </>
  );
}

// Usuarios base sembrados por el sistema: no se pueden eliminar (se recrean
// al arrancar con su contraseña inicial); la vía correcta es desactivarlos.
const USUARIOS_BASE_UI = ["admin", "admin_ops", "admin_validacion", "admin_tesoreria", "val_tesoreria"];

function VistaUsuarios({ actual }: { actual: Usuario }) {
  const [usuarios, setUsuarios] = useState<UsuarioAdmin[]>([]);
  const [error, setError] = useState("");
  const [mensaje, setMensaje] = useState("");
  const [alta, setAlta] = useState({ username: "", nombre: "", rol: "operacion" as Rol, password: "" });

  const cargar = () =>
    api
      .usuarios()
      .then(({ usuarios }) => setUsuarios(usuarios))
      .catch((err: Error) => setError(err.message));

  useEffect(() => {
    cargar();
  }, []);

  return (
    <>
      <h2>Usuarios del sistema</h2>
      {error && <div className="error">{error}</div>}
      {mensaje && <div className="exito-msg">{mensaje}</div>}

      <div className="panel" style={{ marginBottom: "1rem" }}>
        <table>
          <thead>
            <tr>
              <th>Usuario</th>
              <th>Nombre</th>
              <th>Rol</th>
              <th>Estado</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {usuarios.map((u) => (
              <tr key={u.id}>
                <td>{u.username}</td>
                <td>{u.nombre}</td>
                <td>
                  <select
                    value={u.rol}
                    onChange={async (e) => {
                      try {
                        await api.cambiarRolUsuario(u.id, e.target.value as Rol);
                        setMensaje(`Rol de '${u.username}' actualizado.`);
                        setError("");
                        cargar();
                      } catch (err) {
                        setError((err as Error).message);
                      }
                    }}
                    style={{ marginBottom: 0, maxWidth: 240 }}
                  >
                    {ROLES_UI.map((r) => (
                      <option key={r} value={r}>
                        {ETIQUETAS_ROL[r]}
                      </option>
                    ))}
                  </select>
                </td>
                <td>{u.activo === 1 ? "Activo" : "Desactivado"}</td>
                <td>
                  {u.activo === 1 ? (
                    <button
                      className="btn peligro"
                      onClick={async () => {
                        try {
                          await api.cambiarEstadoUsuario(u.id, false);
                          setMensaje(`Usuario '${u.username}' desactivado.`);
                          setError("");
                          cargar();
                        } catch (err) {
                          setError((err as Error).message);
                        }
                      }}
                    >
                      Desactivar
                    </button>
                  ) : (
                    <button
                      className="btn exito"
                      onClick={async () => {
                        try {
                          await api.cambiarEstadoUsuario(u.id, true);
                          setMensaje(`Usuario '${u.username}' activado.`);
                          setError("");
                          cargar();
                        } catch (err) {
                          setError((err as Error).message);
                        }
                      }}
                    >
                      Activar
                    </button>
                  )}
                  {u.id !== actual.id && !USUARIOS_BASE_UI.includes(u.username) && (
                    <button
                      className="btn peligro"
                      style={{ marginLeft: "0.4rem" }}
                      onClick={async () => {
                        const confirmar = window.confirm(
                          `¿Eliminar definitivamente al usuario '${u.username}'? ` +
                            "Sólo es posible si no tiene actividad registrada. Esta acción no se puede deshacer."
                        );
                        if (!confirmar) return;
                        try {
                          await api.eliminarUsuario(u.id);
                          setMensaje(`Usuario '${u.username}' eliminado.`);
                          setError("");
                          cargar();
                        } catch (err) {
                          setError((err as Error).message);
                        }
                      }}
                    >
                      Eliminar
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {usuarios.length === 0 && (
              <tr>
                <td colSpan={5} className="vacio">
                  Sin usuarios.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <form
        className="panel"
        style={{ maxWidth: 720 }}
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.crearUsuario(alta);
            setMensaje(`Usuario '${alta.username}' creado. La contraseña inicial es la que capturaste.`);
            setAlta({ username: "", nombre: "", rol: "operacion", password: "" });
            setError("");
            cargar();
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <h3 style={{ marginTop: 0 }}>Nuevo usuario</h3>
        <div className="rejilla">
          <div>
            <label>Usuario (login)</label>
            <input value={alta.username} onChange={(e) => setAlta({ ...alta, username: e.target.value })} required />
          </div>
          <div>
            <label>Nombre completo</label>
            <input value={alta.nombre} onChange={(e) => setAlta({ ...alta, nombre: e.target.value })} required />
          </div>
          <div>
            <label>Rol</label>
            <select value={alta.rol} onChange={(e) => setAlta({ ...alta, rol: e.target.value as Rol })}>
              {ROLES_UI.map((r) => (
                <option key={r} value={r}>
                  {ETIQUETAS_ROL[r]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>Contraseña inicial</label>
            <input
              type="password"
              value={alta.password}
              onChange={(e) => setAlta({ ...alta, password: e.target.value })}
              required
            />
          </div>
        </div>
        <button className="btn">Crear usuario</button>
      </form>
      <p style={{ color: "var(--tenue)", fontSize: "0.82rem" }}>
        El Administrador del sistema gestiona usuarios y configuración, pero no ejecuta operaciones
        financieras (separación de funciones, 01-ROLES.md §8.1).
      </p>
      <p style={{ color: "var(--tenue)", fontSize: "0.82rem" }}>
        "Eliminar" borra definitivamente al usuario y sólo está disponible si no tiene actividad
        registrada (operaciones, revisiones, asignaciones o bitácora); si tiene historial, desactívalo
        para conservar la trazabilidad. Los usuarios base del sistema (admin, admin_ops,
        admin_validacion, admin_tesoreria, val_tesoreria) no se pueden eliminar.
      </p>
    </>
  );
}

function VistaConfig() {
  const [registros, setRegistros] = useState<CatalogoRegistro[]>([]);
  const [parametros, setParametros] = useState<Parametro[]>([]);
  const [brokers, setBrokers] = useState<Broker[]>([]);
  const [brokerAlta, setBrokerAlta] = useState({ nombre: "", porcentaje: "0" });
  const [error, setError] = useState("");
  const [mensaje, setMensaje] = useState("");
  const [alta, setAlta] = useState({ dominio: "", clave: "", valor: "" });
  const [edicion, setEdicion] = useState<{ id: string; valor: string }>({ id: "", valor: "" });
  const [edicionUmbral, setEdicionUmbral] = useState("");

  const cargar = () => {
    api
      .catalogosRegistros()
      .then(({ registros }) => setRegistros(registros))
      .catch((err: Error) => setError(err.message));
    api
      .parametros()
      .then(({ parametros }) => setParametros(parametros))
      .catch((err: Error) => setError(err.message));
    api
      .brokers()
      .then(({ brokers }) => setBrokers(brokers))
      .catch(() => setBrokers([]));
  };

  useEffect(() => {
    cargar();
  }, []);

  return (
    <>
      <h2>Configuración del sistema</h2>
      {error && <div className="error">{error}</div>}
      {mensaje && <div className="exito-msg">{mensaje}</div>}

      <div className="panel" style={{ marginBottom: "1rem" }}>
        <h3 style={{ marginTop: 0 }}>Parámetros generales</h3>
        <table>
          <thead>
            <tr>
              <th>Clave</th>
              <th>Valor</th>
              <th>Descripción</th>
              <th>Actualizado</th>
            </tr>
          </thead>
          <tbody>
            {parametros.map((p) => (
              <tr key={p.clave}>
                <td>{p.clave}</td>
                <td style={{ fontWeight: 700 }}>{p.valor}</td>
                <td>{p.descripcion}</td>
                <td>{p.actualizado_en}</td>
              </tr>
            ))}
            {parametros.length === 0 && (
              <tr>
                <td colSpan={4} className="vacio">
                  Sin parámetros.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {parametros.some((p) => p.clave === "umbral_direccion") && (
          <div className="barra" style={{ marginTop: "0.8rem" }}>
            <input
              placeholder="Nuevo umbral de Dirección (p. ej. 500000)"
              value={edicionUmbral}
              onChange={(e) => setEdicionUmbral(e.target.value)}
              style={{ maxWidth: 320, marginBottom: 0 }}
            />
            <button
              className="btn"
              onClick={async () => {
                try {
                  await api.actualizarParametro("umbral_direccion", edicionUmbral);
                  setMensaje("Parámetro actualizado: aplica de inmediato al validar operaciones.");
                  setError("");
                  setEdicionUmbral("");
                  cargar();
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            >
              Guardar umbral
            </button>
          </div>
        )}
      </div>

      <div className="panel" style={{ marginBottom: "1rem" }}>
        <h3 style={{ marginTop: 0 }}>Catálogos (pagadoras, conceptos, etc.)</h3>
        <table>
          <thead>
            <tr>
              <th>Dominio</th>
              <th>Clave</th>
              <th>Valor</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            {registros.map((rg) => (
              <tr key={rg.id}>
                <td>{rg.dominio}</td>
                <td>{rg.clave}</td>
                <td>{rg.valor}</td>
                <td>{rg.activo === 1 ? "Activo" : "Inactivo"}</td>
              </tr>
            ))}
            {registros.length === 0 && (
              <tr>
                <td colSpan={4} className="vacio">
                  Catálogo vacío.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <p style={{ color: "var(--tenue)", fontSize: "0.82rem", marginBottom: 0 }}>
          Los dominios <strong>pagador</strong> y <strong>tipo_operacion</strong> alimentan la captura completa
          (formato FLUJO): agrega ahí más pagadores o tipos si el negocio lo requiere.
        </p>
      </div>

      <div className="panel" style={{ marginBottom: "1rem" }}>
        <h3 style={{ marginTop: 0 }}>Brokers (reparto de la comisión, formato FLUJO)</h3>
        <table>
          <thead>
            <tr>
              <th>Broker</th>
              <th style={{ textAlign: "right" }}>% de la comisión</th>
              <th>Estado</th>
              <th>Acción</th>
            </tr>
          </thead>
          <tbody>
            {brokers.map((b) => (
              <tr key={b.id}>
                <td>{b.nombre}</td>
                <td style={{ textAlign: "right" }}>{b.porcentaje.toFixed(2)}%</td>
                <td>{b.activo === 1 ? "Activo" : "Inactivo"}</td>
                <td>
                  <button
                    className="btn"
                    onClick={async () => {
                      try {
                        await api.actualizarBroker(b.id, { activo: b.activo !== 1 });
                        setMensaje(`Broker '${b.nombre}' ${b.activo === 1 ? "desactivado" : "activado"}.`);
                        setError("");
                        cargar();
                      } catch (err) {
                        setError((err as Error).message);
                      }
                    }}
                  >
                    {b.activo === 1 ? "Desactivar" : "Activar"}
                  </button>
                </td>
              </tr>
            ))}
            {brokers.length === 0 && (
              <tr>
                <td colSpan={4} className="vacio">
                  Sin brokers: la comisión completa la retiene la casa.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="rejilla" style={{ maxWidth: 560, marginTop: "0.6rem" }}>
          <div>
            <label>Nombre del broker</label>
            <input
              value={brokerAlta.nombre}
              onChange={(e) => setBrokerAlta({ ...brokerAlta, nombre: e.target.value })}
              placeholder="MGN INTRUST"
            />
          </div>
          <div>
            <label>% de la comisión (parte del total)</label>
            <input
              type="number"
              step="0.01"
              min="0"
              max="100"
              value={brokerAlta.porcentaje}
              onChange={(e) => setBrokerAlta({ ...brokerAlta, porcentaje: e.target.value })}
            />
          </div>
        </div>
        <button
          className="btn"
          style={{ marginTop: "0.6rem" }}
          onClick={async () => {
            try {
              await api.crearBroker({ nombre: brokerAlta.nombre, porcentaje: Number(brokerAlta.porcentaje) });
              setMensaje(`Broker '${brokerAlta.nombre}' creado (${Number(brokerAlta.porcentaje).toFixed(2)}%).`);
              setError("");
              setBrokerAlta({ nombre: "", porcentaje: "0" });
              cargar();
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        >
          Agregar broker
        </button>
      </div>

      <div className="rejilla">
        <form
          className="panel"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api.crearCatalogoRegistro(alta);
              setMensaje(`Registro '${alta.dominio}/${alta.clave}' creado.`);
              setAlta({ dominio: "", clave: "", valor: "" });
              setError("");
              cargar();
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        >
          <h3 style={{ marginTop: 0 }}>Nuevo registro de catálogo</h3>
          <label>Dominio (p. ej. pagadora)</label>
          <input value={alta.dominio} onChange={(e) => setAlta({ ...alta, dominio: e.target.value })} required />
          <label>Clave</label>
          <input value={alta.clave} onChange={(e) => setAlta({ ...alta, clave: e.target.value })} required />
          <label>Valor</label>
          <input value={alta.valor} onChange={(e) => setAlta({ ...alta, valor: e.target.value })} required />
          <button className="btn">Agregar registro</button>
        </form>

        <form
          className="panel"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api.actualizarCatalogoRegistro(Number(edicion.id), {
                valor: edicion.valor,
              });
              setMensaje("Registro actualizado.");
              setEdicion({ id: "", valor: "" });
              setError("");
              cargar();
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        >
          <h3 style={{ marginTop: 0 }}>Modificar registro</h3>
          <label>Registro</label>
          <select value={edicion.id} onChange={(e) => setEdicion({ ...edicion, id: e.target.value })} required>
            <option value="">— Selecciona —</option>
            {registros.map((rg) => (
              <option key={rg.id} value={String(rg.id)}>
                {rg.dominio}/{rg.clave} = {rg.valor}
              </option>
            ))}
          </select>
          <label>Nuevo valor</label>
          <input value={edicion.valor} onChange={(e) => setEdicion({ ...edicion, valor: e.target.value })} />
          <button className="btn" disabled={!edicion.id}>
            Guardar cambio
          </button>
        </form>
      </div>
    </>
  );
}
function BarraConcentrado({
  onError,
  onOk,
}: {
  onError: (m: string) => void;
  onOk: (m: string) => void;
}) {
  return (
    <div className="barra" style={{ marginBottom: "0.8rem" }}>
      <button
        className="btn"
        onClick={async () => {
          try {
            await descargarConcentrado();
            onOk("Concentrado CSV descargado.");
          } catch (err) {
            onError((err as Error).message);
          }
        }}
      >
        Descargar concentrado (CSV)
      </button>
      <span style={{ color: "var(--tenue)", fontSize: "0.82rem" }}>
        Pagos, movimientos y aplicaciones de recursos en un archivo (01-ROLES.md §7.1).
      </span>
    </div>
  );
}

function VistaFondeo() {
  const [resumen, setResumen] = useState<ResumenFondeador | null>(null);
  const [porLiberar, setPorLiberar] = useState<Operacion[]>([]);
  const [error, setError] = useState("");
  const [mensaje, setMensaje] = useState("");

  const cargar = () => {
    api
      .resumenFondeador()
      .then(setResumen)
      .catch((err: Error) => setError(err.message));
    // El Fondeador ve las por validar y ya validadas: aquí nos interesa lo que
    // ya está aprobado y aún NO liberado a Tesorería.
    api
      .lista({ estado: "aprobada" })
      .then(({ operaciones }) => setPorLiberar(operaciones.filter((o) => !o.liberada_en)))
      .catch(() => setPorLiberar([]));
  };

  useEffect(() => {
    cargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ETIQUETAS_FONDEO: Array<[string, number]> = [
    ["En validación", 0],
    ["Observada", 1],
    ["Pend. Dirección", 2],
    ["Aprobada (por liberar)", 3],
    ["En pago", 4],
    ["Pagada", 5],
  ];

  return (
    <>
      <h2>Fondeo — flujos de efectivo</h2>
      {error && <div className="error">{error}</div>}
      {mensaje && <div className="exito-msg">{mensaje}</div>}
      <p style={{ color: "var(--tenue)", fontSize: "0.87rem" }}>
        Montos que Tesorería necesitará por frente (flujos, SOFOM, anticipos a rendimientos, etc.) y
        operaciones ya validadas pendientes de tu liberación: sin liberar, el analista de Tesorería no
        las ve ni las paga.
      </p>

      {resumen && (
        <div className="rejilla" style={{ marginBottom: "1rem" }}>
          {ETIQUETAS_FONDEO.map(([etiqueta, i]) => {
            const f = resumen.por_estado[i];
            if (!f) return null;
            return (
              <div key={etiqueta} className="panel" style={{ margin: 0 }}>
                <strong>{etiqueta}</strong>
                <p style={{ margin: "0.2rem 0" }}>
                  {f.operaciones} operación(es) · ${f.monto.toLocaleString("es-MX", { minimumFractionDigits: 2 })}
                </p>
                <small style={{ color: "var(--tenue)" }}>
                  Flujo a dispersar: ${f.flujo_total.toLocaleString("es-MX", { minimumFractionDigits: 2 })}
                </small>
              </div>
            );
          })}
        </div>
      )}

      {resumen && resumen.por_tipo.length > 0 && (
        <div className="panel" style={{ marginBottom: "1rem" }}>
          <h3 style={{ marginTop: 0 }}>Montos por tipo de operación del negocio</h3>
          <table>
            <thead>
              <tr>
                <th>Tipo</th>
                <th>Moneda</th>
                <th style={{ textAlign: "right" }}>Operaciones</th>
                <th style={{ textAlign: "right" }}>Monto total</th>
                <th style={{ textAlign: "right" }}>Por validar</th>
                <th style={{ textAlign: "right" }}>Por dispersar</th>
                <th style={{ textAlign: "right" }}>Pagado</th>
              </tr>
            </thead>
            <tbody>
              {resumen.por_tipo.map((t) => (
                <tr key={`${t.tipo_operacion}-${t.moneda}`}>
                  <td>{t.tipo_operacion || "—"}</td>
                  <td>{t.moneda}</td>
                  <td style={{ textAlign: "right" }}>{t.operaciones}</td>
                  <td style={{ textAlign: "right" }}>${fmt(t.monto)}</td>
                  <td style={{ textAlign: "right" }}>${fmt(t.por_validar)}</td>
                  <td style={{ textAlign: "right" }}>${fmt(t.por_dispersar)}</td>
                  <td style={{ textAlign: "right" }}>${fmt(t.pagado)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>
          Aprobadas por liberar ({porLiberar.length})
        </h3>
        <table>
          <thead>
            <tr>
              <th>Folio</th>
              <th>Concepto</th>
              <th style={{ textAlign: "right" }}>Monto</th>
              <th>Estado</th>
              <th>Acción</th>
            </tr>
          </thead>
          <tbody>
            {porLiberar.map((o) => (
              <tr key={o.id}>
                <td>{o.folio}</td>
                <td>{o.concepto}</td>
                <td style={{ textAlign: "right" }}>
                  ${o.monto.toLocaleString("es-MX", { minimumFractionDigits: 2 })} {o.moneda}
                </td>
                <td>
                  <span className={`badge ${o.estado}`}>{ETIQUETAS_ESTADO[o.estado]}</span>
                </td>
                <td>
                  <button
                    className="btn exito"
                    onClick={async () => {
                      try {
                        await api.liberar(o.id);
                        setMensaje(`${o.folio} liberada: Tesorería ya puede dispersarla.`);
                        setError("");
                        cargar();
                      } catch (err) {
                        setError((err as Error).message);
                      }
                    }}
                  >
                    Liberar a Tesorería
                  </button>
                </td>
              </tr>
            ))}
            {porLiberar.length === 0 && (
              <tr>
                <td colSpan={5} className="vacio">
                  Nada por liberar: no hay operaciones aprobadas pendientes.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Fase 15 — Matriz tipo Excel (la hoja "SOLICITUD ALTAS" del formato de
 * alta, dentro del sistema): una fila por persona con NOMBRE CORRECTO / banco
 * / cuenta / CLABE y una columna por portal (pagadora) con la marca de
 * estado. Encabezados congelados, buscador y copia de la vista a TSV para
 * pegarla de vuelta en Excel. Con clic en la celda (rol altas/admin) se
 * registra "dada de alta" o el rechazo con motivo. */
function MatrizExcelAltas({
  usuario,
  onError,
  onOk,
  recargar,
}: {
  usuario: Usuario;
  onError: (m: string) => void;
  onOk: (m: string) => void;
  recargar: number;
}) {
  const puedeActuar =
    usuario.rol === "altas" || usuario.rol === "admin_tesoreria" || usuario.rol === "admin";
  type Fila = import("./tipos").AltaBancaria & { portales: import("./tipos").AltaPortal[] };
  const [altas, setAltas] = useState<Fila[]>([]);
  const [portales, setPortales] = useState<Array<{ id: number; nombre: string }>>([]);
  const [busca, setBusca] = useState("");
  const [filtroEstado, setFiltroEstado] = useState("");
  const [soloPendientes, setSoloPendientes] = useState(false);
  const [cargando, setCargando] = useState(true);
  const [celda, setCelda] = useState<{ fila: Fila; altaPortalId: number; portal: string } | null>(null);

  const cargar = () => {
    setCargando(true);
    api
      .matrizAltas()
      .then((m) => {
        setAltas(m.altas as Fila[]);
        setPortales(m.portales);
      })
      .catch((err: Error) => onError(err.message))
      .finally(() => setCargando(false));
  };

  useEffect(() => {
    cargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recargar]);

  const filtradas = altas.filter((a) => {
    if (filtroEstado && a.estado !== filtroEstado) return false;
    if (soloPendientes) {
      const pend = a.portales.filter((p) => p.estado === "pendiente").length;
      if (a.estado === "registrada" || pend === 0) return false;
    }
    if (!busca.trim()) return true;
    const t = busca.trim().toLowerCase();
    return (
      a.beneficiario.toLowerCase().includes(t) ||
      a.banco.toLowerCase().includes(t) ||
      (a.clabe ?? "").includes(t) ||
      (a.cuenta ?? "").includes(t)
    );
  });

  const portalDe = (fila: Fila, portalId: number) =>
    fila.portales.find((p) => p.portal_cuenta_id === portalId);

  const accion = async (nuevo: "dada_de_alta" | "rechazada" | "quitar") => {
    if (!celda) return;
    try {
      if (nuevo === "quitar") {
        await api.quitarPortalAlta(celda.altaPortalId);
        onOk(`Portal '${celda.portal}' quitado de ${celda.fila.beneficiario}.`);
      } else {
        let motivo = "";
        if (nuevo === "rechazada") {
          const m = window.prompt(`Motivo del rechazo en ${celda.portal}:`);
          if (!m || !m.trim()) return;
          motivo = m.trim();
        }
        await api.estadoPortalAlta(celda.altaPortalId, nuevo, motivo);
        onOk(
          nuevo === "dada_de_alta"
            ? `${celda.fila.beneficiario}: dada de alta en ${celda.portal}.`
            : `${celda.fila.beneficiario}: rechazada en ${celda.portal}; la alta regresa a la cola.`
        );
      }
      onError("");
      setCelda(null);
      cargar();
    } catch (err) {
      onError((err as Error).message);
    }
  };

  const copiarTSV = () => {
    const encabezado = [
      "#",
      "BENEFICIARIO",
      "BANCO",
      "CUENTA",
      "CLABE",
      "MDA",
      "ESTADO",
      ...portales.map((p) => p.nombre.toUpperCase()),
      "PORTALES OK",
    ];
    const lineas = [encabezado.join("\t")];
    for (const a of filtradas) {
      const ok = a.portales.filter((p) => p.estado === "dada_de_alta").length;
      const marcas = portales.map((p) => {
        const reg = portalDe(a, p.id);
        return reg ? (reg.estado === "dada_de_alta" ? "OK" : reg.estado === "rechazada" ? "RECHAZADA" : "PENDIENTE") : "";
      });
      lineas.push(
        [
          String(a.id),
          a.beneficiario,
          a.banco,
          a.cuenta,
          a.clabe ?? "",
          a.moneda,
          a.estado.toUpperCase(),
          ...marcas,
          a.portales.length ? `${ok}/${a.portales.length}` : "",
        ].join("\t")
      );
    }
    navigator.clipboard
      .writeText(lineas.join("\n"))
      .then(() =>
        onOk(`Vista copiada (${filtradas.length} filas × ${encabezado.length} columnas). Pégala en Excel con Ctrl+V.`)
      )
      .catch(() => onError("No se pudo copiar al portapapeles."));
  };

  return (
    <>
      <div className="barra barra-matriz">
        <input
          placeholder="Buscar: nombre, banco, CLABE o cuenta…"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          style={{ maxWidth: 260 }}
        />
        <select value={filtroEstado} onChange={(e) => setFiltroEstado(e.target.value)} style={{ maxWidth: 180, marginBottom: 0 }}>
          <option value="">Todos los estados</option>
          <option value="solicitada">En cola</option>
          <option value="registrada">Registradas</option>
          <option value="rechazada">Rechazadas</option>
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: "0.35rem", fontSize: "0.85rem", whiteSpace: "nowrap" }}>
          <input type="checkbox" checked={soloPendientes} onChange={(e) => setSoloPendientes(e.target.checked)} />
          Sólo pendientes
        </label>
        <button className="btn" onClick={copiarTSV} title="Copia la vista para pegarla en Excel">
          Copiar vista (TSV)
        </button>
        <span style={{ color: "var(--tenue)", fontSize: "0.82rem", whiteSpace: "nowrap" }}>
          {filtradas.length} de {altas.length} personas · {portales.length} portales
        </span>
      </div>

      {celda && puedeActuar && (
        <div className="panel barra-matriz" style={{ border: "1px solid var(--acento)" }}>
          <strong style={{ marginRight: "auto" }}>
            {celda.fila.beneficiario} · {celda.portal}
          </strong>
          <button className="btn exito" onClick={() => accion("dada_de_alta")}>
            Dada de alta
          </button>
          <button className="btn peligro" onClick={() => accion("rechazada")}>
            Rechazar…
          </button>
          <button className="btn" onClick={() => accion("quitar")} title="Quita esta persona de este portal">
            Quitar del portal
          </button>
          <button className="btn" onClick={() => setCelda(null)}>
            Cerrar
          </button>
        </div>
      )}

      <div className="matriz-xl-wrap">
        <table className="matriz-xl">
          <thead>
            <tr>
              <th className="mx-num">#</th>
              <th className="mx-fija">Beneficiario (nombre correcto)</th>
              <th>Banco</th>
              <th>Nº cuenta</th>
              <th>CLABE</th>
              <th>Mda</th>
              <th>Estado</th>
              {portales.map((p) => (
                <th key={p.id} className="mx-portal" title={p.nombre}>
                  {p.nombre}
                </th>
              ))}
              <th title="Portales completados">OK</th>
            </tr>
          </thead>
          <tbody>
            {filtradas.map((a, i) => {
              const ok = a.portales.filter((p) => p.estado === "dada_de_alta").length;
              const pend = a.portales.filter((p) => p.estado === "pendiente").length;
              const mal = a.portales.filter((p) => p.estado === "rechazada").length;
              return (
                <tr key={a.id}>
                  <td className="mx-num">{i + 1}</td>
                  <td className="mx-fija mx-benef">{a.beneficiario}</td>
                  <td>{a.banco}</td>
                  <td className="mx-mono">{a.cuenta}</td>
                  <td className="mx-mono">{a.clabe}</td>
                  <td>{a.moneda}</td>
                  <td>
                    {a.estado === "registrada" ? (
                      <span className="mx-chip mx-ok" title="Tesorería ya puede dispersarla">
                        REGISTRADA
                      </span>
                    ) : a.estado === "rechazada" ? (
                      <span className="mx-chip mx-mal" title={a.motivo_rechazo || "Rechazada"}>
                        RECHAZADA
                      </span>
                    ) : (
                      <span
                        className="mx-chip mx-esp"
                        title={pend ? `${pend} portal(es) pendiente(s)` : "Sin portales asignados"}
                      >
                        {pend ? "EN COLA" : "SIN PORTALES"}
                      </span>
                    )}
                  </td>
                  {portales.map((p) => {
                    const reg = portalDe(a, p.id);
                    const clicable = puedeActuar && !!reg;
                    return (
                      <td
                        key={p.id}
                        className={`mx-celda${clicable ? " clicable" : ""}`}
                        onClick={
                          clicable
                            ? () =>
                                setCelda({
                                  fila: a,
                                  altaPortalId: reg!.id,
                                  portal: p.nombre,
                                })
                            : undefined
                        }
                        title={
                          reg
                            ? `${p.nombre}: ${reg.estado.replace(/_/g, " ")}${
                                reg.registrador ? ` · por ${reg.registrador}` : ""
                              }${reg.motivo_rechazo ? ` · ${reg.motivo_rechazo}` : ""}`
                            : "No asignada a este portal"
                        }
                      >
                        {reg ? (
                          reg.estado === "dada_de_alta" ? (
                            <span className="mx-chip mx-ok">✓</span>
                          ) : reg.estado === "rechazada" ? (
                            <span className="mx-chip mx-mal">✗</span>
                          ) : (
                            <span className="mx-chip mx-esp">…</span>
                          )
                        ) : (
                          <span className="mx-vacio">·</span>
                        )}
                      </td>
                    );
                  })}
                  <td className="mx-progreso">
                    {a.portales.length ? `${ok}/${a.portales.length}` : "—"}
                    {mal > 0 && (
                      <span className="mx-alerta" title="Hay un rechazo: la alta volvió a la cola">
                        ⚠
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
            {filtradas.length === 0 && (
              <tr>
                <td className="vacio" colSpan={8 + portales.length}>
                  {cargando ? "Cargando matriz…" : "Sin altas que coincidan con el filtro."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mx-leyenda">
        Cómo se usa: registra la cuenta en el portal bancario y marca la celda — <span className="mx-chip mx-esp">…</span> pendiente ·{" "}
        <span className="mx-chip mx-ok">✓</span> dada de alta · <span className="mx-chip mx-mal">✗</span> rechazada (pide motivo y regresa la
        alta a la cola). Cuando todas las celdas de la fila estén en ✓, la alta pasa sola a REGISTRADA y Tesorería ya puede dispersarla.
        "Copiar vista (TSV)" pega esta hoja en Excel tal cual.
      </p>
    </>
  );
}

function VistaAltas({ usuario }: { usuario: Usuario }) {
  const esOperador = usuario.rol === "operacion";
  const puedeResolver = usuario.rol === "altas" || usuario.rol === "admin_tesoreria" || usuario.rol === "admin";
  const [altas, setAltas] = useState<AltaBancaria[]>([]);
  const [filtro, setFiltro] = useState("");
  const [error, setError] = useState("");
  const [mensaje, setMensaje] = useState("");
  const [form, setForm] = useState({ beneficiario: "", banco: "", moneda: "MXN", cuenta: "", notas: "" });
  // Fase 15: alta en portales — lote, matriz por alta y trabajo por portal.
  const [altaExpandida, setAltaExpandida] = useState<number | null>(null);
  // Fase 15.1: matriz tipo Excel como vista principal de la pestaña.
  const [subVista, setSubVista] = useState<"matriz" | "lista">("matriz");
  const [recargaMatriz, setRecargaMatriz] = useState(0);

  const cargar = () => {
    api
      .altasBancarias(filtro ? { estado: filtro } : {})
      .then(({ altas }) => setAltas(altas))
      .catch((err: Error) => setError(err.message));
  };

  useEffect(() => {
    cargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtro]);

  return (
    <>
      <h2>Altas bancarias</h2>
      {error && <div className="error">{error}</div>}
      {mensaje && <div className="exito-msg">{mensaje}</div>}
      <p style={{ color: "var(--tenue)", fontSize: "0.87rem" }}>
        {esOperador
          ? "Solicita el registro de la cuenta de un beneficiario en el banco: Tesorería de Altas la registra en el portal bancario. Sin alta registrada, Tesorería no puede dispersar esa cuenta."
          : "Base de todas las altas: fecha, solicitante, moneda y banco. Registra en el portal bancario y márcala aquí; Tesorería no puede pagar cuentas sin alta registrada."}
      </p>

      <div className="barra">
        <button
          className={subVista === "matriz" ? "btn acento" : "btn"}
          onClick={() => {
            setSubVista("matriz");
            setRecargaMatriz((r) => r + 1);
          }}
        >
          Matriz (Excel)
        </button>
        <button className={subVista === "lista" ? "btn acento" : "btn"} onClick={() => setSubVista("lista")}>
          Detalle y captura
        </button>
        <small style={{ color: "var(--tenue)", alignSelf: "center", fontSize: "0.8rem" }}>
          {subVista === "matriz"
            ? "Una fila por persona, una columna por portal — como la hoja SOLICITUD ALTAS del formato."
            : "Solicitudes, captura por lotes y trabajo por portal."}
        </small>
      </div>

      {subVista === "matriz" && (
        <MatrizExcelAltas
          usuario={usuario}
          onError={setError}
          onOk={(m) => {
            setMensaje(m);
            setError("");
          }}
          recargar={recargaMatriz}
        />
      )}

      {subVista === "lista" && (
      <>

      {esOperador && (
        <form
          className="panel"
          style={{ maxWidth: 720 }}
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api.solicitarAlta({
                beneficiario: form.beneficiario,
                banco: form.banco,
                moneda: form.moneda,
                cuenta: form.cuenta,
                notas: form.notas,
              });
              setMensaje(`Alta solicitada: ${form.beneficiario} (${form.banco}).`);
              setError("");
              setForm({ beneficiario: "", banco: "", moneda: "MXN", cuenta: "", notas: "" });
              cargar();
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        >
          <h3 style={{ marginTop: 0 }}>Nueva solicitud de alta (manual)</h3>
          <p style={{ color: "var(--tenue)", fontSize: "0.85rem" }}>
            También puedes solicitar el alta desde la operación: en el detalle, sección "Altas bancarias de la
            dispersión".
          </p>
          <div className="rejilla">
            <div>
              <label>Beneficiario</label>
              <input
                value={form.beneficiario}
                onChange={(e) => setForm({ ...form, beneficiario: e.target.value })}
                required
              />
            </div>
            <div>
              <label>Banco</label>
              <input
                value={form.banco}
                onChange={(e) => setForm({ ...form, banco: e.target.value })}
                placeholder="BBVA, BANORTE…"
                required
              />
            </div>
            <div>
              <label>Moneda</label>
              <input
                value={form.moneda}
                onChange={(e) => setForm({ ...form, moneda: e.target.value.toUpperCase() })}
                maxLength={3}
                required
              />
            </div>
            <div>
              <label>Cuenta o CLABE</label>
              <input value={form.cuenta} onChange={(e) => setForm({ ...form, cuenta: e.target.value })} required />
            </div>
          </div>
          <label>Notas (opcional)</label>
          <input value={form.notas} onChange={(e) => setForm({ ...form, notas: e.target.value })} />
          <button className="btn">Solicitar alta</button>
        </form>
      )}

      {puedeResolver && (
        <>
          <PanelLoteAltas
            onError={setError}
            onOk={(m) => {
              setMensaje(m);
              setError("");
              cargar();
            }}
          />
          <PanelTrabajarPortal
            onError={setError}
            onOk={(m) => {
              setMensaje(m);
              setError("");
              cargar();
            }}
          />
        </>
      )}

      <div className="barra">
        <select value={filtro} onChange={(e) => setFiltro(e.target.value)} style={{ maxWidth: 220, marginBottom: 0 }}>
          <option value="">Todos los estados</option>
          <option value="solicitada">Solicitadas</option>
          <option value="registrada">Registradas</option>
          <option value="rechazada">Rechazadas</option>
        </select>
      </div>

      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Solicitó</th>
              <th>Beneficiario</th>
              <th>Banco</th>
              <th>Moneda</th>
              <th>Cuenta / CLABE</th>
              <th>Operación</th>
              <th>Estado</th>
              {puedeResolver && <th>Acciones</th>}
            </tr>
          </thead>
          <tbody>
            {altas.map((a) => (
              <tr key={a.id}>
                <td>{a.creado_en?.slice(0, 10) ?? a.creado_en}</td>
                <td>{a.solicitador ?? "—"}</td>
                <td>{a.beneficiario}</td>
                <td>{a.banco}</td>
                <td>{a.moneda}</td>
                <td>{a.cuenta}</td>
                <td>{a.folio ?? "—"}</td>
                <td>
                  {a.estado === "registrada" && (
                    <span style={{ color: "var(--exito, #2e7d32)", fontWeight: 600 }}>Registrada</span>
                  )}
                  {a.estado === "solicitada" && (
                    <span style={{ color: "var(--ambar, #b26a00)" }}>Solicitada</span>
                  )}
                  {a.estado === "rechazada" && (
                    <span style={{ color: "var(--peligro, #c62828)" }} title={a.motivo_rechazo}>
                      Rechazada{a.motivo_rechazo ? `: ${a.motivo_rechazo}` : ""}
                    </span>
                  )}
                  {a.resolutor && <small style={{ display: "block", color: "var(--tenue)" }}>{a.resolutor}</small>}
                </td>
                {puedeResolver && (
                  <td>
                    <button
                      className="btn"
                      style={{ fontSize: "0.78rem", padding: "0.15rem 0.5rem", marginRight: "0.4rem" }}
                      title="Portales (pagadoras) donde esta cuenta se da de alta"
                      onClick={() => setAltaExpandida(altaExpandida === a.id ? null : a.id)}
                    >
                      {altaExpandida === a.id ? "Cerrar portales" : "Portales"}
                    </button>
                    {a.estado === "solicitada" ? (
                      <>
                        <button
                          className="btn exito"
                          onClick={async () => {
                            try {
                              await api.registrarAlta(a.id);
                              setMensaje(
                                `Cuenta de ${a.beneficiario} marcada como registrada en ${a.banco}: Tesorería ya puede dispersarla.`
                              );
                              setError("");
                              cargar();
                            } catch (err) {
                              setError((err as Error).message);
                            }
                          }}
                        >
                          Registrada
                        </button>
                        <button
                          className="btn peligro"
                          style={{ marginLeft: "0.4rem" }}
                          onClick={async () => {
                            const motivo = window.prompt("Motivo del rechazo:");
                            if (!motivo || !motivo.trim()) return;
                            try {
                              await api.rechazarAlta(a.id, motivo.trim());
                              setMensaje("Alta rechazada.");
                              setError("");
                              cargar();
                            } catch (err) {
                              setError((err as Error).message);
                            }
                          }}
                        >
                          Rechazar
                        </button>
                      </>
                    ) : (
                      <span style={{ color: "var(--tenue)" }}>—</span>
                    )}
                  </td>
                )}
              </tr>
            ))}
            {altaExpandida !== null && puedeResolver && (
              <tr>
                <td colSpan={9} style={{ background: "var(--panel, #fafafa)" }}>
                  <PortalesDeAlta
                    altaId={altaExpandida}
                    onError={setError}
                    onOk={(m) => {
                      setMensaje(m);
                      setError("");
                      cargar();
                    }}
                  />
                </td>
              </tr>
            )}
            {altas.length === 0 && (
              <tr>
                <td colSpan={puedeResolver ? 9 : 8} className="vacio">
                  Sin solicitudes de alta.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      </>
      )}
    </>
  );
}

/**
 * Fase 15 — utilidades del formato de alta en portales.
 * Convierte el texto pegado (TSV del Excel) en líneas del lote:
 * PATERNO ▸ MATERNO ▸ NOMBRE ▸ CLABE (también acepta NOMBRE COMPLETO ▸ CLABE).
 */
function parsearLoteAltas(texto: string): Array<{ paterno: string; materno: string; nombre: string; clabe: string }> {
  return texto
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const c = l.split("\t").map((x) => x.trim());
      if (c.length >= 4) return { paterno: c[0], materno: c[1], nombre: c[2], clabe: c[3] };
      if (c.length === 3) return { paterno: c[0], materno: c[1], nombre: c[2], clabe: "" };
      if (c.length === 2) return { paterno: "", materno: "", nombre: c[0], clabe: c[1] };
      return { paterno: "", materno: "", nombre: c[0], clabe: "" };
    });
}

function copiarAlPortapapeles(texto: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(texto);
  const area = document.createElement("textarea");
  area.value = texto;
  document.body.appendChild(area);
  area.select();
  document.execCommand("copy");
  document.body.removeChild(area);
  return Promise.resolve();
}

/**
 * Fase 15 — Captura por lotes de altas (formato "ALTA CUENTA"): pega las
 * columnas del Excel, elige los portales (pagadoras) y el sistema normaliza
 * los nombres (sin acentos/Ñ), valida las CLABE (18, banco por prefijo),
 * deriva el número de cuenta y deja cada alta en la cola con su portal.
 */
function PanelLoteAltas({ onError, onOk }: { onError: (m: string) => void; onOk: (m: string) => void }) {
  const [texto, setTexto] = useState("");
  const [portales, setPortales] = useState<Array<{ id: number; nombre: string }>>([]);
  const [sel, setSel] = useState<number[]>([]);
  const [res, setRes] = useState<import("./tipos").ResultadoLoteAltas | null>(null);
  const [ocupado, setOcupado] = useState(false);

  useEffect(() => {
    api
      .portalesAltas()
      .then(({ portales }) => setPortales(portales))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const alternar = (id: number) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const procesar = async () => {
    setOcupado(true);
    setRes(null);
    try {
      const lineas = parsearLoteAltas(texto);
      if (!lineas.length) throw new Error("Pega al menos una línea (PATERNO ▸ MATERNO ▸ NOMBRE ▸ CLABE, separadas por tabulador).");
      const r = await api.altasLote(lineas, sel);
      setRes(r);
      onOk(
        `Lote procesado: ${r.creadas.length} alta(s) creada(s), ${r.duplicadas.length} duplicada(s), ${r.errores.length} con error.`
      );
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setOcupado(false);
    }
  };

  const copiarParaPortal = async () => {
    if (!res?.creadas.length) return;
    const tsv = [
      "PATERNO\tMATERNO\tNOMBRE\tNOMBRE COMPLETO\tCLABE\tCUENTA\tBANCO",
      ...res.creadas.map((c) => [c.paterno, c.materno, c.nombre, c.beneficiario, c.clabe, c.cuenta, c.banco].join("\t")),
    ].join("\n");
    try {
      await copiarAlPortapapeles(tsv);
      onOk("Datos copiados: pégalos en el portal bancario (nombres ya normalizados, sin acentos ni Ñ).");
    } catch {
      onError("No se pudo copiar al portapapeles.");
    }
  };

  return (
    <div className="panel" style={{ marginBottom: "1rem" }}>
      <h3 style={{ marginTop: 0 }}>Captura por lotes para portales (formato ALTA CUENTA)</h3>
      <p style={{ color: "var(--tenue)", fontSize: "0.85rem" }}>
        Pega las columnas del Excel: <strong>PATERNO ▸ MATERNO ▸ NOMBRE ▸ CLABE</strong> (separadas por tabulador).
        El sistema normaliza los nombres para el portal (sin acentos, sin Ñ), valida la CLABE (18 dígitos), resuelve
        el banco por prefijo, deriva el número de cuenta (Santander 11 dígitos desde la posición 7; el resto 10 desde
        la 8) y detecta duplicados.
      </p>
      <textarea
        rows={6}
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        placeholder={"PÉREZ\tGARCÍA\tJUAN\t072180004912345678\nOTRO\tEJEMPLO\tMARÍA\t002100012345678901"}
        style={{ width: "100%", fontFamily: "monospace", fontSize: "0.85rem" }}
      />
      {portales.length > 0 && (
        <div style={{ margin: "0.6rem 0" }}>
          <label style={{ fontWeight: 600 }}>Portales donde registrar (pagadoras):</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem 1rem", marginTop: "0.3rem" }}>
            {portales.map((p) => (
              <label key={p.id} style={{ margin: 0, fontSize: "0.85rem", fontWeight: 400 }}>
                <input
                  type="checkbox"
                  checked={sel.includes(p.id)}
                  onChange={() => alternar(p.id)}
                  style={{ marginRight: "0.3rem" }}
                />
                {p.nombre}
              </label>
            ))}
          </div>
        </div>
      )}
      <button className="btn" disabled={ocupado} onClick={() => void procesar()}>
        {ocupado ? "Procesando…" : "Procesar lote"}
      </button>
      {res && (
        <div style={{ marginTop: "0.8rem" }}>
          <p style={{ margin: "0.2rem 0", fontWeight: 600 }}>
            Creadas: {res.creadas.length} · Duplicadas: {res.duplicadas.length} · Con error: {res.errores.length}
            {res.portales.length > 0 && <> · Portales: {res.portales.map((p) => p.nombre).join(", ")}</>}
          </p>
          {res.creadas.length > 0 && (
            <>
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Nombre correcto (para portal)</th>
                    <th>Banco</th>
                    <th>Cuenta derivada</th>
                    <th>CLABE</th>
                  </tr>
                </thead>
                <tbody>
                  {res.creadas.map((c) => (
                    <tr key={c.alta_id}>
                      <td>{c.linea}</td>
                      <td>{c.beneficiario}</td>
                      <td>{c.banco}</td>
                      <td>{c.cuenta}</td>
                      <td style={{ fontFamily: "monospace" }}>{c.clabe}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button className="btn exito" style={{ marginTop: "0.4rem" }} onClick={() => void copiarParaPortal()}>
                Copiar para el portal (TSV)
              </button>
            </>
          )}
          {res.duplicadas.length > 0 && (
            <p style={{ color: "var(--ambar, #b26a00)", fontSize: "0.85rem" }}>
              Duplicadas (ya estaban en la cola o registradas):{" "}
              {res.duplicadas.map((d) => `#${d.linea} ${d.beneficiario} (${d.banco})`).join(" · ")}
            </p>
          )}
          {res.errores.length > 0 && (
            <div className="error">
              {res.errores.map((e) => (
                <div key={e.linea}>
                  Línea {e.linea}: {e.errores.join("; ")}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Fase 15 — matriz alta × portales de UNA alta bancaria: agrega/quita portales
 * y registra el avance por portal (dada de alta / rechazada con motivo). Cuando
 * todos quedan dados de alta, la alta se marca 'registrada' sola.
 */
function PortalesDeAlta({ altaId, onError, onOk }: { altaId: number; onError: (m: string) => void; onOk: (m: string) => void }) {
  const [portales, setPortales] = useState<import("./tipos").AltaPortal[]>([]);
  const [disponibles, setDisponibles] = useState<Array<{ id: number; nombre: string }>>([]);
  const [nuevo, setNuevo] = useState("");

  const cargar = useCallback(() => {
    api
      .portalesDeAlta(altaId)
      .then(({ portales }) => setPortales(portales))
      .catch((err: Error) => onError(err.message));
    api
      .portalesAltas()
      .then(({ portales }) => setDisponibles(portales))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [altaId]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  const cambiar = async (id: number, estado: import("./tipos").AltaPortal["estado"]) => {
    let motivo = "";
    if (estado === "rechazada") {
      const entrada = window.prompt("Motivo del rechazo en el portal:");
      if (!entrada || !entrada.trim()) return;
      motivo = entrada.trim();
    }
    try {
      await api.estadoPortalAlta(id, estado, motivo);
      onOk("Portal actualizado.");
      cargar();
    } catch (err) {
      onError((err as Error).message);
    }
  };

  const agregar = async () => {
    if (!nuevo) return;
    try {
      await api.agregarPortalAlta(altaId, Number(nuevo));
      setNuevo("");
      onOk("Portal agregado a la alta.");
      cargar();
    } catch (err) {
      onError((err as Error).message);
    }
  };

  const quitar = async (id: number) => {
    try {
      await api.quitarPortalAlta(id);
      onOk("Portal quitado de la alta.");
      cargar();
    } catch (err) {
      onError((err as Error).message);
    }
  };

  const todasDadas = portales.length > 0 && portales.every((p) => p.estado === "dada_de_alta");

  return (
    <div style={{ border: "1px solid var(--borde, #ddd)", borderRadius: 6, padding: "0.6rem" }}>
      <strong style={{ fontSize: "0.9rem" }}>Portales (pagadoras) de esta alta</strong>
      {todasDadas && (
        <span style={{ color: "var(--exito, #2e7d32)", fontWeight: 600, marginLeft: "0.6rem", fontSize: "0.85rem" }}>
          Todos dados de alta → la cuenta queda REGISTRADA
        </span>
      )}
      {portales.length > 0 ? (
        <table style={{ marginTop: "0.4rem" }}>
          <thead>
            <tr>
              <th>Portal (pagadora)</th>
              <th>Estado</th>
              <th>Registró</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {portales.map((p) => (
              <tr key={p.id}>
                <td>{p.portal}</td>
                <td>
                  {p.estado === "dada_de_alta" && (
                    <span style={{ color: "var(--exito, #2e7d32)", fontWeight: 600 }}>Dada de alta</span>
                  )}
                  {p.estado === "pendiente" && <span style={{ color: "var(--ambar, #b26a00)" }}>Pendiente</span>}
                  {p.estado === "rechazada" && (
                    <span style={{ color: "var(--peligro, #c62828)" }} title={p.motivo_rechazo}>
                      Rechazada{p.motivo_rechazo ? `: ${p.motivo_rechazo}` : ""}
                    </span>
                  )}
                </td>
                <td>{p.registrador ?? "—"}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  {p.estado !== "dada_de_alta" && (
                    <button
                      className="btn exito"
                      style={{ fontSize: "0.78rem", padding: "0.15rem 0.5rem" }}
                      onClick={() => void cambiar(p.id, "dada_de_alta")}
                    >
                      Dada de alta
                    </button>
                  )}
                  {p.estado !== "rechazada" && (
                    <button
                      className="btn peligro"
                      style={{ fontSize: "0.78rem", padding: "0.15rem 0.5rem", marginLeft: "0.3rem" }}
                      onClick={() => void cambiar(p.id, "rechazada")}
                    >
                      Rechazar
                    </button>
                  )}
                  {p.estado !== "pendiente" && (
                    <button
                      className="btn"
                      style={{ fontSize: "0.78rem", padding: "0.15rem 0.5rem", marginLeft: "0.3rem" }}
                      onClick={() => void cambiar(p.id, "pendiente")}
                    >
                      Pendiente
                    </button>
                  )}
                  <button
                    className="btn"
                    style={{ fontSize: "0.78rem", padding: "0.15rem 0.5rem", marginLeft: "0.3rem" }}
                    title="Quitar este portal de la alta"
                    onClick={() => void quitar(p.id)}
                  >
                    Quitar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p style={{ color: "var(--tenue)", fontSize: "0.85rem" }}>
          Sin portales ligados: usa el registro manual de la fila (Registrada/Rechazar) o agrega portales aquí.
        </p>
      )}
      <div className="barra" style={{ marginTop: "0.4rem", alignItems: "center" }}>
        <select value={nuevo} onChange={(e) => setNuevo(e.target.value)} style={{ maxWidth: 320, marginBottom: 0 }}>
          <option value="">Agregar portal (pagadora)…</option>
          {disponibles
            .filter((d) => !portales.some((p) => p.portal_cuenta_id === d.id))
            .map((d) => (
              <option key={d.id} value={d.id}>
                {d.nombre}
              </option>
            ))}
        </select>
        <button className="btn" disabled={!nuevo} onClick={() => void agregar()}>
          Agregar
        </button>
      </div>
    </div>
  );
}

/**
 * Fase 15 — trabajar UN portal (pagadora): las altas ligadas a ese portal con
 * su nombre normalizado, CLABE y cuenta derivada, listas para teclear o pegar
 * en el portal bancario; y el avance de cada una.
 */
function PanelTrabajarPortal({ onError, onOk }: { onError: (m: string) => void; onOk: (m: string) => void }) {
  const [portales, setPortales] = useState<Array<{ id: number; nombre: string }>>([]);
  const [portalId, setPortalId] = useState("");
  const [filas, setFilas] = useState<import("./tipos").FilaPortalAltas[]>([]);

  useEffect(() => {
    api
      .portalesAltas()
      .then(({ portales }) => setPortales(portales))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cargarFilas = (id: string) => {
    setPortalId(id);
    if (!id) {
      setFilas([]);
      return;
    }
    api
      .filasPortal(Number(id))
      .then(({ filas }) => setFilas(filas))
      .catch((err: Error) => onError(err.message));
  };

  const cambiar = async (altaPortalId: number, estado: import("./tipos").AltaPortal["estado"]) => {
    let motivo = "";
    if (estado === "rechazada") {
      const entrada = window.prompt("Motivo del rechazo en el portal:");
      if (!entrada || !entrada.trim()) return;
      motivo = entrada.trim();
    }
    try {
      await api.estadoPortalAlta(altaPortalId, estado, motivo);
      onOk("Registro actualizado.");
      cargarFilas(portalId);
    } catch (err) {
      onError((err as Error).message);
    }
  };

  const copiarPendientes = async () => {
    const pendientes = filas.filter((f) => f.estado_portal === "pendiente");
    if (!pendientes.length) {
      onError("No hay altas pendientes en este portal.");
      return;
    }
    const tsv = [
      "NOMBRE COMPLETO\tCLABE\tCUENTA\tBANCO",
      ...pendientes.map((f) => [f.beneficiario, f.clabe || f.cuenta, f.cuenta, f.banco].join("\t")),
    ].join("\n");
    try {
      await copiarAlPortapapeles(tsv);
      onOk(`${pendientes.length} cuenta(s) copiada(s): pégalas en el portal.`);
    } catch {
      onError("No se pudo copiar al portapapeles.");
    }
  };

  return (
    <div className="panel" style={{ marginBottom: "1rem" }}>
      <h3 style={{ marginTop: 0 }}>Trabajar en un portal (pagadora)</h3>
      <div className="barra" style={{ alignItems: "center", flexWrap: "wrap" }}>
        <select value={portalId} onChange={(e) => cargarFilas(e.target.value)} style={{ maxWidth: 340, marginBottom: 0 }}>
          <option value="">Elegir portal…</option>
          {portales.map((p) => (
            <option key={p.id} value={p.id}>
              {p.nombre}
            </option>
          ))}
        </select>
        {portalId && (
          <button className="btn exito" onClick={() => void copiarPendientes()}>
            Copiar pendientes (TSV)
          </button>
        )}
      </div>
      {portalId && (
        <table style={{ marginTop: "0.5rem" }}>
          <thead>
            <tr>
              <th>Nombre correcto</th>
              <th>Banco</th>
              <th>Cuenta</th>
              <th>CLABE</th>
              <th>Estado en portal</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {filas.map((f) => (
              <tr key={f.alta_portal_id}>
                <td>{f.beneficiario}</td>
                <td>{f.banco}</td>
                <td style={{ fontFamily: "monospace" }}>{f.cuenta}</td>
                <td style={{ fontFamily: "monospace" }}>{f.clabe || "—"}</td>
                <td>
                  {f.estado_portal === "dada_de_alta" && (
                    <span style={{ color: "var(--exito, #2e7d32)", fontWeight: 600 }}>Dada de alta</span>
                  )}
                  {f.estado_portal === "pendiente" && <span style={{ color: "var(--ambar, #b26a00)" }}>Pendiente</span>}
                  {f.estado_portal === "rechazada" && (
                    <span style={{ color: "var(--peligro, #c62828)" }} title={f.motivo_rechazo}>
                      Rechazada{f.motivo_rechazo ? `: ${f.motivo_rechazo}` : ""}
                    </span>
                  )}
                </td>
                <td style={{ whiteSpace: "nowrap" }}>
                  {f.estado_portal !== "dada_de_alta" && (
                    <button
                      className="btn exito"
                      style={{ fontSize: "0.78rem", padding: "0.15rem 0.5rem" }}
                      onClick={() => void cambiar(f.alta_portal_id, "dada_de_alta")}
                    >
                      Dada de alta
                    </button>
                  )}
                  {f.estado_portal !== "rechazada" && (
                    <button
                      className="btn peligro"
                      style={{ fontSize: "0.78rem", padding: "0.15rem 0.5rem", marginLeft: "0.3rem" }}
                      onClick={() => void cambiar(f.alta_portal_id, "rechazada")}
                    >
                      Rechazar
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {filas.length === 0 && (
              <tr>
                <td colSpan={6} className="vacio">
                  Sin altas ligadas a este portal.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * Fase 13: Resguardo de TRF (la empresa). Saldo por moneda con el equivalente
 * en pesos calculado con el tipo de cambio que registró el banco en cada
 * movimiento; los movimientos en moneda distinta de MXN muestran SIEMPRE su
 * tipo de cambio, para que los resguardos cuadren.
 */
function VistaTrfResguardo({ usuario }: { usuario: Usuario }) {
  const [detalle, setDetalle] = useState<TrfResguardoDetalle | null>(null);
  const [error, setError] = useState("");
  const [mensaje, setMensaje] = useState("");
  const [filtro, setFiltro] = useState("");
  // Ajuste del negocio: el resguardo de TRF ya NO lo manejan los ejecutivos —
  // se modifica SÓLO con operaciones (pago especial desde TRF, comisión TRF de
  // los flujos) y se aplica AL AUTORIZARSE. Los movimientos manuales son
  // correcciones exclusivas del admin.
  const puedeRegistrar = usuario.rol === "admin";
  const [form, setForm] = useState({
    tipo: "ingreso" as "ingreso" | "retiro",
    importe: "",
    moneda: "MXN",
    monedaLibre: "",
    tipo_cambio: "",
    operacion_id: "",
    notas: "",
  });

  const cargar = () => {
    api
      .trfResguardo()
      .then(setDetalle)
      .catch((err: Error) => setError(err.message));
  };

  useEffect(() => {
    cargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const monedaFinal =
    form.moneda === "otra" ? form.monedaLibre.trim().toUpperCase() : form.moneda;
  const requiereTC = monedaFinal !== "MXN";

  const registrar = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!/^[A-Z]{3}$/.test(monedaFinal)) {
      setError("Especifica la moneda (elige de la lista o escribe el código de 3 letras).");
      return;
    }
    if (!(Number(form.importe) > 0)) {
      setError("El importe debe ser mayor a 0.");
      return;
    }
    if (requiereTC && !(Number(form.tipo_cambio) > 0)) {
      setError("Registra el tipo de cambio que aplicó el banco (obligatorio en moneda distinta de MXN).");
      return;
    }
    try {
      await api.registrarTrfMovimiento({
        tipo: form.tipo,
        importe: Number(form.importe),
        moneda: monedaFinal,
        ...(requiereTC || Number(form.tipo_cambio) > 0 ? { tipo_cambio: Number(form.tipo_cambio) } : {}),
        ...(form.operacion_id.trim() ? { operacion_id: Number(form.operacion_id) } : {}),
        ...(form.notas.trim() ? { notas: form.notas.trim() } : {}),
      });
      setMensaje(
        `${form.tipo === "ingreso" ? "Ingreso" : "Retiro"} registrado en el resguardo de TRF: ${
          form.importe
        } ${monedaFinal}${requiereTC ? ` (tipo de cambio ${form.tipo_cambio})` : ""}.`
      );
      setForm({ tipo: form.tipo, importe: "", moneda: form.moneda, monedaLibre: "", tipo_cambio: "", operacion_id: "", notas: "" });
      cargar();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const texto = filtro.trim().toLowerCase();
  const movimientos = (detalle?.movimientos ?? []).filter(
    (m) =>
      !texto ||
      m.moneda.toLowerCase().includes(texto) ||
      m.tipo.includes(texto) ||
      (m.folio ?? "").toLowerCase().includes(texto) ||
      m.notas.toLowerCase().includes(texto) ||
      m.creador.toLowerCase().includes(texto)
  );

  return (
    <>
      <h2>Resguardo de TRF (la empresa)</h2>
      <p style={{ color: "var(--tenue)", fontSize: "0.88rem", maxWidth: 900 }}>
        Ledger de ingresos y retiros de la empresa en la moneda en que ocurren. Los movimientos en
        moneda distinta de MXN guardan el <strong>tipo de cambio que aplicó el banco</strong> en la
        operación, de modo que el resguardo cuadre contra pesos (equivalente = importe × tipo de
        cambio). El saldo nunca se guarda: es la suma de sus movimientos. Los movimientos automáticos
        se aplican <strong>AL AUTORIZARSE</strong> la operación (retiro del pago especial con origen
        TRF e ingreso de la comisión TRF de los flujos en MXN); si la operación autorizada se cancela,
        se reversan solos.
      </p>
      {error && <div className="error">{error}</div>}
      {mensaje && <div className="exito-msg">{mensaje}</div>}

      <div className="rejilla" style={{ maxWidth: 900 }}>
        {(detalle?.saldos ?? []).map((s) => (
          <div key={s.moneda} className="panel" style={{ margin: 0 }}>
            <h3 style={{ marginTop: 0 }}>
              {s.moneda}
              {s.moneda !== "MXN" && <small style={{ color: "var(--tenue)", fontWeight: 400 }}> (con TC registrado)</small>}
            </h3>
            <p style={{ fontSize: "1.25rem", fontWeight: 700, margin: "0.2rem 0" }}>
              {s.saldo.toLocaleString("es-MX", { minimumFractionDigits: 2 })} {s.moneda}
            </p>
            <p style={{ color: "var(--tenue)", fontSize: "0.85rem", margin: 0 }}>
              Ingresos {s.ingresos.toLocaleString("es-MX", { minimumFractionDigits: 2 })} · Retiros{" "}
              {s.retiros.toLocaleString("es-MX", { minimumFractionDigits: 2 })}
            </p>
            <p style={{ fontSize: "0.88rem", margin: "0.3rem 0 0" }}>
              Equivalente: <strong>${s.equivalente_mxn.toLocaleString("es-MX", { minimumFractionDigits: 2 })} MXN</strong>
            </p>
          </div>
        ))}
        {detalle && detalle.saldos.length === 0 && (
          <div className="panel" style={{ margin: 0 }}>
            <p style={{ margin: 0, color: "var(--tenue)" }}>Sin movimientos todavía.</p>
          </div>
        )}
      </div>
      {detalle && detalle.saldos.length > 0 && (
        <p style={{ fontWeight: 600 }}>
          Equivalente total del resguardo: ${detalle.equivalente_total_mxn.toLocaleString("es-MX", { minimumFractionDigits: 2 })} MXN
        </p>
      )}

      {puedeRegistrar && (
        <form className="panel" onSubmit={registrar} style={{ maxWidth: 760 }}>
          <h3 style={{ marginTop: 0 }}>Registrar ingreso / retiro (correcciones)</h3>
          <div className="rejilla">
            <div>
              <label>Tipo de movimiento</label>
              <select value={form.tipo} onChange={(e) => setForm({ ...form, tipo: e.target.value as "ingreso" | "retiro" })}>
                <option value="ingreso">Ingreso (suma al resguardo)</option>
                <option value="retiro">Retiro (resta del resguardo)</option>
              </select>
              <small style={{ display: "block", color: "var(--tenue)", fontSize: "0.8rem" }}>
                Los movimientos normales nacen de OPERACIONES (pago especial desde TRF, comisión TRF) y
                se aplican al autorizarse; usa este formulario sólo para correcciones.
              </small>
            </div>
            <div>
              <label>Moneda</label>
              <select
                value={form.moneda}
                onChange={(e) => setForm({ ...form, moneda: e.target.value, monedaLibre: "" })}
              >
                <option value="MXN">MXN — Peso mexicano</option>
                <option value="USD">USD — Dólar americano</option>
                {MONEDAS_COMUNES.map((m) => (
                  <option key={m.codigo} value={m.codigo}>
                    {m.codigo} — {m.nombre}
                  </option>
                ))}
                <option value="otra">Otra moneda… (especificar)</option>
              </select>
            </div>
            {form.moneda === "otra" && (
              <div>
                <label>Especifica la moneda (código de 3 letras)</label>
                <input
                  value={form.monedaLibre}
                  onChange={(e) => setForm({ ...form, monedaLibre: e.target.value.toUpperCase() })}
                  maxLength={3}
                  placeholder="SEK, NZD, …"
                  style={{ textTransform: "uppercase" }}
                />
              </div>
            )}
            <div>
              <label>Importe</label>
              <input
                type="number"
                step="0.01"
                min="0.01"
                value={form.importe}
                onChange={(e) => setForm({ ...form, importe: e.target.value })}
                required
              />
            </div>
            <div>
              <label>
                Tipo de cambio del banco{requiereTC ? " (obligatorio)" : " (opcional, informativo)"}
              </label>
              <input
                type="number"
                step="0.0001"
                min={requiereTC ? "0.0001" : undefined}
                value={form.tipo_cambio}
                onChange={(e) => setForm({ ...form, tipo_cambio: e.target.value })}
                required={requiereTC}
                placeholder={requiereTC ? "pesos por unidad de moneda" : "—"}
              />
            </div>
            <div>
              <label>Operación ligada (ID, opcional)</label>
              <input
                type="number"
                min="1"
                value={form.operacion_id}
                onChange={(e) => setForm({ ...form, operacion_id: e.target.value })}
                placeholder="ej. 42"
              />
            </div>
            <div>
              <label>Notas (opcional)</label>
              <input
                value={form.notas}
                onChange={(e) => setForm({ ...form, notas: e.target.value })}
                placeholder="banco, referencia, motivo…"
              />
            </div>
          </div>
          {requiereTC && Number(form.tipo_cambio) > 0 && Number(form.importe) > 0 && (
            <p style={{ color: "var(--tenue)", fontSize: "0.87rem" }}>
              Equivalente estimado: <strong>${fmt(r2(Number(form.importe) * Number(form.tipo_cambio)))} MXN</strong>
            </p>
          )}
          <button className="btn">Registrar movimiento</button>
        </form>
      )}

      <h3>Movimientos del resguardo</h3>
      <div className="barra">
        <input
          placeholder="Filtrar por moneda, tipo, folio, notas o quien registró…"
          value={filtro}
          onChange={(e) => setFiltro(e.target.value)}
          style={{ maxWidth: 380, marginBottom: 0 }}
        />
      </div>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Tipo</th>
              <th style={{ textAlign: "right" }}>Importe</th>
              <th>Moneda</th>
              <th style={{ textAlign: "right" }}>Tipo de cambio</th>
              <th style={{ textAlign: "right" }}>Equivalente MXN</th>
              <th>Operación</th>
              <th>Notas</th>
              <th>Registró</th>
            </tr>
          </thead>
          <tbody>
            {movimientos.map((m) => (
              <tr key={m.id}>
                <td>{m.creado_en}</td>
                <td>
                  <strong style={{ color: m.tipo === "ingreso" ? "var(--exito, #2e7d32)" : "var(--peligro, #c62828)" }}>
                    {m.tipo === "ingreso" ? "+ Ingreso" : "− Retiro"}
                  </strong>
                </td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{fmt(m.importe)}</td>
                <td>{m.moneda}</td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  {m.moneda === "MXN" ? <span style={{ color: "var(--tenue)" }}>—</span> : fmt(m.tipo_cambio ?? 0)}
                </td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>${fmt(m.equivalente_mxn)}</td>
                <td>{m.folio ? `${m.folio}` : m.operacion_id ? `#${m.operacion_id}` : "—"}</td>
                <td>{m.notas || "—"}</td>
                <td>{m.creador}</td>
              </tr>
            ))}
            {movimientos.length === 0 && (
              <tr>
                <td colSpan={9} className="vacio">
                  {detalle && detalle.movimientos.length > 0
                    ? "Ningún movimiento coincide con el filtro."
                    : "Sin movimientos registrados."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function VistaValidacion({ usuario }: { usuario: Usuario }) {
  const esAdmin = usuario.rol === "admin_validacion";
  const [cola, setCola] = useState<FilaColaValidacion[]>([]);
  const [cargas, setCargas] = useState<CargoValidacion[]>([]);
  const [validadores, setValidadores] = useState<UsuarioAdmin[]>([]);
  const [ejecutivos, setEjecutivos] = useState<UsuarioAdmin[]>([]);
  const [asigsEjec, setAsigsEjec] = useState<AsignacionEjecutivo[]>([]);
  const [asigEjec, setAsigEjec] = useState({ validador: "", ejecutivo: "", motivo: "" });
  const [error, setError] = useState("");
  const [mensaje, setMensaje] = useState("");
  const [asig, setAsig] = useState({ operacion: "", validador: "", motivo: "" });
  // Fase 13: filtro del listado de la cola (folio, cliente, concepto, capturista).
  const [filtroCola, setFiltroCola] = useState("");
  const textoCola = filtroCola.trim().toLowerCase();
  const colaFiltrada = cola.filter(
    (f) =>
      !textoCola ||
      f.folio.toLowerCase().includes(textoCola) ||
      (f.cliente ?? "").toLowerCase().includes(textoCola) ||
      f.concepto.toLowerCase().includes(textoCola) ||
      f.capturista.toLowerCase().includes(textoCola)
  );

  const cargar = () => {
    api
      .colaValidacion()
      .then(({ cola }) => setCola(cola))
      .catch((err: Error) => setError(err.message));
    if (esAdmin) {
      api
        .cargasValidacion()
        .then(({ cargas }) => setCargas(cargas))
        .catch(() => setCargas([]));
      api
        .validadores()
        .then(({ validadores }) => setValidadores(validadores))
        .catch(() => setValidadores([]));
      // Fase 12: ejecutivos asignados a validadores (visibilidad de la cola).
      api
        .ejecutivos()
        .then(({ ejecutivos }) => setEjecutivos(ejecutivos))
        .catch(() => setEjecutivos([]));
      api
        .asignacionesEjecutivos()
        .then(({ asignaciones }) => setAsigsEjec(asignaciones))
        .catch(() => setAsigsEjec([]));
    }
  };

  useEffect(() => {
    cargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <h2>Cola de Validación</h2>
      {error && <div className="error">{error}</div>}
      {mensaje && <div className="exito-msg">{mensaje}</div>}

      <div className="barra">
        <input
          placeholder="Filtrar por folio, cliente, concepto o capturista…"
          value={filtroCola}
          onChange={(e) => setFiltroCola(e.target.value)}
          style={{ maxWidth: 380, marginBottom: 0 }}
        />
      </div>

      <div className="panel" style={{ marginBottom: "1rem" }}>
        <table>
          <thead>
            <tr>
              <th>Folio</th>
              <th>Cliente</th>
              <th>Concepto</th>
              <th style={{ textAlign: "right" }}>Monto</th>
              <th>Capturó</th>
              <th>Esperando desde</th>
              <th>Asignada a</th>
            </tr>
          </thead>
          <tbody>
            {colaFiltrada.map((f) => (
              <tr key={f.id}>
                <td>{f.folio}</td>
                <td>{f.cliente ?? "—"}</td>
                <td>{f.concepto}</td>
                <td style={{ textAlign: "right" }}>
                  {f.monto.toLocaleString("es-MX", { minimumFractionDigits: 2 })} {f.moneda}
                </td>
                <td>{f.capturista}</td>
                <td>{f.actualizado_en}</td>
                <td>
                  {f.validador_asignado ? (
                    <strong>{f.validador_asignado}</strong>
                  ) : (
                    <span style={{ color: "var(--tenue)" }}>— sin asignar —</span>
                  )}
                </td>
              </tr>
            ))}
            {colaFiltrada.length === 0 && (
              <tr>
                <td colSpan={7} className="vacio">
                  {cola.length === 0 ? "Sin operaciones en validación." : "Ninguna fila coincide con el filtro."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {esAdmin && (
        <>
          <form
            className="panel"
            style={{ maxWidth: 640 }}
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api.asignarValidacion(Number(asig.operacion), Number(asig.validador), asig.motivo);
                setMensaje("Asignación registrada (la asignación anterior se conserva en el historial).");
                setError("");
                setAsig({ operacion: "", validador: "", motivo: "" });
                cargar();
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          >
            <h3 style={{ marginTop: 0 }}>Asignar / reasignar validación</h3>
            <label>Operación en validación</label>
            <select value={asig.operacion} onChange={(e) => setAsig({ ...asig, operacion: e.target.value })} required>
              <option value="">— Selecciona operación —</option>
              {cola.map((f) => (
                <option key={f.id} value={String(f.id)}>
                  {f.folio} — {f.concepto} ({f.validador_asignado ?? "sin asignar"})
                </option>
              ))}
            </select>
            <label>Validador</label>
            <select value={asig.validador} onChange={(e) => setAsig({ ...asig, validador: e.target.value })} required>
              <option value="">— Selecciona validador —</option>
              {validadores.map((v) => (
                <option key={v.id} value={String(v.id)}>
                  {v.nombre} ({v.username}){v.activo !== 1 ? " [desactivado]" : ""}
                </option>
              ))}
            </select>
            <label>Motivo (opcional)</label>
            <input value={asig.motivo} onChange={(e) => setAsig({ ...asig, motivo: e.target.value })} />
            <button className="btn">Asignar / reasignar</button>
          </form>

          <div className="panel" style={{ marginTop: "1rem" }}>
            <h3 style={{ marginTop: 0 }}>Cargas de trabajo (§4.1)</h3>
            <table>
              <thead>
                <tr>
                  <th>Validador</th>
                  <th>Usuario</th>
                  <th style={{ textAlign: "right" }}>Asignadas vigentes</th>
                  <th style={{ textAlign: "right" }}>Revisiones históricas</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {cargas.map((c) => (
                  <tr key={c.id}>
                    <td>{c.nombre}</td>
                    <td>{c.username}</td>
                    <td style={{ textAlign: "right" }}>{c.asignadas}</td>
                    <td style={{ textAlign: "right" }}>{c.revisadas}</td>
                    <td>{c.activo === 1 ? "Activo" : "Desactivado"}</td>
                  </tr>
                ))}
                {cargas.length === 0 && (
                  <tr>
                    <td colSpan={5} className="vacio">
                      Sin validadores registrados.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="panel" style={{ marginTop: "1rem" }}>
            <h3 style={{ marginTop: 0 }}>Ejecutivos de Operaciones asignados a validadores</h3>
            <p style={{ color: "var(--tenue)", fontSize: "0.85rem" }}>
              Cada validador sólo visualiza (y revisa) las operaciones de los ejecutivos que le asignes aquí.
              Los ejecutivos sin asignación siguen el flujo simple: cualquier validador los atiende.
            </p>
            <form
              style={{ display: "flex", flexWrap: "wrap", gap: "0.6rem", alignItems: "end" }}
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await api.asignarEjecutivo(Number(asigEjec.validador), Number(asigEjec.ejecutivo), asigEjec.motivo);
                  setMensaje("Ejecutivo asignado al validador.");
                  setError("");
                  setAsigEjec({ validador: "", ejecutivo: "", motivo: "" });
                  cargar();
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            >
              <div>
                <label>Validador</label>
                <select
                  value={asigEjec.validador}
                  onChange={(e) => setAsigEjec({ ...asigEjec, validador: e.target.value })}
                  required
                >
                  <option value="">— Selecciona —</option>
                  {validadores.map((v) => (
                    <option key={v.id} value={String(v.id)}>
                      {v.nombre} ({v.username})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label>Ejecutivo de Operaciones</label>
                <select
                  value={asigEjec.ejecutivo}
                  onChange={(e) => setAsigEjec({ ...asigEjec, ejecutivo: e.target.value })}
                  required
                >
                  <option value="">— Selecciona —</option>
                  {ejecutivos.map((u) => (
                    <option key={u.id} value={String(u.id)}>
                      {u.nombre} ({u.username})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label>Motivo (opcional)</label>
                <input
                  value={asigEjec.motivo}
                  onChange={(e) => setAsigEjec({ ...asigEjec, motivo: e.target.value })}
                />
              </div>
              <button className="btn">Asignar ejecutivo</button>
            </form>
            <table style={{ marginTop: "0.8rem" }}>
              <thead>
                <tr>
                  <th>Ejecutivo</th>
                  <th>Validador asignado</th>
                  <th>Motivo</th>
                  <th>Asignó</th>
                  <th>Fecha</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {asigsEjec.map((a) => (
                  <tr key={a.id}>
                    <td>
                      {a.ejecutivo} <small>({a.ejecutivo_username})</small>
                    </td>
                    <td>
                      {a.validador} <small>({a.validador_username})</small>
                    </td>
                    <td>{a.motivo || "—"}</td>
                    <td>{a.asignador}</td>
                    <td>{a.creado_en}</td>
                    <td>
                      {a.activo === 1 ? (
                        <button
                          className="btn peligro"
                          onClick={async () => {
                            try {
                              await api.cerrarAsignacionEjecutivo(a.id);
                              setMensaje("Asignación cerrada: el ejecutivo vuelve al flujo simple.");
                              setError("");
                              cargar();
                            } catch (err) {
                              setError((err as Error).message);
                            }
                          }}
                        >
                          Cerrar
                        </button>
                      ) : (
                        <span style={{ color: "var(--tenue)" }}>Cerrada {a.cerrado_en ?? ""}</span>
                      )}
                    </td>
                  </tr>
                ))}
                {asigsEjec.length === 0 && (
                  <tr>
                    <td colSpan={6} className="vacio">
                      Sin asignaciones de ejecutivos: los validadores atienden el flujo simple.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p style={{ color: "var(--tenue)", fontSize: "0.82rem" }}>
            Si una operación tiene asignación vigente, sólo ese validador puede revisarla (§4.1). Sin
            asignación, cualquier validador del área puede revisarla (§4.2).
          </p>
        </>
      )}
    </>
  );
}

function VistaTesoreria({ usuario }: { usuario: Usuario }) {
  const esAdmin = usuario.rol === "admin_tesoreria";
  const esValidador = usuario.rol === "validador_tesoreria";
  const [aplicaciones, setAplicaciones] = useState<AplicacionRecurso[]>([]);
  const [depositos, setDepositos] = useState<Array<{
    movimiento_id: number;
    cuenta: string;
    fecha: string;
    concepto: string;
    disponible: number;
  }>>([]);
  const [cuentas, setCuentas] = useState<Cuenta[]>([]);
  const [tesoreros, setTesoreros] = useState<UsuarioAdmin[]>([]);
  const [coberturas, setCoberturas] = useState<Cobertura[]>([]);
  const [error, setError] = useState("");
  const [mensaje, setMensaje] = useState("");
  const [asig, setAsig] = useState({ cuenta: "", tesorero: "", motivo: "" });
  const [cob, setCob] = useState({ cuenta: "", habitual: "", temporal: "", inicio: "", fin: "", motivo: "" });
  const [apl, setApl] = useState({ movimiento: "", operacion: "", importe: "", observaciones: "" });
  const [pendientes, setPendientes] = useState<DepositoPendiente[]>([]);
  const [clientesRes, setClientesRes] = useState<Cliente[]>([]);
  const [depDir, setDepDir] = useState({
    cliente_id: "",
    cuenta_id: "",
    monto: "",
    comprobante: "",
    fecha: new Date().toISOString().slice(0, 10),
    observaciones: "",
  });
  const formato = (n: number) => n.toLocaleString("es-MX", { minimumFractionDigits: 2 });

  const cargar = () => {
    api
      .recursos()
      .then(({ aplicaciones }) => setAplicaciones(aplicaciones))
      .catch((err: Error) => setError(err.message));
    api
      .coberturas()
      .then(({ coberturas }) => setCoberturas(coberturas))
      .catch(() => setCoberturas([]));
    api
      .cuentas()
      .then(({ cuentas }) => setCuentas(cuentas))
      .catch(() => setCuentas([]));
    if (esValidador || esAdmin) {
      api
        .depositosDisponibles()
        .then(({ depositos }) => setDepositos(depositos.filter((d) => d.disponible > 0.005)))
        .catch(() => setDepositos([]));
      // Depósitos de clientes indicados por los ejecutivos, pendientes de validar.
      api
        .depositosPendientes()
        .then(({ depositos }) => setPendientes(depositos))
        .catch(() => setPendientes([]));
      // Clientes para el registro directo de depósitos al resguardo.
      api
        .clientes()
        .then(({ clientes }) => setClientesRes(clientes))
        .catch(() => setClientesRes([]));
    }
    if (esAdmin) {
      api
        .tesoreros()
        .then(({ tesoreros }) => setTesoreros(tesoreros))
        .catch(() => setTesoreros([]));
    }
  };

  useEffect(() => {
    cargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <h2>Tesorería — Recursos y asignaciones</h2>
      {error && <div className="error">{error}</div>}
      {mensaje && <div className="exito-msg">{mensaje}</div>}

      {/* Cuadre de respaldos por operación: lo que hay vs lo que se pagará. */}
      {(esValidador || esAdmin) && <PanelRespaldosOperaciones onError={setError} />}
      {/* Concentrado de movimientos bancarios (panel tipo Excel) con copia de
          trabajo de Tesorería: pegar estados de cuenta, marcar depósitos. */}
      <PanelConcentrado onError={setError} onOk={setMensaje} />
      {/* Resguardos de brokers: comisiones cobradas menos retiros. */}
      {(esValidador || esAdmin) && (
        <PanelBrokersResguardos puedeRetirar={esAdmin} onError={setError} onOk={setMensaje} />
      )}

      <div className="panel" style={{ marginBottom: "1rem" }}>
        <h3 style={{ marginTop: 0 }}>Aplicaciones de recursos (§5.2)</h3>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Operación</th>
              <th>Cuenta</th>
              <th style={{ textAlign: "right" }}>Importe</th>
              <th>Moneda</th>
              <th>Aplicó</th>
              <th>Fecha</th>
              <th>Estado</th>
              <th>Disponible del depósito</th>
              {esAdmin && <th>Acción</th>}
            </tr>
          </thead>
          <tbody>
            {aplicaciones.map((a) => (
              <tr key={a.id}>
                <td>{a.id}</td>
                <td>
                  {a.folio} <small style={{ color: "var(--tenue)" }}>({a.estado_operacion})</small>
                </td>
                <td>{a.cuenta}</td>
                <td style={{ textAlign: "right" }}>{formato(a.importe)}</td>
                <td>{a.moneda}</td>
                <td>{a.aplicador}</td>
                <td>{a.aplicado_en}</td>
                <td>
                  {a.liberado_por ? (
                    <span>
                      Liberada{a.liberador ? ` por ${a.liberador}` : ""}
                    </span>
                  ) : (
                    <strong>Vigente</strong>
                  )}
                </td>
                <td>{formato(a.disponible_movimiento)}</td>
                {esAdmin && (
                  <td>
                    {!a.liberado_por && (
                      <button
                        className="btn peligro"
                        onClick={async () => {
                          const motivo = window.prompt("Motivo de la liberación (requerido):");
                          if (!motivo) return;
                          try {
                            await api.liberarRecurso(a.id, motivo);
                            setMensaje(`Aplicación ${a.id} liberada (quien aplicó no puede liberarla: doble control §10).`);
                            setError("");
                            cargar();
                          } catch (err) {
                            setError((err as Error).message);
                          }
                        }}
                      >
                        Liberar
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
            {aplicaciones.length === 0 && (
              <tr>
                <td colSpan={esAdmin ? 10 : 9} className="vacio">
                  Sin aplicaciones registradas.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {esValidador && (
        <form
          className="panel"
          style={{ maxWidth: 720 }}
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api.aplicarRecurso({
                movimiento_id: Number(apl.movimiento),
                operacion_id: Number(apl.operacion),
                importe: Number(apl.importe),
                observaciones: apl.observaciones,
              });
              setMensaje("Recurso aplicado a la operación (queda registrado movimiento, operación, importe y usuario).");
              setError("");
              setApl({ movimiento: "", operacion: "", importe: "", observaciones: "" });
              cargar();
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        >
          <h3 style={{ marginTop: 0 }}>Aplicar recurso a operación</h3>
          <label>Depósito disponible</label>
          <select value={apl.movimiento} onChange={(e) => setApl({ ...apl, movimiento: e.target.value })} required>
            <option value="">— Selecciona depósito —</option>
            {depositos.map((d) => (
              <option key={d.movimiento_id} value={String(d.movimiento_id)}>
                #{d.movimiento_id} · {d.cuenta} · {d.fecha} · disponible {formato(d.disponible)} · {d.concepto}
              </option>
            ))}
          </select>
          <label>ID de la operación</label>
          <input
            type="number"
            min="1"
            value={apl.operacion}
            onChange={(e) => setApl({ ...apl, operacion: e.target.value })}
            required
          />
          <label>Importe a aplicar</label>
          <input
            type="number"
            step="0.01"
            min="0.01"
            value={apl.importe}
            onChange={(e) => setApl({ ...apl, importe: e.target.value })}
            required
          />
          <label>Observaciones (opcional)</label>
          <input value={apl.observaciones} onChange={(e) => setApl({ ...apl, observaciones: e.target.value })} />
          <button className="btn">Aplicar recurso</button>
          <p style={{ color: "var(--tenue)", fontSize: "0.82rem", marginBottom: 0 }}>
            El sistema impide la doble utilización: ni el depósito ni la operación pueden sobregirarse.
          </p>
        </form>
      )}

      {(esValidador || esAdmin) && (
        <>
          <div className="panel" style={{ marginBottom: "1rem" }}>
            <h3 style={{ marginTop: 0 }}>Depósitos de clientes por validar (resguardo §14)</h3>
            <p style={{ color: "var(--tenue)", fontSize: "0.85rem", margin: "0 0 0.6rem" }}>
              Los ejecutivos indicaron la cuenta y el comprobante del depósito del cliente. Al validar, el sistema
              registra el movimiento bancario y suma el monto al resguardo del cliente en una sola transacción.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Operación</th>
                  <th>Cliente</th>
                  <th>Cuenta indicada</th>
                  <th style={{ textAlign: "right" }}>Monto</th>
                  <th>Comprobante</th>
                  <th>Fecha depósito</th>
                  <th>Indicó</th>
                  <th>Acción</th>
                </tr>
              </thead>
              <tbody>
                {pendientes.map((d) => (
                  <tr key={d.id}>
                    <td>
                      {d.folio} <small style={{ color: "var(--tenue)" }}>({d.estado_operacion})</small>
                    </td>
                    <td>{d.cliente ?? "—"}</td>
                    <td>{d.cuenta}</td>
                    <td style={{ textAlign: "right" }}>{formato(d.monto)}</td>
                    <td>{d.comprobante}</td>
                    <td>{d.fecha_deposito}</td>
                    <td>{d.indicador}</td>
                    <td>
                      {esValidador && (
                        <button
                          className="btn exito"
                          onClick={async () => {
                            try {
                              const r = await api.validarDepositoId(d.id);
                              setMensaje(
                                `Depósito validado para ${d.folio}: resguardo del cliente ahora en ${r.saldo.toLocaleString("es-MX", { minimumFractionDigits: 2 })}.`
                              );
                              setError("");
                              cargar();
                            } catch (err) {
                              setError((err as Error).message);
                            }
                          }}
                        >
                          Validar
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {pendientes.length === 0 && (
                  <tr>
                    <td colSpan={8} className="vacio">
                      Sin depósitos pendientes de validar.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <form
            className="panel"
            style={{ maxWidth: 720 }}
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const r = await api.crearDepositoResguardo({
                  cliente_id: Number(depDir.cliente_id),
                  cuenta_id: Number(depDir.cuenta_id),
                  monto: Number(depDir.monto),
                  comprobante: depDir.comprobante,
                  fecha: depDir.fecha,
                  observaciones: depDir.observaciones,
                });
                setMensaje(
                  `Depósito registrado: resguardo del cliente ahora en ${r.saldo.toLocaleString("es-MX", { minimumFractionDigits: 2 })}.`
                );
                setError("");
                setDepDir({
                  cliente_id: "",
                  cuenta_id: "",
                  monto: "",
                  comprobante: "",
                  fecha: new Date().toISOString().slice(0, 10),
                  observaciones: "",
                });
                cargar();
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          >
            <h3 style={{ marginTop: 0 }}>Registrar depósito al resguardo del cliente</h3>
            <p style={{ color: "var(--tenue)", fontSize: "0.82rem", margin: "0 0 0.6rem" }}>
              Entrada de recursos confirmada directamente por Tesorería (sin operación asociada). Crea el movimiento
              bancario en la cuenta elegida y suma al resguardo.
            </p>
            <label>Cliente</label>
            <select
              value={depDir.cliente_id}
              onChange={(e) => setDepDir({ ...depDir, cliente_id: e.target.value })}
              required
            >
              <option value="">— Selecciona cliente —</option>
              {clientesRes.map((c) => (
                <option key={c.id} value={String(c.id)}>
                  {c.nombre}
                  {typeof c.resguardo === "number" ? ` (resguardo ${formato(c.resguardo)})` : ""}
                </option>
              ))}
            </select>
            <label>Cuenta bancaria donde entró el recurso</label>
            <select
              value={depDir.cuenta_id}
              onChange={(e) => setDepDir({ ...depDir, cuenta_id: e.target.value })}
              required
            >
              <option value="">— Selecciona cuenta —</option>
              {cuentas.map((c) => (
                <option key={c.id} value={String(c.id)}>
                  {c.nombre}
                </option>
              ))}
            </select>
            <div className="rejilla">
              <div>
                <label>Monto</label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={depDir.monto}
                  onChange={(e) => setDepDir({ ...depDir, monto: e.target.value })}
                  required
                />
              </div>
              <div>
                <label>Fecha</label>
                <input type="date" value={depDir.fecha} onChange={(e) => setDepDir({ ...depDir, fecha: e.target.value })} />
              </div>
            </div>
            <label>Comprobante (folio / referencia)</label>
            <input
              value={depDir.comprobante}
              onChange={(e) => setDepDir({ ...depDir, comprobante: e.target.value })}
              placeholder="Ej. SPEI-77120"
              required
            />
            <label>Observaciones (opcional)</label>
            <input value={depDir.observaciones} onChange={(e) => setDepDir({ ...depDir, observaciones: e.target.value })} />
            <button className="btn">Registrar depósito</button>
          </form>
        </>
      )}

      {esAdmin && (
        <>
          <div className="rejilla" style={{ marginTop: "1rem" }}>
            <form
              className="panel"
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await api.asignarCuenta(Number(asig.cuenta), Number(asig.tesorero), asig.motivo);
                  setMensaje("Cuenta asignada (la asignación anterior se conserva en el historial).");
                  setError("");
                  setAsig({ cuenta: "", tesorero: "", motivo: "" });
                  cargar();
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            >
              <h3 style={{ marginTop: 0 }}>Asignar cuenta a tesorero (§5.1)</h3>
              <label>Cuenta</label>
              <select value={asig.cuenta} onChange={(e) => setAsig({ ...asig, cuenta: e.target.value })} required>
                <option value="">— Selecciona cuenta —</option>
                {cuentas.map((c) => (
                  <option key={c.id} value={String(c.id)}>
                    {c.nombre}
                    {c.tesorero ? ` (actual: ${c.tesorero})` : ""}
                  </option>
                ))}
              </select>
              <label>Tesorero</label>
              <select value={asig.tesorero} onChange={(e) => setAsig({ ...asig, tesorero: e.target.value })} required>
                <option value="">— Selecciona tesorero —</option>
                {tesoreros.map((t) => (
                  <option key={t.id} value={String(t.id)}>
                    {t.nombre} ({t.username}){t.activo !== 1 ? " [desactivado]" : ""}
                  </option>
                ))}
              </select>
              <label>Motivo (opcional)</label>
              <input value={asig.motivo} onChange={(e) => setAsig({ ...asig, motivo: e.target.value })} />
              <button className="btn">Asignar / reasignar</button>
            </form>

            <form
              className="panel"
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await api.crearCobertura({
                    cuenta_id: Number(cob.cuenta),
                    tesorero_habitual_id: Number(cob.habitual),
                    tesorero_temporal_id: Number(cob.temporal),
                    fecha_inicio: cob.inicio,
                    fecha_fin: cob.fin ? cob.fin : null,
                    motivo: cob.motivo,
                  });
                  setMensaje("Cobertura temporal registrada (conserva el responsable habitual).");
                  setError("");
                  setCob({ cuenta: "", habitual: "", temporal: "", inicio: "", fin: "", motivo: "" });
                  cargar();
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            >
              <h3 style={{ marginTop: 0 }}>Cobertura temporal (00-VISION §6)</h3>
              <label>Cuenta</label>
              <select value={cob.cuenta} onChange={(e) => setCob({ ...cob, cuenta: e.target.value })} required>
                <option value="">— Selecciona cuenta —</option>
                {cuentas.map((c) => (
                  <option key={c.id} value={String(c.id)}>
                    {c.nombre}
                  </option>
                ))}
              </select>
              <label>Tesorero habitual</label>
              <select value={cob.habitual} onChange={(e) => setCob({ ...cob, habitual: e.target.value })} required>
                <option value="">— Selecciona —</option>
                {tesoreros.map((t) => (
                  <option key={t.id} value={String(t.id)}>
                    {t.nombre} ({t.username})
                  </option>
                ))}
              </select>
              <label>Tesorero temporal</label>
              <select value={cob.temporal} onChange={(e) => setCob({ ...cob, temporal: e.target.value })} required>
                <option value="">— Selecciona —</option>
                {tesoreros.map((t) => (
                  <option key={t.id} value={String(t.id)}>
                    {t.nombre} ({t.username})
                  </option>
                ))}
              </select>
              <div className="rejilla">
                <div>
                  <label>Desde</label>
                  <input type="date" value={cob.inicio} onChange={(e) => setCob({ ...cob, inicio: e.target.value })} required />
                </div>
                <div>
                  <label>Hasta (opcional)</label>
                  <input type="date" value={cob.fin} onChange={(e) => setCob({ ...cob, fin: e.target.value })} />
                </div>
              </div>
              <label>Motivo (vacaciones, permiso, incapacidad…)</label>
              <input value={cob.motivo} onChange={(e) => setCob({ ...cob, motivo: e.target.value })} />
              <button className="btn">Crear cobertura</button>
            </form>
          </div>

          {coberturas.length > 0 && (
            <div className="panel" style={{ marginTop: "1rem" }}>
              <h3 style={{ marginTop: 0 }}>Coberturas registradas</h3>
              <table>
                <thead>
                  <tr>
                    <th>Cuenta</th>
                    <th>Habitual</th>
                    <th>Temporal</th>
                    <th>Desde</th>
                    <th>Hasta</th>
                    <th>Motivo</th>
                    <th>Vigencia</th>
                  </tr>
                </thead>
                <tbody>
                  {coberturas.map((c) => (
                    <tr key={c.id}>
                      <td>{c.cuenta}</td>
                      <td>{c.habitual}</td>
                      <td>{c.temporal}</td>
                      <td>{c.fecha_inicio}</td>
                      <td>{c.fecha_fin ?? "—"}</td>
                      <td>{c.motivo || "—"}</td>
                      <td>
                        {!c.fecha_fin || c.fecha_fin >= new Date().toISOString().slice(0, 10) ? "Vigente" : "Concluida"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p style={{ color: "var(--tenue)", fontSize: "0.82rem" }}>
            Doble control (§10): quien aplicó un recurso no puede liberarlo; la liberación la hace otra
            persona (Administrador de Tesorería).
          </p>
        </>
      )}
    </>
  );
}

// =====================================================================
// Task 11 — Tesorería de depósitos: confirmador, comprobantes, concentrado
// bancario (panel tipo Excel) con copia de trabajo / versión limpia,
// resguardos de brokers y cuadre de respaldos por operación.
// =====================================================================

/** Descarga el contenido de un comprobante (base64 → archivo). */
async function descargarComprobante(id: number): Promise<void> {
  const { comprobante } = await api.comprobante(id);
  const binario = atob(comprobante.contenido_base64);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
  const blob = new Blob([bytes], { type: comprobante.mime || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const enlace = document.createElement("a");
  enlace.href = url;
  enlace.download = comprobante.nombre;
  document.body.appendChild(enlace);
  enlace.click();
  document.body.removeChild(enlace);
  URL.revokeObjectURL(url);
}

const esImagen = (mime: string) => mime.startsWith("image/");

/**
 * Celda de comprobantes de un depósito: lista los archivos adjuntos (ver /
 * descargar), permite adjuntar más (mientras el depósito esté pendiente) y
 * quitarlos. Sin al menos un comprobante Tesorería no puede validar el depósito.
 */
function CeldaComprobantes({
  deposito,
  puedeAdjuntar,
}: {
  deposito: DepositoOperacion;
  puedeAdjuntar: boolean;
}) {
  const [lista, setLista] = useState<ComprobanteDeposito[]>(deposito.comprobantes ?? []);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState("");

  const recargar = () =>
    api
      .comprobantesDeposito(deposito.id)
      .then(({ comprobantes }) => setLista(comprobantes))
      .catch((err: Error) => setError(err.message));

  useEffect(() => {
    recargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deposito.id]);

  const pendiente = deposito.validado_por === null;

  return (
    <div style={{ minWidth: 170 }}>
      {cargando ? <small>Procesando…</small> : null}
      {error && <small style={{ color: "var(--peligro, #c62828)" }}>{error}</small>}
      {lista.length === 0 && !cargando && (
        <small style={{ color: pendiente ? "var(--ambar, #b26a00)" : "var(--tenue)" }}>
          {pendiente ? "Sin comprobantes: no puede validarse" : "Sin comprobantes adjuntos"}
        </small>
      )}
      {lista.map((c) => (
        <div key={c.id} style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
          <button
            className="btn"
            style={{ padding: "0.1rem 0.5rem", fontSize: "0.78rem" }}
            title={`${c.nombre} · ${Math.max(1, Math.round(c.tamano / 1024))} KB`}
            onClick={async () => {
              setError("");
              setCargando(true);
              try {
                await descargarComprobante(c.id);
              } catch (err) {
                setError((err as Error).message);
              } finally {
                setCargando(false);
              }
            }}
          >
            {esImagen(c.mime) ? "Ver" : "Abrir"}
          </button>
          <small style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 160 }}>
            {c.nombre}
          </small>
          {puedeAdjuntar && pendiente && (
            <button
              className="btn peligro"
              style={{ padding: "0.1rem 0.4rem", fontSize: "0.75rem" }}
              title="Quitar comprobante"
              onClick={async () => {
                setError("");
                setCargando(true);
                try {
                  await api.quitarComprobante(c.id);
                  recargar();
                } catch (err) {
                  setError((err as Error).message);
                } finally {
                  setCargando(false);
                }
              }}
            >
              ×
            </button>
          )}
        </div>
      ))}
      {puedeAdjuntar && pendiente && lista.length < 10 && (
        <label className="btn" style={{ padding: "0.1rem 0.5rem", fontSize: "0.78rem", marginTop: "0.2rem" }}>
          + Adjuntar
          <input
            type="file"
            multiple
            accept="image/*,application/pdf"
            style={{ display: "none" }}
            onChange={async (e) => {
              const archivos = Array.from(e.target.files ?? []);
              e.target.value = "";
              if (!archivos.length) return;
              setError("");
              setCargando(true);
              try {
                const contenido = await Promise.all(
                  archivos.map(
                    (a) =>
                      new Promise<{ nombre: string; mime: string; contenido: string }>((resolver, rechazar) => {
                        const lector = new FileReader();
                        lector.onload = () =>
                          resolver({ nombre: a.name, mime: a.type || "application/octet-stream", contenido: String(lector.result) });
                        lector.onerror = () => rechazar(new Error(`No se pudo leer ${a.name}`));
                        lector.readAsDataURL(a);
                      })
                  )
                );
                await api.subirComprobantes(deposito.id, contenido);
                recargar();
              } catch (err) {
                setError((err as Error).message);
              } finally {
                setCargando(false);
              }
            }}
          />
        </label>
      )}
    </div>
  );
}

/**
 * Vista del Confirmador de Depósitos: su función principal es revisar los
 * depósitos que los ejecutivos indicaron, verificar los comprobantes adjuntos
 * y validarlos; además alimenta el concentrado bancario y marca con un
 * comentario los depósitos ya revisados en el listado de movimientos.
 */
function VistaConfirmacion({ usuario }: { usuario: Usuario }) {
  const [pendientes, setPendientes] = useState<DepositoPendiente[]>([]);
  const [error, setError] = useState("");
  const [mensaje, setMensaje] = useState("");

  const cargar = () =>
    api
      .depositosPendientes()
      .then(({ depositos }) => setPendientes(depositos))
      .catch((err: Error) => setError(err.message));

  useEffect(() => {
    cargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <h2>Confirmación de depósitos</h2>
      <p style={{ color: "var(--tenue)", fontSize: "0.87rem", marginTop: 0 }}>
        Revisa cada depósito indicado por el Ejecutivo, verifica sus comprobantes y confírmalo. Al validar, el
        movimiento bancario se registra en la cuenta y el monto suma al resguardo del cliente. Sin al menos un
        comprobante el depósito no puede confirmarse.
      </p>
      {error && <div className="error">{error}</div>}
      {mensaje && <div className="exito-msg">{mensaje}</div>}

      <div className="panel" style={{ marginBottom: "1rem" }}>
        <h3 style={{ marginTop: 0 }}>Depósitos por confirmar</h3>
        <table>
          <thead>
            <tr>
              <th>Operación</th>
              <th>Cliente</th>
              <th>Cuenta indicada</th>
              <th style={{ textAlign: "right" }}>Monto</th>
              <th style={{ textAlign: "right" }}>Monto operación</th>
              <th>Comprobante</th>
              <th>Fecha depósito</th>
              <th>Indicó</th>
              <th>Comprobantes</th>
              <th>Acción</th>
            </tr>
          </thead>
          <tbody>
            {pendientes.map((d) => {
              const sinComprobantes = (d.comprobantes_count ?? 0) === 0;
              return (
                <tr key={d.id}>
                  <td>
                    {d.folio} <small style={{ color: "var(--tenue)" }}>({d.estado_operacion})</small>
                  </td>
                  <td>{d.cliente ?? "—"}</td>
                  <td>{d.cuenta}</td>
                  <td style={{ textAlign: "right", fontWeight: 700 }}>${fmt(d.monto)}</td>
                  <td style={{ textAlign: "right" }}>${fmt(d.monto_operacion)}</td>
                  <td>{d.comprobante}</td>
                  <td>{d.fecha_deposito}</td>
                  <td>{d.indicador}</td>
                  <td>
                    <CeldaComprobantes deposito={d} puedeAdjuntar={false} />
                  </td>
                  <td>
                    <button
                      className="btn exito"
                      disabled={sinComprobantes}
                      title={sinComprobantes ? "El depósito no tiene comprobantes adjuntos" : "Confirmar depósito"}
                      onClick={async () => {
                        setError("");
                        try {
                          const r = await api.validarDepositoId(d.id);
                          setMensaje(
                            `Depósito confirmado para ${d.folio}: resguardo del cliente ahora en $${fmt(r.saldo)}.`
                          );
                          cargar();
                        } catch (err) {
                          setError((err as Error).message);
                        }
                      }}
                    >
                      Confirmar
                    </button>
                  </td>
                </tr>
              );
            })}
            {pendientes.length === 0 && (
              <tr>
                <td colSpan={10} className="vacio">
                  Sin depósitos pendientes de confirmar.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <PanelConcentrado onError={setError} onOk={setMensaje} />
      <PanelRespaldosOperaciones onError={setError} />
      <p style={{ color: "var(--tenue)", fontSize: "0.82rem" }}>
        Sesión: {usuario.nombre} — el Validador de Tesorería también puede confirmar depósitos, pero ésta es la
        función principal del Confirmador.
      </p>
    </>
  );
}

/** Fila de un lote bancario pegado desde el estado de cuenta (Excel). */
interface FilaBancaria {
  tipo: "deposito" | "retiro";
  monto: number;
  concepto: string;
  referencia: string;
  fecha: string;
}

const ES_FECHA = (t: string) => /^\d{4}-\d{2}-\d{2}$/.test(t) || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(t);

const normalizarFecha = (t: string): string => {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  const dm = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(t);
  if (dm) {
    const anio = dm[3].length === 2 ? `20${dm[3]}` : dm[3];
    return `${anio}-${dm[2].padStart(2, "0")}-${dm[1].padStart(2, "0")}`;
  }
  return "";
};

const ES_MONTO = (t: string) => /^-?\$?\s?-?[\d,]+(\.\d{1,2})?$/.test(t) && /[\d]/.test(t);

const parsearMonto = (t: string): number => {
  const limpio = t.replace(/[$\s]/g, "").replace(/,/g, "");
  const n = Number(limpio);
  return Number.isFinite(n) ? r2(Math.abs(n)) : NaN;
};

/**
 * Parser del panel bancario tipo Excel: acepta las filas pegadas del estado de
 * cuenta (TSV/CSV) con columnas variables (fecha, referencia, concepto, monto).
 * El monto negativo se interpreta como retiro; el positivo como depósito.
 */
export function parsearLoteBancario(texto: string): { filas: FilaBancaria[]; errores: string[] } {
  const filas: FilaBancaria[] = [];
  const errores: string[] = [];
  const lineas = texto
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const delim = ["\t", ";", "|", ","]
    .map((d) => ({ d, n: (texto.match(new RegExp(`\\${d}`, "g")) ?? []).length }))
    .sort((a, b) => b.n - a.n)[0]?.d ?? "\t";
  lineas.forEach((linea, idx) => {
    const num = idx + 1;
    const celdas = linea.split(delim).map((c) => c.trim());
    if (celdas.some((c) => c.toLowerCase() === "fecha")) return; // encabezado
    const cFecha = celdas.find((c) => ES_FECHA(c));
    const fecha = cFecha ? normalizarFecha(cFecha) : "";
    if (!fecha) {
      errores.push(`fila ${num}: no encuentro la fecha (usa YYYY-MM-DD o DD/MM/YYYY)`);
      return;
    }
    const idxMonto = [...celdas].reverse().findIndex((c) => ES_MONTO(c) && c !== cFecha);
    if (idxMonto === -1) {
      errores.push(`fila ${num}: no encuentro el monto`);
      return;
    }
    const cMonto = celdas[celdas.length - 1 - idxMonto];
    const crudo = cMonto.replace(/[$\s]/g, "");
    const monto = parsearMonto(cMonto);
    if (!Number.isFinite(monto) || monto <= 0) {
      errores.push(`fila ${num}: monto inválido (${cMonto})`);
      return;
    }
    const tipo: FilaBancaria["tipo"] = crudo.startsWith("-") ? "retiro" : "deposito";
    const restantes = celdas.filter((c) => c !== cFecha && c !== cMonto && c !== "");
    // De lo que queda: el folio corto alfanumérico es la referencia; el resto,
    // el concepto (si hay dos candidatos largos, el más largo es el concepto).
    let referencia = "";
    let concepto = "";
    const cortos = restantes.filter((c) => c.length <= 24);
    const largos = restantes.filter((c) => c.length > 24);
    if (cortos.length > 0 && largos.length > 0) {
      referencia = cortos[0];
      concepto = largos.join(" ");
    } else if (largos.length > 0) {
      concepto = largos.join(" ");
      referencia = cortos[0] ?? "";
    } else if (restantes.length > 0) {
      referencia = restantes[0];
      concepto = restantes.slice(1).join(" ") || restantes[0];
    }
    if (!concepto) {
      errores.push(`fila ${num}: no encuentro el concepto`);
      return;
    }
    filas.push({ tipo, monto, concepto: concepto.slice(0, 300), referencia: referencia.slice(0, 80), fecha });
  });
  return { filas, errores };
}

/**
 * Concentrado de movimientos bancarios de todas las cuentas (panel tipo Excel):
 * - modo "trabajo" (Tesorería, Validador y Confirmador): pega los estados de
 *   cuenta, agrega movimientos y MARCA los depósitos que cubren lo que los
 *   clientes indicaron (copia de trabajo de Tesorería).
 * - modo "lectura" (Dirección y Auditoría): la versión LIMPIA sin marcas.
 */
function PanelConcentrado({
  modo = "trabajo",
  onError,
  onOk,
}: {
  modo?: "trabajo" | "lectura";
  onError: (m: string) => void;
  onOk: (m: string) => void;
}) {
  const [movimientos, setMovimientos] = useState<MovimientoConcentrado[]>([]);
  const [versionLimpia, setVersionLimpia] = useState(false);
  const [cuentas, setCuentas] = useState<Cuenta[]>([]);
  const [filtros, setFiltros] = useState({ cuenta_id: "", desde: "", hasta: "", q: "" });
  // Alta individual
  const [alta, setAlta] = useState({
    cuenta_id: "",
    tipo: "deposito" as "deposito" | "retiro",
    monto: "",
    concepto: "",
    referencia: "",
    fecha: new Date().toISOString().slice(0, 10),
  });
  // Pegar lote (panel tipo Excel)
  const [pegado, setPegado] = useState({ cuenta_id: "", texto: "" });
  const [analisis, setAnalisis] = useState<{ filas: FilaBancaria[]; errores: string[] } | null>(null);
  // Marca de trabajo
  const [marcando, setMarcando] = useState<{ movimiento: MovimientoConcentrado; comentario: string; deposito_id: string } | null>(null);
  const [pendientesMarca, setPendientesMarca] = useState<DepositoPendiente[]>([]);

  const cargar = useCallback(() => {
    const f = filtros;
    api
      .movimientos({
        cuenta_id: f.cuenta_id ? Number(f.cuenta_id) : undefined,
        desde: f.desde || undefined,
        hasta: f.hasta || undefined,
        q: f.q || undefined,
      })
      .then(({ movimientos: filas, version_limpia }) => {
        setMovimientos(filas);
        setVersionLimpia(version_limpia);
      })
      .catch((err: Error) => onError(err.message));
    api
      .cuentas()
      .then(({ cuentas: lista }) => setCuentas(lista))
      .catch(() => setCuentas([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtros]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  const abrirMarca = async (m: MovimientoConcentrado) => {
    setMarcando({ movimiento: m, comentario: "", deposito_id: "" });
    api
      .depositosPendientes()
      .then(({ depositos }) => setPendientesMarca(depositos))
      .catch(() => setPendientesMarca([]));
  };

  return (
    <div className="panel" style={{ marginBottom: "1rem" }}>
      <h3 style={{ marginTop: 0 }}>
        Concentrado de movimientos bancarios{" "}
        {modo === "lectura" || versionLimpia ? (
          <span style={{ color: "var(--exito, #2e7d32)", fontSize: "0.85rem" }}>— versión LIMPIA (sin marcas de trabajo)</span>
        ) : (
          <span style={{ color: "var(--ambar, #b26a00)", fontSize: "0.85rem" }}>— copia de trabajo de Tesorería (con marcas)</span>
        )}
      </h3>
      <p style={{ color: "var(--tenue)", fontSize: "0.84rem", margin: "0 0 0.5rem" }}>
        {modo === "trabajo"
          ? "Pega aquí los últimos movimientos o todos los del mes de la banca asignada (desde Excel). El concentrado se usa para marcar los depósitos recibidos de los clientes; la versión limpia (sin marcas) es la que consulta Auditoría."
          : "Versión limpia del concentrado de todas las cuentas: constancia sin marcas de trabajo de Tesorería."}
      </p>

      <div className="barra">
        <select value={filtros.cuenta_id} onChange={(e) => setFiltros({ ...filtros, cuenta_id: e.target.value })} style={{ maxWidth: 220 }}>
          <option value="">Todas las cuentas</option>
          {cuentas.map((c) => (
            <option key={c.id} value={String(c.id)}>
              {c.nombre} ({ETIQUETAS_TIPO_CUENTA[c.tipo] ?? c.tipo})
            </option>
          ))}
        </select>
        <input type="date" value={filtros.desde} onChange={(e) => setFiltros({ ...filtros, desde: e.target.value })} title="Desde" />
        <input type="date" value={filtros.hasta} onChange={(e) => setFiltros({ ...filtros, hasta: e.target.value })} title="Hasta" />
        <input
          placeholder="Buscar concepto o referencia…"
          value={filtros.q}
          onChange={(e) => setFiltros({ ...filtros, q: e.target.value })}
          style={{ maxWidth: 220 }}
        />
        <button className="btn" onClick={cargar}>
          Actualizar
        </button>
      </div>

      <table>
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Cuenta</th>
            <th>Tipo</th>
            <th style={{ textAlign: "right" }}>Monto</th>
            <th>Concepto</th>
            <th>Referencia</th>
            <th>Origen</th>
            {modo === "trabajo" && <th>Marca de trabajo</th>}
            {modo === "trabajo" && <th>Acción</th>}
          </tr>
        </thead>
        <tbody>
          {movimientos.map((m) => (
            <tr key={m.id}>
              <td>{m.fecha}</td>
              <td>{m.cuenta}</td>
              <td>{m.tipo === "deposito" ? "Depósito" : "Retiro"}</td>
              <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                {m.tipo === "deposito" ? "+" : "−"}${fmt(m.monto)}
              </td>
              <td>{m.concepto}</td>
              <td>{m.referencia || "—"}</td>
              <td>
                <small>
                  {m.origen} · {m.creado_por_nombre}
                </small>
              </td>
              {modo === "trabajo" && (
                <td style={{ maxWidth: 260 }}>
                  {m.marca || m.deposito_id ? (
                    <>
                      {m.deposito_id ? (
                        <small style={{ display: "block" }}>
                          Depósito #{m.deposito_id} — {m.deposito_folio ?? ""}
                          {m.deposito_cliente ? ` (${m.deposito_cliente})` : ""}
                        </small>
                      ) : null}
                      {m.marca ? (
                        <small style={{ display: "block" }}>
                          “{m.marca}” {m.marcado_por_nombre ? `— ${m.marcado_por_nombre}` : ""}
                        </small>
                      ) : null}
                      <button
                        className="btn peligro"
                        style={{ padding: "0.05rem 0.4rem", fontSize: "0.72rem" }}
                        onClick={async () => {
                          onError("");
                          try {
                            await api.desmarcarMovimiento(m.id);
                            onOk("Marca quitada del movimiento.");
                            cargar();
                          } catch (err) {
                            onError((err as Error).message);
                          }
                        }}
                      >
                        Quitar marca
                      </button>
                    </>
                  ) : (
                    <span style={{ color: "var(--tenue)" }}>—</span>
                  )}
                </td>
              )}
              {modo === "trabajo" && (
                <td>
                  <button className="btn" style={{ padding: "0.1rem 0.5rem", fontSize: "0.78rem" }} onClick={() => void abrirMarca(m)}>
                    {m.marca ? "Editar marca" : "Marcar"}
                  </button>
                </td>
              )}
            </tr>
          ))}
          {movimientos.length === 0 && (
            <tr>
              <td colSpan={modo === "trabajo" ? 9 : 7} className="vacio">
                Sin movimientos en el concentrado.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {marcando && (
        <form
          className="panel"
          style={{ background: "var(--fondo-suave, #f4f4f4)", maxWidth: 720, marginTop: "0.6rem" }}
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api.marcarMovimiento(marcando.movimiento.id, {
                ...(marcando.deposito_id ? { deposito_id: Number(marcando.deposito_id) } : {}),
                comentario: marcando.comentario,
              });
              onOk("Movimiento marcado (queda en bitácora).");
              setMarcando(null);
              cargar();
            } catch (err) {
              onError((err as Error).message);
            }
          }}
        >
          <h4 style={{ marginTop: 0 }}>Marcar movimiento #{marcando.movimiento.id} ({marcando.movimiento.cuenta})</h4>
          <p style={{ color: "var(--tenue)", fontSize: "0.82rem", margin: "0 0 0.4rem" }}>
            Liga este movimiento bancario con el depósito del cliente que cubre y deja tu comentario de confirmación.
            {marcando.movimiento.tipo !== "deposito" && " Sólo los movimientos de tipo DEPÓSITO se ligan a un depósito del cliente."}
          </p>
          <label>Comentario de confirmación</label>
          <input
            value={marcando.comentario}
            onChange={(e) => setMarcando({ ...marcando, comentario: e.target.value })}
            placeholder="Ej. Confirmado contra ficha SPEI del cliente"
          />
          {marcando.movimiento.tipo === "deposito" && (
            <>
              <label>Depósito del cliente que cubre (opcional)</label>
              <select
                value={marcando.deposito_id}
                onChange={(e) => setMarcando({ ...marcando, deposito_id: e.target.value })}
              >
                <option value="">— Sin ligar a un depósito —</option>
                {pendientesMarca.map((d) => (
                  <option key={d.id} value={String(d.id)}>
                    #{d.id} · {d.folio} · {d.cliente ?? "—"} · ${fmt(d.monto)} · {d.comprobante}
                  </option>
                ))}
              </select>
              {pendientesMarca.length === 0 && (
                <input
                  placeholder="…o escribe el ID del depósito indicado (opcional)"
                  value={marcando.deposito_id}
                  onChange={(e) => setMarcando({ ...marcando, deposito_id: e.target.value.replace(/\D/g, "") })}
                />
              )}
            </>
          )}
          <div className="barra">
            <button className="btn exito">Guardar marca</button>
            <button type="button" className="btn" onClick={() => setMarcando(null)}>
              Cancelar
            </button>
          </div>
        </form>
      )}

      {modo === "trabajo" && (
        <>
          <h4 style={{ marginBottom: "0.2rem" }}>Pegar movimientos del estado de cuenta (Excel)</h4>
          <div className="rejilla">
            <div>
              <label>Cuenta bancaria de los movimientos</label>
              <select value={pegado.cuenta_id} onChange={(e) => setPegado({ ...pegado, cuenta_id: e.target.value })}>
                <option value="">— Selecciona cuenta —</option>
                {cuentas.map((c) => (
                  <option key={c.id} value={String(c.id)}>
                    {c.nombre} ({ETIQUETAS_TIPO_CUENTA[c.tipo] ?? c.tipo})
                  </option>
                ))}
              </select>
            </div>
          </div>
          <label>Pega las filas del banco (una por movimiento; monto negativo = retiro)</label>
          <textarea
            rows={6}
            value={pegado.texto}
            onChange={(e) => {
              setPegado({ ...pegado, texto: e.target.value });
              setAnalisis(null);
            }}
            placeholder={"2026-10-26\tSPEI-77120\tSPEI RECIBIDO CLIENTE SA\t$770,000.00\n26/10/2026\tCOM-12\tComisión banco\t-19,250.00"}
            style={{ width: "100%", fontFamily: "monospace", fontSize: "0.85rem" }}
          />
          <div className="barra">
            <button className="btn" onClick={() => setAnalisis(parsearLoteBancario(pegado.texto))} disabled={!pegado.texto.trim()}>
              Analizar
            </button>
            {analisis && analisis.filas.length > 0 && (
              <button
                className="btn exito"
                onClick={async () => {
                  if (!pegado.cuenta_id) {
                    onError("Elige la cuenta bancaria de los movimientos pegados.");
                    return;
                  }
                  try {
                    const r = await api.movimientosLote(Number(pegado.cuenta_id), analisis.filas);
                    onOk(`${r.insertados} movimiento(s) insertados al concentrado.`);
                    setPegado({ cuenta_id: "", texto: "" });
                    setAnalisis(null);
                    cargar();
                  } catch (err) {
                    onError((err as Error).message);
                  }
                }}
              >
                Insertar {analisis.filas.length} movimiento(s)
              </button>
            )}
          </div>
          {analisis && (
            <>
              {analisis.errores.length > 0 && (
                <div className="error">
                  {analisis.errores.slice(0, 6).map((e, i) => (
                    <div key={i}>· {e}</div>
                  ))}
                </div>
              )}
              {analisis.filas.length > 0 && (
                <table style={{ maxWidth: 860 }}>
                  <thead>
                    <tr>
                      <th>Fecha</th>
                      <th>Tipo</th>
                      <th style={{ textAlign: "right" }}>Monto</th>
                      <th>Concepto</th>
                      <th>Referencia</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analisis.filas.map((f, i) => (
                      <tr key={i}>
                        <td>{f.fecha}</td>
                        <td>{f.tipo === "deposito" ? "Depósito" : "Retiro"}</td>
                        <td style={{ textAlign: "right" }}>${fmt(f.monto)}</td>
                        <td>{f.concepto}</td>
                        <td>{f.referencia || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}

          <h4 style={{ marginBottom: "0.2rem", marginTop: "0.8rem" }}>Agregar un movimiento</h4>
          <form
            className="barra"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!alta.cuenta_id) {
                onError("Elige la cuenta bancaria.");
                return;
              }
              try {
                await api.crearMovimiento(Number(alta.cuenta_id), {
                  tipo: alta.tipo,
                  monto: Number(alta.monto),
                  concepto: alta.concepto,
                  referencia: alta.referencia,
                  fecha: alta.fecha,
                });
                onOk("Movimiento agregado al concentrado.");
                setAlta({ ...alta, monto: "", concepto: "", referencia: "" });
                cargar();
              } catch (err) {
                onError((err as Error).message);
              }
            }}
          >
            <select value={alta.cuenta_id} onChange={(e) => setAlta({ ...alta, cuenta_id: e.target.value })} style={{ maxWidth: 220 }}>
              <option value="">— Cuenta —</option>
              {cuentas.map((c) => (
                <option key={c.id} value={String(c.id)}>
                  {c.nombre}
                </option>
              ))}
            </select>
            <select value={alta.tipo} onChange={(e) => setAlta({ ...alta, tipo: e.target.value as "deposito" | "retiro" })}>
              <option value="deposito">Depósito</option>
              <option value="retiro">Retiro</option>
            </select>
            <input type="number" step="0.01" min="0.01" placeholder="Monto" value={alta.monto} onChange={(e) => setAlta({ ...alta, monto: e.target.value })} required style={{ maxWidth: 140 }} />
            <input placeholder="Concepto" value={alta.concepto} onChange={(e) => setAlta({ ...alta, concepto: e.target.value })} required style={{ maxWidth: 220 }} />
            <input placeholder="Referencia" value={alta.referencia} onChange={(e) => setAlta({ ...alta, referencia: e.target.value })} style={{ maxWidth: 140 }} />
            <input type="date" value={alta.fecha} onChange={(e) => setAlta({ ...alta, fecha: e.target.value })} />
            <button className="btn">Agregar</button>
          </form>
        </>
      )}
    </div>
  );
}

/**
 * Listado de operaciones con sus respaldos y el cuadre: resguardo del cliente +
 * depósitos validados + financiamientos aprobados contra el monto de la
 * operación. Lo consulta el Validador para revisar que todo cuadre y que los
 * resguardos se afecten correctamente (también Confirmador y Dirección).
 */
function PanelRespaldosOperaciones({ onError }: { onError: (m: string) => void }) {
  const [filas, setFilas] = useState<FilaRespaldoOperacion[]>([]);
  const [error, setError] = useState("");

  const cargar = useCallback(() => {
    api
      .operacionesRespaldos()
      .then(({ operaciones }) => setFilas(operaciones))
      .catch((err: Error) => {
        setError(err.message);
        onError(err.message);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    cargar();
  }, [cargar]);

  return (
    <div className="panel" style={{ marginBottom: "1rem" }}>
      <div className="barra" style={{ alignItems: "center" }}>
        <h3 style={{ margin: 0 }}>Operaciones y respaldos (cuadre)</h3>
        <button className="btn" onClick={cargar}>
          Actualizar
        </button>
      </div>
      <p style={{ color: "var(--tenue)", fontSize: "0.84rem", margin: "0 0 0.5rem" }}>
        Resguardo del cliente + depósitos validados + financiamientos aprobados contra el monto. Revísalo para
        verificar que todo cuadre y que los resguardos se afecten correctamente; los depósitos sin comprobante no
        pueden validarse.
      </p>
      {error && <div className="error">{error}</div>}
      <table>
        <thead>
          <tr>
            <th>Folio</th>
            <th>Estado</th>
            <th>Cliente</th>
            <th style={{ textAlign: "right" }}>Monto</th>
            <th style={{ textAlign: "right" }}>Resguardo</th>
            <th style={{ textAlign: "right" }}>Dep. pendientes</th>
            <th style={{ textAlign: "right" }}>Dep. validados</th>
            <th style={{ textAlign: "right" }}>Fin. por aprobar</th>
            <th style={{ textAlign: "right" }}>Fin. aprobado</th>
            <th>Respaldo sólido</th>
            <th>Cuadre</th>
          </tr>
        </thead>
        <tbody>
          {filas.map((f) => (
            <tr key={f.id}>
              <td>{f.folio}</td>
              <td>{ETIQUETAS_ESTADO[f.estado] ?? f.estado}</td>
              <td>{f.cliente ?? "—"}</td>
              <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>${fmt(f.monto)}</td>
              <td style={{ textAlign: "right" }}>${fmt(f.resguardo_saldo)}</td>
              <td style={{ textAlign: "right" }}>
                ${fmt(f.depositos_pendientes)}
                {f.depositos_sin_comprobante > 0 ? (
                  <small style={{ color: "var(--ambar, #b26a00)" }}> ({f.depositos_sin_comprobante} sin comprobante)</small>
                ) : null}
              </td>
              <td style={{ textAlign: "right" }}>${fmt(f.depositos_validados)}</td>
              <td style={{ textAlign: "right" }}>${fmt(f.financiamiento_solicitado)}</td>
              <td style={{ textAlign: "right" }}>${fmt(f.financiamiento_aprobado)}</td>
              <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>${fmt(f.respaldo_solido)}</td>
              <td>
                {f.cuadre ? (
                  <span style={{ color: "var(--exito, #2e7d32)", fontWeight: 700 }}>CUADRA</span>
                ) : (
                  <span style={{ color: "var(--peligro, #c62828)", fontWeight: 700 }}>NO CUADRA</span>
                )}
              </td>
            </tr>
          ))}
          {filas.length === 0 && (
            <tr>
              <td colSpan={11} className="vacio">
                Sin operaciones con respaldo por revisar.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Resguardos de brokers: por cada comisión cobrada (cuando una operación queda
 * PAGADA) el broker acumula resguardo; los retiros (pagos de comisión al
 * broker) lo disminuyen. El retiro lo registran admin_tesoreria / admin /
 * admin_operaciones.
 */
function PanelBrokersResguardos({
  puedeRetirar,
  onError,
  onOk,
}: {
  puedeRetirar: boolean;
  onError: (m: string) => void;
  onOk: (m: string) => void;
}) {
  const [resguardos, setResguardos] = useState<ResguardoBroker[]>([]);
  const [retiro, setRetiro] = useState<{ broker_id: string; monto: string; notas: string }>({
    broker_id: "",
    monto: "",
    notas: "",
  });

  const cargar = useCallback(() => {
    api
      .resguardosBrokers()
      .then(({ resguardos: filas }) => setResguardos(filas))
      .catch((err: Error) => onError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    cargar();
  }, [cargar]);

  return (
    <div className="panel" style={{ marginBottom: "1rem" }}>
      <div className="barra" style={{ alignItems: "center" }}>
        <h3 style={{ margin: 0 }}>Resguardos de brokers (comisiones cobradas)</h3>
        <button className="btn" onClick={cargar}>
          Actualizar
        </button>
      </div>
      <p style={{ color: "var(--tenue)", fontSize: "0.84rem", margin: "0 0 0.5rem" }}>
        Cuando una operación queda PAGADA, la parte de la comisión de cada broker participante entra a su resguardo;
        se actualizan con las operaciones. El retiro de comisiones lo registran el Administrador de Tesorería, el de
        Operaciones o el Administrador del sistema.
      </p>
      <table>
        <thead>
          <tr>
            <th>Broker</th>
            <th style={{ textAlign: "right" }}>% de comisión</th>
            <th style={{ textAlign: "right" }}>Comisiones</th>
            <th style={{ textAlign: "right" }}>Retiros</th>
            <th style={{ textAlign: "right" }}>Saldo en resguardo</th>
            <th>Últimos movimientos</th>
          </tr>
        </thead>
        <tbody>
          {resguardos.map((r) => (
            <tr key={r.broker_id}>
              <td>
                {r.nombre}
                {r.activo !== 1 ? <small style={{ color: "var(--tenue)" }}> (inactivo)</small> : null}
              </td>
              <td style={{ textAlign: "right" }}>{r.porcentaje.toFixed(2)}%</td>
              <td style={{ textAlign: "right" }}>${fmt(r.comisiones)}</td>
              <td style={{ textAlign: "right" }}>${fmt(r.retiros)}</td>
              <td style={{ textAlign: "right", fontWeight: 700 }}>${fmt(r.saldo)}</td>
              <td>
                {r.movimientos.length === 0 ? (
                  <small style={{ color: "var(--tenue)" }}>Sin movimientos aún.</small>
                ) : (
                  <ul style={{ margin: 0, paddingLeft: "1rem", fontSize: "0.8rem" }}>
                    {r.movimientos.slice(0, 4).map((m) => (
                      <li key={m.id}>
                        {m.tipo === "comision" ? "Comisión" : "Retiro"} ${fmt(m.importe)}
                        {m.folio ? ` · ${m.folio}` : ""}
                        {m.notas ? ` · ${m.notas}` : ""}
                      </li>
                    ))}
                  </ul>
                )}
              </td>
            </tr>
          ))}
          {resguardos.length === 0 && (
            <tr>
              <td colSpan={6} className="vacio">
                Sin brokers en el catálogo (los da de alta el Administrador de Operaciones).
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {puedeRetirar && (
        <form
          className="barra"
          style={{ marginTop: "0.5rem" }}
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const r = await api.retiroBroker(Number(retiro.broker_id), {
                monto: Number(retiro.monto),
                notas: retiro.notas,
              });
              onOk(`Retiro registrado; saldo del broker ahora en $${fmt(r.saldo)}.`);
              setRetiro({ broker_id: "", monto: "", notas: "" });
              cargar();
            } catch (err) {
              onError((err as Error).message);
            }
          }}
        >
          <select value={retiro.broker_id} onChange={(e) => setRetiro({ ...retiro, broker_id: e.target.value })} required style={{ maxWidth: 220 }}>
            <option value="">— Broker —</option>
            {resguardos.map((r) => (
              <option key={r.broker_id} value={String(r.broker_id)}>
                {r.nombre} (saldo ${fmt(r.saldo)})
              </option>
            ))}
          </select>
          <input
            type="number"
            step="0.01"
            min="0.01"
            placeholder="Monto del retiro"
            value={retiro.monto}
            onChange={(e) => setRetiro({ ...retiro, monto: e.target.value })}
            required
            style={{ maxWidth: 150 }}
          />
          <input placeholder="Notas (pago de comisión, semana 42…)" value={retiro.notas} onChange={(e) => setRetiro({ ...retiro, notas: e.target.value })} />
          <button className="btn">Registrar retiro</button>
        </form>
      )}
    </div>
  );
}
