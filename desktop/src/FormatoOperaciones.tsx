import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import {
  descargarPlantillaDispersiones,
  leerFilas,
  mapearDispersiones,
  type LineaLayout,
} from "./layout";
import type { Broker, Cliente, CuentaCatalogo, EstructuraCatalogo, Usuario } from "./tipos";

/**
 * FORMATO DE OPERACIONES (captura de flujo) — reproduce el formato de Excel
 * del negocio: secciones A (fecha/deposito/frente/banco/monto), B (cliente/
 * razón social/RFC/ejecutivo/brokers), C (pagadora/tipo/timbrar/comisión),
 * D (cálculos: IVA, neto, comisiones, resguardo, devolución, flujo total),
 * la tabla de DISPERSIÓN con los encabezados del formato (se agregan filas
 * con el botón "+ Agregar fila" o importando el layout) y la barra de
 * comprobación (Total / VERDADERO-FALSO / diferencia a favor o en contra).
 * Reemplaza por completo al formulario anterior.
 */

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const fmt = (n: number) => n.toLocaleString("es-MX", { minimumFractionDigits: 2 });

/** Cuenta del catálogo elegida en un select de pagadora/frente ("c<id>"). */
function pagadoraElegidaCuenta(catalogo: CuentaCatalogo[], sel: string): number | null {
  if (!sel.startsWith("c")) return null;
  const c = catalogo.find((x) => `c${x.id}` === sel);
  return c ? c.id : null;
}

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
  rfc: "",
  importe: NaN,
  pagadora: "",
  pagadora_cuenta_id: null,
});

const HOY = () => new Date().toISOString().slice(0, 10);
const ZOOM_MIN = 0.6;
const ZOOM_MAX = 1.5;

/** Nivel de zoom del formato (se recuerda entre sesiones en localStorage). */
const leerZoom = (): number => {
  const v = Number(localStorage.getItem("fmt-zoom"));
  return Number.isFinite(v) && v >= ZOOM_MIN && v <= ZOOM_MAX ? v : 1;
};

interface DestinoSel {
  cuenta_id: number | null;
  tipo: string;
  nombre: string;
  manejo_manual: boolean;
}

/** Convierte la selección del catálogo al payload `destinos` de la API. */
const destinosAPayload = (seleccion: Record<string, DestinoSel>) =>
  Object.values(seleccion).map((d) => ({
    ...(d.cuenta_id !== null ? { cuenta_id: d.cuenta_id } : {}),
    tipo: d.tipo,
    manejo_manual: d.manejo_manual,
  }));

/** ¿La fila de dispersión tiene algún dato capturado? (para no guardar filas vacías) */
const filaConDatos = (d: LineaLayout): boolean =>
  d.beneficiario.trim() !== "" ||
  d.nombre.trim() !== "" ||
  d.apellido_paterno.trim() !== "" ||
  d.apellido_materno.trim() !== "" ||
  d.razon_social.trim() !== "" ||
  d.concepto.trim() !== "" ||
  d.referencia.trim() !== "" ||
  d.rfc.trim() !== "" ||
  d.tarjeta.trim() !== "" ||
  d.cuenta.trim() !== "" ||
  d.clabe.trim() !== "" ||
  d.banco.trim() !== "" ||
  (Number.isFinite(d.importe) && d.importe > 0);

export default function FormatoOperaciones({
  onCreada,
  onError,
  usuario,
  onPagoEspecial,
}: {
  onCreada: () => void;
  onError: (m: string) => void;
  usuario: Usuario;
  onPagoEspecial: () => void;
}) {
  const [guardando, setGuardando] = useState(false);
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [clienteId, setClienteId] = useState("");
  const [rsCliente, setRsCliente] = useState("");
  const [brokers, setBrokers] = useState<Broker[]>([]);
  // 4 ranuras de broker (Broker 1..4 del formato): broker + % de la comisión.
  const [slots, setSlots] = useState<Array<{ brokerId: string; pct: string }>>([
    { brokerId: "", pct: "" },
    { brokerId: "", pct: "" },
    { brokerId: "", pct: "" },
    { brokerId: "", pct: "" },
  ]);
  const [timbrar, setTimbrar] = useState(false);
  const [observaciones, setObservaciones] = useState("");
  const [monto, setMonto] = useState("");
  const [comisionPct, setComisionPct] = useState("2.50");
  const [fecha, setFecha] = useState(new Date().toISOString().slice(0, 10));
  const [fechaDeposito, setFechaDeposito] = useState("");
  // Empresa frente: RESGUARDO (por omisión) o una cuenta tipo "frente" del catálogo.
  const [frenteSel, setFrenteSel] = useState("resguardo");
  // Pagadora de la operación (catálogo de Tesorería) o CUALQUIER FLUJO.
  const [pagadoraSel, setPagadoraSel] = useState("");
  // Banco donde depositó el cliente (catálogo de cuentas) + fecha del depósito.
  const [bancoDeposito, setBancoDeposito] = useState("");
  const [archivosDeposito, setArchivosDeposito] = useState<File[]>([]);
  const [bancoComprobacion, setBancoComprobacion] = useState("MGN INTRUST");
  const [dispersiones, setDispersiones] = useState<LineaLayout[]>([VACIA()]);
  const [erroresLayout, setErroresLayout] = useState<string[]>([]);
  const [cuentasCat, setCuentasCat] = useState<CuentaCatalogo[]>([]);
  const [saldoCliente, setSaldoCliente] = useState(0);
  // Zoom del formato: alejar para ver la operación completa, acercar para capturar.
  const [zoom, setZoom] = useState(leerZoom);
  const [folioGuardado, setFolioGuardado] = useState("");
  // Actualización funcional: varios clics seguidos siempre avanzan un paso.
  const ajustarZoom = (delta: number) =>
    setZoom((prev) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round((prev + delta) * 100) / 100)));
  const restablecerZoom = () => setZoom(1);
  // La preferencia de zoom se recuerda entre sesiones.
  useEffect(() => {
    localStorage.setItem("fmt-zoom", String(zoom));
  }, [zoom]);

  useEffect(() => {
    api.clientes().then(({ clientes }) => setClientes(clientes)).catch(() => setClientes([]));
    api.brokers().then(({ brokers }) => setBrokers(brokers)).catch(() => setBrokers([]));
  }, []);
  useEffect(() => {
    api.cuentasCatalogo().then(({ cuentas }) => setCuentasCat(cuentas)).catch(() => setCuentasCat([]));
  }, []);
  useEffect(() => {
    if (!clienteId) {
      setSaldoCliente(0);
      return;
    }
    api.resguardo(Number(clienteId)).then((r) => setSaldoCliente(r.saldo)).catch(() => setSaldoCliente(0));
  }, [clienteId]);
  // Fase 14: la comisión preestablecida del cliente se rellena sola.
  const clienteSel = clientes.find((c) => String(c.id) === clienteId) ?? null;
  useEffect(() => {
    if (clienteSel?.comision_broker_pct != null) setComisionPct(String(clienteSel.comision_broker_pct));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clienteSel?.comision_broker_pct]);

  const catalogoPagadoras = useMemo(() => cuentasCat.filter((c) => c.visible_operador !== 0), [cuentasCat]);
  const frentes = useMemo(() => catalogoPagadoras.filter((c) => c.tipo === "frente"), [catalogoPagadoras]);

  // Estructuras de cuentas (Contaduría): el catálogo del negocio ligado a la
  // captura — al elegir pagadora/frente se muestra su estructura (giro,
  // importe máximo por mes) y queda disponible como referencia.
  const [estructurasCat, setEstructurasCat] = useState<EstructuraCatalogo[]>([]);
  useEffect(() => {
    api
      .catalogoEstructuras()
      .then(({ estructuras }) => setEstructurasCat(estructuras))
      .catch(() => setEstructurasCat([]));
  }, []);
  const estructuraPagadora = useMemo(() => {
    const pid = pagadoraElegidaCuenta(catalogoPagadoras, pagadoraSel);
    return (pid && estructurasCat.find((e) => e.cuenta_id === pid)) || null;
  }, [pagadoraSel, catalogoPagadoras, estructurasCat]);
  const estructuraFrente = useMemo(() => {
    const fid = pagadoraElegidaCuenta(catalogoPagadoras, frenteSel);
    return (fid && estructurasCat.find((e) => e.cuenta_id === fid)) || null;
  }, [frenteSel, catalogoPagadoras, estructurasCat]);

  const pagadoraElegida: DestinoSel | null = useMemo(() => {
    if (!pagadoraSel) return null;
    if (pagadoraSel === "tflujo")
      return { cuenta_id: null, tipo: "flujo", nombre: "CUALQUIER FLUJO", manejo_manual: false };
    const c = catalogoPagadoras.find((x) => `c${x.id}` === pagadoraSel);
    return c ? { cuenta_id: c.id, tipo: c.tipo ?? "flujo", nombre: c.nombre, manejo_manual: false } : null;
  }, [pagadoraSel, catalogoPagadoras]);

  const frenteElegido: DestinoSel | null = useMemo(() => {
    if (!frenteSel.startsWith("c")) return null;
    const c = frentes.find((x) => `c${x.id}` === frenteSel);
    return c ? { cuenta_id: c.id, tipo: c.tipo ?? "frente", nombre: c.nombre, manejo_manual: false } : null;
  }, [frenteSel, frentes]);

  const destinosSel = useMemo(() => {
    const d: Record<string, DestinoSel> = {};
    if (frenteElegido) d[`c${frenteElegido.cuenta_id}`] = frenteElegido;
    if (pagadoraElegida) d[pagadoraElegida.cuenta_id !== null ? `c${pagadoraElegida.cuenta_id}` : `t${pagadoraElegida.tipo}`] = pagadoraElegida;
    return d;
  }, [frenteElegido, pagadoraElegida]);

  // ---- Cálculos del formato (misma lógica del negocio) ----
  const montoNum = Number(monto) || 0;
  const pctNum = Number(comisionPct) || 0;
  const iva = r2((montoNum * 16) / 116);
  const neto = r2((montoNum * 100) / 116);
  const comisionTotalOp = r2((montoNum * pctNum) / 100);
  const filas = useMemo(() => dispersiones.filter(filaConDatos), [dispersiones]);
  const flujoTotal = r2(filas.reduce((s, d) => s + (Number.isFinite(d.importe) ? d.importe : 0), 0));
  const devolucion = r2(flujoTotal - comisionTotalOp);
  const diferencia = r2(montoNum - flujoTotal);
  const comprobacionOk = diferencia >= -0.005;
  const resguardoSobrante = r2(Math.max(diferencia, 0));
  const brokersElegidos = slots
    .map((s) => ({ broker: brokers.find((b) => String(b.id) === s.brokerId), pct: Number(s.pct) || 0 }))
    .filter((x) => x.broker);
  const sumaBrokersPct = r2(brokersElegidos.reduce((s, x) => s + x.pct, 0));
  const comisionBroker = (pct: number) => r2((comisionTotalOp * pct) / 100);

  // ---- Respaldo (§6.1): saldo del resguardo + el depósito del formato ----
  const cuentaDeposito = cuentasCat.find((c) => `c${c.id}` === bancoDeposito) ?? null;
  const hayDeposito = !!clienteId && !!cuentaDeposito && !!fechaDeposito && montoNum > 0;
  const disponibleResp = r2(saldoCliente + (hayDeposito ? montoNum : 0));
  const faltanteRespaldo = r2(flujoTotal - disponibleResp);
  const respaldoOk = !clienteId || faltanteRespaldo <= 0.005;

  /** Edita una celda de la fila i; paterno/materno/nombre rellenan el NOMBRE completo. */
  const editarFila = (i: number, campo: keyof LineaLayout, valor: string) => {
    setDispersiones((prev) =>
      prev.map((d, j) => {
        if (j !== i) return d;
        const fila = { ...d, [campo]: valor } as LineaLayout;
        if (campo === "apellido_paterno" || campo === "apellido_materno" || campo === "nombre") {
          fila.beneficiario =
            `${fila.apellido_paterno} ${fila.apellido_materno} ${fila.nombre}`.replace(/\s+/g, " ").trim();
        }
        return fila;
      })
    );
  };

  const importarLayout = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const archivo = e.target.files?.[0];
    e.target.value = "";
    if (!archivo) return;
    try {
      const filasLayout = await leerFilas(archivo);
      const r = mapearDispersiones(filasLayout, catalogoPagadoras);
      setErroresLayout(r.errores);
      if (r.filas.length)
        setDispersiones((prev) => [...prev.filter(filaConDatos), ...r.filas, VACIA()]);
    } catch (err) {
      setErroresLayout([(err as Error).message]);
    }
  };

  const validarLocal = (): string[] => {
    const e: string[] = [];
    if (montoNum <= 0) e.push("captura el Monto Pagado (sección A)");
    if (!pagadoraElegida) e.push("selecciona la Pagadora (sección C)");
    if (filas.length === 0) e.push("agrega al menos una fila en la Dispersión");
    filas.forEach((d, i) => {
      if (!d.beneficiario.trim()) e.push(`fila ${i + 1}: falta el NOMBRE (completo) del beneficiario`);
      if (!(Number.isFinite(d.importe) && d.importe > 0)) e.push(`fila ${i + 1}: el Importe debe ser mayor a 0`);
    });
    if (!comprobacionOk)
      e.push("comprobación FALSA: el Flujo Total excede el Monto Pagado");
    if (sumaBrokersPct > 100.0001) e.push("la suma de los % de los brokers excede 100%");
    slots.forEach((s, i) => {
      if (s.brokerId && !(Number(s.pct) > 0)) e.push(`Broker ${i + 1}: define su % de la comisión`);
    });
    if (clienteId && !respaldoOk)
      e.push(
        `respaldo insuficiente: disponible $${fmt(disponibleResp)} para un flujo de $${fmt(flujoTotal)} — registra el depósito (Banco y Fecha del depósito) o cubre con el resguardo`
      );
    return e;
  };

  /** Lee un archivo como base64 (comprobantes del depósito). */
  const leerArchivo = (archivo: File): Promise<string> =>
    new Promise((resolver, rechazar) => {
      const lector = new FileReader();
      lector.onload = () => resolver(String(lector.result));
      lector.onerror = () => rechazar(new Error(`No se pudo leer ${archivo.name}`));
      lector.readAsDataURL(archivo);
    });

  const guardar = async (modo: "borrador" | "enviar") => {
    const errores = validarLocal();
    if (errores.length) {
      onError(`Formato incompleto: ${errores.join(" · ")}`);
      return;
    }
    if (
      !window.confirm(
        modo === "enviar"
          ? "¿Enviar la operación a Calidad? Pasará a revisión y ya no podrás editarla."
          : "¿Guardar la operación como BORRADOR? Podrás seguir editándola desde Operaciones."
      )
    )
      return;
    setGuardando(true);
    setFolioGuardado("");
    try {
      const concepto = filas.find((d) => d.concepto.trim())?.concepto.trim() || "PAGO";
      const obsPartes = [
        rsCliente.trim() ? `Razón social cliente: ${rsCliente.trim()}` : "",
        bancoComprobacion.trim() ? `Comprobación: ${bancoComprobacion.trim()}` : "",
        observaciones.trim(),
      ].filter(Boolean);
      const dispersionesPayload = filas.map((d) => ({
        ...d,
        importe: r2(d.importe),
        pagadora: d.pagadora.trim() || pagadoraElegida?.nombre || "CUALQUIER FLUJO",
        pagadora_cuenta_id: d.pagadora_cuenta_id ?? pagadoraElegida?.cuenta_id ?? null,
      }));
      const creada = await api.crear({
        tipo: "flujo",
        concepto,
        monto: montoNum,
        moneda: "MXN",
        fecha_operacion: fecha,
        ...(clienteId ? { cliente_id: Number(clienteId) } : {}),
        destinos: destinosAPayload(destinosSel),
        timbrar,
        comision_pct: pctNum,
        ...(clienteSel?.comision_trf_pct != null ? { comision_trf_pct: clienteSel.comision_trf_pct } : {}),
        observaciones: obsPartes.join(" — "),
        dispersiones: dispersionesPayload,
        brokers: brokersElegidos.map((x) => ({ broker_id: x.broker!.id, porcentaje: x.pct })),
        ...(clienteId && hayDeposito
          ? {
              respaldo: {
                depositos: [
                  {
                    cuenta_id: cuentaDeposito!.id,
                    monto: montoNum,
                    comprobante: `DEPOSITO ${cuentaDeposito!.nombre}${fechaDeposito ? ` ${fechaDeposito}` : ""}`,
                    fecha_deposito: fechaDeposito,
                  },
                ],
              },
            }
          : {}),
      });
      // Comprobantes del depósito (archivos adjuntos): se suben en cuanto la
      // operación existe para que Tesorería pueda validar el respaldo.
      if (archivosDeposito.length > 0 && clienteId && hayDeposito && creada.operacion?.id) {
        try {
          const det = await api.detalle(creada.operacion.id);
          const creado =
            det.depositos.find(
              (dep) => dep.cuenta_id === cuentaDeposito!.id && Math.abs(dep.monto - montoNum) < 0.005
            ) ?? det.depositos[0];
          if (creado) {
            const contenido = await Promise.all(
              archivosDeposito.map(async (a) => ({
                nombre: a.name,
                mime: a.type || "application/octet-stream",
                contenido: await leerArchivo(a),
              }))
            );
            await api.subirComprobantes(creado.id, contenido);
          }
        } catch (errComp) {
          onError(`La operación se creó, pero hubo un problema al subir comprobantes: ${(errComp as Error).message}`);
        }
      }
      const folio = creada.operacion?.folio ?? "";
      onError(""); // limpia errores previos de validación ya resueltos
      if (modo === "enviar") {
        // ENVIAR: guarda y manda la operación a revisión de Calidad (en_validacion).
        try {
          await api.enviarValidacion(creada.operacion.id);
          onCreada();
        } catch (errEnvio) {
          onError(
            `La operación ${folio} se guardó, pero no se pudo enviar a Calidad: ${(errEnvio as Error).message}. Envíala desde Operaciones.`
          );
          onCreada();
        }
      } else {
        // GUARDAR: queda como BORRADOR, editable desde Operaciones.
        reiniciarForma(folio);
      }
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setGuardando(false);
    }
  };

  /** Limpia el formato para capturar la siguiente operación. */
  const reiniciarForma = (folio: string) => {
    setClienteId("");
    setRsCliente("");
    setSlots([
      { brokerId: "", pct: "" },
      { brokerId: "", pct: "" },
      { brokerId: "", pct: "" },
      { brokerId: "", pct: "" },
    ]);
    setTimbrar(false);
    setObservaciones("");
    setMonto("");
    setComisionPct("2.50");
    setFecha(HOY());
    setFechaDeposito("");
    setFrenteSel("resguardo");
    setPagadoraSel("");
    setBancoDeposito("");
    setArchivosDeposito([]);
    setBancoComprobacion("MGN INTRUST");
    setDispersiones([VACIA()]);
    setErroresLayout([]);
    setFolioGuardado(folio);
  };

  /** Celda de la sección (etiqueta + contenido coloreado). */
  const Celda = ({
    etiqueta,
    color,
    children,
    nota,
  }: {
    etiqueta: string;
    color: "verde" | "azul" | "naranja" | "rosa" | "amarilla" | "gris";
    children: React.ReactNode;
    nota?: string;
  }) => (
    <div className="fmt-fila">
      <label>{etiqueta}</label>
      <div className={`fmt-celda c-${color}`}>{children}</div>
      {nota ? <small className="fmt-nota">{nota}</small> : null}
    </div>
  );

  return (
    <div className="fmt-hoja" style={{ zoom }}>
      <div className="fmt-titulo">
        <span className="fmt-folio" title="El folio lo asigna el sistema al guardar">
          Folio Ops: al guardar
        </span>
        FORMATO DE OPERACIONES
      </div>

      {/* Herramientas: zoom para ver la operación completa + pago especial */}
      <div className="fmt-toolbar">
        <span>Zoom</span>
        <button type="button" className="zoom-btn" onClick={() => ajustarZoom(-0.1)} disabled={zoom <= ZOOM_MIN} title="Alejar (ver la operación completa)" aria-label="Alejar">
          −
        </button>
        <span className="zoom-nivel">{Math.round(zoom * 100)}%</span>
        <button type="button" className="zoom-btn" onClick={() => ajustarZoom(0.1)} disabled={zoom >= ZOOM_MAX} title="Acercar" aria-label="Acercar">
          +
        </button>
        <button type="button" className="zoom-restablecer" onClick={restablecerZoom} disabled={zoom === 1}>
          Restablecer
        </button>
        <button type="button" className="btn secundario fmt-btn-especial" onClick={onPagoEspecial}>
          Pago especial (formato adjunto)
        </button>
      </div>

      {folioGuardado && (
        <div className="fmt-exito">
          Operación <b>{folioGuardado}</b> guardada como <b>BORRADOR</b>. Puedes seguirla editando desde
          <b> Operaciones</b> o enviarla a Calidad con el botón <b>Enviar</b> cuando esté completa.
        </div>
      )}

      <div className="fmt-secciones">
        {/* ---- A: fechas, frente, banco y monto pagado ---- */}
        <div className="fmt-col">
          <div className="fmt-sec">
            <span className="fmt-letra">A</span>
            <div className="fmt-filas">
              <Celda etiqueta="Fecha de la operación" color="verde">
                <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} required />
              </Celda>
              <Celda etiqueta="Fecha del deposito" color="verde">
                <input type="date" value={fechaDeposito} onChange={(e) => setFechaDeposito(e.target.value)} />
              </Celda>
              <Celda
                etiqueta="Empresa frente"
                color="azul"
                nota={
                  estructuraFrente
                    ? `ESTRUCTURA: ${estructuraFrente.giro || "—"} — ${estructuraFrente.importe_maximo || "sin límite indicado"}`
                    : undefined
                }
              >
                <select value={frenteSel} onChange={(e) => setFrenteSel(e.target.value)}>
                  <option value="resguardo">RESGUARDO</option>
                  {frentes.map((f) => (
                    <option key={f.id} value={`c${f.id}`}>
                      {f.nombre}
                    </option>
                  ))}
                </select>
              </Celda>
              <Celda
                etiqueta="Banco"
                color="azul"
                nota={clienteId && !respaldoOk ? `Respaldo insuficiente: faltan $${fmt(faltanteRespaldo)}` : undefined}
              >
                <select value={bancoDeposito} onChange={(e) => setBancoDeposito(e.target.value)}>
                  <option value="">— Banco del depósito —</option>
                  {cuentasCat.map((c) => (
                    <option key={c.id} value={`c${c.id}`}>
                      {c.nombre}
                      {c.banco ? ` — ${c.banco}` : ""}
                    </option>
                  ))}
                </select>
              </Celda>
              <Celda etiqueta="Monto Pagado" color="azul">
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={monto}
                  onChange={(e) => setMonto(e.target.value)}
                  placeholder="0.00"
                  required
                />
              </Celda>
              {bancoDeposito && (
                <Celda etiqueta="Comprobantes del depósito (opcional)" color="gris">
                  <input
                    type="file"
                    multiple
                    accept="image/*,application/pdf"
                    onChange={(e) => setArchivosDeposito(Array.from(e.target.files ?? []))}
                  />
                </Celda>
              )}
              {clienteId && (
                <p className="fmt-respaldo">
                  Saldo de resguardo de <strong>{clienteSel?.nombre}</strong>: <strong>${fmt(saldoCliente)}</strong>
                  {hayDeposito ? ` + depósito $${fmt(montoNum)}` : ""} · disponible <strong>${fmt(disponibleResp)}</strong>{" "}
                  frente al Flujo Total <strong>${fmt(flujoTotal)}</strong>{" "}
                  <span style={{ color: respaldoOk ? "var(--exito, #2e7d32)" : "var(--peligro, #c62828)" }}>
                    {respaldoOk ? "OK" : `FALTAN $${fmt(faltanteRespaldo)}`}
                  </span>
                </p>
              )}
            </div>
          </div>

          {/* ---- B: cliente, ejecutivo y brokers ---- */}
          <div className="fmt-sec">
            <span className="fmt-letra">B</span>
            <div className="fmt-filas">
              <Celda etiqueta="Cliente" color="naranja">
                <select
                  value={clienteId}
                  onChange={(e) => {
                    setClienteId(e.target.value);
                    setRsCliente("");
                  }}
                >
                  <option value="">— Sin cliente —</option>
                  {clientes.map((c) => (
                    <option key={c.id} value={String(c.id)}>
                      {c.nombre}
                    </option>
                  ))}
                </select>
              </Celda>
              <Celda etiqueta="Razón Social Cliente" color="verde">
                <input value={rsCliente} onChange={(e) => setRsCliente(e.target.value)} placeholder="Se anota en observaciones" />
              </Celda>
              <Celda etiqueta="RFC Cliente" color="verde">
                <input value={clienteSel?.rfc || ""} readOnly placeholder="—" />
              </Celda>
              <Celda etiqueta="Ejecutivo" color="verde">
                <input value={usuario.nombre} readOnly />
              </Celda>
              {slots.map((s, i) => {
                const elegido = brokers.find((b) => String(b.id) === s.brokerId);
                return (
                  <Celda
                    key={i}
                    etiqueta={`Broker ${i + 1}`}
                    color="rosa"
                    nota={elegido && !(Number(s.pct) > 0) ? "define el %" : undefined}
                  >
                    <div className="fmt-broker">
                      <select
                        value={s.brokerId}
                        onChange={(e) => {
                          const b = brokers.find((x) => String(x.id) === e.target.value);
                          setSlots((prev) =>
                            prev.map((x, j) => (j === i ? { brokerId: e.target.value, pct: b ? String(b.porcentaje) : "" } : x))
                          );
                        }}
                      >
                        <option value="">—</option>
                        {brokers.map((b) => (
                          <option key={b.id} value={String(b.id)}>
                            {b.nombre}
                          </option>
                        ))}
                      </select>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        max="100"
                        value={s.pct}
                        onChange={(e) => setSlots((prev) => prev.map((x, j) => (j === i ? { ...x, pct: e.target.value } : x)))}
                        placeholder="%"
                        disabled={!s.brokerId}
                      />
                      <span className="fmt-monto-broker">
                        {elegido && Number(s.pct) > 0 ? `$${fmt(comisionBroker(Number(s.pct)))}` : "$—"}
                      </span>
                    </div>
                  </Celda>
                );
              })}
              {sumaBrokersPct > 0 && (
                <p className="fmt-respaldo">
                  Suma de brokers: {sumaBrokersPct.toFixed(2)}%{" "}
                  {sumaBrokersPct <= 100.0001 ? `(la casa retiene ${r2(100 - sumaBrokersPct).toFixed(2)}%)` : "— EXCEDE 100%"}
                </p>
              )}
              {clientes.length === 0 && (
                <p className="fmt-respaldo">
                  Aún no tienes clientes asignados: la operación puede capturarse sin cliente.
                </p>
              )}
            </div>
          </div>
        </div>

        {/* ---- C y D: pagadora, tipo, timbrar, comisión y cálculos ---- */}
        <div className="fmt-col">
          <div className="fmt-sec">
            <span className="fmt-letra">C</span>
            <div className="fmt-filas">
              <Celda
                etiqueta="Pagadora"
                color="amarilla"
                nota={
                  estructuraPagadora
                    ? `ESTRUCTURA: ${estructuraPagadora.giro || "—"} — ${estructuraPagadora.importe_maximo || "sin límite indicado"}${estructuraPagadora.tipo ? ` (${estructuraPagadora.tipo})` : ""}`
                    : undefined
                }
              >
                <select value={pagadoraSel} onChange={(e) => setPagadoraSel(e.target.value)}>
                  <option value="">— Selecciona la pagadora ({catalogoPagadoras.length} disponibles) —</option>
                  <option value="tflujo">CUALQUIER FLUJO — Tesorería determina la cuenta</option>
                  {catalogoPagadoras.map((c) => (
                    <option key={c.id} value={`c${c.id}`}>
                      {c.nombre}
                    </option>
                  ))}
                </select>
              </Celda>
              <Celda etiqueta="Tipo de Operación" color="verde">
                <input value="FLUJOS" readOnly />
              </Celda>
              <Celda etiqueta="Timbrar" color="gris">
                <select value={timbrar ? "si" : "no"} onChange={(e) => setTimbrar(e.target.value === "si")}>
                  <option value="no">NO</option>
                  <option value="si">SÍ</option>
                </select>
              </Celda>
              <Celda
                etiqueta="Comision %"
                color="amarilla"
                nota={
                  (clienteSel?.comision_trf_pct ?? 0) > 0
                    ? `COMISIÓN COBRADA EN RESGUARDO — TRF ${clienteSel?.comision_trf_pct}% va directo al resguardo de la empresa`
                    : undefined
                }
              >
                <input type="number" step="0.01" min="0" value={comisionPct} onChange={(e) => setComisionPct(e.target.value)} required />
              </Celda>
            </div>
          </div>

          <div className="fmt-sec">
            <span className="fmt-letra">D</span>
            <div className="fmt-filas">
              <Celda etiqueta="Monto Pagado" color="verde">
                <input value={`$ ${montoNum > 0 ? fmt(montoNum) : "-"}`} readOnly />
              </Celda>
              <Celda etiqueta="IVA" color="verde">
                <input value={`$ ${montoNum > 0 ? fmt(iva) : "-"}`} readOnly />
              </Celda>
              <Celda etiqueta="Neto (subtotal)" color="verde">
                <input value={`$ ${montoNum > 0 ? fmt(neto) : "-"}`} readOnly />
              </Celda>
              <Celda etiqueta="Comision total op" color="amarilla">
                <input value={`$ ${montoNum > 0 ? fmt(comisionTotalOp) : "-"}`} readOnly />
              </Celda>
              <Celda etiqueta="Comision total" color="rosa">
                <input value={`$ ${montoNum > 0 ? fmt(comisionTotalOp) : "-"}`} readOnly />
              </Celda>
              {slots.map((s, i) => (
                <Celda key={i} etiqueta={`Comision Broker ${i + 1}`} color="rosa">
                  <div className="fmt-broker">
                    <input value={`$ ${s.brokerId && Number(s.pct) > 0 ? fmt(comisionBroker(Number(s.pct))) : "-"}`} readOnly />
                    <span className="fmt-pct">{s.brokerId && Number(s.pct) > 0 ? `${Number(s.pct).toFixed(2)}%` : "0.00%"}</span>
                  </div>
                </Celda>
              ))}
              <Celda etiqueta="Resguardo" color="verde">
                <div className="fmt-broker">
                  <input value={`$ ${montoNum > 0 ? fmt(resguardoSobrante) : "-"}`} readOnly />
                  <span className="fmt-otro">Otro</span>
                </div>
              </Celda>
              <Celda etiqueta="Devolución" color="verde">
                <input value={`$ ${fmt(devolucion)}`} readOnly />
              </Celda>
              <Celda etiqueta="Flujo Total" color="gris">
                <input value={`$ ${fmt(flujoTotal)}`} readOnly />
              </Celda>
            </div>
          </div>
        </div>
      </div>

      {/* ---- Dispersión: tabla con los encabezados del formato ---- */}
      <div className="fmt-barra-seccion">Dispersión</div>
      {erroresLayout.length > 0 && (
        <div className="error">
          {erroresLayout.slice(0, 5).map((e, i) => (
            <div key={i}>· {e}</div>
          ))}
        </div>
      )}
      <div className="matriz-xl-wrap fmt-wrap-tabla">
        <table className="fmt-tabla">
          <thead>
            <tr>
              <th></th>
              <th>CONCEPTO</th>
              <th>TIPO DE OPERACIÓN</th>
              <th>PATERNO</th>
              <th>MATERNO</th>
              <th>NOMBRE</th>
              <th>NOMBRE</th>
              <th>REFERENCIA</th>
              <th>RFC</th>
              <th>INE</th>
              <th>#</th>
              <th>Tarjeta</th>
              <th>CUENTA CLABE</th>
              <th>Banco</th>
              <th>CLABE</th>
              <th>Importe</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {dispersiones.map((d, i) => (
              <tr key={i}>
                <td className="fmt-numfila">{i + 1}</td>
                <td><CellEdit value={d.concepto} onChange={(v) => editarFila(i, "concepto", v)} placeholder="PAGO" /></td>
                <td><input className="fmt-in fmt-solo" value="FLUJO" readOnly /></td>
                <td><CellEdit value={d.apellido_paterno} onChange={(v) => editarFila(i, "apellido_paterno", v)} /></td>
                <td><CellEdit value={d.apellido_materno} onChange={(v) => editarFila(i, "apellido_materno", v)} /></td>
                <td><CellEdit value={d.nombre} onChange={(v) => editarFila(i, "nombre", v)} /></td>
                <td><CellEdit value={d.beneficiario} onChange={(v) => editarFila(i, "beneficiario", v)} className="fmt-strong" /></td>
                <td><CellEdit value={d.referencia} onChange={(v) => editarFila(i, "referencia", v)} /></td>
                <td><CellEdit value={d.rfc} onChange={(v) => editarFila(i, "rfc", v)} /></td>
                <td><CellEdit value={d.ine} onChange={(v) => editarFila(i, "ine", v)} /></td>
                <td><CellEdit value={d.numero} onChange={(v) => editarFila(i, "numero", v)} /></td>
                <td><CellEdit value={d.tarjeta} onChange={(v) => editarFila(i, "tarjeta", v)} className="fmt-mono" /></td>
                <td><CellEdit value={d.cuenta} onChange={(v) => editarFila(i, "cuenta", v)} className="fmt-mono" /></td>
                <td><CellEdit value={d.banco} onChange={(v) => editarFila(i, "banco", v)} /></td>
                <td><CellEdit value={d.clabe} onChange={(v) => editarFila(i, "clabe", v)} className="fmt-mono" /></td>
                <td className="fmt-celdaimporte">
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    className="fmt-in fmt-importe"
                    value={Number.isFinite(d.importe) && d.importe !== 0 ? String(d.importe) : ""}
                    onChange={(e) => setDispersiones((prev) => prev.map((x, j) => (j === i ? { ...x, importe: Number(e.target.value) } : x)))}
                    placeholder="0.00"
                  />
                  {pagadoraElegida && !d.pagadora && (
                    <small className="fmt-pagadora" title="Pagadora de la operación">
                      {pagadoraElegida.nombre}
                    </small>
                  )}
                  {d.pagadora && (
                    <small className="fmt-pagadora" title="Pagadora de la línea (layout)">
                      {d.pagadora}
                    </small>
                  )}
                </td>
                <td>
                  <button
                    type="button"
                    className="fmt-quitar"
                    title={`Quitar fila ${i + 1}`}
                    onClick={() => setDispersiones((prev) => (prev.length > 1 ? prev.filter((_, j) => j !== i) : [VACIA()]))}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="barra fmt-barra-disp">
        <button type="button" className="btn" onClick={() => setDispersiones((prev) => [...prev.filter(filaConDatos), VACIA()])}>
          + Agregar fila (encabezados del formato)
        </button>
        <label className="btn" style={{ marginBottom: 0 }}>
          Importar layout (Excel/CSV)
          <input type="file" accept=".xlsx,.xls,.csv,.txt" style={{ display: "none" }} onChange={importarLayout} />
        </label>
        <button type="button" className="btn" onClick={() => void descargarPlantillaDispersiones(catalogoPagadoras)}>
          Descargar layout (con catálogo vigente)
        </button>
        {dispersiones.length > 1 && (
          <button type="button" className="btn peligro" onClick={() => setDispersiones([VACIA()])}>
            Limpiar
          </button>
        )}
      </div>

      {/* ---- Comprobación (barra azul marino del formato) ---- */}
      <div className="fmt-comprobacion">
        <span className="fmt-cuentafila">{filas.length}</span>
        <input
          className="fmt-banco-check"
          value={bancoComprobacion}
          onChange={(e) => setBancoComprobacion(e.target.value)}
          title="Entidad de comprobación"
          aria-label="Entidad de comprobación"
        />
        <div className="fmt-check-datos">
          <div className="fmt-check-linea">
            <span>Total</span>
            <b>{fmt(flujoTotal)}</b>
          </div>
          <div className="fmt-check-linea">
            <span>Comprobación</span>
            <span className={`fmt-veredicto ${comprobacionOk ? "ok" : "mal"}`}>
              {comprobacionOk ? "VERDADERO" : "FALSO"}
            </span>
          </div>
          <div className="fmt-check-linea">
            <span>DIFERENCIA A FAVOR / (EN CONTRA)</span>
            <b className={diferencia >= -0.005 ? "ok" : "mal"}>
              {diferencia < 0 ? "-" : ""}
              {fmt(Math.abs(diferencia))}
            </b>
          </div>
        </div>
      </div>

      {/* ---- Observaciones ---- */}
      <div className="fmt-barra-seccion">Observaciones o Instrucciones Especiales</div>
      <textarea
        className="fmt-obs"
        value={observaciones}
        onChange={(e) => setObservaciones(e.target.value)}
        rows={5}
        placeholder="Instrucciones especiales de la operación (opcional)"
      />

      <div className="barra" style={{ marginTop: "0.8rem" }}>
        <button type="button" className="btn secundario" onClick={() => void guardar("borrador")} disabled={guardando}>
          {guardando ? "Guardando…" : "Guardar"}
        </button>
        <button type="button" className="btn" onClick={() => void guardar("enviar")} disabled={guardando}>
          {guardando ? "Enviando…" : "Enviar"}
        </button>
        <small className="fmt-ayuda">
          <b>Guardar</b> deja la operación como BORRADOR (sigues editándola en Operaciones). <b>Enviar</b> la manda a
          revisión de Calidad. El Flujo Total es la suma de los importes y la comprobación debe dar VERDADERO; las filas
          se agregan con “+ Agregar fila” o importando el layout.
        </small>
      </div>
    </div>
  );
}

/** Celda editable de la tabla de dispersión (input sin bordes, estilo Excel). */
function CellEdit({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <input
      className={`fmt-in ${className ?? ""}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
    />
  );
}
