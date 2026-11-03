import { test } from "vitest";

// Fase pendiente (docs/05-sincronizacion.md): cliente offline con cola.
// Estos casos se implementarán junto con la cola en el desktop.

test.todo("cola offline: cambio capturado sin red queda en estado 'pendiente'");

test.todo("cola offline: al recuperar red, push confirma y pasa a 'confirmado'");

test.todo("cola offline: conflicto del servidor deja la entrada en 'conflicto' para resolución humana");

test.todo("cola offline: reintento idempotente no duplica registros (uuid + versión)");

test.todo("cola offline: staging con ack en dos fases");
