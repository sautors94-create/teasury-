# Fase 15 — Altas en portales bancarios (formato "ALTA CUENTA"), catálogo SPEI y bóveda de credenciales

Origen: el formato operativo `ALTA CUENTA.xlsm` (altas de cuentas en los portales
bancarios de las pagadoras) y el catálogo maestro `CUENTAS JS` (cuentas + accesos).

## Qué resuelve

El equipo de Altas capturaba nombres y CLABE en un Excel, los limpiaba con la macro
`Tullbox` y el "NOMBRE CORRECTO" se tecleaba a mano en cada portal bancario de las 25
pagadoras (hoja SOLICITUD ALTAS con una columna por pagadora). El catálogo de bancos
vivía en un BUSCARV a un archivo externo de SharePoint, las fórmulas estaban incompletas
en algunas filas y los nombres podían salir con acentos según la fila. La Fase 15 lleva
todo ese formato al sistema, con las reglas integradas y sin puntos frágiles:

1. **Catálogo SPEI local (92 bancos)** — tabla `bancos_spei` sembrada desde el catálogo
   del formato. Se acabó el vínculo externo: el banco se resuelve por el prefijo de la
   CLABE contra el catálogo de la base. `GET /bancos`.
2. **CLABE validada y derivada** — normaliza a sólo dígitos, exige 18, resuelve el banco
   por los 3 primeros dígitos y **deriva el número de cuenta** con la regla por banco:
   los bancos 072 Banorte, 002 Banamex, 021 HSBC, 012 BBVA, 044 Scotiabank y 127 Azteca
   usan los dígitos 8-17; **Santander (014) usa los dígitos 7-17 (11 dígitos)**. Los
   bancos sin regla dejan la cuenta para captura manual, igual que el formato. El
   validador es `POST /clabe/validar` y lo usa toda la app (altas, cuentas, capturas).
3. **Nombre correcto integrado** — la normalización de la macro y los SUBSTITUTE está
   ahora en el servidor: mayúsculas, sin acentos, Ñ→N, sólo letras y espacios compactos
   (`GARCÍA ÑÁÑEZ María José` → `GARCIA NANEZ MARIA JOSE`). Se aplica siempre, sin
   importar la fila ni quién capture (corrige la inconsistencia M/L del formato).
4. **Captura por lotes para portales** — `POST /altas-bancarias/lote` (rol altas,
   admin_tesorería, admin): pega las columnas PATERNO/MATERNO/NOMBRE/CLABE, elige los
   portales (pagadoras activas) donde se registrará cada cuenta y el sistema crea las
   altas en la cola con su fila por portal. Duplicados (misma cuenta ya solicitada o
   registrada) y errores (CLABE corta, banco no reconocido) se reportan línea por línea
   sin bloquear al resto.
5. **Matriz alta × portal** — cada alta se liga a N portales
   (`GET /altas-bancarias/:id/portales`, `POST …/portales`, `POST /altas-portales/:id/estado`,
   `DELETE /altas-portales/:id`). Cuando **todos** los portales quedan `dada_de_alta`, la
   alta pasa a REGISTRADA sola; un rechazo (con motivo obligatorio) o un portal agregado
   después la regresa a la cola para que Tesorería no disperse una cuenta incompleta.
6. **Trabajar un portal** — la vista por pagadora lista sus filas pendientes primero, con
   el nombre correcto, banco, cuenta derivada y CLABE listos para teclear o copiar
   ("Copiar pendientes (TSV)"), y los botones "Dada de alta" / "Rechazar" al registrar.
7. **Catálogo maestro de cuentas** — `cuentas` suma CLABE, moneda, origen (JS/JS MTY),
   estatus (ACTIVA/CANCELADA/SUSPENDIDA con fecha de baja), cliente y formato de reporte.
   La cuenta puede nacer con su CLABE (banco y número auto-llenados) y el PATCH
   `/cuentas/:id/catalogo` valida que el banco asentado no contradiga el prefijo.
8. **Importador del catálogo** — `POST /cuentas/importar-lote` pega las filas del Excel
   de cuentas (TSV: nombre, banco, numero_cuenta, clabe, moneda, origen, estatus,
   cliente). Dedupe por CLABE o por banco+número: si existe, actualiza los campos llenos
   sin duplicar; los errores se reportan por línea.
9. **Bóveda de credenciales multi-usuario** — una cuenta → N credenciales
   (`cuentas_credenciales`: portal bancario, correo, EPLATA, SOFIPO, token, otro; con
   usuario, contraseña, NIP, clave de seguridad, número de token, teléfono, correo y
   vigencia). Los sensibles se guardan **cifrados** en la base; los listados sólo traen
   banderas (`tiene_secreto`), y el valor se entrega uno por uno en
   `GET /credenciales/:id/secreto` con **auditoría** de quién consultó qué y cuándo
   (`credenciales_accesos`). Puede ver la bóveda: admin_tesorería/admin siempre; un
   tesorero sólo si la cuenta está asignada a él o tiene cobertura vigente.
10. **Migración automática** — al arrancar, el backend añade columnas y tablas nuevas a
    bases previas y siembra los 92 bancos una sola vez. Idempotente, sin pasos manuales.

## Roles

- `altas` (Tesorería de Altas, creado en la Fase 12): captura por lotes, marca portales,
  ve la cola de altas y las filas por portal. No revela credenciales.
- `admin_tesoreria` / `admin`: además de lo anterior, administran el catálogo maestro,
  importan cuentas y administran la bóveda (crear/editar credenciales y revelar secretos).
- `tesoreria`: la bóveda sólo de las cuentas que tiene asignadas (o cobertura vigente).
- `operacion` (Ejecutivo): solicita altas desde la operación (Fase 12) y puede validar
  CLABEs; no captura lotes ni marca portales.

## Notas de diseño

- La derivación de cuenta es igual a la del formato (MID por banco); el dígito verificador
  de la CLABE no se valida porque el formato tampoco lo hace (sólo longitud 18).
- Los portales de una alta son pagadoras **activas** del catálogo de cuentas; el rol altas
  las elige de un listado ligero (`GET /cuentas/portales`).
- El estado de la alta se recalcula en un solo lugar (altas, portales, agregar, quitar y
  estado de portal usan la misma regla), por lo que la cola nunca queda inconsistente.
- La verificación del smoke es `scripts/smoke-fase15.mjs`; los tests nuevos están en
  `backend/test/fase15.test.ts`.
