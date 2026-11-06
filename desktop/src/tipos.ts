export type Rol =
  | "admin"
  | "admin_operaciones"
  | "admin_validacion"
  | "admin_tesoreria"
  | "operacion"
  | "validacion"
  | "validador_tesoreria"
  | "confirmador"
  | "tesoreria"
  | "fondeador"
  | "altas"
  | "direccion"
  | "auditoria"
  | "contaduria";

export const ETIQUETAS_ROL: Record<Rol, string> = {
  admin: "Administrador del sistema",
  admin_operaciones: "Administrador de Operaciones",
  admin_validacion: "Administrador de Validación",
  admin_tesoreria: "Administrador de Tesorería",
  operacion: "Ejecutivo de Operaciones",
  validacion: "Validador",
  validador_tesoreria: "Validador de Tesorería",
  confirmador: "Confirmador de Depósitos",
  tesoreria: "Tesorero",
  fondeador: "Tesorero Fondeador",
  altas: "Tesorería de Altas",
  direccion: "Dirección",
  auditoria: "Auditoría",
  contaduria: "Contaduría (timbrado y estructuras)",
};

// ---- Cargos de Tesorería (funciones asignables) ----
// Todos son tesoreros; cada persona puede tener uno o varios cargos y cada
// cargo puede recaer en una o varias personas. El cargo otorga las mismas
// funciones que su rol equivalente.

export type Cargo = "validador" | "altas" | "confirmador" | "fondeador";

export const CARGOS: Cargo[] = ["validador", "altas", "confirmador", "fondeador"];

export const ETIQUETAS_CARGO: Record<Cargo, string> = {
  validador: "Validador",
  altas: "Altas",
  confirmador: "Confirmador",
  fondeador: "Fondeador",
};

/** Cargo que implica de forma natural cada rol tesorero (equivalencia). */
const CARGO_POR_ROL: Partial<Record<Rol, Cargo>> = {
  validador_tesoreria: "validador",
  altas: "altas",
  confirmador: "confirmador",
  fondeador: "fondeador",
};

/** Cargos totales de un usuario: los asignados más el que implica su rol. */
export function cargosDe(usuario: Usuario): Cargo[] {
  const set = new Set<Cargo>(usuario.cargos ?? []);
  const implicito = CARGO_POR_ROL[usuario.rol];
  if (implicito) set.add(implicito);
  return [...set];
}

/** ¿Tiene el usuario este cargo (asignado o por su rol)? */
export function tieneCargo(usuario: Usuario, cargo: Cargo): boolean {
  return cargosDe(usuario).includes(cargo);
}

/** Roles del personal de Tesorería: a ellos se les pueden asignar cargos. */
export const ROLES_TESORERIA: Rol[] = [
  "tesoreria",
  "validador_tesoreria",
  "confirmador",
  "fondeador",
  "altas",
  "admin_tesoreria",
];

// ---- Tipos de cuenta de Tesorería (sólo el Administrador crea cuentas) ----

export type TipoCuenta =
  | "flujo"
  | "frente"
  | "prestamo"
  | "anticipo_rendimiento"
  | "sofom"
  | "asimilado";

export const TIPOS_CUENTA: TipoCuenta[] = [
  "flujo",
  "frente",
  "prestamo",
  "anticipo_rendimiento",
  "sofom",
  "asimilado",
];

export const ETIQUETAS_TIPO_CUENTA: Record<TipoCuenta, string> = {
  flujo: "Flujo",
  frente: "Frente",
  prestamo: "Préstamo",
  anticipo_rendimiento: "Anticipo a rendimientos",
  sofom: "SOFOM",
  asimilado: "Asimilado",
};

export type Estado =
  | "borrador"
  | "en_validacion"
  | "observada"
  | "pendiente_direccion"
  | "aprobada"
  | "en_pago"
  | "pagada"
  | "cancelada";

export interface Usuario {
  id: number;
  username: string;
  nombre: string;
  rol: Rol;
  /** Cargos de Tesorería asignados (0 o más). */
  cargos?: Cargo[];
}

export interface Operacion {
  id: number;
  folio: string;
  tipo: "pago" | "cobro" | "financiamiento" | "flujo" | "pago_especial";
  concepto: string;
  proveedor: string;
  monto: number;
  moneda: string;
  fecha_operacion: string;
  estado: Estado;
  cliente_id: number | null;
  cliente?: string | null;
  pagador?: string;
  tipo_operacion?: string;
  timbrar?: number;
  comision_pct?: number;
  observaciones?: string;
  creado_en: string;
  actualizado_en: string;
  capturista?: string;
  /** Liberación del Tesorero Fondeador (Fase 12). */
  liberada_por?: number | null;
  liberada_en?: string | null;
  liberador?: string | null;
}

export interface Revision {
  id: number;
  operacion_id: number;
  revisor: string;
  resultado: "aprobada" | "observada";
  comentario: string;
  fecha: string;
}

export type MedioPago = "transferencia" | "domiciliacion" | "cheque" | "efectivo" | "otro";

export interface Pago {
  id: number;
  operacion_id: number;
  medio: MedioPago;
  monto: number;
  moneda: string;
  fecha_pago: string;
  comprobante: string;
  notas: string;
  pagador?: string;
  folio?: string;
  fecha_registro: string;
}

export const MEDIOS_PAGO: MedioPago[] = ["transferencia", "domiciliacion", "cheque", "efectivo", "otro"];

export interface Cuenta {
  id: number;
  nombre: string;
  banco: string;
  numero_cuenta: string;
  tipo: TipoCuenta;
  saldo_inicial: number;
  activa: number;
  /** Fase 13: visible en el listado de pagadoras de los operadores (Tesorería la controla). */
  visible_operador?: number;
  creado_en: string;
  saldo_actual?: number;
  total_pagado?: number;
  tesorero?: string | null;
  /** Fase 15 — catálogo maestro (columnas añadidas por la migración). */
  clabe?: string;
  moneda?: string;
  origen?: string;
  estatus?: string;
  cliente?: string;
  fecha_alta?: string | null;
  fecha_baja?: string | null;
  formato_reporte?: string;
}

/**
 * Fase 13: monedas más usadas para la opción "Otra moneda…" de la captura
 * (además de MXN y USD). El ejecutivo elige de esta lista o especifica un
 * código de 3 letras.
 */
export const MONEDAS_COMUNES: Array<{ codigo: string; nombre: string }> = [
  { codigo: "EUR", nombre: "Euro" },
  { codigo: "GBP", nombre: "Libra Esterlina" },
  { codigo: "JPY", nombre: "Yen Japonés" },
  { codigo: "CHF", nombre: "Franco Suizo" },
  { codigo: "CAD", nombre: "Dólar Canadiense" },
  { codigo: "AUD", nombre: "Dólar Australiano" },
  { codigo: "CNY", nombre: "Yuan Chino" },
];

export interface MovimientoCuenta {
  fuente: "pago" | "movimiento";
  fecha: string;
  monto: number;
  concepto: string;
}

export interface Evento {
  id: number;
  usuario: string;
  accion: string;
  detalle: string;
  fecha: string;
  folio?: string | null;
}

export const ETIQUETAS_ESTADO: Record<Estado, string> = {
  borrador: "Borrador",
  en_validacion: "En calidad",
  observada: "Observada",
  pendiente_direccion: "Pend. Dirección",
  aprobada: "Aprobada",
  en_pago: "En pago (tandas)",
  pagada: "Pagada",
  cancelada: "Cancelada",
};

// ---- Formato FLUJO (captura completa de operaciones) ----

export interface Broker {
  id: number;
  nombre: string;
  porcentaje: number;
  activo: number;
  creado_en: string;
}

export interface Dispersion {
  id?: number;
  operacion_id?: number;
  orden?: number;
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
  /** Fase 14: datos de la persona beneficiaria y del pago — TODOS OPCIONALES. */
  nombre?: string;
  apellido_paterno?: string;
  apellido_materno?: string;
  concepto?: string;
  referencia_pago?: string;
  /** Formato de Operaciones: RFC de la persona beneficiaria (opcional). */
  rfc?: string;
  importe: number;
  /** Pagadora solicitada (Tarea 12): nombre del catálogo o "CUALQUIER <TIPO>". */
  pagadora?: string;
  pagadora_cuenta_id?: number | null;
}

/**
 * Pagadora/frente de la operación seleccionado del catálogo de Tesorería
 * (Tarea 12). cuenta_id NULL = "CUALQUIER <tipo>" (Tesorería determina).
 */
export interface DestinoOperacion {
  id: number;
  operacion_id: number;
  cuenta_id: number | null;
  tipo: string;
  nombre: string;
  manejo_manual: number;
  cuenta?: string | null;
  banco?: string | null;
  cuenta_activa?: number | null;
}

export interface OperacionBroker {
  id: number;
  operacion_id: number;
  broker_id: number;
  nombre: string;
  porcentaje: number;
  monto: number;
}

export interface CalculosFlujo {
  iva: number;
  neto: number;
  comision_total: number;
  comision_brokers: number;
  /** Fase 14: comisión que va DIRECTO al resguardo de TRF. */
  comision_trf?: number;
  flujo_total: number;
  devolucion: number;
  diferencia: number;
  comprobacion: "VERDADERO" | "FALSO";
}

/**
 * Fase 14: datos del pago especial de una operación (sin el contenido del
 * formato: el archivo se descarga por su propio endpoint).
 */
export interface PagoEspecialInfo {
  operacion_id: number;
  descripcion: string;
  pagadora_cuenta_id: number | null;
  pagadora: string;
  resguardo_origen: "trf" | "broker";
  broker_origen_id: number | null;
  broker_origen: string;
  formato_nombre: string;
  formato_mime: string;
  creado_por: number;
  creado_por_nombre?: string;
  creado_en: string;
}

export interface DetalleOperacion {
  operacion: Operacion;
  liberada_por_nombre?: string | null;
  revisiones: Revision[];
  historial: Evento[];
  pagos: Pago[];
  pago: Pago | null;
  deposito: DepositoOperacion | null;
  depositos: DepositoOperacion[];
  financiamientos: Financiamiento[];
  respaldo: RespaldoOperacion | null;
  dispersiones: Dispersion[];
  destinos?: DestinoOperacion[];
  altas_dispersiones?: EstadoAltaDispersion[];
  brokers: OperacionBroker[];
  calculos: CalculosFlujo;
  pago_especial?: PagoEspecialInfo | null;
  totales_pago: { total_por_dispersar: number; total_dispersado: number; restante: number };
}

/** Estado del alta bancaria de una línea de dispersión (Fase 12). */
export interface EstadoAltaDispersion {
  dispersion_id: number;
  beneficiario: string;
  banco: string;
  cuenta: string;
  importe: number;
  /** false si la línea no tiene banco o cuenta/CLABE (no verificable). */
  verificable: boolean;
  registrada: boolean;
  estado_alta: "solicitada" | "registrada" | "rechazada" | null;
}

// ---- Fase 12: altas bancarias (Tesorería de Altas) ----

export interface AltaBancaria {
  id: number;
  operacion_id: number | null;
  beneficiario: string;
  banco: string;
  moneda: string;
  cuenta: string;
  /** CLABE de 18 dígitos (fase 15; el backend la devuelve con SELECT ab.*). */
  clabe: string;
  estado: "solicitada" | "registrada" | "rechazada";
  notas: string;
  motivo_rechazo: string;
  solicitado_por: number;
  creado_en: string;
  resuelto_por: number | null;
  resuelto_en: string | null;
  /** Datos que agrega el backend al consultar. */
  solicitador?: string;
  resolutor?: string | null;
  folio?: string | null;
  concepto?: string | null;
}

export interface AsignacionEjecutivo {
  id: number;
  validador_id: number;
  ejecutivo_id: number;
  motivo: string;
  asignado_por: number;
  activo: number;
  creado_en: string;
  cerrado_en: string | null;
  validador: string;
  validador_username: string;
  ejecutivo: string;
  ejecutivo_username: string;
  asignador: string;
}

// ---- Barra de pronóstico (Tesorería): operaciones capturadas por categoría ----
export interface PronosticoCategoria {
  categoria: "FLUJOS" | "ASIMILADOS" | "FRENTES" | "PAGOS ESPECIALES" | "OTROS";
  operaciones: number;
  monto: number;
  flujo_total: number;
}

export interface Pronostico {
  categorias: PronosticoCategoria[];
  por_estado: Array<{ estado: string; operaciones: number; monto: number }>;
  total: { operaciones: number; monto: number; flujo_total: number };
}

export interface ResumenFondeador {
  por_estado: Array<{ operaciones: number; monto: number; flujo_total: number }>;
  por_tipo: Array<{
    tipo_operacion: string;
    moneda: string;
    operaciones: number;
    monto: number;
    por_validar: number;
    por_dispersar: number;
    pagado: number;
  }>;
  por_liberar: { operaciones: number; monto: number };
  liberadas: { operaciones: number; monto: number };
}

// ---- Respaldo de operaciones: depósitos múltiples y financiamientos (§6.1) ----

export interface Financiamiento {
  id: number;
  operacion_id: number;
  cliente_id: number;
  monto: number;
  notas: string;
  estado: "solicitado" | "aprobado" | "rechazado" | "cancelado";
  requiere_aprobacion: number;
  exento_motivo: string;
  solicitado_por: number;
  creado_en: string;
  resuelto_por: number | null;
  resuelto_en: string | null;
  movimiento_id: number | null;
  /** Datos que agrega el backend al consultar. */
  cliente?: string;
  folio?: string;
  concepto?: string;
  monto_operacion?: number;
  estado_operacion?: string;
  solicitador?: string;
  resolutor?: string | null;
}

/** Balanza de respaldo de una operación: lo que hay contra lo que se pagará. */
export interface RespaldoOperacion {
  saldo_resguardo: number;
  depositos_pendientes: number;
  financiamiento_solicitado: number;
  disponible: number;
  requerido: number;
  faltante: number;
}

export interface ReporteDireccion {
  umbral_direccion: number;
  por_estado: Array<{ estado: Estado; operaciones: number; monto: number }>;
  pendientes_direccion: Operacion[];
  totales: { operaciones: number; monto: number };
  pagos_ultimos_30_dias: { pagos: number; monto: number };
  pendientes_tesoreria: { operaciones: number; monto: number };
}

// ---- Fase roles (01-ROLES.md) ----

export interface Cliente {
  id: number;
  nombre: string;
  rfc: string;
  contacto: string;
  notas: string;
  activo: number;
  creado_en: string;
  ejecutivo?: string | null;
  resguardo?: number;
  /** Política de financiamiento (la determina Dirección, §6.1). */
  financiamiento_sin_aprobacion?: number;
  financiamiento_maximo?: number | null;
  /** Fase 14: comisiones preestablecidas del cliente (las fija
   *  admin_operaciones). null = sin preestablecer. */
  comision_broker_pct?: number | null;
  comision_trf_pct?: number | null;
}

export interface Asignacion {
  id: number;
  cliente_id: number;
  ejecutivo_id: number;
  motivo: string;
  activo: number;
  creado_en: string;
  cerrado_en: string | null;
  ejecutivo: string;
  asignador: string;
}

export interface UsuarioAdmin {
  id: number;
  username: string;
  nombre: string;
  rol: Rol;
  cargos: Cargo[];
  activo: number;
}

export interface CatalogoRegistro {
  id: number;
  dominio: string;
  clave: string;
  valor: string;
  activo: number;
}

export interface Parametro {
  clave: string;
  valor: string;
  descripcion: string;
  actualizado_en: string;
}

// ---- Fase roles 2-4 (01-ROLES.md §4-§7) ----

export interface FilaColaValidacion {
  id: number;
  folio: string;
  concepto: string;
  proveedor: string;
  monto: number;
  moneda: string;
  actualizado_en: string;
  cliente?: string | null;
  capturista: string;
  validador_id: number | null;
  validador_asignado?: string | null;
}

export interface CargoValidacion {
  id: number;
  username: string;
  nombre: string;
  activo: number;
  asignadas: number;
  revisadas: number;
}

export interface AsignacionValidacion {
  id: number;
  operacion_id: number;
  validador_id: number;
  motivo: string;
  activo: number;
  creado_en: string;
  cerrado_en: string | null;
  validador: string;
  asignador: string;
}

export interface AsignacionCuenta {
  id: number;
  cuenta_id: number;
  tesorero_id: number;
  motivo: string;
  activo: number;
  creado_en: string;
  cerrado_en: string | null;
  tesorero: string;
  asignador: string;
}

export interface Cobertura {
  id: number;
  cuenta_id: number;
  tesorero_habitual_id: number;
  tesorero_temporal_id: number;
  fecha_inicio: string;
  fecha_fin: string | null;
  motivo: string;
  activo: number;
  creado_en: string;
  cerrado_en: string | null;
  cuenta: string;
  habitual: string;
  temporal: string;
  asignador: string;
}

export interface AplicacionRecurso {
  id: number;
  movimiento_id: number;
  operacion_id: number;
  importe: number;
  moneda: string;
  observaciones: string;
  aplicado_por: number;
  aplicado_en: string;
  liberado_por: number | null;
  liberado_en: string | null;
  liberado_motivo: string | null;
  folio: string;
  estado_operacion: string;
  aplicador: string;
  liberador?: string | null;
  tipo_movimiento: string;
  monto_movimiento: number;
  concepto_movimiento: string;
  cuenta_id: number;
  cuenta: string;
  disponible_movimiento: number;
}

// ---- Resguardos y coberturas de clientes (área de Operaciones) ----

export interface CoberturaCliente {
  id: number;
  cliente_id: number;
  ejecutivo_habitual_id: number;
  ejecutivo_temporal_id: number;
  fecha_inicio: string;
  fecha_fin: string | null;
  motivo: string;
  activo: number;
  creado_en: string;
  cerrado_en: string | null;
  habitual: string;
  temporal: string;
  asignador: string;
}

export interface ResguardoMovimiento {
  id: number;
  cliente_id: number;
  tipo: "deposito" | "cargo" | "financiamiento";
  importe: number;
  operacion_id: number | null;
  cuenta_id: number | null;
  comprobante: string;
  observaciones: string;
  creado_en: string;
  folio?: string | null;
  cuenta?: string | null;
  registrado_por: string;
}

export interface ResguardoDetalle {
  cliente: { id: number; nombre: string };
  saldo: number;
  movimientos: ResguardoMovimiento[];
}

export interface DepositoOperacion {
  id: number;
  operacion_id: number;
  cuenta_id: number;
  monto: number;
  comprobante: string;
  fecha_deposito: string;
  indicado_por: number;
  creado_en: string;
  validado_por: number | null;
  validado_en: string | null;
  cuenta?: string | null;
  /** Comprobantes adjuntos (metadatos; el detalle los agrega el backend). */
  comprobantes?: ComprobanteDeposito[];
}

export interface DepositoPendiente extends DepositoOperacion {
  folio: string;
  monto_operacion: number;
  estado_operacion: string;
  cliente?: string | null;
  cuenta: string;
  indicador: string;
  /** Cuántos comprobantes tiene adjuntos (sin ellos no puede validarse). */
  comprobantes_count?: number;
}

// ---- Comprobantes de depósitos (respaldo documental, §5.3) ----

export interface ComprobanteDeposito {
  id: number;
  deposito_id: number;
  nombre: string;
  mime: string;
  tamano: number;
  subido_por: number;
  creado_en: string;
}

export interface ComprobanteDescargado extends ComprobanteDeposito {
  contenido_base64: string;
}

// ---- Concentrado de movimientos bancarios (panel tipo Excel) ----

export interface MovimientoConcentrado {
  id: number;
  cuenta_id: number;
  cuenta: string;
  tipo: "deposito" | "retiro";
  monto: number;
  concepto: string;
  referencia: string;
  fecha: string;
  origen: string;
  creado_por_nombre: string;
  /** Marca de trabajo: liga el movimiento con el depósito del cliente. */
  deposito_id: number | null;
  marca: string;
  marcado_por: number | null;
  marcado_por_nombre: string | null;
  marcado_en: string | null;
  deposito_comprobante?: string | null;
  deposito_folio?: string | null;
  deposito_operacion_id?: number | null;
  deposito_cliente?: string | null;
}

export interface FilaRespaldoOperacion {
  id: number;
  folio: string;
  estado: Estado;
  monto: number;
  tipo: string;
  fecha_operacion: string;
  cliente: string | null;
  resguardo_saldo: number;
  depositos_pendientes: number;
  depositos_validados: number;
  depositos_sin_comprobante: number;
  financiamiento_solicitado: number;
  financiamiento_aprobado: number;
  respaldo_solido: number;
  cuadre: boolean;
}

// ---- Resguardos de brokers (comisiones cobradas) ----

export interface MovimientoBroker {
  id: number;
  broker_id: number;
  tipo: "comision" | "retiro";
  importe: number;
  operacion_id: number | null;
  folio?: string | null;
  notas: string;
  creador: string;
  creado_en: string;
}

export interface ResguardoBroker {
  broker_id: number;
  nombre: string;
  porcentaje: number;
  activo: number;
  comisiones: number;
  retiros: number;
  saldo: number;
  movimientos: MovimientoBroker[];
}

export interface CuentaCatalogo {
  id: number;
  nombre: string;
  banco: string;
  numero_cuenta: string;
  tipo?: TipoCuenta;
  /** Fase 13: 1 = aparece en el listado de pagadoras de los operadores. */
  visible_operador?: number;
}

// ---- Resguardo de TRF (la empresa, Fase 13) ----

export interface TrfResguardoMovimiento {
  id: number;
  tipo: "ingreso" | "retiro";
  importe: number;
  moneda: string;
  /** Tipo de cambio que aplicó el banco (obligatorio cuando moneda ≠ MXN). */
  tipo_cambio: number | null;
  operacion_id: number | null;
  folio?: string | null;
  notas: string;
  creador: string;
  creado_en: string;
  /** Equivalente en pesos (importe para MXN; importe × tipo_cambio para otras). */
  equivalente_mxn: number;
}

export interface TrfResguardoDetalle {
  movimientos: TrfResguardoMovimiento[];
  saldos: Array<{
    moneda: string;
    saldo: number;
    ingresos: number;
    retiros: number;
    equivalente_mxn: number;
  }>;
  equivalente_total_mxn: number;
}

/** Ajuste del negocio: saldos del resguardo de TRF SIN el ledger — lo consulta
 * la captura del pago especial (quien captura ya no ve los movimientos). */
export interface TrfResguardoSaldos {
  saldos: TrfResguardoDetalle["saldos"];
  equivalente_total_mxn: number;
}

// ===================== Fase 15 — Cuentas, bóveda y altas en portales =====================

/** Banco del catálogo SPEI (la clave son los 3 primeros dígitos de la CLABE). */
export interface BancoSpei {
  clave: string;
  nombre_corto: string;
  nombre_completo: string;
}

/** Resultado de validar/derivar una CLABE (regla por banco; Santander especial). */
export interface ValidacionClabe {
  ok: boolean;
  clabe: string;
  banco: { clave: string; nombre: string } | null;
  cuenta: string;
  errores: string[];
}

/** Credencial de la bóveda (los sensibles NUNCA viajan en listados). */
export interface CredencialBoveda {
  id: number;
  cuenta_id: number;
  tipo: "portal" | "correo" | "eplata" | "sofipo" | "token" | "otro";
  etiqueta: string;
  usuario: string;
  tiene_secreto: boolean;
  tiene_nip: boolean;
  tiene_clave_seguridad: boolean;
  token_numero: string;
  telefono: string;
  correo: string;
  vigencia: string;
  notas: string;
  activo: number;
  creado_por: number;
  creado_por_nombre?: string;
  creado_en: string;
  actualizado_en: string | null;
}

/** Registro de acceso a la bóveda (quién consultó/copió qué y cuándo). */
export interface AccesoCredencial {
  id: number;
  credencial_id: number;
  usuario_id: number;
  usuario?: string;
  accion: "ver" | "crear" | "actualizar" | "desactivar";
  campo: string;
  fecha: string;
  etiqueta?: string;
  tipo?: string;
}

/** Registro de una alta bancaria en el portal de una pagadora. */
export interface AltaPortal {
  id: number;
  alta_bancaria_id: number;
  portal_cuenta_id: number;
  portal?: string;
  estado: "pendiente" | "dada_de_alta" | "rechazada";
  motivo_rechazo: string;
  registrado_por: number | null;
  registrador?: string | null;
  registrado_en: string | null;
  creado_en: string;
}

/** Vista tipo Excel (hoja "SOLICITUD ALTAS"): cada alta con sus portales y el
 * catálogo de portales (pagadoras activas), todo en una sola llamada. */
export interface MatrizAltas {
  altas: Array<AltaBancaria & { portales: AltaPortal[] }>;
  portales: Array<{ id: number; nombre: string }>;
}

/** Línea creada por la captura por lotes de altas (formato ALTA CUENTA). */
export interface LineaLoteAltas {
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

export interface ResultadoLoteAltas {
  creadas: LineaLoteAltas[];
  duplicadas: Array<{ linea: number; beneficiario: string; banco: string; cuenta: string; estado: string; alta_id: number }>;
  errores: Array<{ linea: number; errores: string[] }>;
  portales: Array<{ id: number; nombre: string }>;
}

/** Fila del listado de un portal (para teclear/pegar en el portal bancario). */
export interface FilaPortalAltas {
  alta_portal_id: number;
  estado_portal: AltaPortal["estado"];
  motivo_rechazo: string;
  registrado_en: string | null;
  alta_id: number;
  beneficiario: string;
  banco: string;
  cuenta: string;
  clabe: string;
  moneda: string;
  estado_alta: AltaBancaria["estado"];
  registrador?: string | null;
}

// ---- Sección RESGUARDOS (unificada; sustituye al apartado 'Resguardo TRF') ----

/** Fila del listado de resguardos: uno por cliente + resumen del resguardo TRF. */
export interface ResguardoResumen {
  cliente_id: number;
  cliente: string;
  activo: number;
  saldo: number;
  movimientos_count: number;
  ultimo_movimiento: string | null;
}

export interface ResguardoLista {
  resguardos: ResguardoResumen[];
  trf: {
    saldos: Array<{ moneda: string; saldo: number; equivalente_mxn: number }>;
    equivalente_total_mxn: number;
  };
}

/** Detalle del resguardo de UN mes (con saldo de apertura, como el Excel). */
export interface ResguardoMesDetalle extends ResguardoDetalle {
  mes: string;
  historial_completo: boolean;
  saldo_anterior: number;
}

// ---- Contaduría: solicitudes de timbrado (facturación) ----

export interface SolicitudTimbrado {
  id: number;
  folio: string;
  fecha_operacion: string;
  estado: string;
  monto: number;
  moneda: string;
  tipo: string;
  tipo_operacion: string | null;
  comision_pct: number | null;
  cliente: string | null;
  capturado_por: string;
  dispersiones_count: number;
}

// ---- Estructuras de cuentas (formato Ejercicio 2026 de Contaduría) ----

export type TipoEstructura = "FRENTE" | "RB" | "FLUJOS" | "SOFOM";

export interface Estructura {
  id: number;
  cuenta_id: number | null;
  giro: string;
  nucleo: string;
  razon_social: string;
  tipo: TipoEstructura;
  empresa: string;
  importe_maximo: string;
  observaciones: string;
  estatus_operacion: number;
  bancos: Record<string, number>;
  total_cuentas: number;
  extras: Record<string, number>;
  observaciones2: string;
  creado_en: string;
  actualizado_en: string | null;
  cuenta?: string | null;
  cuenta_banco?: string | null;
}

/** Columnas de bancos y trámites del formato (en el orden del Excel). */
export const BANCOS_ESTRUCTURA = [
  "JS",
  "BANORTE",
  "BANORTE US",
  "SANTANDER",
  "SANTANDER US",
  "BANCOMER",
  "BANCOMER US",
  "E PLATA",
  "E PLATA 02",
  "KLU",
  "AFIRME",
  "KUSPID",
  "TRAFALGAR",
] as const;

export const EXTRAS_ESTRUCTURA = [
  "SUCURSAL",
  "REPSE 2023",
  "REPSE 2024",
  "REPSE 2025",
  "INE",
  "TIANGUIS DIGITAL",
  "COMPRA NET",
  "PADRON DE PROVEEDORES MUNICIPAL QRO",
  "PADRON PROVEEDORES ESTATAL QRO",
  "PADRON PROVEEDOR PUEBLA",
  "CFE",
  "INM CONSTANCIA DE EMPLEADOR",
  "RP",
  "ISN",
] as const;

/** Catálogo activo para la captura (frentes/RB vigentes con importe máximo). */
export interface EstructuraCatalogo {
  id: number;
  cuenta_id: number | null;
  giro: string;
  nucleo: string;
  razon_social: string;
  tipo: TipoEstructura;
  empresa: string;
  importe_maximo: string;
  total_cuentas: number;
  cuenta: string | null;
}
