import type { Evento, Operacion, Revision, Usuario } from "./tipos";

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
    solicitar<{ operacion: Operacion; revisiones: Revision[]; historial: Evento[] }>(
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
  auditoria: () => solicitar<{ eventos: Evento[] }>("/auditoria"),
};