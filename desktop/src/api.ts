import type {
  AccesoCredencial,
  AltaBancaria,
  AltaPortal,
  AplicacionRecurso,
  Asignacion,
  AsignacionCuenta,
  AsignacionEjecutivo,
  AsignacionValidacion,
  Broker,
  CalculosFlujo,
  CargoValidacion,
  CatalogoRegistro,
  Cliente,
  Cobertura,
  CoberturaCliente,
  ComprobanteDeposito,
  ComprobanteDescargado,
  CredencialBoveda,
  Cuenta,
  CuentaCatalogo,
  FilaPortalAltas,
  MatrizAltas,
  ResultadoLoteAltas,
  ValidacionClabe,
  BancoSpei,
  DepositoOperacion,
  DepositoPendiente,
  DetalleOperacion,
  Dispersion,
  Evento,
  Financiamiento,
  FilaColaValidacion,
  FilaRespaldoOperacion,
  MedioPago,
  MovimientoConcentrado,
  MovimientoCuenta,
  Operacion,
  OperacionBroker,
  Pago,
  Parametro,
  Pronostico,
  ReporteDireccion,
  ResguardoBroker,
  ResguardoDetalle,
  ResguardoLista,
  ResguardoMesDetalle,
  Estructura,
  EstructuraCatalogo,
  SolicitudTimbrado,
  ResumenFondeador,
  Revision,
  Rol,
  TipoCuenta,
  TrfResguardoDetalle,
  TrfResguardoMovimiento,
  TrfResguardoSaldos,
  Usuario,
  UsuarioAdmin,
  Cargo,
} from "./tipos";

let token: string | null = localStorage.getItem("token");

export function setToken(valor: string | null): void {
  token = valor;
  if (valor) localStorage.setItem("token", valor);
  else localStorage.removeItem("token");
}

export function getToken(): string | null {
  return token;
}

async function solicitar<T>(ruta: string, opciones: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${ruta}`, {
    ...opciones,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...opciones.headers,
    },
  });
  const cuerpo = await res.json().catch(() => ({}));
  if (!res.ok) {
    const mensaje = cuerpo.error ?? `Error ${res.status}`;
    const detalle = cuerpo.detalles ? `: ${cuerpo.detalles.join(", ")}` : "";
    throw new Error(`${mensaje}${detalle}`);
  }
  return cuerpo as T;
}

export const api = {
  login: (username: string, password: string) =>
    solicitar<{ token: string; usuario: Usuario }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  me: () => solicitar<{ usuario: Usuario }>("/auth/me"),
  lista: (
    filtros: {
      estado?: string;
      q?: string;
      desde?: string;
      hasta?: string;
      /** Fase 13: filtros del listado. */
      tipo?: string;
      moneda?: string;
      monto_min?: string;
      monto_max?: string;
    } = {}
  ) => {
    const params = new URLSearchParams();
    if (filtros.estado) params.set("estado", filtros.estado);
    if (filtros.q) params.set("q", filtros.q);
    if (filtros.desde) params.set("desde", filtros.desde);
    if (filtros.hasta) params.set("hasta", filtros.hasta);
    if (filtros.tipo) params.set("tipo", filtros.tipo);
    if (filtros.moneda) params.set("moneda", filtros.moneda);
    if (filtros.monto_min) params.set("monto_min", filtros.monto_min);
    if (filtros.monto_max) params.set("monto_max", filtros.monto_max);
    const qs = params.toString();
    return solicitar<{ operaciones: Operacion[] }>(`/operaciones${qs ? `?${qs}` : ""}`);
  },
  detalle: (id: number) => solicitar<DetalleOperacion>(`/operaciones/${id}`),
  crear: (datos: Record<string, unknown>) =>
    solicitar<{ operacion: Operacion; calculos?: CalculosFlujo }>("/operaciones", {
      method: "POST",
      body: JSON.stringify(datos),
    }),
  guardarDispersiones: (id: number, dispersiones: Dispersion[]) =>
    solicitar<{ dispersiones: Dispersion[]; calculos: CalculosFlujo }>(`/operaciones/${id}/dispersiones`, {
      method: "PUT",
      body: JSON.stringify({ dispersiones }),
    }),
  guardarDatosFlujo: (
    id: number,
    datos: {
      pagador?: string;
      tipo_operacion?: string;
      timbrar?: boolean;
      comision_pct?: number;
      observaciones?: string;
      brokers?: Array<{ broker_id: number; porcentaje: number }>;
      /** Tarea 12: pagadoras/frentes del catálogo (reemplazo completo). */
      destinos?: Array<{ cuenta_id?: number; tipo: string; manejo_manual: boolean }>;
    }
  ) =>
    solicitar<{ operacion: Operacion; brokers: OperacionBroker[]; calculos: CalculosFlujo }>(
      `/operaciones/${id}/datos-flujo`,
      { method: "PUT", body: JSON.stringify(datos) }
    ),
  brokers: () => solicitar<{ brokers: Broker[] }>("/brokers"),
  crearBroker: (datos: { nombre: string; porcentaje: number }) =>
    solicitar<{ broker: Broker }>("/brokers", { method: "POST", body: JSON.stringify(datos) }),
  actualizarBroker: (id: number, datos: { nombre?: string; porcentaje?: number; activo?: boolean }) =>
    solicitar<{ broker: Broker }>(`/brokers/${id}`, { method: "PATCH", body: JSON.stringify(datos) }),
  enviarValidacion: (id: number) =>
    solicitar<{ operacion: Operacion }>(`/operaciones/${id}/enviar-validacion`, { method: "POST" }),
  revisar: (id: number, resultado: "aprobada" | "observada", comentario: string) =>
    solicitar<{ operacion: Operacion }>(`/operaciones/${id}/revision`, {
      method: "POST",
      body: JSON.stringify({ resultado, comentario }),
    }),
  cancelar: (id: number) =>
    solicitar<{ operacion: Operacion }>(`/operaciones/${id}/cancelar`, { method: "POST" }),
  liberar: (id: number) =>
    solicitar<{ operacion: Operacion }>(`/operaciones/${id}/liberar`, { method: "POST" }),
  resumenFondeador: () => solicitar<ResumenFondeador>("/fondeador/resumen"),
  /** Barra de pronóstico: operaciones capturadas por FLUJOS/ASIMILADOS/FRENTES/etc. */
  pronostico: () => solicitar<Pronostico>("/pronostico"),
  altasBancarias: (filtros: { estado?: string; operacion_id?: number } = {}) => {
    const params = new URLSearchParams();
    if (filtros.estado) params.set("estado", filtros.estado);
    if (typeof filtros.operacion_id === "number") params.set("operacion_id", String(filtros.operacion_id));
    const qs = params.toString();
    return solicitar<{ altas: AltaBancaria[] }>(`/altas-bancarias${qs ? `?${qs}` : ""}`);
  },
  solicitarAlta: (datos: {
    operacion_id?: number;
    dispersion_id?: number;
    beneficiario?: string;
    banco?: string;
    moneda?: string;
    cuenta?: string;
    notas?: string;
  }) => solicitar<{ alta: AltaBancaria }>("/altas-bancarias", { method: "POST", body: JSON.stringify(datos) }),
  registrarAlta: (id: number) =>
    solicitar<{ alta: AltaBancaria }>(`/altas-bancarias/${id}/registrada`, { method: "POST" }),
  rechazarAlta: (id: number, motivo: string) =>
    solicitar<{ alta: AltaBancaria }>(`/altas-bancarias/${id}/rechazar`, {
      method: "POST",
      body: JSON.stringify({ motivo }),
    }),
  asignarEjecutivo: (validador_id: number, ejecutivo_id: number, motivo?: string) =>
    solicitar<{ asignacion: AsignacionEjecutivo }>("/validacion/asignar-ejecutivo", {
      method: "POST",
      body: JSON.stringify({ validador_id, ejecutivo_id, motivo }),
    }),
  asignacionesEjecutivos: () =>
    solicitar<{ asignaciones: AsignacionEjecutivo[] }>("/validacion/asignaciones-ejecutivos"),
  cerrarAsignacionEjecutivo: (id: number) =>
    solicitar<{ asignacion: AsignacionEjecutivo }>(`/validacion/asignaciones-ejecutivos/${id}/cerrar`, {
      method: "POST",
    }),
  pagar: (
    id: number,
    datos: {
      medio: MedioPago;
      monto: number;
      comprobante: string;
      fecha_pago?: string;
      notas?: string;
      cuenta_id?: number | null;
    }
  ) =>
    solicitar<{
      operacion: Operacion;
      pago: Pago;
      completado: boolean;
      pagado: { total_por_dispersar: number; total_dispersado: number; restante: number };
    }>(`/operaciones/${id}/pago`, {
      method: "POST",
      body: JSON.stringify(datos),
    }),
  pagarLote: (
    id: number,
    pagos: Array<{
      medio?: MedioPago;
      monto: number;
      comprobante: string;
      fecha_pago?: string;
      notas?: string;
      cuenta_id?: number | null;
    }>
  ) =>
    solicitar<{
      operacion: Operacion;
      pagos: Pago[];
      completado: boolean;
      pagado: { total_por_dispersar: number; total_dispersado: number; restante: number };
    }>(`/operaciones/${id}/pagos`, {
      method: "POST",
      body: JSON.stringify({ pagos }),
    }),
  pagos: () => solicitar<{ pagos: Pago[] }>("/pagos"),
  reportesDireccion: () => solicitar<ReporteDireccion>("/reportes/direccion"),
  cuentas: (todas?: boolean) =>
    solicitar<{ cuentas: Cuenta[] }>(`/cuentas${todas ? "?todas=1" : ""}`),
  detalleCuenta: (id: number) =>
    solicitar<{ cuenta: Cuenta; movimientos: MovimientoCuenta[] }>(`/cuentas/${id}`),
  crearCuenta: (datos: {
    nombre: string;
    banco?: string;
    numero_cuenta?: string;
    saldo_inicial?: number;
    tipo?: TipoCuenta;
    /** Fase 15: con CLABE válida el backend auto-llena banco y número. */
    clabe?: string;
  }) => solicitar<{ cuenta: Cuenta }>("/cuentas", { method: "POST", body: JSON.stringify(datos) }),
  // Tarea 12: sacar de operación (activa=false) o reactivar (activa=true).
  estadoCuenta: (id: number, activa: boolean, motivo: string) =>
    solicitar<{ cuenta: Cuenta }>(`/cuentas/${id}/estado`, {
      method: "PATCH",
      body: JSON.stringify({ activa, motivo }),
    }),
  // Fase 13: Tesorería oculta/muestra una cuenta en el listado de pagadoras
  // que ven los operadores al capturar.
  visibilidadCuenta: (id: number, visible_operador: boolean, motivo: string) =>
    solicitar<{ cuenta: Cuenta }>(`/cuentas/${id}/visible`, {
      method: "PATCH",
      body: JSON.stringify({ visible_operador, motivo }),
    }),
  // Fase 14: comisiones preestablecidas del cliente (las fija admin_operaciones).
  comisionesCliente: (
    id: number,
    datos: { comision_broker_pct?: number | null; comision_trf_pct?: number | null }
  ) =>
    solicitar<{ cliente: Cliente }>(`/clientes/${id}/comisiones`, {
      method: "PATCH",
      body: JSON.stringify(datos),
    }),
  // Fase 14: descarga del formato adjunto del pago especial (p.ej. SAT).
  formatoPagoEspecial: (id: number) =>
    solicitar<{ nombre: string; mime: string; contenido: string }>(
      `/operaciones/${id}/pago-especial/formato`
    ),
  crearMovimiento: (
    id: number,
    datos: {
      tipo: "deposito" | "retiro";
      monto: number;
      concepto: string;
      fecha?: string;
      referencia?: string;
    }
  ) =>
    solicitar<{ movimiento: unknown }>(`/cuentas/${id}/movimientos`, {
      method: "POST",
      body: JSON.stringify(datos),
    }),
  movimientosLote: (
    id: number,
    movimientos: Array<{
      tipo: "deposito" | "retiro";
      monto: number;
      concepto: string;
      referencia?: string;
      fecha?: string;
    }>
  ) =>
    solicitar<{ ok: boolean; insertados: number; ids: number[] }>(`/cuentas/${id}/movimientos/lote`, {
      method: "POST",
      body: JSON.stringify({ movimientos }),
    }),
  movimientos: (filtros: { cuenta_id?: number; desde?: string; hasta?: string; q?: string } = {}) => {
    const params = new URLSearchParams();
    if (filtros.cuenta_id) params.set("cuenta_id", String(filtros.cuenta_id));
    if (filtros.desde) params.set("desde", filtros.desde);
    if (filtros.hasta) params.set("hasta", filtros.hasta);
    if (filtros.q) params.set("q", filtros.q);
    const qs = params.toString();
    return solicitar<{ movimientos: MovimientoConcentrado[]; version_limpia: boolean }>(
      `/movimientos${qs ? `?${qs}` : ""}`
    );
  },
  marcarMovimiento: (id: number, datos: { deposito_id?: number; comentario?: string }) =>
    solicitar<{ ok: boolean; movimiento: MovimientoConcentrado }>(`/movimientos/${id}/marca`, {
      method: "POST",
      body: JSON.stringify(datos),
    }),
  desmarcarMovimiento: (id: number) =>
    solicitar<{ ok: boolean }>(`/movimientos/${id}/marca`, { method: "DELETE" }),
  operacionesRespaldos: (estados?: string) =>
    solicitar<{ operaciones: FilaRespaldoOperacion[] }>(
      `/operaciones/respaldos${estados ? `?estados=${encodeURIComponent(estados)}` : ""}`
    ),
  aprobarDireccion: (id: number, aprobado: boolean, comentario: string) =>
    solicitar<{ operacion: Operacion }>(`/operaciones/${id}/aprobacion-direccion`, {
      method: "POST",
      body: JSON.stringify({ aprobado, comentario }),
    }),
  auditoria: () => solicitar<{ eventos: Evento[] }>("/auditoria"),

  // ---- Fase roles: administración y clientes ----
  usuarios: () => solicitar<{ usuarios: UsuarioAdmin[] }>("/usuarios"),
  ejecutivos: () => solicitar<{ ejecutivos: UsuarioAdmin[] }>("/usuarios/ejecutivos"),
  crearUsuario: (datos: {
    username: string;
    nombre: string;
    rol: Rol;
    password: string;
    cargos?: Cargo[];
  }) =>
    solicitar<{ usuario: UsuarioAdmin }>("/usuarios", {
      method: "POST",
      body: JSON.stringify(datos),
    }),
  cambiarEstadoUsuario: (id: number, activo: boolean) =>
    solicitar<{ usuario: UsuarioAdmin }>(`/usuarios/${id}/estado`, {
      method: "PATCH",
      body: JSON.stringify({ activo }),
    }),
  cambiarRolUsuario: (id: number, rol: Rol) =>
    solicitar<{ usuario: UsuarioAdmin }>(`/usuarios/${id}/rol`, {
      method: "PATCH",
      body: JSON.stringify({ rol }),
    }),
  eliminarUsuario: (id: number) =>
    solicitar<{ eliminado: boolean; username: string }>(`/usuarios/${id}`, { method: "DELETE" }),

  // ---- Cargos de Tesorería (funciones asignables a los tesoreros) ----
  personalCargos: () =>
    solicitar<{ personal: UsuarioAdmin[]; cargos_posibles: Cargo[] }>("/usuarios/cargos"),
  guardarCargos: (id: number, cargos: Cargo[]) =>
    solicitar<{ usuario: UsuarioAdmin; nota: string }>(`/usuarios/${id}/cargos`, {
      method: "PATCH",
      body: JSON.stringify({ cargos }),
    }),
  clientes: () => solicitar<{ clientes: Cliente[] }>("/clientes"),
  crearCliente: (datos: { nombre: string; rfc?: string; contacto?: string; notas?: string }) =>
    solicitar<{ cliente: Cliente }>("/clientes", { method: "POST", body: JSON.stringify(datos) }),
  actualizarCliente: (
    id: number,
    datos: { nombre?: string; rfc?: string; contacto?: string; notas?: string; activo?: boolean }
  ) =>
    solicitar<{ cliente: Cliente }>(`/clientes/${id}`, {
      method: "PATCH",
      body: JSON.stringify(datos),
    }),
  asignarCliente: (id: number, ejecutivo_id: number, motivo?: string) =>
    solicitar<{ asignacion: Asignacion }>(`/clientes/${id}/asignaciones`, {
      method: "POST",
      body: JSON.stringify({ ejecutivo_id, motivo }),
    }),
  asignacionesCliente: (id: number) =>
    solicitar<{ asignaciones: Asignacion[] }>(`/clientes/${id}/asignaciones`),
  catalogosRegistros: () =>
    solicitar<{ registros: CatalogoRegistro[] }>("/catalogos/registros"),
  crearCatalogoRegistro: (datos: { dominio: string; clave: string; valor: string }) =>
    solicitar<{ registro: CatalogoRegistro }>("/catalogos/registros", {
      method: "POST",
      body: JSON.stringify(datos),
    }),
  actualizarCatalogoRegistro: (id: number, datos: { valor?: string; activo?: boolean }) =>
    solicitar<{ registro: CatalogoRegistro }>(`/catalogos/registros/${id}`, {
      method: "PATCH",
      body: JSON.stringify(datos),
    }),
  parametros: () => solicitar<{ parametros: Parametro[] }>("/parametros"),
  actualizarParametro: (clave: string, valor: string) =>
    solicitar<{ parametro: Parametro }>(`/parametros/${clave}`, {
      method: "PATCH",
      body: JSON.stringify({ valor }),
    }),

  // ---- Fase roles 2-4: validación, tesorería, concentrado ----
  validadores: () => solicitar<{ validadores: UsuarioAdmin[] }>("/usuarios/validadores"),
  colaValidacion: () => solicitar<{ cola: FilaColaValidacion[] }>("/validacion/cola"),
  cargasValidacion: () => solicitar<{ cargas: CargoValidacion[] }>("/validacion/cargas"),
  asignarValidacion: (operacionId: number, validador_id: number, motivo?: string) =>
    solicitar<{ asignacion: AsignacionValidacion }>(`/operaciones/${operacionId}/asignar-validacion`, {
      method: "POST",
      body: JSON.stringify({ validador_id, motivo }),
    }),
  tesoreros: () => solicitar<{ tesoreros: UsuarioAdmin[] }>("/usuarios/tesoreros"),
  asignarCuenta: (cuentaId: number, tesorero_id: number, motivo?: string) =>
    solicitar<{ asignacion: AsignacionCuenta }>(`/cuentas/${cuentaId}/asignar`, {
      method: "POST",
      body: JSON.stringify({ tesorero_id, motivo }),
    }),
  crearCobertura: (datos: {
    cuenta_id: number;
    tesorero_habitual_id: number;
    tesorero_temporal_id: number;
    fecha_inicio: string;
    fecha_fin?: string | null;
    motivo?: string;
  }) =>
    solicitar<{ cobertura: Cobertura }>("/coberturas", {
      method: "POST",
      body: JSON.stringify(datos),
    }),
  coberturas: () => solicitar<{ coberturas: Cobertura[] }>("/coberturas"),
  aplicarRecurso: (datos: { movimiento_id: number; operacion_id: number; importe: number; observaciones?: string }) =>
    solicitar<{ aplicacion: AplicacionRecurso }>("/recursos/aplicar", {
      method: "POST",
      body: JSON.stringify(datos),
    }),
  liberarRecurso: (id: number, motivo: string) =>
    solicitar<{ aplicacion: AplicacionRecurso }>(`/recursos/${id}/liberar`, {
      method: "POST",
      body: JSON.stringify({ motivo }),
    }),
  recursos: () => solicitar<{ aplicaciones: AplicacionRecurso[] }>("/recursos"),
  depositosDisponibles: () =>
    solicitar<{
      depositos: Array<{
        movimiento_id: number;
        cuenta_id: number;
        cuenta: string;
        fecha: string;
        monto: number;
        concepto: string;
        disponible: number;
      }>;
    }>("/recursos/disponibles"),
  // ---- Respaldo de operaciones: depósitos múltiples y financiamientos (§6.1) ----
  agregarDeposito: (
    operacionId: number,
    datos: { cuenta_id: number; monto: number; comprobante: string; fecha_deposito?: string }
  ) =>
    solicitar<{ deposito: DepositoOperacion }>(`/operaciones/${operacionId}/depositos`, {
      method: "POST",
      body: JSON.stringify(datos),
    }),
  quitarDeposito: (operacionId: number, depositoId: number) =>
    solicitar<{ ok: boolean }>(`/operaciones/${operacionId}/depositos/${depositoId}`, {
      method: "DELETE",
    }),
  validarDepositoId: (depositoId: number) =>
    solicitar<{ ok: boolean; saldo: number }>(`/depositos/${depositoId}/validar`, { method: "POST" }),
  comprobantesDeposito: (depositoId: number) =>
    solicitar<{ comprobantes: ComprobanteDeposito[] }>(`/depositos/${depositoId}/comprobantes`),
  comprobante: (id: number) =>
    solicitar<{ comprobante: ComprobanteDescargado }>(`/comprobantes/${id}`),
  subirComprobantes: (
    depositoId: number,
    comprobantes: Array<{ nombre: string; mime: string; contenido: string }>
  ) =>
    solicitar<{ ok: boolean; ids: number[]; comprobantes: ComprobanteDeposito[] }>(
      `/depositos/${depositoId}/comprobantes`,
      { method: "POST", body: JSON.stringify({ comprobantes }) }
    ),
  quitarComprobante: (id: number) =>
    solicitar<{ ok: boolean }>(`/comprobantes/${id}`, { method: "DELETE" }),
  resguardosBrokers: () => solicitar<{ resguardos: ResguardoBroker[] }>("/brokers/resguardos"),
  retiroBroker: (brokerId: number, datos: { monto: number; notas?: string }) =>
    solicitar<{ retiro: unknown; saldo: number }>(`/brokers/${brokerId}/retiros`, {
      method: "POST",
      body: JSON.stringify(datos),
    }),

  // ---- Resguardo de TRF (la empresa, Fase 13) ----
  trfResguardo: () => solicitar<TrfResguardoDetalle>("/trf/resguardo"),
  // Ajuste del negocio: saldo SIN el ledger, para la captura de pagos
  // especiales (el detalle ya no es visible para quien captura).
  trfResguardoSaldo: () => solicitar<TrfResguardoSaldos>("/trf/resguardo/saldo"),
  registrarTrfMovimiento: (datos: {
    tipo: "ingreso" | "retiro";
    importe: number;
    moneda?: string;
    /** Tipo de cambio que aplicó el banco (obligatorio cuando moneda ≠ MXN). */
    tipo_cambio?: number;
    operacion_id?: number | null;
    notas?: string;
  }) =>
    solicitar<{ movimiento: TrfResguardoMovimiento }>("/trf/resguardo", {
      method: "POST",
      body: JSON.stringify(datos),
    }),
  financiamientos: (estado?: string) =>
    solicitar<{ financiamientos: Financiamiento[] }>(
      `/financiamientos${estado ? `?estado=${encodeURIComponent(estado)}` : ""}`
    ),
  aprobarFinanciamiento: (id: number) =>
    solicitar<{ financiamiento: Financiamiento; saldo: number }>(`/financiamientos/${id}/aprobar`, {
      method: "POST",
    }),
  rechazarFinanciamiento: (id: number, motivo?: string) =>
    solicitar<{ financiamiento: Financiamiento }>(`/financiamientos/${id}/rechazar`, {
      method: "POST",
      body: JSON.stringify({ motivo }),
    }),
  actualizarPoliticaFinanciamiento: (
    clienteId: number,
    datos: { sin_aprobacion?: boolean; monto_maximo?: number | null }
  ) =>
    solicitar<{ cliente: Cliente }>(`/clientes/${clienteId}/financiamiento`, {
      method: "PATCH",
      body: JSON.stringify(datos),
    }),

  // ---- Resguardos y coberturas de clientes (área de Operaciones) ----
  cuentasCatalogo: () => solicitar<{ cuentas: CuentaCatalogo[] }>("/cuentas/catalogo"),
  coberturasCliente: (id: number) =>
    solicitar<{ coberturas: CoberturaCliente[] }>(`/clientes/${id}/coberturas`),
  crearCoberturaCliente: (
    id: number,
    datos: {
      ejecutivo_habitual_id: number;
      ejecutivo_temporal_id: number;
      fecha_inicio: string;
      fecha_fin?: string | null;
      motivo?: string;
    }
  ) =>
    solicitar<{ cobertura: CoberturaCliente }>(`/clientes/${id}/coberturas`, {
      method: "POST",
      body: JSON.stringify(datos),
    }),
  cerrarCoberturaCliente: (id: number, coberturaId: number) =>
    solicitar<{ cobertura: CoberturaCliente }>(`/clientes/${id}/coberturas/${coberturaId}/cerrar`, {
      method: "POST",
    }),
  resguardo: (id: number) => solicitar<ResguardoDetalle>(`/clientes/${id}/resguardo`),
  depositosPendientes: () =>
    solicitar<{ depositos: DepositoPendiente[] }>("/resguardos/depositos-pendientes"),
  indicarDeposito: (
    operacionId: number,
    datos: { cuenta_id: number; monto: number; comprobante: string; fecha_deposito?: string }
  ) =>
    solicitar<{ deposito: DepositoOperacion }>(`/operaciones/${operacionId}/deposito`, {
      method: "POST",
      body: JSON.stringify(datos),
    }),
  validarDeposito: (operacionId: number) =>
    solicitar<{ ok: boolean; saldo: number }>(`/operaciones/${operacionId}/deposito/validar`, {
      method: "POST",
    }),
  crearDepositoResguardo: (datos: {
    cliente_id: number;
    cuenta_id: number;
    monto: number;
    comprobante: string;
    fecha?: string;
    operacion_id?: number | null;
    observaciones?: string;
  }) =>
    solicitar<{ deposito: unknown; saldo: number }>("/resguardos/depositos", {
      method: "POST",
      body: JSON.stringify(datos),
    }),

  // ============ Fase 15 — Catálogo SPEI, bóveda y altas en portales ============
  bancos: () => solicitar<{ bancos: BancoSpei[] }>("/bancos"),
  validarClabe: (clabe: string) =>
    solicitar<ValidacionClabe>("/clabe/validar", { method: "POST", body: JSON.stringify({ clabe }) }),
  /** Listado ligero de portales (pagadoras activas) para las pantallas de altas. */
  portalesAltas: () => solicitar<{ portales: Array<{ id: number; nombre: string }> }>("/cuentas/portales"),
  /** Vista tipo Excel: tablero completo de altas × portales en una sola llamada. */
  matrizAltas: () => solicitar<MatrizAltas>("/altas-bancarias/matriz"),
  /** Captura por lotes de altas (formato ALTA CUENTA). */
  altasLote: (lineas: Array<{ paterno: string; materno: string; nombre: string; clabe: string; notas?: string }>, portales: number[]) =>
    solicitar<ResultadoLoteAltas>("/altas-bancarias/lote", {
      method: "POST",
      body: JSON.stringify({ lineas, portales }),
    }),
  portalesDeAlta: (altaId: number) =>
    solicitar<{ portales: AltaPortal[] }>(`/altas-bancarias/${altaId}/portales`),
  agregarPortalAlta: (altaId: number, portal_cuenta_id: number) =>
    solicitar<{ portal: AltaPortal }>(`/altas-bancarias/${altaId}/portales`, {
      method: "POST",
      body: JSON.stringify({ portal_cuenta_id }),
    }),
  estadoPortalAlta: (altaPortalId: number, estado: AltaPortal["estado"], motivo = "") =>
    solicitar<{ portal: AltaPortal; alta: AltaBancaria }>(`/altas-portales/${altaPortalId}/estado`, {
      method: "POST",
      body: JSON.stringify({ estado, motivo }),
    }),
  quitarPortalAlta: (altaPortalId: number) =>
    solicitar<{ ok: boolean; alta: AltaBancaria }>(`/altas-portales/${altaPortalId}`, { method: "DELETE" }),
  /** Filas de un portal: altas ligadas listas para teclear/pegar en el portal. */
  filasPortal: (portal_cuenta_id: number) =>
    solicitar<{ filas: FilaPortalAltas[] }>(`/altas-portales?portal_cuenta_id=${portal_cuenta_id}`),
  catálogoCuenta: (id: number, datos: Record<string, unknown>) =>
    solicitar<{ cuenta: Cuenta }>(`/cuentas/${id}/catalogo`, {
      method: "PATCH",
      body: JSON.stringify(datos),
    }),
  importarCuentas: (lineas: string[]) =>
    solicitar<{ creadas: string[]; actualizadas: string[]; errores: Array<{ linea: number; errores: string[] }> }>(
      "/cuentas/importar-lote",
      { method: "POST", body: JSON.stringify({ lineas }) }
    ),
  /** Layout simple de cuentas: BANCO, NOMBRE, CLAVE (CLABE) y CUENTA CORTA. */
  cargarLayoutCuentas: (filas: Array<{ banco: string; nombre: string; clave: string; cuenta_corta: string }>) =>
    solicitar<{ creadas: string[]; actualizadas: string[]; errores: Array<{ fila: number; errores: string[] }> }>(
      "/cuentas/layout",
      { method: "POST", body: JSON.stringify({ filas }) }
    ),
  credenciales: (cuentaId: number) =>
    solicitar<{ cuenta: string; credenciales: CredencialBoveda[] }>(`/cuentas/${cuentaId}/credenciales`),
  crearCredencial: (
    cuentaId: number,
    datos: {
      tipo: string;
      etiqueta?: string;
      usuario?: string;
      secreto?: string;
      nip?: string;
      clave_seguridad?: string;
      token_numero?: string;
      telefono?: string;
      correo?: string;
      vigencia?: string;
      notas?: string;
    }
  ) =>
    solicitar<{ credencial: CredencialBoveda }>(`/cuentas/${cuentaId}/credenciales`, {
      method: "POST",
      body: JSON.stringify(datos),
    }),
  actualizarCredencial: (id: number, datos: Record<string, unknown>) =>
    solicitar<{ credencial: CredencialBoveda }>(`/credenciales/${id}`, {
      method: "PATCH",
      body: JSON.stringify(datos),
    }),
  /** Revela un campo sensible (queda auditado en el backend). */
  secretoCredencial: (id: number, campo: "secreto" | "nip" | "clave_seguridad") =>
    solicitar<{ campo: string; valor: string }>(
      `/credenciales/${id}/secreto?campo=${encodeURIComponent(campo)}`
    ),
  accesosBoveda: (cuentaId: number) =>
    solicitar<{ accesos: AccesoCredencial[] }>(`/cuentas/${cuentaId}/credenciales/accesos`),

  // ---- Sección RESGUARDOS (unificada) ----
  resguardos: () => solicitar<ResguardoLista>("/resguardos"),
  /** Detalle del resguardo de un cliente; `mes` (YYYY-MM) opcional — los roles
   *  sin historial completo siempre reciben el mes en curso (lo fuerza el API). */
  resguardoMes: (clienteId: number, mes?: string) =>
    solicitar<ResguardoMesDetalle>(
      `/clientes/${clienteId}/resguardo${mes ? `?mes=${encodeURIComponent(mes)}` : ""}`
    ),

  // ---- Contaduría: timbrado + estructuras ----
  solicitudesTimbrado: () =>
    solicitar<{ solicitudes: SolicitudTimbrado[]; total: number; por_estado: Record<string, number> }>(
      "/timbrado/solicitudes"
    ),
  estructuras: (filtros?: { q?: string; tipo?: string; estatus?: string }) => {
    const p = new URLSearchParams();
    if (filtros?.q) p.set("q", filtros.q);
    if (filtros?.tipo) p.set("tipo", filtros.tipo);
    if (filtros?.estatus) p.set("estatus", filtros.estatus);
    const qs = p.toString();
    return solicitar<{ estructuras: Estructura[]; total: number }>(`/estructuras${qs ? `?${qs}` : ""}`);
  },
  catalogoEstructuras: () => solicitar<{ estructuras: EstructuraCatalogo[] }>("/estructuras/catalogo"),
  crearEstructura: (datos: Record<string, unknown>) =>
    solicitar<{ estructura: Estructura }>("/estructuras", { method: "POST", body: JSON.stringify(datos) }),
  editarEstructura: (id: number, datos: Record<string, unknown>) =>
    solicitar<{ estructura: Estructura }>(`/estructuras/${id}`, { method: "PATCH", body: JSON.stringify(datos) }),
  estatusEstructura: (id: number, estatus_operacion: boolean) =>
    solicitar<{ estructura: Estructura }>(`/estructuras/${id}/estatus`, {
      method: "PATCH",
      body: JSON.stringify({ estatus_operacion }),
    }),
  cargarLayoutEstructuras: (
    filas: Array<Record<string, unknown>>
  ) =>
    solicitar<{
      creadas: number;
      actualizadas: number;
      errores: string[];
      detalles_creadas: string[];
      detalles_actualizadas: string[];
    }>("/estructuras/layout", { method: "POST", body: JSON.stringify({ filas }) }),
  /** Nombres (sin números) de las cuentas activas para ligar estructuras. */
  cuentasNombres: () =>
    solicitar<{ cuentas: Array<{ id: number; nombre: string; banco: string; tipo: string }> }>(
      "/cuentas/nombres"
    ),
};

/** Descarga el concentrado CSV (requiere rol tesoreria, direccion o auditoria). */
export async function descargarConcentrado(): Promise<void> {
  const res = await fetch("/api/reportes/concentrado", {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`Error ${res.status} al descargar el concentrado`);
  const texto = await res.text();
  const nombre = `concentrado-${new Date().toISOString().slice(0, 10)}.csv`;
  const blob = new Blob([texto], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const enlace = document.createElement("a");
  enlace.href = url;
  enlace.download = nombre;
  document.body.appendChild(enlace);
  enlace.click();
  document.body.removeChild(enlace);
  URL.revokeObjectURL(url);
}