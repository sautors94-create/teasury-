export type Rol = "operacion" | "validacion" | "tesoreria" | "direccion" | "auditoria";

export type Estado =
  | "borrador"
  | "en_validacion"
  | "observada"
  | "pendiente_direccion"
  | "aprobada"
  | "pagada"
  | "cancelada";

export interface Usuario {
  id: number;
  username: string;
  nombre: string;
  rol: Rol;
}

export interface Operacion {
  id: number;
  folio: string;
  tipo: "pago" | "cobro" | "financiamiento";
  concepto: string;
  proveedor: string;
  monto: number;
  moneda: string;
  fecha_operacion: string;
  estado: Estado;
  creado_en: string;
  actualizado_en: string;
  capturista?: string;
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
  saldo_inicial: number;
  activa: number;
  creado_en: string;
  saldo_actual?: number;
  total_pagado?: number;
}

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
  en_validacion: "En validación",
  observada: "Observada",
  pendiente_direccion: "Pend. Dirección",
  aprobada: "Aprobada",
  pagada: "Pagada",
  cancelada: "Cancelada",
};

export interface ReporteDireccion {
  umbral_direccion: number;
  por_estado: Array<{ estado: Estado; operaciones: number; monto: number }>;
  pendientes_direccion: Operacion[];
  totales: { operaciones: number; monto: number };
  pagos_ultimos_30_dias: { pagos: number; monto: number };
  pendientes_tesoreria: { operaciones: number; monto: number };
}
