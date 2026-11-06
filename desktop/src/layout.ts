/**
 * Parser de layouts para el formato FLUJO: importa líneas de dispersión
 * (captura) o tandas de pago (Tesorería) desde Excel (.xlsx/.xls) o CSV.
 *
 * Los encabezados se normalizan (mayúsculas, sin acentos) y se aceptan alias,
 * p.ej.: NOMBRE/BENEFICIARIO, RAZON SOCIAL/RAZON_SOCIAL, CUENTA CLABE/CLABE,
 * IMPORTE/MONTO, FECHA/FECHA_PAGO, REFERENCIA/COMPROBANTE…
 *
 * Tarea 12: la columna PAGADORA se resuelve contra el catálogo de Tesorería
 * (cuentas activas): nombre exacto → cuenta concreta; "CUALQUIER <TIPO>" →
 * Tesorería determina la cuenta. La plantilla descargable lleva el catálogo
 * vigente en una segunda hoja.
 *
 * Fase 14: columnas nuevas TODAS OPCIONALES — NOMBRE (de pila), APELLIDO
 * PATERNO, APELLIDO MATERNO, CONCEPTO y REFERENCIA PAGO. Ninguna es
 * obligatoria: el sistema no exige datos, ni en captura manual ni por layout.
 */

import type { CuentaCatalogo } from "./tipos";

export interface LineaLayout {
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
  /** Fase 14: datos de la persona beneficiaria y del pago — TODOS OPCIONALES
   *  (el sistema no los hace obligatorios, ni en captura ni por layout). */
  nombre: string;
  apellido_paterno: string;
  apellido_materno: string;
  concepto: string;
  referencia_pago: string;
  /** Formato de Operaciones: RFC de la persona beneficiaria (opcional). */
  rfc: string;
  importe: number;
  /** Pagadora solicitada: nombre del catálogo o "CUALQUIER <TIPO>". */
  pagadora: string;
  /** Cuenta resuelta del catálogo; null = cualquier cuenta de ese tipo. */
  pagadora_cuenta_id: number | null;
}

export interface TandaLayout {
  medio: string;
  monto: number;
  fecha_pago: string;
  comprobante: string;
  notas: string;
}

export interface ResultadoMapeo<T> {
  filas: T[];
  errores: string[];
}

const MEDIOS_VALIDOS = ["transferencia", "domiciliacion", "cheque", "efectivo", "otro"];

const ALIAS_DISPERSION: Record<string, Exclude<keyof LineaLayout, "pagadora_cuenta_id">> = {
  BENEFICIARIO: "beneficiario",
  // Fase 14: NOMBRE pasa a ser el nombre de pila del beneficiario (persona);
  // "NOMBRE CORTO" sigue siendo el beneficiario completo (compatibilidad).
  NOMBRE: "nombre",
  "NOMBRE CORTO": "beneficiario",
  NOMBRE_CORTO: "beneficiario",
  "APELLIDO PATERNO": "apellido_paterno",
  APELLIDO_PATERNO: "apellido_paterno",
  PATERNO: "apellido_paterno",
  "APELLIDO MATERNO": "apellido_materno",
  APELLIDO_MATERNO: "apellido_materno",
  MATERNO: "apellido_materno",
  CONCEPTO: "concepto",
  "CONCEPTO DE PAGO": "concepto",
  "REFERENCIA PAGO": "referencia_pago",
  REFERENCIA_PAGO: "referencia_pago",
  "REFERENCIA PARA PAGO": "referencia_pago",
  RAZON_SOCIAL: "razon_social",
  "RAZON SOCIAL": "razon_social",
  RAZON: "razon_social",
  NOMBRE_COMPLETO: "razon_social",
  "NOMBRE COMPLETO": "razon_social",
  REFERENCIA: "referencia",
  REF: "referencia",
  RFC: "rfc",
  INE: "ine",
  NUMERO: "numero",
  NO: "numero",
  NUM: "numero",
  "#": "numero",
  TARJETA: "tarjeta",
  CUENTA: "cuenta",
  CLABE: "clabe",
  CUENTA_CLABE: "clabe",
  "CUENTA CLABE": "clabe",
  CLABE_INTERBANCARIA: "clabe",
  BANCO: "banco",
  ETIQUETA: "etiqueta",
  TAG: "etiqueta",
  PAGADORA: "pagadora",
  "PAGADORA TESORERIA": "pagadora",
  CUENTA_PAGADORA: "pagadora",
  "CUENTA PAGADORA": "pagadora",
  IMPORTE: "importe",
  MONTO: "importe",
  CANTIDAD: "importe",
};

/** Los tipos válidos para "CUALQUIER <TIPO>" con su forma textual. */
const TIPOS_CUALQUIER: Record<string, string> = {
  FLUJO: "flujo",
  FRENTE: "frente",
  PRESTAMO: "prestamo",
  "ANTICIPO RENDIMIENTO": "anticipo_rendimiento",
  "ANTICIPO A RENDIMIENTOS": "anticipo_rendimiento",
  SOFOM: "sofom",
  ASIMILADO: "asimilado",
};

const ALIAS_TANDAS: Record<string, string> = {
  MEDIO: "medio",
  MEDIO_DE_PAGO: "medio",
  "MEDIO DE PAGO": "medio",
  MONTO: "monto",
  IMPORTE: "monto",
  CANTIDAD: "monto",
  FECHA_PAGO: "fecha_pago",
  "FECHA DE PAGO": "fecha_pago",
  FECHA: "fecha_pago",
  COMPROBANTE: "comprobante",
  REFERENCIA: "comprobante",
  FOLIO: "comprobante",
  NOTAS: "notas",
  NOTA: "notas",
  OBSERVACIONES: "notas",
};

function normalizar(s: unknown): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

/** Convierte "$1,234.56", "1234,56", "1,234.56" o 1234.56 → number. */
export function importeANumero(valor: unknown): number {
  if (typeof valor === "number") return valor;
  if (typeof valor !== "string") return NaN;
  let t = valor.replace(/[$\s]/g, "");
  if (!t) return NaN;
  if (t.includes(",") && t.includes(".")) {
    t = t.replace(/,/g, "");
  } else if (t.includes(",")) {
    const partes = t.split(",");
    t = partes.length === 2 && partes[1].length !== 3 ? t.replace(",", ".") : t.replace(/,/g, "");
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

/** Normaliza fechas: Date de Excel, ISO o dd/mm/yyyy → YYYY-MM-DD ('' si vacía). */
function fechaISO(valor: unknown): string {
  if (valor instanceof Date && !Number.isNaN(valor.getTime())) {
    const y = valor.getFullYear();
    const m = String(valor.getMonth() + 1).padStart(2, "0");
    const d = String(valor.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const s = String(valor ?? "").trim();
  if (!s) return "";
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  const dmy = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/.exec(s);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  return "";
}

/** Lee el archivo (.xlsx/.xls/.csv/.txt) y devuelve filas como objetos. */
export async function leerFilas(archivo: File): Promise<Array<Record<string, unknown>>> {
  const nombre = archivo.name.toLowerCase();
  if (nombre.endsWith(".xlsx") || nombre.endsWith(".xls")) {
    const XLSX = await import("xlsx");
    const datos = await archivo.arrayBuffer();
    const libro = XLSX.read(datos, { type: "array", cellDates: true });
    // Tarea 12: la plantilla trae la hoja DISPERSIONES con los datos y
    // CATALOGO PAGADORAS de referencia; se lee la de datos si existe.
    const nombreHoja =
      libro.SheetNames.find((n) => normalizar(n) === "DISPERSIONES") ?? libro.SheetNames[0];
    const hoja = libro.Sheets[nombreHoja];
    if (!hoja) throw new Error("El archivo no tiene hojas legibles");
    return XLSX.utils.sheet_to_json<Record<string, unknown>>(hoja, { defval: "", raw: true });
  }
  if (nombre.endsWith(".csv") || nombre.endsWith(".txt")) {
    return parsearCSV(await archivo.text());
  }
  throw new Error("Formato no soportado: usa Excel (.xlsx) o CSV");
}

/** Parser CSV tolerante: detecta delimitador (, ; tab) y soporta comillas. */
function parsearCSV(texto: string): Array<Record<string, unknown>> {
  const limpio = texto.replace(/^\uFEFF/, "");
  const primera = limpio.split(/\r?\n/).find((l) => l.trim()) ?? "";
  const candidatos = [";", ",", "\t"].map((d) => ({
    d,
    n: primera.split(d).length - 1,
  }));
  candidatos.sort((a, b) => b.n - a.n);
  const delimitador = candidatos[0].n > 0 ? candidatos[0].d : ",";

  const filas: string[][] = [];
  let campo = "";
  let fila: string[] = [];
  let enComillas = false;
  for (let i = 0; i < limpio.length; i++) {
    const c = limpio[i];
    if (enComillas) {
      if (c === '"') {
        if (limpio[i + 1] === '"') {
          campo += '"';
          i++;
        } else {
          enComillas = false;
        }
      } else {
        campo += c;
      }
    } else if (c === '"') {
      enComillas = true;
    } else if (c === delimitador) {
      fila.push(campo);
      campo = "";
    } else if (c === "\n") {
      fila.push(campo);
      campo = "";
      filas.push(fila);
      fila = [];
    } else if (c !== "\r") {
      campo += c;
    }
  }
  if (campo !== "" || fila.length) {
    fila.push(campo);
    filas.push(fila);
  }
  const conDatos = filas.filter((f) => f.some((c) => c.trim() !== ""));
  const encabezados = (conDatos.shift() ?? []).map(normalizar);
  return conDatos.map((f) => {
    const obj: Record<string, unknown> = {};
    encabezados.forEach((h, i) => {
      if (h) obj[h] = (f[i] ?? "").trim();
    });
    return obj;
  });
}

/**
 * Mapea filas del layout a líneas de dispersión (captura del formato FLUJO).
 * Con el catálogo de Tesorería (Tarea 12) la columna PAGADORA es obligatoria y
 * se resuelve: nombre del catálogo (comparación sin acentos/mayúsculas) →
 * cuenta concreta; "CUALQUIER <TIPO>" → Tesorería determina la cuenta. Sin
 * catálogo se conserva el texto tal cual (compatibilidad).
 */
export function mapearDispersiones(
  filas: Array<Record<string, unknown>>,
  catalogo?: CuentaCatalogo[]
): ResultadoMapeo<LineaLayout> {
  const porNombre = new Map<string, CuentaCatalogo>();
  if (catalogo) {
    for (const c of catalogo) porNombre.set(normalizar(c.nombre), c);
  }
  const lineas: LineaLayout[] = [];
  const errores: string[] = [];
  filas.forEach((fila, i) => {
    const linea: LineaLayout = {
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
    };
    let reconocido = false;
    for (const [clave, valor] of Object.entries(fila)) {
      const campo = ALIAS_DISPERSION[normalizar(clave)];
      if (!campo) continue;
      reconocido = true;
      if (campo === "importe") {
        linea.importe = importeANumero(valor);
      } else if (campo === "pagadora") {
        linea.pagadora = String(valor ?? "").trim();
      } else {
        linea[campo] = String(valor ?? "").trim();
      }
    }
    if (!reconocido) return; // fila sin columnas conocidas (notas sueltas, totales…)
    const f = i + 1;
    if (!linea.beneficiario && !Number.isFinite(linea.importe)) return; // fila vacía o de totales
    if (!linea.beneficiario) errores.push(`fila ${f}: falta el beneficiario`);
    if (!Number.isFinite(linea.importe) || linea.importe <= 0) errores.push(`fila ${f}: importe inválido`);
    // Pagadora (Tarea 12): obligatoria con catálogo; se resuelve contra él.
    if (catalogo) {
      const texto = normalizar(linea.pagadora);
      if (!texto) {
        errores.push(`fila ${f}: indica la PAGADORA (cuenta del catálogo) o escribe CUALQUIER FLUJO`);
      } else if (porNombre.has(texto)) {
        const cuenta = porNombre.get(texto)!;
        linea.pagadora = cuenta.nombre;
        linea.pagadora_cuenta_id = cuenta.id;
      } else {
        const cualquier = /^CUALQUIER\s+(.+)$/.exec(texto);
        const tipo = cualquier ? TIPOS_CUALQUIER[normalizar(cualquier[1])] : undefined;
        if (tipo) {
          linea.pagadora = `CUALQUIER ${tipo.toUpperCase().replace(/_/g, " ")}`;
          linea.pagadora_cuenta_id = null;
        } else {
          errores.push(
            `fila ${f}: la pagadora '${linea.pagadora}' no está en el catálogo de Tesorería (descarga el layout actualizado; para dejarla a criterio escribe CUALQUIER FLUJO)`
          );
        }
      }
    }
    lineas.push(linea);
  });
  if (lineas.length === 0 && errores.length === 0) {
    errores.push(
      "No se reconoció ninguna línea: el layout debe tener encabezados como BENEFICIARIO, IMPORTE, CLABE, BANCO, PAGADORA…"
    );
  }
  return { filas: lineas, errores };
}

/** Mapea filas del layout a tandas de pago (Tesorería). */
export function mapearTandas(filas: Array<Record<string, unknown>>): ResultadoMapeo<TandaLayout> {
  const tandas: TandaLayout[] = [];
  const errores: string[] = [];
  filas.forEach((fila, i) => {
    const tanda: TandaLayout = { medio: "transferencia", monto: NaN, fecha_pago: "", comprobante: "", notas: "" };
    let reconocido = false;
    for (const [clave, valor] of Object.entries(fila)) {
      const campo = ALIAS_TANDAS[normalizar(clave)];
      if (!campo) continue;
      reconocido = true;
      if (campo === "monto") tanda.monto = importeANumero(valor);
      else if (campo === "fecha_pago") tanda.fecha_pago = fechaISO(valor);
      else if (campo === "medio") {
        const medio = normalizar(valor).replace(/\s+/g, "").toLowerCase();
        tanda.medio = MEDIOS_VALIDOS.includes(medio) ? medio : "transferencia";
      } else {
        (tanda as unknown as Record<string, string>)[campo] = String(valor ?? "").trim();
      }
    }
    if (!reconocido) return;
    const f = i + 1;
    if (!Number.isFinite(tanda.monto) && !tanda.comprobante) return; // fila vacía
    if (!Number.isFinite(tanda.monto) || tanda.monto <= 0) errores.push(`fila ${f}: monto inválido`);
    if (!tanda.comprobante) errores.push(`fila ${f}: falta el comprobante`);
    tandas.push(tanda);
  });
  if (tandas.length === 0 && errores.length === 0) {
    errores.push("No se reconoció ninguna tanda: el layout debe tener encabezados como MONTO, FECHA, COMPROBANTE…");
  }
  return { filas: tandas, errores };
}

/**
 * Descarga la plantilla del layout de dispersiones en Excel (.xlsx) con el
 * catálogo de Tesorería vigente (Tarea 12): hoja "DISPERSIONES" para llenar
 * (con la columna PAGADORA) y hoja "CATALOGO PAGADORAS" con las cuentas activas
 * al momento de la descarga. Si Tesorería saca una cuenta de operación, deja de
 * aparecer aquí en la siguiente descarga.
 */
export async function descargarPlantillaDispersiones(catalogo: CuentaCatalogo[] = []): Promise<void> {
  const XLSX = await import("xlsx");
  const encabezados = [
    "BENEFICIARIO",
    "NOMBRE",
    "APELLIDO PATERNO",
    "APELLIDO MATERNO",
    "RAZON SOCIAL",
    "CONCEPTO",
    "REFERENCIA",
    "RFC",
    "REFERENCIA PAGO",
    "INE",
    "NUMERO",
    "TARJETA",
    "CUENTA",
    "CLABE",
    "BANCO",
    "PAGADORA",
    "IMPORTE",
    "ETIQUETA",
  ];
  const ejemplo: Array<Array<string | number>> = [
    [
      "COMERCIAL BRAIN FENIX",
      "",
      "",
      "",
      "COMERCIAL BRAIN FENIX S DE RL DE CV",
      "PAGO DE PROVEEDORES",
      "",
      "",
      "",
      "",
      "",
      "",
      "6461803528523520323",
      "",
      "STP",
      catalogo[0]?.nombre ?? "FLUJOS 01",
      "57000.00",
      "PROVEEDOR",
    ],
    ["JUAN", "PEREZ", "GARCIA", "", "", "PAGO DE HONORARIOS", "1010", "", "REF-88", "", "", "", "646180352590100116", "", "STP", "CUALQUIER FLUJO", "303.00", "GASTOS"],
  ];
  const hojaDatos = XLSX.utils.aoa_to_sheet([encabezados, ...ejemplo]);
  hojaDatos["!cols"] = [
    { wch: 26 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 34 }, { wch: 22 }, { wch: 12 }, { wch: 14 }, { wch: 16 },
    { wch: 12 }, { wch: 10 }, { wch: 18 }, { wch: 22 }, { wch: 20 }, { wch: 12 }, { wch: 24 }, { wch: 12 }, { wch: 14 },
  ];
  const hojaCatalogo = XLSX.utils.aoa_to_sheet([
    ["PAGADORA", "TIPO", "BANCO", "NUMERO DE CUENTA"],
    ...catalogo.map((c) => [
      c.nombre,
      etiquetaTipo(c.tipo),
      c.banco ?? "",
      c.numero_cuenta ?? "",
    ]),
  ]);
  hojaCatalogo["!cols"] = [{ wch: 30 }, { wch: 24 }, { wch: 14 }, { wch: 20 }];
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, hojaDatos, "DISPERSIONES");
  XLSX.utils.book_append_sheet(libro, hojaCatalogo, "CATALOGO PAGADORAS");
  XLSX.writeFile(libro, "layout-dispersiones.xlsx");
}

/** Etiqueta legible del tipo de cuenta para el catálogo del layout. */
function etiquetaTipo(tipo?: string): string {
  const etiquetas: Record<string, string> = {
    flujo: "Flujo",
    frente: "Frente",
    prestamo: "Préstamo",
    anticipo_rendimiento: "Anticipo a rendimientos",
    sofom: "SOFOM",
    asimilado: "Asimilado",
  };
  return (tipo && etiquetas[tipo]) || tipo || "";
}

/** Descarga la plantilla CSV del layout de tandas de pago. */
export function descargarPlantillaTandas(): void {
  const filas = [
    ["MEDIO", "MONTO", "FECHA_PAGO", "COMPROBANTE", "NOTAS"],
    ["transferencia", "30000.00", "2026-10-27", "TRF-001", "Primera tanda"],
    ["transferencia", "28803.00", "2026-10-28", "TRF-002", "Segunda tanda (cierre)"],
  ];
  const csv = filas.map((f) => f.join(",")).join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const enlace = document.createElement("a");
  enlace.href = url;
  enlace.download = "plantilla-tandas.csv";
  document.body.appendChild(enlace);
  enlace.click();
  document.body.removeChild(enlace);
  URL.revokeObjectURL(url);
}

/* ------------------- Layout de cuentas (4 columnas) ---------------------- */

/** Fila del layout simple de cuentas: BANCO, NOMBRE, CLAVE y CUENTA CORTA. */
export interface FilaLayoutCuentas {
  banco: string;
  nombre: string;
  clave: string;
  cuenta_corta: string;
}

/** Alias aceptados por columna (las claves van normalizadas). */
const ALIAS_CUENTAS: Record<string, keyof FilaLayoutCuentas> = {
  BANCO: "banco",
  "BANCO EMISOR": "banco",
  INSTITUCION: "banco",
  NOMBRE: "nombre",
  "NOMBRE DE CUENTA": "nombre",
  "NOMBRE CUENTA": "nombre",
  ALIAS: "nombre",
  CLAVE: "clave",
  CLABE: "clave",
  "CLAVE INTERBANCARIA": "clave",
  "CLAVE INTERBANCARIA ESTANDARIZADA": "clave",
  "CUENTA CORTA": "cuenta_corta",
  CUENTA_CORTA: "cuenta_corta",
  "NO CUENTA": "cuenta_corta",
  "NO. CUENTA": "cuenta_corta",
  "NO DE CUENTA": "cuenta_corta",
  "NUMERO CUENTA": "cuenta_corta",
  "NUMERO DE CUENTA": "cuenta_corta",
  CUENTA: "cuenta_corta",
};

/**
 * Mapea filas del archivo (Excel o CSV) al layout de cuentas. Acepta los
 * encabezados en cualquier orden y con alias (CLAVE ≡ CLABE, CUENTA ≡
 * CUENTA CORTA…); ignora columnas desconocidas.
 */
export function mapearCuentasLayout(filas: Array<Record<string, unknown>>): FilaLayoutCuentas[] {
  return filas.map((fila) => {
    const limpia: FilaLayoutCuentas = { banco: "", nombre: "", clave: "", cuenta_corta: "" };
    for (const [crudo, valor] of Object.entries(fila)) {
      const campo = ALIAS_CUENTAS[normalizar(crudo)];
      if (!campo) continue;
      const texto = String(valor ?? "").trim();
      if (texto && !limpia[campo]) limpia[campo] = texto;
    }
    return limpia;
  });
}

/** Descarga la plantilla del layout de cuentas (sólo los 4 encabezados). */
export function descargarPlantillaCuentas(): void {
  const filas = [["BANCO", "NOMBRE", "CLAVE", "CUENTA CORTA"]];
  const csv = filas.map((f) => f.join(",")).join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const enlace = document.createElement("a");
  enlace.href = url;
  enlace.download = "layout-cuentas.csv";
  document.body.appendChild(enlace);
  enlace.click();
  document.body.removeChild(enlace);
  URL.revokeObjectURL(url);
}

/* --------------- Layout de ESTRUCTURAS (Excel de Contaduría) -------------- */

/** BANCOS ESTRUCTURA claves están en tipos.ts. */
import { BANCOS_ESTRUCTURA, EXTRAS_ESTRUCTURA } from "./tipos";

/** Fila del layout de estructuras: mismas claves que acepta el backend. */
export interface FilaEstructuraLayout {
  giro: string;
  nucleo: string;
  razon_social: string;
  tipo: string;
  empresa: string;
  importe_maximo: string;
  observaciones: string;
  estatus_operacion: number;
  bancos: Record<string, number>;
  total_cuentas: number;
  extras: Record<string, number>;
  observaciones2: string;
}

const ALIAS_ESTRUCTURAS: Record<string, string> = {
  GIRO: "giro",
  NUCLEO: "nucleo",
  "NUCLEO DE FRENTES": "nucleo",
  "NUCLEO DE FRENTE": "nucleo",
  "RAZON SOCIAL": "razon_social",
  RAZON_SOCIAL: "razon_social",
  RAZONSOCIAL: "razon_social",
  EMPRESA: "empresa",
  TIPO: "tipo",
  "IMPORTE MAXIMO PARA BAJAR POR MES": "importe_maximo",
  "IMPORTE MAXIMO PARA BAJAR AL MES": "importe_maximo",
  "IMPORTE MAXIMO PARA BAJAR": "importe_maximo",
  "IMPORTE MAXIMO": "importe_maximo",
  "ESTATUS DE OPERACION": "estatus_operacion",
  "ESTATUS OPERACION": "estatus_operacion",
  ESTATUS: "estatus_operacion",
  "TOTAL DE CUENTAS": "total_cuentas",
  "TOTAL CUENTAS": "total_cuentas",
  "TOTAL DE CTA": "total_cuentas",
  // Los DOS encabezados "OBSERVACIONES" del Excel: el 1º va a observaciones y
  // el 2º a observaciones2 (se resuelven por posición al leer la fila).
  OBSERVACIONES: "__obs__",
  OBSERVACIONES2: "observaciones2",
  "OBSERVACIONES 2": "observaciones2",
  "OBSERVACIONES TRAMITES": "observaciones2",
};

function boolANumero(valor: unknown): number {
  const t = normalizar(valor);
  return ["TRUE", "VERDADERO", "1", "SI", "X", "Y", "YES"].includes(t) ? 1 : 0;
}

function textoLimpio(valor: unknown): string {
  const s = String(valor ?? "").trim();
  return s === "*" ? "" : s;
}

/** Lee el Excel/CSV de estructuras y devuelve filas mapeadas con avisos. */
export async function leerFilasEstructuras(
  archivo: File
): Promise<{ filas: FilaEstructuraLayout[]; avisos: string[] }> {
  let matriz: unknown[][] = [];
  const nombre = archivo.name.toLowerCase();
  if (nombre.endsWith(".xlsx") || nombre.endsWith(".xls")) {
    const XLSX = await import("xlsx");
    const datos = await archivo.arrayBuffer();
    const libro = XLSX.read(datos, { type: "array", cellDates: true });
    const nombreHoja =
      libro.SheetNames.find((n) => normalizar(n) === "GENERAL") ?? libro.SheetNames[0];
    const hoja = libro.Sheets[nombreHoja];
    if (!hoja) throw new Error("El archivo no tiene hojas legibles");
    matriz = XLSX.utils.sheet_to_json<unknown[]>(hoja, { header: 1, defval: "", raw: false });
  } else if (nombre.endsWith(".csv") || nombre.endsWith(".txt")) {
    const texto = (await archivo.text()).replace(/^\uFEFF/, "");
    const primera = texto.split(/\r?\n/).find((l) => l.trim()) ?? "";
    const candidatos = [";", ",", "\t"].map((d) => ({ d, n: primera.split(d).length - 1 }));
    candidatos.sort((a, b) => b.n - a.n);
    const delimitador = candidatos[0].n > 0 ? candidatos[0].d : ",";
    matriz = texto.split(/\r?\n/).map((l) => {
      const campos: string[] = [];
      let campo = "";
      let comillas = false;
      for (let i = 0; i < l.length; i++) {
        const c = l[i];
        if (comillas) {
          if (c === '"') {
            if (l[i + 1] === '"') { campo += '"'; i++; } else comillas = false;
          } else campo += c;
        } else if (c === '"') comillas = true;
        else if (c === delimitador) { campos.push(campo); campo = ""; }
        else campo += c;
      }
      campos.push(campo);
      return campos;
    });
  } else {
    throw new Error("Formato no soportado: usa Excel (.xlsx) o CSV");
  }

  // Busca la fila de encabezados: la que tenga RAZON SOCIAL y TIPO.
  let iEncabezados = -1;
  for (let i = 0; i < Math.min(matriz.length, 12); i++) {
    const fila = (matriz[i] ?? []).map(normalizar);
    if (fila.includes("RAZON SOCIAL") && fila.includes("TIPO")) {
      iEncabezados = i;
      break;
    }
  }
  if (iEncabezados < 0) {
    throw new Error(
      "No encontré la fila de encabezados del formato (debe incluir RAZON SOCIAL y TIPO)"
    );
  }
  const encabezados = (matriz[iEncabezados] ?? []).map(normalizar);
  // Posición de los encabezados OBSERVACIONES: 1º → observaciones, 2º → observaciones2.
  const obsIdx: number[] = [];
  const columnas: Array<{ idx: number; campo: string }> = [];
  encabezados.forEach((h, idx) => {
    const campo = ALIAS_ESTRUCTURAS[h];
    if (!campo) return;
    if (campo === "__obs__") {
      obsIdx.push(idx);
      columnas.push({ idx, campo: obsIdx.length === 1 ? "observaciones" : "observaciones2" });
    } else {
      columnas.push({ idx, campo });
    }
  });

  const filas: FilaEstructuraLayout[] = [];
  const avisos: string[] = [];
  for (let r = iEncabezados + 1; r < matriz.length; r++) {
    const cruda = matriz[r] ?? [];
    const fila: FilaEstructuraLayout = {
      giro: "",
      nucleo: "",
      razon_social: "",
      tipo: "",
      empresa: "",
      importe_maximo: "",
      observaciones: "",
      estatus_operacion: 1,
      bancos: {},
      total_cuentas: 0,
      extras: {},
      observaciones2: "",
    };
    let bancosDetectados = 0;
    let extrasDetectados = 0;
    for (const [h, idx] of (encabezados as string[]).map((h, idx) => [h, idx] as const)) {
      const valor = cruda[idx];
      if (BANCOS_ESTRUCTURA.includes(h as (typeof BANCOS_ESTRUCTURA)[number])) {
        const v = boolANumero(valor);
        fila.bancos[h] = v;
        bancosDetectados += v;
        continue;
      }
      if (EXTRAS_ESTRUCTURA.includes(h as (typeof EXTRAS_ESTRUCTURA)[number])) {
        const v = boolANumero(valor);
        fila.extras[h] = v;
        extrasDetectados += v;
        continue;
      }
    }
    for (const { idx, campo } of columnas) {
      const valor = cruda[idx];
      if (campo === "estatus_operacion") fila.estatus_operacion = boolANumero(valor);
      else if (campo === "total_cuentas") {
        const n = importeANumero(valor);
        fila.total_cuentas = Number.isFinite(n) && n >= 0 ? Math.round(n) : bancosDetectados;
      } else if (["giro", "nucleo", "razon_social", "empresa", "importe_maximo", "observaciones", "observaciones2"].includes(campo)) {
        fila[campo as "giro"] = textoLimpio(valor);
      } else if (campo === "tipo") {
        const t = normalizar(valor);
        fila.tipo = ["FRENTE", "RB", "FLUJOS", "SOFOM"].includes(t) ? t : "";
      }
    }
    if (!fila.razon_social) continue; // fila de totales/notas
    if (!fila.tipo) {
      avisos.push(`fila ${r + 1}: '${fila.razon_social}' sin TIPO válido (FRENTE/RB/FLUJOS/SOFOM) — se omite`);
      continue;
    }
    if (!fila.total_cuentas) fila.total_cuentas = bancosDetectados;
    filas.push(fila);
  }
  return { filas, avisos };
}

/** Plantilla del layout de estructuras con TODAS las columnas del formato. */
export async function descargarPlantillaEstructuras(): Promise<void> {
  const XLSX = await import("xlsx");
  const encabezados = [
    "GIRO",
    "NUCLEO DE FRENTES",
    "RAZON SOCIAL",
    "TIPO",
    "EMPRESA",
    "IMPORTE MAXIMO PARA BAJAR POR MES",
    "OBSERVACIONES",
    "ESTATUS DE OPERACION",
    ...BANCOS_ESTRUCTURA,
    "TOTAL DE CUENTAS",
    ...EXTRAS_ESTRUCTURA,
    "OBSERVACIONES 2",
  ];
  const ejemplo = [
    [
      "PUBLICIDAD", "PUBLICIDAD", "EJEMPLO FRENTE SA DE CV", "FRENTE", "EJEMPLO FRENTE SA DE CV",
      "", "", 1, ...BANCOS_ESTRUCTURA.map((_, i) => (i === 0 ? 1 : 0)), 1,
      ...EXTRAS_ESTRUCTURA.map(() => 0), "",
    ],
    [
      "PUBLICIDAD", "PUBLICIDAD", "EJEMPLO RB SA DE CV", "RB", "EJEMPLO FRENTE SA DE CV",
      "de un 25 a un 30 % del flujo", "", 1, ...BANCOS_ESTRUCTURA.map((_, i) => (i === 0 ? 1 : 0)), 1,
      ...EXTRAS_ESTRUCTURA.map(() => 0), "",
    ],
  ];
  const hoja = XLSX.utils.aoa_to_sheet([encabezados, ...ejemplo]);
  hoja["!cols"] = encabezados.map((h) => ({ wch: Math.min(Math.max(h.length + 2, 10), 34) }));
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, hoja, "GENERAL");
  XLSX.writeFile(libro, "layout-estructuras.xlsx");
}
