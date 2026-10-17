export interface ReporteDireccion {
  umbral_direccion: number;
  por_estado: Array<{ estado: Estado; operaciones: number; monto: number }>;
  pendientes_direccion: Operacion[];
  totales: { operaciones: number; monto: number };
  pagos_ultimos_30_dias: { pagos: number; monto: number };
  pendientes_tesoreria: { operaciones: number; monto: number };
}
