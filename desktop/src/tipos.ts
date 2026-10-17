export type Rol = "operacion" | "validacion" | "tesoreria" | "direccion" | "auditoria";

export type Estado =
  | "borrador"
  | "en_validacion"
  | "observada"
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
  aprobada: "Aprobada",
  pagada: "Pagada",
  cancelada: "Cancelada",
};