import { defineConfig } from "vitest/config";

/**
 * Configuración de Vitest para el backend.
 *
 * Los timeouts por defecto de Vitest (5 s por prueba, 10 s por hook) quedan
 * cortos en equipos de desarrollo lentos (Windows con antivirus en tiempo
 * real, discos lentos): la suite falla con "Test timed out in 5000ms" aunque
 * el sistema funcione correctamente. Se amplían a 30 s; en máquinas normales
 * no cambia nada porque cada prueba termina en 1-3 s.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
