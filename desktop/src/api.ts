import type {
  Cuenta,
  Evento,
  MedioPago,
  MovimientoCuenta,
  Operacion,
  Pago,
  ReporteDireccion,
  Revision,
  Usuario,
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
  lista: (filtros: { estado?: string; q?: string } = {}) => {
    const params = new URLSearchParams();
    if (filtros.estado) params.set("estado", filtros.estado);
    if (filtros.q) params.set("q", filtros.q);
    const qs = params.toString();
    return solicitar<{ operaciones: Operacion[] }>(`/operaciones${qs ? `?${qs}` : ""}`);
  },
  detalle: (id: number) =>
    solicitar<{ operacion: Operacion; revisiones: Revision[]; historial: Evento[]; pago: Pago | null }>(
      `/operaciones/${id}`
    ),
  crear: (datos: Partial<Operacion>) =>
    solicitar<{ operacion: Operacion }>("/operaciones", {
      method: "POST",
      body: JSON.stringify(datos),
    }),
  enviarValidacion: (id: number) =>
    solicitar<{ operacion: Operacion }>(`/operaciones/${id}/enviar-validacion`, { method: "POST" }),
  revisar: (id: number, resultado: "aprobada" | "observada", comentario: string) =>
    solicitar<{ operacion: Operacion }>(`/operaciones/${id}/revision`, {
      method: "POST",
      body: JSON.stringify({ resultado, comentario }),
    }),
  cancelar: (id: number) =>
    solicitar<{ operacion: Operacion }>(`/operaciones/${id}/cancelar`, { method: "POST" }),
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
    solicitar<{ operacion: Operacion; pago: Pago }>(`/operaciones/${id}/pago`, {
      method: "POST",
      body: JSON.stringify(datos),
    }),
  pagos: () => solicitar<{ pagos: Pago[] }>("/pagos"),
  reportesDireccion: () => solicitar<ReporteDireccion>("/reportes/direccion"),
  cuentas: () => solicitar<{ cuentas: Cuenta[] }>("/cuentas"),
  detalleCuenta: (id: number) =>
    solicitar<{ cuenta: Cuenta; movimientos: MovimientoCuenta[] }>(`/cuentas/${id}`),
  crearCuenta: (datos: { nombre: string; banco?: string; numero_cuenta?: string; saldo_inicial?: number }) =>
    solicitar<{ cuenta: Cuenta }>("/cuentas", { method: "POST", body: JSON.stringify(datos) }),
  crearMovimiento: (
    id: number,
    datos: { tipo: "deposito" | "retiro"; monto: number; concepto: string; fecha?: string }
  ) =>
    solicitar<{ movimiento: unknown }>(`/cuentas/${id}/movimientos`, {
      method: "POST",
      body: JSON.stringify(datos),
    }),
  aprobarDireccion: (id: number, aprobado: boolean, comentario: string) =>
    solicitar<{ operacion: Operacion }>(`/operaciones/${id}/aprobacion-direccion`, {
      method: "POST",
      body: JSON.stringify({ aprobado, comentario }),
    }),
  auditoria: () => solicitar<{ eventos: Evento[] }>("/auditoria"),
};